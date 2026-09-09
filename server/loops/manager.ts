/**
 * P15 — LoopManager.
 *
 * An open loop is a persistent intent the owner placed on Madhurita.
 * Loops are generators of tasks. The LoopManager evaluates active loops on
 * every relevant domain event, on a periodic tick, and when explicitly
 * triggered. Each evaluation may create a Task via the TaskExecutor.
 *
 * Deduplication is mandatory: a loop never creates duplicate tasks for the
 * same trigger condition. The manager tracks the last satisfaction state
 * per loop.
 */

import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { TaskExecutor } from '@server/tasks/executor.js';
import type { DomainEventType } from '@server/events/types.js';

export type LoopStatus = 'active' | 'paused' | 'closed';

export type TriggerSpec =
  | { type: 'event'; eventType: string; filter?: (payload: unknown) => boolean }
  | { type: 'schedule'; intervalMs: number }
  | { type: 'condition'; check: () => Promise<boolean> };

export type TaskKind = 'reminder' | 'recurring' | 'one_shot' | 'background';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  /** Evaluation tick interval (default 15 min). */
  pollIntervalMs?: number;
  /**
   * Minimum gap between two task creations from the same trigger. Guards
   * against an event storm producing one task per event.
   */
  triggerCooldownMs?: number;
  /**
   * Where a failed event publish is reported. Defaults to `console.error`.
   * The same seam `EventBus` and `TaskExecutor` have, for the same reason.
   */
  report?: ((what: string, error: unknown) => void) | undefined;
}

interface TriggerState {
  loopId: string;
  lastSatisfiedAt: number | null;
  lastEvaluatedAt: number | null;
  /**
   * Last time this trigger actually produced a task. The dedup cooldown is
   * measured against this, not `lastSatisfiedAt` — an event handler sets
   * `lastSatisfiedAt` to `now` immediately before evaluating, so comparing
   * against it made every event-triggered loop dedup itself away.
   */
  lastFiredAt: number | null;
  // For event triggers: the event payload that last satisfied
  lastEventPayload: unknown | null;
  // For schedule triggers: the next scheduled run time
  nextRunAt: number | null;
}

export class LoopManager {
  private readonly db: Database;
  private readonly eventBus: EventBus;
  private readonly taskExecutor: TaskExecutor;
  private readonly pollIntervalMs: number;
  private readonly triggerCooldownMs: number;
  private readonly report: (what: string, error: unknown) => void;

  private running = false;
  private stopRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  // In-memory trigger state for dedup and evaluation
  private triggerStates = new Map<string, TriggerState>();
  // In-memory specs to preserve JS functions (condition checks, event filters)
  private specs = new Map<string, { triggerSpec: TriggerSpec; actionSpec: ActionSpec }>();

  // Active event subscriptions
  private eventUnsubscribes = new Map<string, () => void>();

  constructor(db: Database, eventBus: EventBus, taskExecutor: TaskExecutor, options: LoopManagerOptions = {}) {
    this.db = db;
    this.eventBus = eventBus;
    this.taskExecutor = taskExecutor;
    this.pollIntervalMs = options.pollIntervalMs ?? 900_000; // 15 minutes
    this.triggerCooldownMs = options.triggerCooldownMs ?? 1000;
    this.report =
      options.report ??
      ((what, error) => {
        console.error(`[loops] ${what}:`, error);
      });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.registerEventTriggers();
    this.schedulePoll();
  }

