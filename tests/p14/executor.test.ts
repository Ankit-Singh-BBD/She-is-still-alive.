import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ActionPipeline, ToolRegistry, DEFAULT_RETRY_POLICY } from '@server/actions/index.js';
import { EventBus } from '@server/events/event-bus.js';
import { TaskExecutor } from '@server/tasks/executor.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';

describe('TaskExecutor (P14)', () => {
  let db: Database;
  let eventBus: EventBus;
  let registry: ToolRegistry;
  let pipeline: ActionPipeline;
  let executor: TaskExecutor;

  const owner: Identity = {
    id: 'usr_owner0000000000000000001',
    kind: 'owner',
    displayName: 'Owner',
    status: 'active',
    enrolledAt: 0,
    lastSeenAt: 0,
    permissions: DEFAULT_PERMISSIONS.owner,
  };

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));

    // Insert test identities
    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', 'Owner', 'active', 0, 0)`).run(owner.id);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(owner.id, JSON.stringify(DEFAULT_PERMISSIONS.owner));

    eventBus = new EventBus(db);
    registry = new ToolRegistry();
    pipeline = new ActionPipeline({ registry, db, eventBus });
    executor = new TaskExecutor(db, eventBus, { registry, pipeline, pollIntervalMs: 50 });
  });

  afterEach(() => {
    executor.stop();
    db.close();
  });

  it('schedules and executes a one-shot reminder at the right time', async () => {
    let reminderDelivered = false;
    let deliveredMessage = '';

    executor.setHandlers({
      onReminder: (_identityId, message) => {
        reminderDelivered = true;
        deliveredMessage = message;
        return true;
      },
    });

    const now = Date.now();
    const taskId = executor.scheduleTask({
      identityId: owner.id,
      kind: 'reminder',
      payload: { kind: 'reminder', message: 'Take medication' },
      dueAt: now + 50, // due in 50ms
    });

    const taskBefore = executor.getTask(taskId);
    expect(taskBefore?.status).toBe('pending');

    // Tick before due — should NOT execute
    await executor.tick(now);
    expect(reminderDelivered).toBe(false);

    // Tick after due — should execute
    await executor.tick(now + 60);
    expect(reminderDelivered).toBe(true);
    expect(deliveredMessage).toBe('Take medication');

    const taskAfter = executor.getTask(taskId);
    expect(taskAfter?.status).toBe('completed');
    expect(taskAfter?.completedAt).not.toBeNull();
  });

  it('retries a failing tool execution with backoff up to maxAttempts', async () => {
    let attempts = 0;
    registry.register({
      id: 'tool:flaky',
      name: 'Flaky Tool',
      description: 'Fails twice, succeeds on third attempt',
      inputSchema: z.object({}),
      clearanceRequired: 'safe',
      retryPolicy: DEFAULT_RETRY_POLICY,
      timeoutMs: 1000,
      execute: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('transient failure');
        }
        return { success: true };
      },
    });

    const now = Date.now();
    const taskId = executor.scheduleTask({
      identityId: owner.id,
      kind: 'one_shot',
      payload: { kind: 'one_shot', toolId: 'tool:flaky', input: {}, runAt: now },
      maxAttempts: 3,
      dueAt: now,
    });

    // 1st attempt: fails, rescheduled
    await executor.tick(now);
    let task = executor.getTask(taskId);
    expect(task?.status).toBe('pending');
    expect(task?.attempt).toBe(1);
    expect(task?.lastError).toContain('transient failure');

    // 2nd attempt: advance time past retry backoff, fails again
    await executor.tick(now + 2000);
    task = executor.getTask(taskId);
    expect(task?.status).toBe('pending');
    expect(task?.attempt).toBe(2);

    // 3rd attempt: advance time, succeeds
    await executor.tick(now + 6000);
    task = executor.getTask(taskId);
    expect(task?.status).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('marks task as failed when maxAttempts is exceeded', async () => {
    registry.register({
      id: 'tool:always_fail',
      name: 'Failing Tool',
      description: 'Always fails',
      inputSchema: z.object({}),
      clearanceRequired: 'safe',
      retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 50, retryableErrors: [] },
      timeoutMs: 1000,
      execute: async () => {
        throw new Error('permanent error');
      },
    });

    const now = Date.now();
    const taskId = executor.scheduleTask({
      identityId: owner.id,
      kind: 'one_shot',
      payload: { kind: 'one_shot', toolId: 'tool:always_fail', input: {}, runAt: now },
      maxAttempts: 1, // Only 1 attempt allowed
      dueAt: now,
    });

    await executor.tick(now);
    const task = executor.getTask(taskId);
    expect(task?.status).toBe('failed');
    expect(task?.lastError).toContain('permanent error');
  });

  it('cancels pending and running tasks', async () => {
    const taskId = executor.scheduleTask({
      identityId: owner.id,
      kind: 'reminder',
      payload: { kind: 'reminder', message: 'Never fire' },
      dueAt: Date.now() + 10_000,
    });

    const cancelled = executor.cancelTask(taskId);
    expect(cancelled).toBe(true);

    const task = executor.getTask(taskId);
    expect(task?.status).toBe('cancelled');

    // Attempting to cancel an already cancelled task returns false
    expect(executor.cancelTask(taskId)).toBe(false);
  });
});
