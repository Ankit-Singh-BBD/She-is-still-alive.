/**
 * CognitiveRuntime — orchestrates the 12-stage cycle.
 *
 * All twelve stages are real implementations living in
 * `server/cognition/stages/{1..12}.ts`: 1-6 (PERCEIVE..DECIDE) from P08, 7-9
 * (ACT, VERIFY, RESPOND) from P09, and 10-12 (LEARN, UPDATE, PERSIST) from P10.
 *
 * The runtime is the only place stage transitions are decided (Part VII.2):
 * each stage is a pure function, invoked exactly once per cycle, and its typed
 * output is threaded explicitly to its successors. The JSON in a StageTrace is
 * an audit record of what happened — never the transport between stages.
 *
 * A stage that throws does not abort the cycle: the error is recorded on its
 * trace, the documented fallback is substituted, and the cycle reports
 * `degraded` rather than `completed` so the outcome never overstates itself.
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { MemoryRetrieval } from '@server/memory/retrieval.js';
import type { ConversationRepository } from '@server/conversations/repository.js';
import type { TranscriptReader, TurnDraft } from '@server/conversations/messages.js';
import type {
  CycleRecord,
  CycleStatus,
  RawStimulus,
  IdentifiedStimulus,
  RecalledContext,
  UnderstandingProposal,
  ReasoningTraceProposal,
  AuthorizedDecision,
  ActionResult,
  VerificationReport,
  AuthorizedResponse,
  AuthorizedLearningDelta,
  UpdateResult,
  PersistResult,
  StageTrace,
  StageNumber,
  AuditCollector,
  AuditEntry,
} from './types.js';

import { perceive } from './stages/1.js';
import { identify } from './stages/2.js';
import { recall } from './stages/3.js';
import { understand, type UnderstandOptions } from './stages/4.js';
import { reason, type ReasonOptions } from './stages/5.js';
import { decide, type DecideOptions } from './stages/6.js';
import { act, type ActOptions } from './stages/7.js';
import { verify, type VerifyOptions } from './stages/8.js';
import { respond, type RespondOptions } from './stages/9.js';
import { learn, type LearnOptions } from './stages/10.js';
import { update, type UpdateOptions } from './stages/11.js';
import { persist, type PersistOptions, type PersistInput } from './stages/12.js';

export interface CognitiveRuntimeOptions {
  db?: Database | undefined;
  identityRepo?: IdentityRepository | undefined;
  eventBus?: EventBus | undefined;
  memoryRetrieval?: MemoryRetrieval | undefined;
  /**
   * Opens the conversation a cycle is recorded against when the stimulus does
   * not name one. Without it, an unnamed conversation is an error rather than a
   * guess.
   */
  conversations?: ConversationRepository | undefined;
  /**
   * Reads the recent turns of the conversation for stage 3, and is the reason
   * she can refer to what was just said. Absent, every cycle starts from
   * memory alone and `RecalledContext.recentTurns` stays undefined — which the
   * prompts report as "not loaded" rather than as "nothing was said".
   */
  transcript?: TranscriptReader | undefined;
  /** Caller identity used by stages 6-7 for authorization. */
  identity?: Identity | undefined;
  understand?: UnderstandOptions | undefined;
  reason?: ReasonOptions | undefined;
  decide?: DecideOptions | undefined;
  act?: ActOptions | undefined;
  verify?: VerifyOptions | undefined;
  respond?: RespondOptions | undefined;
  learn?: LearnOptions | undefined;
  update?: UpdateOptions | undefined;
  persist?: PersistOptions | undefined;
}

interface StageOutcome<O> {
  trace: StageTrace;
  output: O | undefined;
}

/**
 * In-memory audit buffer for one cycle. Stage 9 records disclosure decisions
 * here; stage 12 (PERSIST, P10) flushes them to `audit_log` inside the cycle's
 * transaction (Build Book Part VII.1 stage 12).
 */
export class CycleAuditBuffer implements AuditCollector {
  private readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  drain(): AuditEntry[] {
    return [...this.entries];
  }
}

