/**
 * P15 — LoopManager. Declarative triggers only.
 *
 * A `TriggerSpec` is persisted as JSON and rebuilt without executing stored code.
 * The earlier JS-closure form silently broke durability: `JSON.stringify(fn)` is
 * `undefined`, so a trigger's predicate vanished on restart and every rebooted
 * loop fell back to a never-true default.
 *
 * Allowed trigger kinds:
 *  - `schedule`   — fires when `now >= nextRunAt` (intervalMs, no predicate).
 *  - `event`      — fires when a `DomainEventType` is observed and an optional
 *                  declarative `filterPredicate` over `payload` holds.
 *  - `condition`  — fires when a named, registered `conditionId` evaluates true
 *                  (e.g. `goal.initiative`). No inline functions are persisted.
 */

import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { TaskExecutor } from '@server/tasks/executor.js';
import type { DomainEventType } from '@server/events/types.js';

export type LoopStatus = 'active' | 'paused' | 'closed';

export type DeclarativePredicate = {
  field?: string;
  equals?: unknown;
  contains?: string;
};

// Keep `event` + declarative filter or named condition; no JS closures on disk.
export type TriggerSpec =
  | { type: 'schedule'; intervalMs: number }
  | { type: 'event'; eventType: DomainEventType; filterPredicate?: DeclarativePredicate }
  | { type: 'condition'; conditionId: string };

export type TaskKind = 'reminder' | 'recurring' | 'one_shot' | 'background';

export interface TaskSchedule {
  runAt?: number;
  intervalMs?: number;
  maxRuns?: number;
}

export type TaskPayload =
  | { kind: 'reminder'; message: string; channel?: 'text' | 'voice' }
  | { kind: 'recurring'; toolId: string; input: unknown; intervalMs: number; maxRuns?: number }
  | { kind: 'one_shot'; toolId: string; input: unknown; runAt: number }
  | { kind: 'background'; toolId: string; input: unknown };

export interface ActionSpec {
  kind: 'task';
  taskKind: TaskKind;
  payload: TaskPayload;
  schedule?: TaskSchedule;
}

export interface OpenLoopRow {
  id: string;
  identityId: string;
  topic: string;
  triggerSpec: TriggerSpec;
  actionSpec: ActionSpec;
  status: LoopStatus;
  openedAt: number;
  lastEvaluatedAt: number;
  lastProgressAt: number;
  summary: string | null;
  contextJson: string | null;
}

export interface LoopEvaluation {
  loopId: string;
  evaluatedAt: number;
  triggerSatisfied: boolean;
  taskCreated: boolean;
  taskId: string | null;
  reason: string | null;
}

export interface LoopManagerOptions {
  pollIntervalMs?: number;
  triggerCooldownMs?: number;
  /** Named condition evaluators — the only `condition` triggers allowed. */
  conditionRegistry?: Map<string, () => Promise<boolean> | boolean>;
  report?: ((what: string, error: unknown) => void) | undefined;
}

interface TriggerState {
  loopId: string;
  lastSatisfiedAt: number | null;
  lastEvaluatedAt: number | null;
  lastFiredAt: number | null;
  lastEventPayload: unknown | null;
  nextRunAt: number | null;
}

export class LoopManager {
  private readonly db: Database;
  private readonly eventBus: EventBus;
  private readonly taskExecutor: TaskExecutor;
  private readonly pollIntervalMs: number;
  private readonly triggerCooldownMs: number;
  private readonly conditionRegistry: Map<string, () => Promise<boolean> | boolean>;
  private readonly report: (what: string, error: unknown) => void;

  private running = false;
  private stopRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  private triggerStates = new Map<string, TriggerState>();
  private specs = new Map<string, { triggerSpec: TriggerSpec; actionSpec: ActionSpec }>();
  private eventUnsubscribes = new Map<string, () => void>();

  constructor(db: Database, eventBus: EventBus, taskExecutor: TaskExecutor, options: LoopManagerOptions = {}) {
    this.db = db;
    this.eventBus = eventBus;
    this.taskExecutor = taskExecutor;
    this.pollIntervalMs = options.pollIntervalMs ?? 900_000;
    this.triggerCooldownMs = options.triggerCooldownMs ?? 1000;
    this.conditionRegistry = options.conditionRegistry ?? new Map();
    this.report =
      options.report ??
      ((what, error) => {
        console.error(`[loops] ${what}:`, error);
      });
  }

