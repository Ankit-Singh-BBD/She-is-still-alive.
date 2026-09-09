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
 *  - A refusal is never recorded as an attempt. Every `ActionResult` leaving here
 *    carries `attempted`, and it is `false` for all five refusals below and for a
 *    `NotAttemptedError` raised by the executor. Stage 9 speaks from that field, so
 *    getting it wrong is her claiming to have started something she never touched.
 *
 * P09 rollback contract: with no executor wired, the action is disabled and a
 * refusal result is recorded; the cycle continues to a text-only response.
 */

import { check } from '@server/authz/index.js';
import type { AuthzCaller } from '@server/authz/types.js';
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

/**
 * The seam's one way to say *nothing was dispatched*.
 *
 * `ToolExecutor.execute` returns `Promise<unknown>`, so a failure can only arrive
 * here as a rejection — and a rejection is otherwise indistinguishable from a tool
 * that ran and threw. That gap is what made her say "I started on that, but I could
 * not confirm it actually went through" about calls that were refused before
 * anything was dispatched: a revoked identity, a caller with no `mayAccessTools`
 * entry, an input its schema rejected. All three were recorded `attempted: true`,
 * which is the more alarming of the two sentences and the false one.
 *
 * An implementation raises this when it knows the tool was never handed the call.
 * Anything else it throws means the call went out, which is the conservative
 * default: an executor that forgets to use this over-reports "go and look" rather
 * than under-reporting it, and the honest failure is the one that sends someone to
 * check.
 */
export class NotAttemptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAttemptedError';
  }
}

export interface ActOptions {
  executor?: ToolExecutor | undefined;
  /**
   * Who is asking, as of this cycle. The three fields `check()` reads, composed by
   * `effectiveCaller` — see its note. `.id` is also what the refusal record names.
   */
  identity?: AuthzCaller | undefined;
  cycleId?: string | undefined;
  timeoutMs?: number | undefined;
  /**
   * What clearance a tool declares. Stage 7 has no registry — it speaks only to
   * the `ToolExecutor` seam — so without this it has to assume something, and the
   * assumption used to be hardcoded `'safe'`: the *weaker* of the two
   * requirements. A tool declared `'all'` therefore passed the check here and was
   * refused later inside the pipeline, which means the boundary that exists to
   * catch a decision tampered with between stages was checking a requirement the
   * tool does not have.
   *
   * Absent, or returning `undefined` for a tool it does not know, it falls back
   * to `'safe'` — still the weaker assumption, but now the pipeline is the only
   * place that can be lenient by accident rather than both.
   */
  clearanceFor?: ((toolId: string) => 'safe' | 'all' | undefined) | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function act(
  decision: AuthorizedDecision,
  opts: ActOptions = {},
): Promise<ActionResult[]> {
  const { proposal } = decision;

  // Only a tool decision acts. respond/clarify/noop/learn are carried out by later
  // stages, so stage 7 is a no-op for them.
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
  // actually performs the side effect authorizes it again — against the
  // clearance the tool really declares, not against an assumed one.
  const authz = check(opts.identity, 'tool:execute', {
    type: 'tool',
    toolId,
    clearanceRequired: opts.clearanceFor?.(toolId) ?? 'safe',
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
    return [{ toolId, attempted: true, success: true, output, verified: false }];
  } catch (e) {
    // Two different failures arrive here, and only one of them touched the world.
    //
    // `NotAttemptedError` is the executor saying it refused before dispatch — see
    // its note; it is the only way a `Promise<unknown>` seam can carry that. It
    // belongs with the refusals above, and for the same reason: nothing was called,
    // so nothing can have changed.
    if (e instanceof NotAttemptedError) return [refusal(toolId, e.message)];
    // Anything else is a call that went out. `attempted` is true here and that is
    // the point of the field: the executor was called and threw, or ran past its
    // deadline, so the tool may well have done half of what it was asked before
    // failing. Stage 9 has to be able to say that rather than the flat "nothing
    // happened" it says for a refusal.
    return [{ toolId, attempted: true, success: false, error: errorMessage(e), verified: false }];
  }
}

/** Refused before dispatch: nothing was called, so nothing can have changed. */
function refusal(toolId: string, reason: string): ActionResult {
  return { toolId, attempted: false, success: false, error: reason, verified: false };
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
