/**
 * ToolRegistry — the single source of truth for what tools exist and how they run.
 *
 * A registered tool carries its own input schema, the clearance a caller needs, a
 * deadline, and a retry policy. `execute` is the only way a tool's handler is called.
 *
 * ## The two ways a call fails, again
 *
 * `withDeadline` below gives up waiting on a handler; the handler does not stop. So a
 * deadline expiry is not "the tool failed" — it is "we stopped watching, and the work
 * may still land". That is the same distinction `attempted` draws one layer up, and it
 * has the same consequence if it is lost: retrying is safe for a read and duplicates a
 * side effect for a write.
 *
 * It used to be lost. The retry decision was a substring match of the thrown error's
 * *message* against `retryableErrors`, and the deadline message reads `Tool 'x'
 * exceeded its 5000ms deadline` — which contains none of `timeout`, `network`,
 * `ECONNREFUSED`, `ETIMEDOUT`, `temporary`. So the only failure a SQLite-backed tool
 * can realistically have was the one failure never retried, and `memory.recall` and
 * `reminder.list` declared `maxAttempts: 3` while getting exactly one. Prose is not a
 * control-flow channel: reword the message and the retry behaviour changes silently.
 * `DeadlineExceededError` carries it by type instead.
 */

import type { z } from 'zod';
import type { Identity } from '@server/identity/types.js';
import { check } from '@server/authz/index.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Substrings matched against a *handler-thrown* error's message.
   *
   * Deliberately not consulted for a deadline — see `retryOnDeadline`. These are for
   * errors a tool's own handler raises, where the message is the only classification
   * a third-party client tends to offer.
   */
  retryableErrors: string[];
  /**
   * Whether running this tool a second time is safe when the first run blew its
   * deadline and is *still going*.
   *
   * This is a question about the tool, not about the error: `withDeadline` cannot
   * cancel a handler, so a retry after a deadline is a second concurrent execution.
   * For an idempotent read that is free. For anything that writes it is a duplicate
   * side effect — the row inserted twice, the reminder scheduled twice — and no
   * amount of retrying makes the record of it more honest.
   *
   * Required rather than optional so a tool author has to answer it, and `false` in
   * `DEFAULT_RETRY_POLICY` so the answer a tool gets by not thinking about it is the
   * one that cannot duplicate anything.
   */
  retryOnDeadline: boolean;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  name: string;
  description: string;
  inputSchema: z.ZodSchema<TInput>;
  outputSchema?: z.ZodSchema<TOutput> | undefined;
  clearanceRequired: 'safe' | 'all';
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput>;
}

export interface ToolExecutionContext {
  identityId: string;
  cycleId: string;
  causationId: string;
  caller: Identity;
}

/**
 * The deadline fired and the handler was abandoned mid-flight.
 *
 * Typed because two decisions need to tell this apart from a handler that threw, and
 * both were reading prose to do it: whether to retry (`retryOnDeadline`), and what the
 * durable record should say happened. The message is still human-readable, but nothing
 * branches on it.
 *
 * What it does *not* mean is that nothing happened. The handler is still running and
 * may still complete its write, so a `false` recorded against this call can be
 * contradicted by the world a moment later. Cancelling properly needs an
 * `AbortSignal` on `ToolExecutionContext` and a handler that honours it; no tool here
 * does I/O that could, so the signal would be surface with no implementation behind
 * it. This is the note that says so, for whoever adds the first tool that can.
 */
export class DeadlineExceededError extends Error {
  readonly toolId: string;
  readonly timeoutMs: number;

  constructor(toolId: string, timeoutMs: number) {
    super(`Tool '${toolId}' exceeded its ${timeoutMs}ms deadline`);
    this.name = 'DeadlineExceededError';
    this.toolId = toolId;
    this.timeoutMs = timeoutMs;
  }
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(def: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(def.id)) {
      throw new Error(`Tool '${def.id}' is already registered`);
    }
    // A tool that may not be attempted once cannot run at all, so it is refused here
    // rather than left to fail confusingly at its first call. It also keeps the retry
    // loop below provably terminating without a trailing unreachable throw.
    if (!Number.isInteger(def.retryPolicy.maxAttempts) || def.retryPolicy.maxAttempts < 1) {
      throw new Error(
        `Tool '${def.id}' declares maxAttempts=${def.retryPolicy.maxAttempts}; it must be at least 1`,
      );
    }
    this.tools.set(def.id, def as ToolDefinition);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Checks authorization for the tool against the caller's permissions.
   * Returns the authz decision; throws if denied.
   */
  authorize(caller: Identity, toolId: string, clearanceRequired: 'safe' | 'all'): void {
    const authz = check(caller, 'tool:execute', {
      type: 'tool',
      toolId,
      clearanceRequired,
    });
    if (!authz.allowed) {
      throw new Error(authz.reason ?? `Denied by authorization policy`);
    }
  }

  /**
   * Executes a tool under its own deadline and retry policy, and returns its output.
   *
   * The loop is unbounded and the bound lives in the catch, which is what lets the
   * last failure throw from the one place that decides not to retry. Written the other
   * way — a counted loop with a `throw lastError` after it — the trailing throw is
   * unreachable, the compiler cannot know that, and `lastError` has to be a mutable
   * outer variable read through a non-null assertion. `register` guarantees
   * `maxAttempts >= 1`, so the first pass always runs and the catch always terminates.
   */
  async execute<TInput, TOutput>(
    toolId: string,
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<TOutput> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool '${toolId}' not found in registry`);
    }

    const validated = tool.inputSchema.parse(input);
    this.authorize(context.caller, toolId, tool.clearanceRequired);

    const policy = tool.retryPolicy;

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await withDeadline(
          tool.execute(validated, context),
          tool.timeoutMs,
          toolId,
        );
        return tool.outputSchema ? (tool.outputSchema.parse(result) as TOutput) : (result as TOutput);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        if (attempt >= policy.maxAttempts || !isRetryable(error, policy)) throw error;
        const delay = Math.min(
          policy.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
          policy.maxDelayMs,
        );
        await sleep(delay);
      }
    }
  }
}

/**
 * Whether this failure may be tried again.
 *
 * Two questions, not one. A deadline is answered by the tool's own idempotency, a
 * handler error by what its message says — and conflating them is what made a
 * deadline unretryable everywhere, because `retryableErrors` describes errors a
 * handler raises and a deadline is not one of those.
 */
function isRetryable(error: Error, policy: RetryPolicy): boolean {
  if (error instanceof DeadlineExceededError) return policy.retryOnDeadline;
  return policy.retryableErrors.some((pattern) => error.message.includes(pattern));
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, toolId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(toolId, timeoutMs)), timeoutMs);
    work.then(
      (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The policy a tool gets by spreading rather than deciding.
 *
 * Conservative in the one direction that matters: `retryOnDeadline: false`, so a tool
 * that writes and forgets to think about idempotency cannot be run twice against an
 * abandoned first run. The two read tools that want three real attempts opt in at
 * their own definition, where a reader can see the claim next to the handler that
 * justifies it.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  retryableErrors: ['network', 'ECONNREFUSED', 'ETIMEDOUT', 'temporary'],
  retryOnDeadline: false,
};