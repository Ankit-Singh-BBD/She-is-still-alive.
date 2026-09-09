/**
 * ActionPipeline — the six stages between an authorized decision and a durable
 * record of what came of it.
 *
 * The LLM proposes a tool call in stage 6 (DECIDE). The application runs it
 * through this pipeline:
 *
 *   1. UNDERSTAND — resolve the tool, validate the input against its schema
 *   2. PLAN       — determine execution order, dependencies, side effects
 *   3. AUTHORIZE  — verify caller permissions against the tool's clearance
 *   4. EXECUTE    — run the tool under retry, timeout and deadline
 *   5. VERIFY     — re-read authoritative state, assert postconditions
 *   6. PERSIST    — write the `action_result` row, publish the domain event
 *
 * The pipeline is invoked by cognitive stage 7 (ACT) through the `ToolExecutor`
 * seam, and by `TaskExecutor` for scheduled work.
 *
 * ## Where the seventh stage went
 *
 * Part XI.1 declares a seventh, RESPOND, and its own table says what that stage
 * has to be: *"LLM drafts the response; application applies Knowledge Disclosure
 * Policy and authorizes output."* This file used to hold a `stageRespond` that was
 * none of those things — a hardcoded English template ending in
 * `JSON.stringify(output)` — whose return value was assigned to
 * `const _responseFragment` and read by nothing. The dead assignment was the
 * smaller half of the problem. The larger half is that a pipeline has no caller,
 * no computed register, no disclosure policy and no completion-claim gate, so
 * language authored down here could not have been spoken even if something had
 * wanted it: it would have been a second opinion about the outcome, in English, in
 * front of an owner who is answered in Hinglish.
 *
 * The stage is real and it runs — in `server/cognition/stages/9.ts`, over the
 * `ActionResult` that this pipeline's outcome becomes. That is where the register
 * is computed, where `attempted`/`success`/`verified` are turned into a sentence
 * she is *allowed* to say, and where a claim she cannot support is caught. RESPOND
 * is not missing from the design; it is one layer up, in the only place that could
 * honour the book's description of it.
 *
 * ## Three outcomes, not two
 *
 * `PipelineResult` reports `attempted` as well as `success` and `verified`, because
 * a call that was refused before dispatch and a call that was dispatched and threw
 * are different facts about the world and she has to say different things about
 * them. See the field's own note.
 */

import type { ToolRegistry } from './registry.js';
import type { Database } from '@server/persistence/db.js';
import { ulid } from '@server/persistence/ids.js';
import type { Identity } from "@server/identity/types.js";
import type { EventBus } from '@server/events/event-bus.js';

export interface PipelineContext {
  toolId: string;
  input: unknown;
  identityId: string;
  cycleId: string;
  causationId: string;
  caller: Identity;
}

export interface PipelineResult {
  /**
   * Whether stage 4 was reached — whether the tool was handed the call at all.
   *
   * This field is the difference between *"the world may be half-changed, go and
   * look"* and *"nothing was touched"*, and without it the seam above could not
   * carry that distinction: a revoked identity, a missing `mayAccessTools` entry
   * and an input that failed its schema all returned `{success: false}`, which the
   * executor turned into a thrown error, which stage 7 recorded as `attempted:
   * true`, which made her say *"I started on that, but I could not confirm it
   * actually went through"* about a call that was never made. That is the more
   * alarming of the two sentences and it was the false one.
   *
   * `false` means one of stages 1–3 refused. `true` means `registry.execute` was
   * called; it may still have thrown, and `success` says which.
   *
   * Required rather than optional so that every construction site has to answer it
   * — the same reason `ActionResult.attempted` is required in
   * `server/cognition/types.ts`.
   */
  attempted: boolean;
  success: boolean;
  output?: unknown | undefined;
  error?: string | undefined;
  verified: boolean;
  actionResultId: string;
}

export interface ActionPipelineOptions {
  registry: ToolRegistry;
  db?: Database;
  eventBus?: EventBus;
  /** Optional postcondition verifier for VERIFY stage. */
  verifier?: PostconditionVerifier;
}

/**
 * Postcondition verifier for VERIFY stage. Each tool can register a verifier
 * that re-reads authoritative state and asserts expected changes.
 */
export interface PostconditionVerifier {
  verify(toolId: string, input: unknown, output: unknown, db: Database): Promise<{
    postconditionsMet: boolean;
    discrepancies: string[];
  }>;
}

/**
 * Simple in-memory verifier registry.
 * In P13+, tools register their own verifiers.
 */
class DefaultVerifierRegistry implements PostconditionVerifier {
  private verifiers = new Map<string, (input: unknown, output: unknown, db: Database) => Promise<{ postconditionsMet: boolean; discrepancies: string[] }>>();

