/**
 * ActionPipeline (P11) — 7-stage pipeline for tool execution.
 *
 * The LLM proposes a tool call in stage 6 (DECIDE). The application runs it
 * through this pipeline:
 *
 *   1. UNDERSTAND — parse the toolId and input, resolve references
 *   2. PLAN — determine execution order, dependencies, side effects
 *   3. AUTHORIZE — verify caller permissions against tool clearance
 *   4. EXECUTE — run the tool with timeout, retry, deadline
 *   5. VERIFY — re-read authoritative state, assert postconditions
 *   6. PERSIST — write action_result row, emit domain_event
 *   7. RESPOND — build the response fragment for the cognitive cycle
 *
 * Each stage is a pure function. The pipeline is invoked by Stage 7 (ACT)
 * through the ToolExecutor interface.
 */

import type { ToolRegistry } from './registry.js';
import type { Database } from '@server/persistence/db.js';
import { ulid } from 'ulid';
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
   * Main entry point — runs the 7-stage pipeline for a single tool call.
   */
  async execute(context: PipelineContext): Promise<PipelineResult> {
    const actionResultId = ulid();
    let currentInput = context.input;
    let currentOutput: unknown;
    let error: string | undefined;
    let success = false;
    let verified = false;

    // Stage 1: UNDERSTAND
    const understandResult = await this.stageUnderstand(context, currentInput);
    if (!understandResult.ok) {
      error = understandResult.error;
    } else {
      currentInput = understandResult.resolvedInput;
    }

    // Stage 2: PLAN
    const planResult = await this.stagePlan(context, currentInput);
    if (!planResult.ok) {
      error = planResult.error;
    } else {
      currentInput = planResult.executionPlan.input;
    }

    // Stage 3: AUTHORIZE
    const authorizeResult = await this.stageAuthorize(context);
    if (!authorizeResult.ok) {
      error = authorizeResult.error;
    }

    // Stage 4: EXECUTE
    if (!error) {
      const executeResult = await this.stageExecute(context, currentInput);
      if (!executeResult.ok) {
        error = executeResult.error;
      } else {
        currentOutput = executeResult.output;
        success = true;
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
      await this.stagePersist(context, actionResultId, currentInput, currentOutput, success, verified, error, discrepancies);
    }

    // Stage 7: RESPOND
    const _responseFragment = this.stageRespond(success, verified, currentOutput, error, discrepancies);

    const result: PipelineResult = {
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
  private async stagePersist(
    context: PipelineContext,
    actionResultId: string,
    input: unknown,
    output: unknown | undefined,
    success: boolean,
    verified: boolean,
    error: string | undefined,
    discrepancies: string[],
  ): Promise<void> {
    if (!this.db) return;

    const insert = this.db.raw.prepare(
      `INSERT INTO action_result
         (id, cycle_id, tool_id, input_json, output_json, verified, error, persisted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    insert.run(
      actionResultId,
      context.cycleId,
      context.toolId,
      JSON.stringify(input),
      output ? JSON.stringify(output) : null,
      verified ? 1 : 0,
      error ?? null,
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
    // "returned something we could not verify".
    if (this.eventBus) {
      await this.eventBus.publish({
        type: success && verified ? 'action.executed' : 'action.failed',
        payload: {
          toolId: context.toolId,
          success,
          verified,
          error,
          discrepancies,
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

  // ── Stage 7: RESPOND ──
  private stageRespond(
    success: boolean,
    verified: boolean,
    output: unknown | undefined,
    error: string | undefined,
    discrepancies: string[],
  ): string {
    if (!success) {
      return `Action failed: ${error ?? 'unknown error'}`;
    }
    if (!verified && discrepancies.length > 0) {
      return `Action completed but verification found discrepancies: ${discrepancies.join('; ')}`;
    }
    if (!verified) {
      return 'Action completed (unverified — no postcondition verifier)';
    }
    return `Action completed and verified${output ? `: ${JSON.stringify(output)}` : ''}`;
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