export class CognitiveRuntime {
  private readonly db: Database;
  private readonly identityRepo: IdentityRepository | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly memoryRetrieval: MemoryRetrieval | undefined;
  private readonly conversations: ConversationRepository | undefined;
  private readonly transcript: TranscriptReader | undefined;
  private readonly understandOpts: UnderstandOptions;
  private readonly reasonOpts: ReasonOptions;
  private readonly decideOpts: DecideOptions;
  private readonly actOpts: ActOptions;
  private readonly verifyOpts: VerifyOptions;
  private readonly respondOpts: RespondOptions;
  private readonly learnOpts: LearnOptions;
  private readonly updateOpts: UpdateOptions;
  private readonly persistOpts: PersistOptions;

  constructor(options: CognitiveRuntimeOptions = {}) {
    this.db = options.db ?? getDatabase();
    this.identityRepo = options.identityRepo;
    this.eventBus = options.eventBus;
    this.memoryRetrieval = options.memoryRetrieval;
    this.conversations = options.conversations;
    this.transcript = options.transcript;
    this.understandOpts = options.understand ?? {};
    this.reasonOpts = options.reason ?? {};
    this.decideOpts = { ...(options.decide ?? {}), identity: options.identity };
    this.actOpts = { ...(options.act ?? {}), identity: options.identity };
    this.verifyOpts = {
      ...(options.verify ?? {}),
      // `this.db`, not `options.db`: stage 8's whole job is to re-read
      // authoritative state, and it reports "no database to re-read" when it has
      // none. A runtime constructed without an explicit database still has one
      // (the process-wide instance), and handing stage 8 `undefined` there would
      // make every verification fail for a reason that is not true.
      db: this.db,
      identityId: options.identity?.id,
    };
    this.respondOpts = options.respond ?? {};
    this.learnOpts = {
      ...(options.learn ?? {}),
      db: this.db,
    };
    this.updateOpts = {
      ...(options.update ?? {}),
      db: this.db,
    };
    this.persistOpts = {
      ...(options.persist ?? {}),
      db: this.db,
      eventBus: options.eventBus,
    };
  }

