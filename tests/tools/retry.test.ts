/**
 * `retryOnDeadline` — a declared retry that was never taken.
 *
 * `DEFAULT_RETRY_POLICY` says `maxAttempts: 3`. Two tools take it un-overridden —
 * `memory.recall` and `reminder.list` — and both got exactly one attempt, because the
 * retry decision was a substring match against the thrown error's *message*:
 *
 *     retryableErrors.some((pattern) => error.message.includes(pattern))
 *
 * and the deadline message reads `Tool 'x' exceeded its 5000ms deadline`, which
 * contains none of `timeout`, `network`, `ECONNREFUSED`, `ETIMEDOUT`, `temporary`.
 * Every one of those five describes an error a *handler* raises. Both tools are
 * SQLite-backed reads whose handlers do not raise any of them, so the only failure
 * they can realistically have was the one failure never retried, and `maxAttempts: 3`
 * was a number with no effect.
 *
 * Adding `'deadline'` to the list would have been the wrong fix, and the reason is the
 * last test here: `withDeadline` rejects without cancelling, so the abandoned handler
 * keeps running and a retry is a *second concurrent execution*. Whether that is
 * acceptable is a question about the tool — free for an idempotent read, a duplicated
 * side effect for anything that writes — and no amount of error classification can
 * answer it. So the tool answers it, and the answer it gets by not thinking about it
 * is `false`.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { z } from 'zod';

import {
  ToolRegistry,
  DeadlineExceededError,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type ToolExecutionContext,
} from '@server/actions/registry.js';
import { ulid } from '@server/persistence/ids.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp } from '@server/app.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

const owner: Identity = {
  id: ulid(),
  kind: 'owner',
  displayName: 'Ankit',
  permissions: DEFAULT_PERMISSIONS.owner,
  enrolledAt: Date.now(),
  lastSeenAt: Date.now(),
  status: 'active',
};

const contextFor = (): ToolExecutionContext => {
  const cycleId = ulid();
  return { identityId: owner.id, cycleId, causationId: cycleId, caller: owner };
};

/** Fast backoff: these tests are about how many attempts happen, not how long they wait. */
const fast = (over: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...DEFAULT_RETRY_POLICY,
  baseDelayMs: 1,
  maxDelayMs: 4,
  ...over,
});

/**
 * A tool that never finishes inside its deadline, counting how many times its handler
 * is entered and the most that were ever in flight at once.
 */
const stalling = (id: string, retryPolicy: RetryPolicy) => {
  const seen = { attempts: 0, peakConcurrent: 0, inFlight: 0 };
  const registry = new ToolRegistry();
  registry.register({
    id,
    name: id,
    description: 'Never finishes inside its deadline.',
    inputSchema: z.object({}).strict(),
    clearanceRequired: 'safe',
    retryPolicy,
    timeoutMs: 15,
    execute: () => {
      seen.attempts += 1;
      seen.inFlight += 1;
      seen.peakConcurrent = Math.max(seen.peakConcurrent, seen.inFlight);
      return new Promise<{ ok: true }>((res) =>
        setTimeout(() => {
          seen.inFlight -= 1;
          res({ ok: true });
        }, 80),
      );
    },
  });
  return { registry, seen };
};