  /** Re-attach trigger state + event subscriptions from durable rows. Survives restart. */
  private rebuildFromDurable(): void {
    this.triggerStates.clear();
    this.specs.clear();
    // Drain stale subscriptions — start() may be called more than once per process.
    for (const unsub of this.eventUnsubscribes.values()) unsub();
    this.eventUnsubscribes.clear();

    const activeLoops = this.getActiveLoops();
    for (const loop of activeLoops) {
      const spec = this.specs.get(loop.id) ?? this.getLoopMetadata(loop.id);
      if (!spec) continue;
      this.specs.set(loop.id, spec);
      const ts = spec.triggerSpec;
      this.triggerStates.set(loop.id, {
        loopId: loop.id,
        lastSatisfiedAt: null,
        lastEvaluatedAt: null,
        lastFiredAt: null,
        lastEventPayload: null,
        nextRunAt: ts.type === 'schedule' ? Date.now() + ts.intervalMs : null,
      });
      if (ts.type === 'event') this.registerEventTrigger(loop.id, ts);
    }
  }

  start(): void {
    if (this.running) return;
    this.rebuildFromDurable();
    this.running = true;
    this.stopRequested = false;
    this.schedulePoll();
  }

  stop(): void {
    this.stopRequested = true;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    for (const unsub of this.eventUnsubscribes.values()) unsub();
    this.eventUnsubscribes.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  registerCondition(id: string, check: () => Promise<boolean> | boolean): void {
    this.conditionRegistry.set(id, check);
  }

  openLoop(input: {
    identityId: string;
    topic: string;
    triggerSpec: TriggerSpec;
    actionSpec: ActionSpec;
    summary?: string;
    context?: Record<string, unknown>;
  }): string {
    this.ensureLoopMetadataTable();
    const id = ulid();
    const now = new Date().toISOString();
    this.db.raw
      .prepare(
        `INSERT INTO open_loop (id, identity_id, topic, status, opened_at, last_progress, summary, context_json)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(id, input.identityId, input.topic, now, now, input.summary ?? null, input.context ? JSON.stringify(input.context) : null);

    // Persist specs as JSON — all fields are data (conditionId / filterPredicate),
    // never functions, so JSON round-trips faithfully.
    this.db.raw
      .prepare(`INSERT INTO loop_metadata (loop_id, trigger_spec_json, action_spec_json) VALUES (?, ?, ?)`)
      .run(id, JSON.stringify(input.triggerSpec), JSON.stringify(input.actionSpec));

    this.triggerStates.set(id, {
      loopId: id,
      lastSatisfiedAt: null,
      lastEvaluatedAt: null,
      lastFiredAt: null,
      lastEventPayload: null,
      nextRunAt: input.triggerSpec.type === 'schedule' ? Date.now() + input.triggerSpec.intervalMs : null,
    });
    this.specs.set(id, { triggerSpec: input.triggerSpec, actionSpec: input.actionSpec });
    if (input.triggerSpec.type === 'event') this.registerEventTrigger(id, input.triggerSpec);
    this.publish('loop.opened', { loopId: id, topic: input.topic, identityId: input.identityId });
    return id;
  }

  private ensureLoopMetadataTable(): void {
    this.db.raw.exec(
      `CREATE TABLE IF NOT EXISTS loop_metadata (
         loop_id TEXT PRIMARY KEY,
         trigger_spec_json TEXT NOT NULL,
         action_spec_json TEXT NOT NULL,
         FOREIGN KEY(loop_id) REFERENCES open_loop(id) ON DELETE CASCADE
       );`,
    );
  }

  closeLoop(loopId: string): boolean {
    const result = this.db.raw
      .prepare(`UPDATE open_loop SET status = 'closed', updated_at = ? WHERE id = ? AND status != 'closed'`)
      .run(new Date().toISOString(), loopId);
    if (result.changes > 0) {
      this.unregisterEventTrigger(loopId);
      this.triggerStates.delete(loopId);
      this.specs.delete(loopId);
      this.publish('loop.closed', { loopId });
      return true;
    }
    return false;
  }

  pauseLoop(loopId: string): boolean {
    const result = this.db.raw
      .prepare(`UPDATE open_loop SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`)
      .run(new Date().toISOString(), loopId);
    if (result.changes > 0) {
      this.unregisterEventTrigger(loopId);
      this.publish('loop.paused', { loopId });
      return true;
    }
    return false;
  }

  resumeLoop(loopId: string): boolean {
    const loop = this.getLoop(loopId);
    if (!loop || loop.status !== 'paused') return false;
    const result = this.db.raw
      .prepare(`UPDATE open_loop SET status = 'active', updated_at = ?, last_progress = ? WHERE id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), loopId);
    if (result.changes > 0) {
      const meta = this.getLoopMetadata(loopId);
      if (meta?.triggerSpec?.type === 'event') this.registerEventTrigger(loopId, meta.triggerSpec);
      this.publish('loop.resumed', { loopId });
      return true;
    }
    return false;
  }