  async runCycle(stimulus: RawStimulus): Promise<CycleRecord> {
    const cycleId = ulid();
    const startedAt = Date.now();

    // Resolved once, before anything else, and then carried on the stimulus
    // itself.
    //
    // It used to be resolved inside `createCycleRecord` and thrown away: the
    // `cycle_record` row pointed at a real conversation while the stimulus every
    // stage saw still had `conversationId: undefined`, and the record this
    // method returned said `'unknown'`. So stage 10 wrote
    // `sourceConversationId: 'unknown'` into the provenance of everything it
    // learned, and stage 3 had no conversation to read a transcript from.
    // Resolving once and threading it fixes all three.
    const conversationId = this.resolveConversationId(stimulus);
    const situated: RawStimulus = { ...stimulus, conversationId };

    const cycleRecord = await this.createCycleRecord(cycleId, situated, conversationId, startedAt);

    const stages: StageTrace[] = [];

    // ── Stages 1-6: real implementations (P08) ──

    const r1 = await this.runStage<RawStimulus>(1, 'PERCEIVE', situated, () =>
      perceive(situated),
    );
    stages.push(r1.trace);
    const perceived = r1.output ?? situated;

    const r2 = await this.runStage<IdentifiedStimulus>(2, 'IDENTIFY', perceived, () =>
      identify(perceived, this.identityRepo),
    );
    stages.push(r2.trace);
    const identified = r2.output ?? identify(perceived);

    const r3 = await this.runStage<RecalledContext>(3, 'RECALL', identified, () =>
      recall(identified, this.memoryRetrieval, this.transcript),
    );
    stages.push(r3.trace);
    const recalled = r3.output ?? emptyContext(identified);

    const r4 = await this.runStage<UnderstandingProposal>(4, 'UNDERSTAND', recalled, () =>
      understand(recalled, this.understandOpts),
    );
    stages.push(r4.trace);
    const understanding = r4.output ?? DEFAULT_UNDERSTANDING;

    const r5 = await this.runStage<ReasoningTraceProposal>(
      5,
      'REASON',
      { understanding },
      () => reason(recalled, understanding, this.reasonOpts),
    );
    stages.push(r5.trace);
    const reasoning = r5.output ?? DEFAULT_REASONING;

    const r6 = await this.runStage<AuthorizedDecision>(6, 'DECIDE', { reasoning }, () =>
      decide(reasoning, identified, this.decideOpts),
    );
    stages.push(r6.trace);
    const authorizedDecision = r6.output ?? DEFAULT_DECISION;

    // ── Stages 7-9: real implementations (P09) ──

    const r7 = await this.runStage<ActionResult[]>(7, 'ACT', authorizedDecision, () =>
      act(authorizedDecision, { ...this.actOpts, cycleId }),
    );
    stages.push(r7.trace);
    const actionResults = r7.output ?? [];

    const r8 = await this.runStage<VerificationReport>(8, 'VERIFY', actionResults, () =>
      verify(actionResults, { ...this.verifyOpts, cycleId }),
    );
    stages.push(r8.trace);
    const verification = r8.output;

    const verifiedResults = verification?.results ?? actionResults;

    // Stage 9 records its disclosure decisions into the cycle's audit buffer.
    // Stage 12 (P10) flushes them to `audit_log` together with the rest of the
    // cycle artifacts in one transaction.
    const audit = new CycleAuditBuffer();
    const r9 = await this.runStage<AuthorizedResponse>(
      9,
      'RESPOND',
      { recalled, actionResults: verifiedResults, verification },
      () => respond(recalled, authorizedDecision, verifiedResults, verification, {
        ...this.respondOpts,
        audit,
      }),
    );
    stages.push(r9.trace);
    const response = r9.output;

    // ── Stages 10-12: real implementations (P10) ──

    const r10 = await this.runStage<AuthorizedLearningDelta>(10, 'LEARN', response, () =>
      learn(recalled, authorizedDecision, response ?? DEFAULT_RESPONSE, verifiedResults, verification, {
        ...this.learnOpts,
        cycleId,
      }),
    );
    stages.push(r10.trace);
    const learningDelta = r10.output;

    const r11 = await this.runStage<UpdateResult>(11, 'UPDATE', learningDelta, () =>
      update(learningDelta, this.updateOpts),
    );
    stages.push(r11.trace);
    const updateResult = r11.output;

    const completedAt = Date.now();

    // A stage that threw was replaced by its documented fallback, so the cycle
    // still produced a response — but reporting it as a clean 'completed' would
    // be a claim the traces contradict. Derive the status from the traces.
    const failedStages = stages.filter((s) => s.error !== undefined);
    const cycleStatus: CycleStatus = failedStages.length > 0 ? 'degraded' : 'completed';
    const cycleError =
      failedStages.length > 0
        ? failedStages.map((s) => `${s.stageName}: ${s.error ?? 'unknown error'}`).join('; ')
        : undefined;

    const persistInput: PersistInput = {
      cycleId,
      status: cycleStatus,
      error: cycleError,
      completedAt,
      identityId: stimulus.identityId,
      conversationId,
      turns: transcriptTurns({
        stimulus: situated,
        cycleId,
        response,
        startedAt,
        completedAt,
      }),
      actionResults: verifiedResults,
      decision: authorizedDecision,
      response,
      learningDelta,
      updateResult,
      audit: audit.drain(),
      stages: [...stages, /* r12.trace will be appended below */ ],
    };

    const r12 = await this.runStage<PersistResult>(12, 'PERSIST', updateResult, () =>
      persist(persistInput, this.persistOpts),
    );
    stages.push(r12.trace);
    // Stage 12's own trace isn't in `persist`'s transaction — `runStage`
    // creates the trace wrapper *around* the handler that calls `persist`,
    // so its `stage_trace` row hasn't been written yet. Flush it now.
    await this.finalizeCycleRecord(cycleId, [r12.trace]);

    // Stage 12 runs after the status above was computed. If persistence itself
    // threw, nothing durable was written and the cycle genuinely failed.
    const persistFailed = r12.trace.error !== undefined;
    const finalStatus: CycleStatus = persistFailed ? 'failed' : cycleStatus;
    const finalError = persistFailed
      ? [cycleError, `PERSIST: ${r12.trace.error ?? 'unknown error'}`].filter(Boolean).join('; ')
      : cycleError;

    if (persistFailed) {
      // The status column still reads whatever `persist` last committed (or
      // 'running' if it never got that far). Correct it out-of-band so the row
      // does not outlive the process claiming success.
      this.recordCycleFailure(cycleId, finalError ?? 'persist failed', completedAt);
    }

    return {
      ...cycleRecord,
      status: finalStatus,
      error: finalError,
      completedAt,
      stages,
      proposedDecision: authorizedDecision.proposal,
      authorizedDecision,
      actionResults: verifiedResults,
      response,
      learningDelta,
    };
  }

