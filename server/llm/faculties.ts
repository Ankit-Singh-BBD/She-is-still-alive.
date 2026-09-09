/**
 * The five adapters that put the model behind the stage gates.
 *
 * Each method here implements an interface a cognitive stage declared for
 * itself — `LlmFaculty` in stages 4, 5 and 6, `ResponseFaculty` in stage 9,
 * `LearningFaculty` in stage 10 — and each does exactly four things: reduce the
 * stage's typed input to a prompt, call the transport, parse the answer with
 * that stage's Zod schema, and hand back a *proposal*.
 *
 * What none of them do is decide anything. Every method returns a value the
 * calling stage then validates, clamps and authorizes:
 *
 *  - stage 4 rejects an intent outside its five and collapses it to `clarify`;
 *  - stage 6 drops a tool id the caller has no clearance for and substitutes a
 *    clarification, having asked `server/authz`;
 *  - stage 9 runs the Knowledge Disclosure Policy over whatever was drafted and
 *    replaces success language over an unverified action;
 *  - stage 10 applies thresholds, deduplication and the Scoped Learning Policy
 *    before a single row is written.
 *
 * So the worst a compromised or confused model can do from in here is waste a
 * turn. That is the whole point of Part II.
 *
 * ## Failure is loud
 *
 * A malformed answer raises `LanguageFacultyError`, which the stage does not
 * catch: `CognitiveRuntime` records it on the trace and substitutes the stage's
 * documented fallback, and the cycle reports `degraded`. Catching it here and
 * quietly returning a heuristic would make a broken model indistinguishable
 * from a working one, which is the honesty bug this codebase keeps finding.
 */

import type { z } from 'zod';

import type { CognitiveStageKey } from '@server/cognition/budgets.js';
import type { LlmFaculty as DecideFaculty } from '@server/cognition/stages/6.js';
import type { ResponseFaculty } from '@server/cognition/stages/9.js';
import type { LearningFaculty } from '@server/cognition/stages/10.js';
import type {
  ActionResult,
  AuthorizedDecision,
  AuthorizedResponse,
  DecisionProposal,
  IdentifiedStimulus,
  RecalledContext,
  ReasoningTraceProposal,
  UnderstandingProposal,
  VerificationReport,
} from '@server/cognition/types.js';
import type { MemoryDomain, Sensitivity, SubjectKind } from '@server/memory/types.js';

import {
  buildDecidePrompt,
  buildLearnPrompt,
  buildReasonPrompt,
  buildRespondPrompt,
  buildTranscriptLearnPrompt,
  buildUnderstandPrompt,
  SYSTEM_INSTRUCTIONS,
} from './prompts.js';
import {
  decisionSchema,
  extractionsSchema,
  reasoningSchema,
  responseSchema,
  understandingSchema,
  type FacultySchema,
} from './schemas.js';
import { LanguageFacultyError, type LanguageModel } from './types.js';

/** What stage 10 asks for, named so the return type is readable. */
export interface ExtractionProposal {
  domain: MemoryDomain;
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  subjectKind: SubjectKind;
}

export interface LanguageFacultiesOptions {
  model: LanguageModel;
  /**
   * The tools stage 6 may name, read at call time rather than captured.
   *
   * A function because the registry is populated during boot and can grow: a
   * snapshot taken when the faculties were constructed would tell her about a
   * roster that no longer matches what stage 7 can actually run.
   */
  toolIds: () => readonly string[];
}

/**
 * One object that satisfies all five stage-local faculty interfaces.
 *
 * They are together rather than in five classes because they share a model, a
 * failure mode and a set of prompts, and because `server/app.ts` passes the same
 * instance to every stage — five objects would be five places to forget to wire.
 */
export class LanguageFaculties implements DecideFaculty, ResponseFaculty, LearningFaculty {
  private readonly model: LanguageModel;
  private readonly toolIds: () => readonly string[];

  constructor(options: LanguageFacultiesOptions) {
    this.model = options.model;
    this.toolIds = options.toolIds;
  }

  /** The model that answers, for the boot banner and for provenance. */
  get modelId(): string {
    return this.model.modelId;
  }

  // ── Stage 4: UNDERSTAND ──────────────────────────────────────────────────

  async proposeUnderstanding(input: {
    stimulus: IdentifiedStimulus;
    recalled: RecalledContext;
  }): Promise<UnderstandingProposal> {
    const wire = await this.ask('UNDERSTAND', understandingSchema, buildUnderstandPrompt(input));
    return {
      intent: wire.intent,
      confidence: wire.confidence,
      disambiguationNeeded: wire.disambiguationNeeded,
      clarifyingQuestions: wire.clarifyingQuestions,
      entities: wire.entities,
    };
  }

  // ── Stage 5: REASON ──────────────────────────────────────────────────────

  async proposeReasoning(input: {
    stimulus: IdentifiedStimulus;
    recalled: RecalledContext;
    understanding: UnderstandingProposal;
  }): Promise<ReasoningTraceProposal> {
    const wire = await this.ask('REASON', reasoningSchema, buildReasonPrompt(input));
    return {
      steps: wire.steps,
      optionsConsidered: wire.optionsConsidered,
      recommendedApproach: wire.recommendedApproach,
    };
  }

