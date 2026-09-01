/**
 * Stage 7: ACT
 *
 * The Application executes the authorized decision. The LLM has no role here
 * (Build Book Part VII.1 stage 7, Part XI.1 stage 4): the LLM proposed the
 * decision in stage 6, the application authorized it there, and the application
 * — not the model — is what actually calls a tool.
 *
 * Invariants enforced here:
 *  - An unauthorized decision never reaches an executor.
 *  - Authorization is re-checked at the execution boundary (defence in depth:
 *    a decision object that was mutated between stages still cannot execute).
 *  - Execution is *bounded*: every call runs under a deadline.
 *  - Nothing leaves this stage marked `verified`. Only stage 8, having re-read
 *    authoritative state, may set that flag (Part XI.3 — a textual "done" is
 *    never proof).
 *
 * P09 rollback contract: with no executor wired, the action is disabled and a
 * refusal result is recorded; the cycle continues to a text-only response.
 */

import { check } from '@server/authz/index.js';
import type { Identity } from '@server/identity/types.js';
import type { ActionResult, AuthorizedDecision } from '../types.js';

export interface ToolExecutionContext {
  identityId: string;
  cycleId: string;
  causationId: string;
}

/**
 * The application-side seam to real tool infrastructure. P11/P12 supply the
 * ActionPipeline and ToolRegistry behind this interface; stage 7 only ever
 * speaks to it through the application.
 */
export interface ToolExecutor {
  execute(call: {
    toolId: string;
    input: unknown;
    context: ToolExecutionContext;
  }): Promise<unknown>;
}

export interface ActOptions {
  executor?: ToolExecutor | undefined;
  identity?: Identity | undefined;
  cycleId?: string | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function act(
  decision: AuthorizedDecision,
  opts: ActOptions = {},
): Promise<ActionResult[]> {
  const { proposal } = decision;

  // Only a tool decision acts. respond/clarify/noop/learn/schedule_task are
  // carried out by later stages, so stage 7 is a no-op for them.
  if (proposal.action !== 'execute_tool') return [];

  const toolId = proposal.toolId;

  if (!decision.authorized) {
    return [refusal(toolId ?? 'unknown', decision.reason ?? 'Decision was not authorized')];
  }
  if (!toolId) {
    return [refusal('unknown', 'execute_tool decision carried no toolId')];
  }
  if (!opts.identity) {
    return [refusal(toolId, 'No authenticated identity at the execution boundary')];
  }

  // Defence in depth. Stage 6 authorized this proposal; the boundary that
  // actually performs the side effect authorizes it again.
  const authz = check(opts.identity, 'tool:execute', {
    type: 'tool',
    toolId,
    clearanceRequired: 'safe',
  });
  if (!authz.allowed) {
    return [refusal(toolId, authz.reason ?? 'Denied by authorization policy')];
  }

  if (!opts.executor) {
    return [refusal(toolId, 'No tool executor is wired; action is disabled')];
  }

  const cycleId = opts.cycleId ?? 'unknown';
  const context: ToolExecutionContext = {
    identityId: opts.identity.id,
    cycleId,
    causationId: cycleId,
  };

  try {
    const output = await withDeadline(
      opts.executor.execute({ toolId, input: proposal.toolInput, context }),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      toolId,
    );
    // success == "the call returned", not "the world changed". Stage 8 decides
    // the latter.
    return [{ toolId, success: true, output, verified: false }];
  } catch (e) {
    return [{ toolId, success: false, error: errorMessage(e), verified: false }];
  }
}

function refusal(toolId: string, reason: string): ActionResult {
  return { toolId, success: false, error: reason, verified: false };
}

async function withDeadline<T>(work: Promise<T>, timeoutMs: number, toolId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Tool '${toolId}' exceeded its ${timeoutMs}ms deadline`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
