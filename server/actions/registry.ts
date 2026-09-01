/**
 * ToolRegistry (P12) — single source of truth for tool definitions.
 *
 * Each tool carries a Zod schema for input validation, a retry policy, timeout,
 * and an execution deadline. The registry validates, authorizes, and executes
 * tool calls through the ActionPipeline (P11).
 */

import type { z } from 'zod';
import type { Identity } from '@server/identity/types.js';
import { check } from '@server/authz/index.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors: string[]; // Error codes/messages that trigger retry
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

export interface RegistryOptions {
  identity: Identity;
  cycleId: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(def: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(def.id)) {
      throw new Error(`Tool '${def.id}' is already registered`);
    }
    this.tools.set(def.id, def as ToolDefinition);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  /**
   * Validates input against the tool's Zod schema.
   * Throws ZodError if invalid.
   */
  validateInput<T>(toolId: string, input: unknown): T {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool '${toolId}' not found in registry`);
    }
    return tool.inputSchema.parse(input) as T;
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
   * Executes a tool with retry, timeout, and deadline enforcement.
   * Returns the tool's output on success.
   */
  async execute<TInput, TOutput>(
    toolId: string,
    input: TInput,
    context: ToolExecutionContext
  ): Promise<TOutput> {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool '${toolId}' not found in registry`);
    }

    // Validate input
    const validated = tool.inputSchema.parse(input);

    // Authorization check
    this.authorize(context.caller, toolId, tool.clearanceRequired);

    // Execute with retry + timeout
    let lastError: Error | undefined;
    const { maxAttempts, baseDelayMs, maxDelayMs, retryableErrors } = tool.retryPolicy;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await withDeadline(
          tool.execute(validated, context),
          tool.timeoutMs,
          toolId,
        );

        // Optionally validate output
        if (tool.outputSchema) {
          return tool.outputSchema.parse(result) as TOutput;
        }
        return result as TOutput;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));

        // Check if error is retryable
        const isRetryable = retryableErrors.some(
          (pattern) => lastError!.message.includes(pattern),
        );
        if (!isRetryable || attempt === maxAttempts) {
          throw lastError;
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
          maxDelayMs,
        );
        await sleep(delay);
      }
    }

    throw lastError;
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, toolId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Tool '${toolId}' exceeded its ${timeoutMs}ms deadline`)),
      timeoutMs,
    );
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
 * Default retry policy — conservative for side-effecting tools.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  retryableErrors: ['timeout', 'network', 'ECONNREFUSED', 'ETIMEDOUT', 'temporary'],
};