  getLoop(loopId: string): OpenLoopRow | null {
    const row = this.db.raw
      .prepare(
        `SELECT id, identity_id, topic, status, opened_at, last_progress, last_evaluated_at, summary, context_json FROM open_loop WHERE id = ?`,
      )
      .get(loopId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const id = row['id'] as string;
    const inMem = this.specs.get(id);
    const meta = inMem ?? this.getLoopMetadata(id);
    return {
      id,
      identityId: row['identity_id'] as string,
      topic: row['topic'] as string,
      triggerSpec: meta?.triggerSpec ?? { type: 'condition', conditionId: '__missing__' },
      actionSpec: meta?.actionSpec ?? { kind: 'task', taskKind: 'background', payload: { kind: 'background', toolId: '', input: {} } },
      status: row['status'] as LoopStatus,
      openedAt: new Date(row['opened_at'] as string).getTime(),
      lastEvaluatedAt: row['last_evaluated_at'] ? new Date(row['last_evaluated_at'] as string).getTime() : 0,
      lastProgressAt: new Date(row['last_progress'] as string).getTime(),
      summary: (row['summary'] as string | null) ?? null,
      contextJson: (row['context_json'] as string | null) ?? null,
    };
  }

  getActiveLoops(identityId?: string): OpenLoopRow[] {
    const query = identityId
      ? `SELECT id, identity_id, topic, status, opened_at, last_progress, last_evaluated_at, summary, context_json FROM open_loop WHERE status = 'active' AND identity_id = ? ORDER BY opened_at ASC`
      : `SELECT id, identity_id, topic, status, opened_at, last_progress, last_evaluated_at, summary, context_json FROM open_loop WHERE status = 'active' ORDER BY opened_at ASC`;
    const rows = (identityId
      ? this.db.raw.prepare(query).all(identityId)
      : this.db.raw.prepare(query).all()) as Record<string, unknown>[];
    return rows.map((row) => {
      const id = row['id'] as string;
      const inMem = this.specs.get(id);
      const meta = inMem ?? this.getLoopMetadata(id);
      return {
        id,
        identityId: row['identity_id'] as string,
        topic: row['topic'] as string,
        triggerSpec: meta?.triggerSpec ?? { type: 'condition', conditionId: '__missing__' },
        actionSpec: meta?.actionSpec ?? { kind: 'task', taskKind: 'background', payload: { kind: 'background', toolId: '', input: {} } },
        status: row['status'] as LoopStatus,
        openedAt: new Date(row['opened_at'] as string).getTime(),
        lastEvaluatedAt: row['last_evaluated_at'] ? new Date(row['last_evaluated_at'] as string).getTime() : 0,
        lastProgressAt: new Date(row['last_progress'] as string).getTime(),
        summary: (row['summary'] as string | null) ?? null,
        contextJson: (row['context_json'] as string | null) ?? null,
      };
    });
  }

  async evaluateAll(now: number = Date.now()): Promise<LoopEvaluation[]> {
    const loops = this.getActiveLoops();
    const results: LoopEvaluation[] = [];
    for (const loop of loops) {
      results.push(await this.evaluateLoop(loop, now));
    }
    return results;
  }

  private schedulePoll(): void {
    if (this.stopRequested) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.evaluateAll().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private async evaluateLoop(loop: OpenLoopRow, now: number): Promise<LoopEvaluation> {
    const triggerState = this.triggerStates.get(loop.id);
    if (!triggerState) return this.makeEval(loop, false, null, 'no trigger state');
    const { triggerSpec, actionSpec, identityId } = loop;
    let satisfied = false;
    let reason = 'not satisfied';

    if (triggerSpec.type === 'schedule') {
      if (triggerState.nextRunAt !== null && now >= triggerState.nextRunAt) {
        satisfied = true;
        reason = 'schedule due';
      }
    } else if (triggerSpec.type === 'event') {
      if (triggerState.lastSatisfiedAt !== null && triggerState.lastSatisfiedAt > (triggerState.lastEvaluatedAt ?? 0)) {
        satisfied = true;
        reason = 'event received';
      }
    } else {
      const check = this.conditionRegistry.get(triggerSpec.conditionId);
      if (!check) {
        reason = `unknown condition '${triggerSpec.conditionId}'`;
      } else {
        try {
          satisfied = !!(await check());
          reason = satisfied ? 'condition true' : 'condition false';
        } catch {
          reason = 'condition error';
        }
      }
    }

    if (!satisfied) return this.makeEval(loop, false, null, reason);
    if (triggerState.lastFiredAt !== null && now - triggerState.lastFiredAt < this.triggerCooldownMs) {
      return this.makeEval(loop, true, null, 'dedup cooldown');
    }

    const scheduleObj = actionSpec.schedule ? { schedule: actionSpec.schedule } : {};
    const taskId = this.taskExecutor.scheduleTask({
      identityId,
      kind: actionSpec.taskKind,
      payload: actionSpec.payload,
      ...scheduleObj,
      maxAttempts: 3,
    });

    triggerState.lastSatisfiedAt = now;
    triggerState.lastFiredAt = now;
    if (triggerSpec.type === 'schedule') triggerState.nextRunAt = now + triggerSpec.intervalMs;

    this.db.raw
      .prepare(`UPDATE open_loop SET last_evaluated_at = ?, last_progress = ?, updated_at = ? WHERE id = ?`)
      .run(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), loop.id);

    this.publish('loop.evaluated', { loopId: loop.id, triggerSatisfied: true, taskCreated: true, taskId, reason });
    this.publish('loop.task_created', { loopId: loop.id, taskId });
    return this.makeEval(loop, true, taskId, reason);
  }

  private makeEval(loop: OpenLoopRow, triggerSatisfied: boolean, taskId: string | null, reason: string | null): LoopEvaluation {
    return { loopId: loop.id, evaluatedAt: Date.now(), triggerSatisfied, taskCreated: taskId !== null, taskId, reason };
  }

  private registerEventTrigger(loopId: string, triggerSpec: TriggerSpec): void {
    if (triggerSpec.type !== 'event') return;
    if (this.eventUnsubscribes.has(loopId)) return;
    const predicate = triggerSpec.filterPredicate;
    const unsub = this.eventBus.subscribe(
      async (event) => {
        if (!this.running) return;
        const triggerState = this.triggerStates.get(loopId);
        if (!triggerState) return;
        if (predicate && !matchesPredicate(event.payload, predicate)) return;
        const now = Date.now();
        if (triggerState.lastSatisfiedAt !== null && event.timestamp <= triggerState.lastSatisfiedAt) return;
        triggerState.lastSatisfiedAt = now;
        triggerState.lastEventPayload = event.payload;
        const loop = this.getLoop(loopId);
        if (loop && loop.status === 'active') await this.evaluateLoop(loop, now);
      },
      [triggerSpec.eventType as DomainEventType],
    );
    this.eventUnsubscribes.set(loopId, unsub);
  }

  private unregisterEventTrigger(loopId: string): void {
    const unsub = this.eventUnsubscribes.get(loopId);
    if (unsub) {
      unsub();
      this.eventUnsubscribes.delete(loopId);
    }
  }

  private getLoopMetadata(loopId: string): { triggerSpec: TriggerSpec; actionSpec: ActionSpec } | null {
    const row = this.db.raw
      .prepare(`SELECT trigger_spec_json, action_spec_json FROM loop_metadata WHERE loop_id = ?`)
      .get(loopId) as { trigger_spec_json: string; action_spec_json: string } | undefined;
    if (!row) return null;
    return {
      triggerSpec: JSON.parse(row.trigger_spec_json) as TriggerSpec,
      actionSpec: JSON.parse(row.action_spec_json) as ActionSpec,
    };
  }

  private publish(type: DomainEventType, payload: Record<string, unknown>): void {
    void this.eventBus
      .publish({
        type,
        payload,
        identityId: undefined,
        cycleId: undefined,
        timestamp: Date.now(),
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      })
      .catch((error: unknown) => {
        this.report(`publishing ${type}`, error);
      });
  }
}

function matchesPredicate(payload: unknown, pred: DeclarativePredicate): boolean {
  if (!pred || (pred.field === undefined && pred.equals === undefined && pred.contains === undefined)) return true;
  if (typeof payload !== 'object' || payload === null) return false;
  const value = (payload as Record<string, unknown>)[pred.field ?? ''];
  if (pred.equals !== undefined) return value === pred.equals;
  if (pred.contains !== undefined) return typeof value === 'string' && value.includes(pred.contains);
  return true;
}