  /**
   * Best-effort correction of a cycle row when stage 12 itself threw. Runs
   * outside any transaction and swallows its own errors — if the database is
   * unreachable there is nothing further this can do, and throwing here would
   * mask the original persistence error from the caller.
   */
  private recordCycleFailure(cycleId: string, error: string, completedAt: number): void {
    try {
      this.db.raw
        .prepare(
          `UPDATE cycle_record
              SET status = 'failed', completed_at = ?, error = ?
            WHERE id = ?`,
        )
        .run(new Date(completedAt).toISOString(), error, cycleId);
    } catch {
      // Intentionally ignored — see doc comment.
    }
  }

  /**
   * Invokes one stage exactly once, capturing its trace. A thrown stage does not
   * abort the cycle: the error is recorded on the trace and the runtime falls
   * back to the stage's documented default (the P08 rollback contract).
   */
  private async runStage<O>(
    stage: StageNumber,
    stageName: string,
    input: unknown,
    handler: () => Promise<O> | O,
  ): Promise<StageOutcome<O>> {
    const startedAt = Date.now();
    const inputJson = safeStringify(input);
    try {
      const output = await handler();
      return {
        trace: {
          stage,
          stageName,
          startedAt,
          completedAt: Date.now(),
          inputJson,
          outputJson: safeStringify(output),
        },
        output,
      };
    } catch (e) {
      return {
        trace: {
          stage,
          stageName,
          startedAt,
          completedAt: Date.now(),
          inputJson,
          error: e instanceof Error ? e.message : String(e),
        },
        output: undefined,
      };
    }
  }

  // ── Persistence ──

  /**
   * The conversation this cycle belongs to.
   *
   * `cycle_record.conversation_id` is a foreign key, and the previous fallback
   * for a stimulus that carried no conversation was the string `'unknown'` — a
   * value that can never satisfy that key. So a cycle without a conversation id
   * did not degrade, it threw on its first insert, and nothing in `server/`
   * created a conversation for it to point at.
   *
   * Now: an id that is supplied is honoured (and opened if the caller invented
   * it), and an absent one opens or continues the caller's conversation. With no
   * repository injected there is nothing that could honestly be inserted, so
   * that says what is missing instead of failing on a constraint three frames
   * later.
   */
  private resolveConversationId(stimulus: RawStimulus): string {
    if (stimulus.conversationId !== undefined && stimulus.conversationId !== '') {
      return this.conversations
        ? this.conversations.ensure(stimulus.conversationId, stimulus.identityId)
        : stimulus.conversationId;
    }
    if (!this.conversations) {
      throw new Error(
        'runCycle() was given a stimulus with no conversationId and the runtime has no ' +
          'ConversationRepository to open one with. Pass `conversations` when constructing ' +
          'CognitiveRuntime, or set conversationId on the stimulus.',
      );
    }
    return this.conversations.openOrContinue(
      stimulus.identityId,
      stimulus.source === 'audio' ? 'voice' : 'text',
    ).id;
  }