describe('retryOnDeadline — the declared attempts are the attempts taken', () => {
  it('takes every declared attempt when the tool says a deadline is safe to retry', async () => {
    const { registry, seen } = stalling('test.slow_read', fast({ retryOnDeadline: true }));

    await expect(registry.execute('test.slow_read', {}, contextFor())).rejects.toThrow(
      DeadlineExceededError,
    );
    // Three, because the policy says three. This was 1 before `retryOnDeadline` existed.
    expect(seen.attempts).toBe(3);
  });

  it('takes exactly one when the tool has not said a deadline is safe to retry', async () => {
    const { registry, seen } = stalling('test.slow_write', fast({ retryOnDeadline: false }));

    await expect(registry.execute('test.slow_write', {}, contextFor())).rejects.toThrow(
      DeadlineExceededError,
    );
    // Same `maxAttempts: 3`, opposite outcome — and this is the conservative default.
    expect(seen.attempts).toBe(1);
  });

  it('defaults to not retrying a deadline', () => {
    // The whole point of the field being required rather than optional: a tool author
    // who spreads the default gets the answer that cannot duplicate a side effect.
    expect(DEFAULT_RETRY_POLICY.retryOnDeadline).toBe(false);
  });

  it('raises a typed deadline error, so nothing has to read the message', async () => {
    const { registry } = stalling('test.typed', fast({ maxAttempts: 1 }));

    const error = await registry
      .execute('test.typed', {}, contextFor())
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect(error).toMatchObject({ toolId: 'test.typed', timeoutMs: 15 });
    // The message is still for humans. Nothing branches on it — that is the fix.
    expect((error as Error).message).toMatch(/exceeded its 15ms deadline/);
  });

  it('still classifies a handler-thrown error by its message', async () => {
    // `retryableErrors` was not wrong, it was only asked the wrong question. Errors a
    // handler raises are still matched by substring, because for a third-party client
    // the message is usually the only classification on offer.
    let attempts = 0;
    const registry = new ToolRegistry();
    registry.register({
      id: 'test.flaky',
      name: 'Flaky',
      description: 'Fails twice with a retryable message, then succeeds.',
      inputSchema: z.object({}).strict(),
      clearanceRequired: 'safe',
      retryPolicy: fast({ retryableErrors: ['ECONNREFUSED'], retryOnDeadline: false }),
      timeoutMs: 1000,
      execute: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443'));
        return Promise.resolve({ ok: true });
      },
    });

    await expect(registry.execute('test.flaky', {}, contextFor())).resolves.toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it('does not retry a handler error whose message matches nothing', async () => {
    let attempts = 0;
    const registry = new ToolRegistry();
    registry.register({
      id: 'test.broken',
      name: 'Broken',
      description: 'Fails in a way no pattern describes.',
      inputSchema: z.object({}).strict(),
      clearanceRequired: 'safe',
      retryPolicy: fast({ retryOnDeadline: true }),
      timeoutMs: 1000,
      execute: () => {
        attempts += 1;
        return Promise.reject(new Error('the row was already there'));
      },
    });

    await expect(registry.execute('test.broken', {}, contextFor())).rejects.toThrow(
      /already there/,
    );
    // `retryOnDeadline: true` is not a licence to retry everything.
    expect(attempts).toBe(1);
  });

  it('refuses to register a tool that may not be attempted once', () => {
    // The retry loop is unbounded and its bound lives in the catch, so a tool
    // declaring zero attempts would hang rather than fail. It is refused here instead
    // — and a tool that cannot be attempted at all is a mistake regardless.
    const registry = new ToolRegistry();
    const def = {
      id: 'test.never',
      name: 'Never',
      description: 'Declares no attempts.',
      inputSchema: z.object({}).strict(),
      clearanceRequired: 'safe' as const,
      retryPolicy: fast({ maxAttempts: 0 }),
      timeoutMs: 1000,
      execute: () => Promise.resolve({}),
    };
    expect(() => registry.register(def)).toThrow(/must be at least 1/);
  });
});

describe('why the default is false', () => {
  it('runs the handler concurrently with the abandoned one when a deadline is retried', async () => {
    // `withDeadline` gives up waiting; it cannot cancel. So the first handler is still
    // running when the second starts, which is exactly why retryability is a property
    // of the tool and not of the error. For an idempotent read the overlap is free.
    // For a write it is the row inserted twice.
    const { registry, seen } = stalling('test.overlap', fast({ retryOnDeadline: true }));

    await expect(registry.execute('test.overlap', {}, contextFor())).rejects.toThrow(
      DeadlineExceededError,
    );

    expect(seen.attempts).toBe(3);
    expect(seen.peakConcurrent).toBeGreaterThan(1);
  });
});

describe('which production tools opt in', () => {
  it('is exactly the two idempotent reads', async () => {
    const db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    const app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    try {
      const optedIn = app.registry
        .list()
        .filter((t) => t.retryPolicy.retryOnDeadline)
        .map((t) => t.id)
        .sort();

      // The assertion that locks the *policy* rather than the mechanism. A new tool
      // that writes and opts in has to change this line, which is the moment to ask
      // whether running it twice against an abandoned first run is really safe.
      expect(optedIn).toEqual(['memory.recall', 'reminder.list']);

      // And every tool that does not opt in gets one attempt at a deadline, whatever
      // `maxAttempts` it declares — so no tool is quietly claiming three.
      for (const tool of app.registry.list()) {
        if (tool.retryPolicy.retryOnDeadline) continue;
        expect(tool.retryPolicy.maxAttempts).toBe(1);
      }
    } finally {
      await app.stop();
      db.close();
      closeDatabase();
    }
  });
});