  register(toolId: string, verifier: (input: unknown, output: unknown, db: Database) => Promise<{ postconditionsMet: boolean; discrepancies: string[] }>): void {
    this.verifiers.set(toolId, verifier);
  }

  async verify(toolId: string, input: unknown, output: unknown, db: Database): Promise<{ postconditionsMet: boolean; discrepancies: string[] }> {
    const verifier = this.verifiers.get(toolId);
    if (!verifier) {
      // No verifier registered — mark as unverified with discrepancy
      return {
        postconditionsMet: false,
        discrepancies: [`No PostconditionVerifier registered for tool '${toolId}'`],
      };
    }
    return verifier(input, output, db);
  }
}

export class ActionPipeline {
  private readonly registry: ToolRegistry;
  private readonly db: Database | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly verifier: PostconditionVerifier;

  constructor(opts: ActionPipelineOptions) {
    this.registry = opts.registry;
    this.db = opts.db;
    this.eventBus = opts.eventBus;
    this.verifier = opts.verifier ?? new DefaultVerifierRegistry();
  }

  /**
   * Runs the pipeline for a single tool call.
   *
   * The three gates run in order and the first one to refuse ends it. They used to
   * all run and each assign the same `error` variable, so the recorded reason was
   * whichever gate failed *last* rather than the one that actually stopped the
   * call: an unknown tool that also failed authorization was persisted as an
   * authorization failure, and the row named a gate the call never reached. Worse,
   * AUTHORIZE ran on input that UNDERSTAND had already rejected.
   */
  async execute(context: PipelineContext): Promise<PipelineResult> {
    const actionResultId = ulid();
    let currentInput = context.input;
    let currentOutput: unknown;
    let error: string | undefined;
    let attempted = false;
    let success = false;
    let verified = false;

    // Stage 1: UNDERSTAND
    const understandResult = await this.stageUnderstand(context, currentInput);
    if (!understandResult.ok) {
      error = understandResult.error;
    } else {
      currentInput = understandResult.resolvedInput;

      // Stage 2: PLAN
      const planResult = await this.stagePlan(context, currentInput);
      if (!planResult.ok) {
        error = planResult.error;
      } else {
        currentInput = planResult.executionPlan.input;

        // Stage 3: AUTHORIZE
        const authorizeResult = await this.stageAuthorize(context);
        if (!authorizeResult.ok) {
          error = authorizeResult.error;
        } else {
          // Stage 4: EXECUTE. Past this line the tool has been handed the call, so
          // `attempted` is set before the await rather than after it: a throw from
          // in there is a tool that ran and failed, and the record has to say so
          // even though this frame never sees a return value.
          attempted = true;
          const executeResult = await this.stageExecute(context, currentInput);
          if (!executeResult.ok) {
            error = executeResult.error;
          } else {
            currentOutput = executeResult.output;
            success = true;
          }
        }
      }
    }

    // Stage 5: VERIFY
    let discrepancies: string[] = [];
    if (success && this.db) {
      const verifyResult = await this.stageVerify(context, currentInput, currentOutput);
      verified = verifyResult.postconditionsMet;
      discrepancies = verifyResult.discrepancies;
    }

    // Stage 6: PERSIST
    if (this.db) {
      await this.stagePersist(context, actionResultId, currentInput, currentOutput, {
        attempted,
        success,
        verified,
        error,
        discrepancies,
      });
    }

    const result: PipelineResult = {
      attempted,
      success,
      verified,
      actionResultId,
    };
    if (success && currentOutput !== undefined) result.output = currentOutput;
    if (!success && error !== undefined) result.error = error;
    return result;
  }