  private async createCycleRecord(
    id: string,
    stimulus: RawStimulus,
    conversationId: string,
    startedAt: number,
  ): Promise<CycleRecord> {
    this.db.raw
      .prepare(
        `INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        conversationId,
        new Date(startedAt).toISOString(),
        JSON.stringify(stimulus),
      );

    // Announce the start. Stage 12 publishes the terminal event
    // (`cycle.completed` / `cycle.degraded` / `cycle.failed`), but nothing
    // published the opening one, so `cycle.started` sat declared and unused and
    // a subscriber could only ever learn about a cycle after it was over —
    // which is no use at all to anything that wants to show that she is
    // thinking while she is thinking.
    if (this.eventBus) {
      await this.eventBus.publish({
        type: 'cycle.started',
        payload: {
          cycleId: id,
          conversationId,
          source: stimulus.source,
        },
        identityId: stimulus.identityId,
        cycleId: id,
        timestamp: startedAt,
        causationId: undefined,
        correlationId: id,
        version: 1,
      });
    }

    return {
      id,
      identityId: stimulus.identityId,
      // The resolved conversation, not `stimulus.conversationId ?? 'unknown'`.
      // The caller is told which thread this cycle is in, which is also the
      // thread its transcript was written to.
      conversationId,
      status: 'running',
      startedAt,
      stages: [],
    };
  }

  private async finalizeCycleRecord(
    id: string,
    stages: StageTrace[],
  ): Promise<void> {
    const insertTrace = this.db.raw.prepare(
      `INSERT INTO stage_trace (id, cycle_id, stage, stage_name, started_at, completed_at, input_json, output_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // One transaction so stage traces are persisted reliably.
    this.db.raw.transaction(() => {
      for (const stage of stages) {
        insertTrace.run(
          ulid(),
          id,
          stage.stage,
          stage.stageName,
          new Date(stage.startedAt).toISOString(),
          stage.completedAt ? new Date(stage.completedAt).toISOString() : null,
          stage.inputJson,
          stage.outputJson ?? null,
          stage.error ?? null,
        );
      }
    })();
  }
}

// ── Defaults used when a stage errors (P08 rollback contract) ──

const DEFAULT_RESPONSE: AuthorizedResponse = {
  text: 'Hello — I hear you.',
  voiceEnabled: false,
  disclosuresApplied: ['default'],
  redacted: false,
};

const DEFAULT_UNDERSTANDING: UnderstandingProposal = {
  intent: 'respond',
  confidence: 0,
  disambiguationNeeded: false,
  clarifyingQuestions: [],
  entities: {},
};

const DEFAULT_REASONING: ReasoningTraceProposal = {
  steps: [
    { description: 'Reasoning stage failed; defaulting.', conclusion: 'respond', confidence: 0 },
  ],
  optionsConsidered: ['respond'],
  recommendedApproach: 'respond',
};

const DEFAULT_DECISION: AuthorizedDecision = {
  proposal: { action: 'respond', rationale: 'Decision stage failed; default response' },
  authorized: false,
  reason: 'Decision stage failed',
  clearanceChecked: false,
};

function emptyContext(stimulus: IdentifiedStimulus): RecalledContext {
  return {
    stimulus,
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    retrievedAt: Date.now(),
  };
}

/**
 * The turns this cycle should add to the transcript.
 *
 * Two rules, both of them about not writing a line nobody said:
 *
 *   - The user's turn is written only when the stimulus actually carried text. A
 *     system trigger, a proactive wake-up or an audio stimulus with no
 *     transcript yet has nothing to quote, and serialising its payload into the
 *     transcript would put JSON in her mouth. When voice lands (P19) the
 *     transcript belongs in `payload.text` and this needs no change.
 *   - Her turn is written only when stage 9 produced an *authorized* response.
 *     If stage 9 threw, the runtime returns no response and the caller shows
 *     nothing, so recording the fallback line would be a claim the traces
 *     contradict. The text stored is the authorized one — post-redaction, what
 *     she actually said — never a draft.
 *
 * The timestamps are the cycle's own: the stimulus arrived when it arrived, and
 * the answer exists as of `completedAt`. Ordering never depends on them being
 * distinct (see `MessageRepository.recentForCaller`), but they are the honest
 * times, and `startedAt` is the fallback for a stimulus that carried none.
 */
function transcriptTurns(input: {
  stimulus: RawStimulus;
  cycleId: string;
  response: AuthorizedResponse | undefined;
  startedAt: number;
  completedAt: number;
}): TurnDraft[] {
  const turns: TurnDraft[] = [];

  const said = textOf(input.stimulus.payload);
  if (said.trim() !== '') {
    turns.push({
      role: 'user',
      text: said,
      timestamp: input.stimulus.receivedAt || input.startedAt,
      metadata: { cycleId: input.cycleId, source: input.stimulus.source },
    });
  }

  const answered = input.response?.text ?? '';
  if (answered.trim() !== '') {
    turns.push({
      role: 'assistant',
      text: answered,
      timestamp: input.completedAt,
      metadata: {
        cycleId: input.cycleId,
        redacted: input.response?.redacted ?? false,
        disclosuresApplied: input.response?.disclosuresApplied ?? [],
      },
    });
  }

  return turns;
}

/** The text a stimulus carried, if it carried any. */
function textOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}
