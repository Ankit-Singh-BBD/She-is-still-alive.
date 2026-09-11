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
  let conditions: Map<string, () => Promise<boolean> | boolean>;

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
    conditions = new Map();
    loopManager = new LoopManager(db, eventBus, executor, { pollIntervalMs: 50, conditionRegistry: conditions });
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
    let evals = await loopManager.evaluateAll(now);
    expect(evals[0]?.taskCreated).toBe(false);

    evals = await loopManager.evaluateAll(now + 3600_050);
    expect(evals[0]?.taskCreated).toBe(true);
    expect(evals[0]?.taskId).not.toBeNull();

    const pending = executor.getPendingTasks(owner.id);
    expect(pending.length).toBe(1);
    expect((pending[0]?.payload as { message: string }).message).toBe('Check the rain forecast');

    evals = await loopManager.evaluateAll(now + 3600_050);
    expect(evals[0]?.taskCreated).toBe(false);
    expect(executor.getPendingTasks(owner.id).length).toBe(1);
  });

  it('evaluates a condition trigger and creates task when true', async () => {
    let conditionState = false;
    conditions.set('battery-low', () => conditionState);

    loopManager.openLoop({
      identityId: owner.id,
      topic: 'Battery monitor',
      triggerSpec: { type: 'condition', conditionId: 'battery-low' },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'Battery low!' },
      },
    });

    let evals = await loopManager.evaluateAll();
    expect(evals[0]?.taskCreated).toBe(false);

    conditionState = true;
    evals = await loopManager.evaluateAll();
    expect(evals[0]?.taskCreated).toBe(true);
    expect(executor.getPendingTasks().length).toBe(1);
  });

  it('does not produce tasks for closed or paused loops', async () => {
    conditions.set('always-true', () => true);
    const loopId = loopManager.openLoop({
      identityId: owner.id,
      topic: 'Closed loop test',
      triggerSpec: { type: 'condition', conditionId: 'always-true' },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'Should not run' },
      },
    });

    loopManager.pauseLoop(loopId);
    let evals = await loopManager.evaluateAll();
    expect(evals.length).toBe(0);
    expect(executor.getPendingTasks().length).toBe(0);

    loopManager.closeLoop(loopId);
    evals = await loopManager.evaluateAll();
    expect(evals.length).toBe(0);
    expect(executor.getPendingTasks().length).toBe(0);
  });

  it('survives restart: start() rebuilds triggers from durable rows without re-opening', async () => {
    const loopId = loopManager.openLoop({
      identityId: owner.id,
      topic: 'survives restart',
      triggerSpec: { type: 'schedule', intervalMs: 60_000 },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'rebuilt' },
      },
    });

    // Simulate process restart: a new manager over the same DB re-attaches.
    const conditions2 = new Map<string, () => Promise<boolean> | boolean>();
    const rebooted = new LoopManager(db, eventBus, executor, { pollIntervalMs: 50, conditionRegistry: conditions2 });
    rebooted.start();
    expect(rebooted.getLoop(loopId)?.status).toBe('active');
    // A rebuilt schedule loop must not fire immediately before its interval.
    const evals = await rebooted.evaluateAll(Date.now());
    expect(evals[0]?.taskCreated).toBe(false);
    rebooted.stop();
  });

  it('reports a failed event publish instead of taking the process down', async () => {
    const failures: string[] = [];
    const brokenBus = new EventBus(db);
    brokenBus.publish = async () => {
      throw new Error('domain_event is locked');
    };
    const isolated = new LoopManager(db, brokenBus, executor, {
      report: (what) => failures.push(what),
    });

    const openedId = isolated.openLoop({
      identityId: owner.id,
      topic: 'still opens',
      triggerSpec: { type: 'schedule', intervalMs: 60_000 },
      actionSpec: {
        kind: 'task',
        taskKind: 'reminder',
        payload: { kind: 'reminder', message: 'x' },
      },
    });

    expect(isolated.getLoop(openedId)?.status).toBe('active');

    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toEqual(['publishing loop.opened']);
  });
});