  // ── Stage 1: UNDERSTAND ──
  private async stageUnderstand(
    context: PipelineContext,
    input: unknown,
  ): Promise<{ ok: true; resolvedInput: unknown } | { ok: false; error: string }> {
    const tool = this.registry.get(context.toolId);
    if (!tool) {
      return { ok: false, error: `Tool '${context.toolId}' not found` };
    }

    // Validate input schema
    try {
      const validated = tool.inputSchema.parse(input);
      return { ok: true, resolvedInput: validated };
    } catch (e) {
      return { ok: false, error: `Input validation failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // ── Stage 2: PLAN ──
  private async stagePlan(
    context: PipelineContext,
    input: unknown,
  ): Promise<{ ok: true; executionPlan: { input: unknown } } | { ok: false; error: string }> {
    // For single-tool calls, the plan is trivial: just execute it.
    // Multi-tool workflows would be planned here.
    return { ok: true, executionPlan: { input } };
  }

  // ── Stage 3: AUTHORIZE ──
  private async stageAuthorize(
    context: PipelineContext,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const tool = this.registry.get(context.toolId);
    if (!tool) {
      return { ok: false, error: `Tool '${context.toolId}' not found` };
    }

    try {
      this.registry.authorize(context.caller, context.toolId, tool.clearanceRequired);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Stage 4: EXECUTE ──
  private async stageExecute(
    context: PipelineContext,
    input: unknown,
  ): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
    try {
      const output = await this.registry.execute(context.toolId, input, {
        identityId: context.identityId,
        cycleId: context.cycleId,
        causationId: context.causationId,
        caller: context.caller,
      });
      return { ok: true, output };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── Stage 5: VERIFY ──
  private async stageVerify(
    context: PipelineContext,
    input: unknown,
    output: unknown,
  ): Promise<{ postconditionsMet: boolean; discrepancies: string[] }> {
    if (!this.db) {
      return { postconditionsMet: false, discrepancies: ['No database available for verification'] };
    }
    return this.verifier.verify(context.toolId, input, output, this.db);
  }

  // ── Stage 6: PERSIST ──
  /**
   * The one durable record of the call, and the payload that announces it.
   *
   * Both used to be narrower than what this method already knew. The row held
   * `verified` and `error` but not `attempted`, so a reader could not tell a refusal
   * from a failure — the same distinction the honesty contract turns on, present in
   * memory and dropped on the way to disk. And `discrepancies` was computed in stage
   * 5, passed in here, and used only in the event: the reason a verification failed
   * survived exactly as long as a subscriber was listening, and the row that outlives
   * every subscriber said only `verified = 0`.
   */
  private async stagePersist(
    context: PipelineContext,
    actionResultId: string,
    input: unknown,
    output: unknown | undefined,
    outcome: {
      attempted: boolean;
      success: boolean;
      verified: boolean;
      error: string | undefined;
      discrepancies: string[];
    },
  ): Promise<void> {
    if (!this.db) return;

    const insert = this.db.raw.prepare(
      `INSERT INTO action_result
         (id, cycle_id, tool_id, input_json, output_json, attempted, verified, error,
          discrepancies_json, persisted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run(
      actionResultId,
      context.cycleId,
      context.toolId,
      JSON.stringify(input),
      output ? JSON.stringify(output) : null,
      outcome.attempted ? 1 : 0,
      outcome.verified ? 1 : 0,
      outcome.error ?? null,
      outcome.discrepancies.length > 0 ? JSON.stringify(outcome.discrepancies) : null,
      new Date().toISOString(),
    );

    // Emit domain event.
    //
    // The type reflects what happened. This published `action.executed`
    // unconditionally with `success` buried in the payload, which left
    // `action.failed` declared in the event union and never once published: a
    // subscriber that asked for failures heard nothing, and one that asked for
    // executions was handed the failures too. A tool that ran but whose
    // postconditions were not met also did not do its job, so it belongs on the
    // failure side — the payload keeps the distinction between "threw" and
    // "returned something we could not verify", and `attempted` keeps the third one:
    // "was never dispatched".
    if (this.eventBus) {
      await this.eventBus.publish({
        type: outcome.success && outcome.verified ? 'action.executed' : 'action.failed',
        payload: {
          toolId: context.toolId,
          attempted: outcome.attempted,
          success: outcome.success,
          verified: outcome.verified,
          error: outcome.error,
          discrepancies: outcome.discrepancies,
        },
        identityId: context.identityId,
        cycleId: context.cycleId,
        timestamp: Date.now(),
        causationId: context.causationId,
        correlationId: context.cycleId,
        version: 1,
      });
    }
  }

  /**
   * Registers a postcondition verifier for one tool.
   *
   * Only meaningful when this pipeline is using its own `DefaultVerifierRegistry`.
   * When a caller has supplied a verifier of their own — as the composition root
   * does, with the registry shared with cognitive stage 8 — there is nowhere here
   * to put the registration, and it used to be dropped silently: the tool went on
   * verifying through the injected registry, which had never heard of it, and
   * reported `postconditionsMet: false` forever with no clue as to why.
   *
   * So it throws. A verifier that cannot be installed is a verifier that will not
   * run, and that has to be a loud failure at wiring time rather than a quiet
   * `verified = 0` in every row afterwards.
   */
  registerVerifier(toolId: string, verifier: (input: unknown, output: unknown, db: Database) => Promise<{ postconditionsMet: boolean; discrepancies: string[] }>): void {
    if (!(this.verifier instanceof DefaultVerifierRegistry)) {
      throw new Error(
        `Cannot register a verifier for '${toolId}' on this pipeline: it was constructed with a ` +
          `verifier of its own, so registrations belong there. Register the postcondition with ` +
          `that registry instead (see server/tools/verification.ts).`,
      );
    }
    this.verifier.register(toolId, verifier);
  }
}

export { DefaultVerifierRegistry };