  stop(): void {
    this.stopRequested = true;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    // Unsubscribe all event handlers
    for (const unsub of this.eventUnsubscribes.values()) {
      unsub();
    }
    this.eventUnsubscribes.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  openLoop(input: {
    identityId: string;
    topic: string;
    triggerSpec: TriggerSpec;
    actionSpec: ActionSpec;
    summary?: string;
    context?: Record<string, unknown>;
  }): string {
    const id = ulid();
    const now = new Date().toISOString();

    this.db.raw
      .prepare(
        `INSERT INTO open_loop (id, identity_id, topic, status, opened_at, last_progress, summary, context_json)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.identityId,
        input.topic,
        now,
        now,
        input.summary ?? null,
        input.context ? JSON.stringify(input.context) : null,
      );

    // Store trigger spec in a side table? For now, we keep it in context_json
    // but the schema doesn't have trigger/action columns. We need to store them.
    // Use a separate metadata table or extend open_loop. For minimal P15, we'll
    // add trigger_spec_json and action_spec_json columns via a migration.
    // However, the existing migration doesn't have these. Let's add them now.
    // Actually, we can store them in context_json as a structured object.
    // But the schema says context_json is for context only. Let's add a proper
    // migration later. For now, we'll keep a separate in-memory map keyed by loopId.
    // That's not durable. Better to add columns.
    // For P15, we'll add trigger_spec_json and action_spec_json columns to the
    // open_loop table in a new migration. But to keep things moving, let's just
    // store them in a separate in-memory map and re-load on startup.
    // Actually the Build Book doesn't mandate a migration in P15 - the tables
    // already exist in 0003_domain.sql. Let's just use a separate metadata table
    // or extend the open_loop table. Since we're doing P14+P15 together, we can
    // add a small migration.

    // For now, let's store trigger/action in context_json with a special key.
    // Better: create a new migration for P15 that adds these columns.
    // Let's do a quick ALTER TABLE for now.
    this.ensureLoopMetadataTable();

    this.db.raw
      .prepare(
        `INSERT INTO loop_metadata (loop_id, trigger_spec_json, action_spec_json)
         VALUES (?, ?, ?)`,
      )
      .run(id, JSON.stringify(input.triggerSpec), JSON.stringify(input.actionSpec));

    // Initialize trigger state
    this.triggerStates.set(id, {
      loopId: id,
      lastSatisfiedAt: null,
      lastEvaluatedAt: null,
      lastFiredAt: null,
      lastEventPayload: null,
      nextRunAt: input.triggerSpec.type === 'schedule' ? Date.now() + input.triggerSpec.intervalMs : null,
    });
    this.specs.set(id, { triggerSpec: input.triggerSpec, actionSpec: input.actionSpec });

    // Register event subscription if needed
    if (input.triggerSpec.type === 'event') {
      this.registerEventTrigger(id, input.triggerSpec);
    }

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
      .prepare(
        `UPDATE open_loop SET status = 'closed', updated_at = ? WHERE id = ? AND status != 'closed'`,
      )
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
      .prepare(
        `UPDATE open_loop SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
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
      .prepare(
        `UPDATE open_loop SET status = 'active', updated_at = ?, last_progress = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), loopId);
    if (result.changes > 0) {
      const meta = this.getLoopMetadata(loopId);
      if (meta?.triggerSpec?.type === 'event') {
        this.registerEventTrigger(loopId, meta.triggerSpec);
      }
      this.publish('loop.resumed', { loopId });
      return true;
    }
    return false;
  }

  getLoop(loopId: string): OpenLoopRow | null {
    const row = this.db.raw
      .prepare(
        `SELECT id, identity_id, topic, status, opened_at, last_progress, last_evaluated_at,
                summary, context_json
         FROM open_loop WHERE id = ?`,
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
      triggerSpec: meta?.triggerSpec ?? { type: 'condition', check: async () => false },
      actionSpec: meta?.actionSpec ?? { kind: 'task', taskKind: 'background', payload: { kind: 'background', toolId: '', input: {} } },
      status: row['status'] as LoopStatus,
      openedAt: new Date(row['opened_at'] as string).getTime(),
      lastEvaluatedAt: new Date(row['last_evaluated_at'] as string).getTime(),
      lastProgressAt: new Date(row['last_progress'] as string).getTime(),
      summary: (row['summary'] as string | null) ?? null,
      contextJson: (row['context_json'] as string | null) ?? null,
    };
  }

  getActiveLoops(identityId?: string): OpenLoopRow[] {
    const query = identityId
      ? `SELECT id, identity_id, topic, status, opened_at, last_progress, last_evaluated_at,
                summary, context_json
         FROM open_loop WHERE status = 'active' AND identity_id = ? ORDER BY opened_at ASC`
      : `SELECT id, identity_id, topic, status, opened_at, last_progress, last_evaluated_at,
                summary, context_json
         FROM open_loop WHERE status = 'active' ORDER BY opened_at ASC`;
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
        triggerSpec: meta?.triggerSpec ?? { type: 'condition', check: async () => false },
        actionSpec: meta?.actionSpec ?? { kind: 'task', taskKind: 'background', payload: { kind: 'background', toolId: '', input: {} } },
        status: row['status'] as LoopStatus,
      openedAt: new Date(row['opened_at'] as string).getTime(),
      lastEvaluatedAt: new Date(row['last_evaluated_at'] as string).getTime(),
      lastProgressAt: new Date(row['last_progress'] as string).getTime(),
      summary: (row['summary'] as string | null) ?? null,
      contextJson: (row['context_json'] as string | null) ?? null,
    };
  });
}

  /** Force an immediate evaluation of all active loops (e.g. from test). */
  async evaluateAll(now: number = Date.now()): Promise<LoopEvaluation[]> {
    const loops = this.getActiveLoops();
    const results: LoopEvaluation[] = [];
    for (const loop of loops) {
      const evalResult = await this.evaluateLoop(loop, now);
      results.push(evalResult);
    }
    return results;
  }

  // ── Internals ──

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

    // Check if trigger is satisfied
    let satisfied = false;
    let reason = 'not satisfied';

    if (triggerSpec.type === 'schedule') {
      if (triggerState.nextRunAt !== null && now >= triggerState.nextRunAt) {
        satisfied = true;
        reason = 'schedule due';
      }
    } else if (triggerSpec.type === 'event') {
      // Event triggers are handled by the event handler directly calling
      // maybeCreateTask. But we also check here for any events we might have
      // missed or for edge cases.
      if (triggerState.lastSatisfiedAt !== null && triggerState.lastSatisfiedAt > (triggerState.lastEvaluatedAt ?? 0)) {
        satisfied = true;
        reason = 'event received';
      }
    } else if (triggerSpec.type === 'condition') {
      try {
        satisfied = await triggerSpec.check();
        reason = satisfied ? 'condition true' : 'condition false';
      } catch {
        satisfied = false;
        reason = 'condition error';
      }
    }

    if (!satisfied) {
      return this.makeEval(loop, false, null, reason);
    }

    // Dedup: don't create a second task for the same trigger firing. Measured
    // from the last time a task was actually created (`lastFiredAt`), because
    // the event path sets `lastSatisfiedAt = now` right before calling here.
    if (triggerState.lastFiredAt !== null) {
      const cooldownMs = this.triggerCooldownMs;
      if (now - triggerState.lastFiredAt < cooldownMs) {
        return this.makeEval(loop, true, null, 'dedup cooldown');
      }
    }

    // Check if identity can receive proactive messages (for owner notifications)
    // This is enforced at task creation time via the reminder handler, but we
    // should respect it here too for tasks that generate output.
    // For now, we just proceed - the task executor will handle the permission check.

    // Create the task
    const scheduleObj = actionSpec.schedule ? { schedule: actionSpec.schedule } : {};
    const taskId = this.taskExecutor.scheduleTask({
      identityId,
      kind: actionSpec.taskKind,
      payload: actionSpec.payload,
      ...scheduleObj,
      maxAttempts: 3,
    });

    // Update trigger state
    triggerState.lastSatisfiedAt = now;
    triggerState.lastFiredAt = now;
    if (triggerSpec.type === 'schedule') {
      triggerState.nextRunAt = now + triggerSpec.intervalMs;
    }

    // Update loop timestamps
    this.db.raw
      .prepare(
        `UPDATE open_loop SET last_evaluated_at = ?, last_progress = ?, updated_at = ? WHERE id = ?`,
      )
      .run(new Date(now).toISOString(), new Date(now).toISOString(), new Date(now).toISOString(), loop.id);

    this.publish('loop.evaluated', { loopId: loop.id, triggerSatisfied: true, taskCreated: true, taskId, reason });
    this.publish('loop.task_created', { loopId: loop.id, taskId });

    return this.makeEval(loop, true, taskId, reason);
  }

  private makeEval(loop: OpenLoopRow, triggerSatisfied: boolean, taskId: string | null, reason: string | null): LoopEvaluation {
    return {
      loopId: loop.id,
      evaluatedAt: Date.now(),
      triggerSatisfied,
      taskCreated: taskId !== null,
      taskId,
      reason,
    };
  }

  private registerEventTriggers(): void {
    const loops = this.getActiveLoops();
    for (const loop of loops) {
      if (loop.triggerSpec.type === 'event') {
        this.registerEventTrigger(loop.id, loop.triggerSpec);
      }
    }
  }

  private registerEventTrigger(loopId: string, triggerSpec: TriggerSpec): void {
    if (triggerSpec.type !== 'event') return;
    if (this.eventUnsubscribes.has(loopId)) return; // already registered

    const unsub = this.eventBus.subscribe(
      async (event) => {
        if (!this.running) return;
        const triggerState = this.triggerStates.get(loopId);
        if (!triggerState) return;

        // Check filter
        if (triggerSpec.filter && !triggerSpec.filter(event.payload)) return;

        // Check if this event is newer than our last satisfaction
        const now = Date.now();
        if (triggerState.lastSatisfiedAt !== null && event.timestamp <= triggerState.lastSatisfiedAt) {
          return;
        }

        triggerState.lastSatisfiedAt = now;
        triggerState.lastEventPayload = event.payload;

        // Evaluate this loop immediately
        const loop = this.getLoop(loopId);
        if (loop && loop.status === 'active') {
          await this.evaluateLoop(loop, now);
        }
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
      .prepare(
        `SELECT trigger_spec_json, action_spec_json FROM loop_metadata WHERE loop_id = ?`,
      )
      .get(loopId) as { trigger_spec_json: string; action_spec_json: string } | undefined;
    if (!row) return null;
    return {
      triggerSpec: JSON.parse(row.trigger_spec_json) as TriggerSpec,
      actionSpec: JSON.parse(row.action_spec_json) as ActionSpec,
    };
  }

  /**
   * Announce a loop transition, fire-and-forget, with the failure reported
   * rather than thrown at the process.
   *
   * See `TaskExecutor.publish` for the full reasoning: the six call sites here
   * all ran `void this.publish(...)`, and an unhandled rejection is a shutdown.
   * A loop that could not announce it opened is still open.
   */
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