import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { resolve } from 'node:path';
import { ActionPipeline, ToolRegistry } from '@server/actions/index.js';
import { EventBus } from '@server/events/event-bus.js';
import { TaskExecutor } from '@server/tasks/executor.js';
import { LoopManager } from '@server/loops/manager.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';

describe('LoopManager (P15)', () => {
  let db: Database;
  let eventBus: EventBus;
  let registry: ToolRegistry;
  let pipeline: ActionPipeline;
  let executor: TaskExecutor;
  let loopManager: LoopManager;

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

    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', 'Owner', 'active', 0, 0)`).run(owner.id);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(owner.id, JSON.stringify(DEFAULT_PERMISSIONS.owner));

    eventBus = new EventBus(db);
    registry = new ToolRegistry();
    pipeline = new ActionPipeline({ registry, db, eventBus });
    executor = new TaskExecutor(db, eventBus, { registry, pipeline });
    loopManager = new LoopManager(db, eventBus, executor, { pollIntervalMs: 50 });
  });

  afterEach(() => {
    loopManager.stop();
    executor.stop();
    db.close();
  });

  it('evaluates a satisfied schedule trigger and creates a task with deduplication', async () => {
    loopManager.openLoop({
      identityId: owner.id,
      topic: 'Daily weather reminder',
      triggerSpec: { type: 'schedule', intervalMs: 3600_000 },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'Check the rain forecast' },
      },
    });

    const now = Date.now();
    // 1st eval before schedule interval: no task
    let evals = await loopManager.evaluateAll(now);
    expect(evals[0]?.taskCreated).toBe(false);

    // 2nd eval after interval: creates exactly 1 task
    evals = await loopManager.evaluateAll(now + 3600_050);
    expect(evals[0]?.taskCreated).toBe(true);
    expect(evals[0]?.taskId).not.toBeNull();

    const pending = executor.getPendingTasks(owner.id);
    expect(pending.length).toBe(1);
    expect((pending[0]?.payload as { message: string }).message).toBe('Check the rain forecast');

    // 3rd immediate eval: dedup prevents duplicate task
    evals = await loopManager.evaluateAll(now + 3600_050);
    expect(evals[0]?.taskCreated).toBe(false);
    expect(executor.getPendingTasks(owner.id).length).toBe(1);
  });

  it('evaluates a condition trigger and creates task when true', async () => {
    let conditionState = false;

    loopManager.openLoop({
      identityId: owner.id,
      topic: 'Battery monitor',
      triggerSpec: {
        type: 'condition',
        check: async () => conditionState,
      },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'Battery low!' },
      },
    });

    // When false: no task
    let evals = await loopManager.evaluateAll();
    expect(evals[0]?.taskCreated).toBe(false);

    // When true: task created
    conditionState = true;
    evals = await loopManager.evaluateAll();
    expect(evals[0]?.taskCreated).toBe(true);
    expect(executor.getPendingTasks().length).toBe(1);
  });

  it('does not produce tasks for closed or paused loops', async () => {
    const loopId = loopManager.openLoop({
      identityId: owner.id,
      topic: 'Closed loop test',
      triggerSpec: { type: 'condition', check: async () => true },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'Should not run' },
      },
    });

    // Pause loop
    loopManager.pauseLoop(loopId);
    let evals = await loopManager.evaluateAll();
    expect(evals.length).toBe(0); // paused loop not in active loops
    expect(executor.getPendingTasks().length).toBe(0);

    // Close loop
    loopManager.closeLoop(loopId);
    evals = await loopManager.evaluateAll();
    expect(evals.length).toBe(0);
    expect(executor.getPendingTasks().length).toBe(0);
  });
});