  // ── Stage 6: DECIDE ──────────────────────────────────────────────────────

  async proposeDecision(input: {
    stimulus: IdentifiedStimulus;
    reasoning: ReasoningTraceProposal;
  }): Promise<DecisionProposal> {
    const toolIds = this.toolIds();
    const wire = await this.ask(
      'DECIDE',
      decisionSchema,
      buildDecidePrompt({ ...input, toolIds }),
    );

    // A tool she was never shown is not a proposal, it is a hallucination, and
    // stage 6 would authorize it against the authz matrix rather than against
    // the roster. Reducing it to `clarify` here keeps the two consistent: the
    // application refuses, and the refusal is recorded in the rationale.
    if (wire.action === 'execute_tool' && (!wire.toolId || !toolIds.includes(wire.toolId))) {
      return {
        action: 'clarify',
        rationale: `Proposed a tool that is not installed: ${wire.toolId ?? '(none named)'}`,
      };
    }

    return {
      action: wire.action,
      toolId: wire.toolId,
      toolInput: wire.toolInput,
      taskSpec: wire.taskSpec,
      rationale: wire.rationale,
    };
  }

  // ── Stage 9: RESPOND ─────────────────────────────────────────────────────

  async draftResponse(input: {
    recalled: RecalledContext;
    decision: AuthorizedDecision;
    results: ActionResult[];
    verification: VerificationReport | undefined;
  }): Promise<{ text: string; voicePreferred?: boolean | undefined }> {
    const wire = await this.ask('RESPOND', responseSchema, buildRespondPrompt(input));
    return { text: wire.text, voicePreferred: wire.voicePreferred };
  }

  // ── Stage 10: LEARN ──────────────────────────────────────────────────────

  async proposeExtractions(input: {
    recalled: RecalledContext;
    decision: AuthorizedDecision;
    response: AuthorizedResponse;
    actionResults: { toolId: string; success: boolean; verified: boolean }[];
    verification: VerificationReport | undefined;
  }): Promise<ExtractionProposal[]> {
    const wire = await this.ask('LEARN', extractionsSchema, buildLearnPrompt(input));
    return wire.extractions.map((extraction) => ({
      domain: extraction.domain,
      data: extraction.data,
      confidence: extraction.confidence,
      importance: extraction.importance,
      sensitivity: extraction.sensitivity,
      subjectKind: extraction.subjectKind,
    }));
  }

  // ── Stage 10, after the fact ─────────────────────────────────────────────

  /**
   * The same LEARN faculty, driven from a stored transcript.
   *
   * `LearningPipeline` learns out of band: it is handed a `cycle_record` row and
   * the conversation, long after the working context that stage 3 assembled has
   * gone. It gets its own prompt rather than a half-filled `buildLearnPrompt`
   * because the honest input here is *less* than a live cycle's, and a prompt
   * that pretended otherwise — an empty recalled context standing in for one that
   * was never loaded — would invite her to re-propose everything she already
   * knows.
   *
   * The schema, the instruction and the parse are the live stage's. Only the
   * prompt differs, so the two paths cannot drift on what an extraction is
   * allowed to look like.
   */
  async proposeExtractionsFromTranscript(input: {
    cycle: { status: string; decision?: string | undefined; answered?: string | undefined };
    messages: readonly { role: string; text: string }[];
    speakerKind: string;
    alreadyKnown?: readonly string[] | undefined;
  }): Promise<ExtractionProposal[]> {
    const wire = await this.ask('LEARN', extractionsSchema, buildTranscriptLearnPrompt(input));
    return wire.extractions.map((extraction) => ({
      domain: extraction.domain,
      data: extraction.data,
      confidence: extraction.confidence,
      importance: extraction.importance,
      sensitivity: extraction.sensitivity,
      subjectKind: extraction.subjectKind,
    }));
  }

  // ── The one call ─────────────────────────────────────────────────────────

  /**
   * Ask, then check. The provider's structured output is a convenience; this
   * parse is the actual gate on shape.
   */
  private async ask<T>(
    stage: CognitiveStageKey,
    schema: FacultySchema<T>,
    prompt: string,
  ): Promise<T> {
    const result = await this.model.generateJson({
      stage,
      systemInstruction: SYSTEM_INSTRUCTIONS[stage],
      prompt,
      schema: schema.json,
    });

    const parsed = schema.zod.safeParse(result.json);
    if (!parsed.success) {
      throw new LanguageFacultyError(
        stage,
        `the answer did not match the schema (${describeIssues(parsed.error)})`,
      );
    }
    return parsed.data;
  }
}

/**
 * Zod issues reduced to paths and codes.
 *
 * Deliberately not `error.message`: Zod quotes the offending *value* in several
 * of its messages, and this string is written to a `stage_trace` row that
 * outlives the cycle. A path and a code say what drifted without recording what
 * she was told.
 */
function describeIssues(error: z.ZodError): string {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    seen.add(`${path}: ${issue.code}`);
    if (seen.size >= 4) break;
  }
  return [...seen].join(', ');
}
