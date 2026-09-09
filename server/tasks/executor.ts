/**
 * P14 — TaskExecutor.
 *
 * Durable, scheduled, executable work. Polls the `task` table for due tasks,
 * atomically claims them, executes the payload, and updates status with
 * retry/backoff. Emits domain events for every state transition.
 *
 * The LLM is never the executor: it may *propose* a task schedule, but the
 * application is the only thing that runs tool code, mutates state, or
 * persists rows.
 */

import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { ToolRegistry } from '@server/actions/registry.js';
import type { ActionPipeline } from '@server/actions/pipeline.js';
import type { Identity } from '@server/identity/types.js';
import { IdentityRepository } from '@server/identity/repository.js';
import type { DomainEventType } from '@server/events/types.js';

export type TaskKind = 'reminder' | 'recurring' | 'one_shot' | 'background';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * How many permanently-failed rows `failedTasks` will pull before filtering by
 * time in TypeScript.
 *
 * The bound exists because the `since` cutoff cannot be a SQL predicate (see
 * `failedTasks`), so the query has to over-fetch. It is generous relative to
 * what a caller does with the result — the autonomic layer raises *one* notice
 * per failed task and is rate-limited per topic — while still refusing to load a
 * year of failures into memory to answer a question about the last hour.
 */
const FAILED_TASK_SCAN_LIMIT = 200;

export interface TaskSchedule {
  runAt?: number; // epoch ms; if absent, run immediately when claimed
  intervalMs?: number; // for recurring: ms between runs
  maxRuns?: number; // for recurring
}

export type TaskPayload =
  | { kind: 'reminder'; message: string; channel?: 'text' | 'voice' }
  | { kind: 'recurring'; toolId: string; input: unknown; intervalMs: number; maxRuns?: number }
  | { kind: 'one_shot'; toolId: string; input: unknown; runAt: number }
  | { kind: 'background'; toolId: string; input: unknown };

export interface TaskRow {
  id: string;
  identityId: string;
  kind: TaskKind;
  payload: TaskPayload;
  dueAt: number | null;
  status: TaskStatus;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  lastError: string | null;
}

export interface TaskExecutorOptions {
  pollIntervalMs?: number;
  maxConcurrent?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Optional — for executing recurring/one_shot/background tasks. */
  registry?: ToolRegistry;
  /** Optional — for executing recurring/one_shot/background tasks. */
  pipeline?: ActionPipeline;
  /**
   * Identity source used to resolve the caller a task executes as. Defaults to
   * a repository over the same database. Injecting one lets a composition root
   * share a single instance.
   */
  identityRepo?: IdentityRepository;
  /**
   * Where a failed event publish is reported. Defaults to `console.error`.
   *
   * Injectable for the same reason `EventBus` and `RealtimeFlow` have one: the
   * bug this exists for is a rejection nobody sees, and a test cannot assert on
   * `console`.
   */
  report?: ((what: string, error: unknown) => void) | undefined;
}

export interface ScheduleTaskInput {
  identityId: string;
  kind: TaskKind;
  payload: TaskPayload;
  schedule?: TaskSchedule;
  maxAttempts?: number;
  /** If absent, uses current time. */
  dueAt?: number;
}

export interface TaskExecutorHandlers {
  /** Reminders are dispatched here (instead of a tool). Returns true if delivered. */
  onReminder?: (identityId: string, message: string, channel: 'text' | 'voice') => Promise<boolean> | boolean;
}

/**
 * Application-authoritative task executor.
 */
export class TaskExecutor {
  private readonly db: Database;
  private readonly eventBus: EventBus | undefined;
  private readonly registry: ToolRegistry | undefined;
  private readonly pipeline: ActionPipeline | undefined;
  private readonly identityRepo: IdentityRepository;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly handlers: TaskExecutorHandlers;
  private readonly report: (what: string, error: unknown) => void;

  private running = false;
  private stopRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight = new Set<string>();

  constructor(db: Database, eventBus: EventBus | undefined, options: TaskExecutorOptions = {}) {
    this.db = db;
    this.eventBus = eventBus;
    this.registry = options.registry;
    this.pipeline = options.pipeline;
    this.identityRepo = options.identityRepo ?? new IdentityRepository(db);
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 60_000;
    this.handlers = {};
    this.report =
      options.report ??
      ((what, error) => {
        console.error(`[tasks] ${what}:`, error);
      });
  }

  /** Set reminder dispatch handler (e.g. from realtime broadcaster). */
  setHandlers(handlers: TaskExecutorHandlers): void {
    Object.assign(this.handlers, handlers);
  }

  start(): void {
    if (this.running) return;
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
  }

  isRunning(): boolean {
    return this.running;
  }

  scheduleTask(input: ScheduleTaskInput): string {
    const id = ulid();
    const now = new Date().toISOString();
    const dueAt = input.dueAt
      ? new Date(input.dueAt).toISOString()
      : input.schedule?.runAt
        ? new Date(input.schedule.runAt).toISOString()
        : now;

    this.db.raw
      .prepare(
        `INSERT INTO task (id, identity_id, kind, payload_json, due_at, status, attempt, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.identityId,
        input.kind,
        JSON.stringify(input.payload),
        dueAt,
        input.maxAttempts ?? 3,
        now,
        now,
      );

    this.publish('task.scheduled', { taskId: id, kind: input.kind, dueAt: Date.parse(dueAt) });
    return id;
  }

  cancelTask(taskId: string): boolean {
    const result = this.db.raw
      .prepare(
        `UPDATE task SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'running')`,
      )
      .run(new Date().toISOString(), taskId);
    if (result.changes > 0) {
      this.publish('task.cancelled', { taskId });
      this.inflight.delete(taskId);
      return true;
    }
    return false;
  }

  getTask(taskId: string): TaskRow | null {
    const row = this.db.raw
      .prepare(
        `SELECT id, identity_id, kind, payload_json, due_at, status, attempt, max_attempts,
                created_at, updated_at, completed_at, last_error
         FROM task WHERE id = ?`,
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getPendingTasks(identityId?: string): TaskRow[] {
    const query = identityId
      ? `SELECT id, identity_id, kind, payload_json, due_at, status, attempt, max_attempts,
                created_at, updated_at, completed_at, last_error
         FROM task WHERE status = 'pending' AND identity_id = ? ORDER BY due_at ASC`
      : `SELECT id, identity_id, kind, payload_json, due_at, status, attempt, max_attempts,
                created_at, updated_at, completed_at, last_error
         FROM task WHERE status = 'pending' ORDER BY due_at ASC`;
    const rows = (identityId
      ? this.db.raw.prepare(query).all(identityId)
      : this.db.raw.prepare(query).all()) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /** Force an immediate evaluation cycle (e.g. from a test or operator). */
  async tick(now: number = Date.now()): Promise<number> {
    return this.runClaimCycle(now);
  }

  /**
   * Tasks that used up every attempt and never succeeded, most recent first.
   *
   * Here rather than as a query in the caller because the `task` table is this
   * module's to read: the autonomic layer needs to know that something she
   * undertook for him has permanently failed, and a second place that knows how
   * `status`, `attempt` and `max_attempts` relate is a second place to get it
   * wrong. The `attempt >= max_attempts` term is what distinguishes a permanent
   * failure from one the retry backoff is still working through — a row can sit
   * in `failed` between attempts.
   *
   * `since` bounds it so a database that has been alive for a year does not
   * report a task that failed in March as news. It is applied in TypeScript
   * rather than as a SQL predicate on purpose: `task.updated_at` is TEXT and the
   * column holds two formats — `datetime('now')` from the schema default writes
   * `'YYYY-MM-DD HH:MM:SS'`, while every write in this file uses
   * `toISOString()`. Those two do not order against each other lexically (`'T'`
   * sorts above `' '`), so a string range comparison would silently drop rows.
   * `mapRow` parses both, and a number comparison is unambiguous.
   */
  failedTasks(since: number, identityId?: string): TaskRow[] {
    const columns = `id, identity_id, kind, payload_json, due_at, status, attempt, max_attempts,
                created_at, updated_at, completed_at, last_error`;
    const rows = (
      identityId === undefined
        ? this.db.raw
            .prepare(
              `SELECT ${columns} FROM task
                WHERE status = 'failed' AND attempt >= max_attempts
                ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(FAILED_TASK_SCAN_LIMIT)
        : this.db.raw
            .prepare(
              `SELECT ${columns} FROM task
                WHERE status = 'failed' AND attempt >= max_attempts AND identity_id = ?
                ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(identityId, FAILED_TASK_SCAN_LIMIT)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r)).filter((task) => task.updatedAt >= since);
  }

  // ── Internals ──

  private schedulePoll(): void {
    if (this.stopRequested) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.runClaimCycle().finally(() => this.schedulePoll());
    }, this.pollIntervalMs);
  }

  private async runClaimCycle(now: number = Date.now()): Promise<number> {
    if (this.inflight.size >= this.maxConcurrent) return 0;
    const slots = this.maxConcurrent - this.inflight.size;
    const claimable = this.claimableTasks(now, slots);
    if (claimable.length === 0) return 0;
    await Promise.allSettled(claimable.map((row) => this.executeRow(row, now)));
    return claimable.length;
  }

  private claimableTasks(now: number, limit: number): TaskRow[] {
    const isoNow = new Date(now).toISOString();
    const rows = this.db.raw
      .prepare(
        `SELECT id, identity_id, kind, payload_json, due_at, status, attempt, max_attempts,
                created_at, updated_at, completed_at, last_error
         FROM task
         WHERE status = 'pending' AND (due_at IS NULL OR due_at <= ?)
         ORDER BY due_at ASC
         LIMIT ?`,
      )
      .all(isoNow, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  private async executeRow(row: TaskRow, now: number): Promise<void> {
    // Atomically claim: only if still pending. UPDATE ... WHERE id = ? AND status='pending'.
    const claim = this.db.raw
      .prepare(
        `UPDATE task SET status = 'running', attempt = attempt + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date(now).toISOString(), row.id);
    if (claim.changes === 0) return; // somebody else claimed it

    this.inflight.add(row.id);
    this.publish('task.claimed', { taskId: row.id, attempt: row.attempt + 1 });

    try {
      await this.executePayload(row);
      this.markCompleted(row.id);
      this.publish('task.completed', { taskId: row.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.markFailed(row, message, now);
    } finally {
      this.inflight.delete(row.id);
    }
  }

  private async executePayload(row: TaskRow): Promise<void> {
    const payload = row.payload;
    if (payload.kind === 'reminder') {
      if (!this.handlers.onReminder) {
        // No dispatcher registered — log and complete (the application will
        // surface reminders through a registered handler). The reminder
        // remains completed; missing dispatch is not an error of the executor.
        return;
      }
      const ok = await this.handlers.onReminder(row.identityId, payload.message, payload.channel ?? 'text');
      if (!ok) throw new Error('Reminder dispatch returned false');
      return;
    }
    // All non-reminder kinds delegate to the action pipeline.
    if (!this.pipeline || !this.registry) {
      throw new Error('Action pipeline / registry not configured on TaskExecutor');
    }
    if (payload.kind === 'recurring' || payload.kind === 'one_shot' || payload.kind === 'background') {
      // Ensure a conversation and cycle_record exist for this task ID so PERSIST can insert action_result without FK violation.
      const convId = `conv_task_${row.id}`;
      const nowIso = new Date().toISOString();
      this.db.raw
        .prepare(
          `INSERT OR IGNORE INTO conversation (id, identity_id, channel, status, started_at)
           VALUES (?, ?, 'text', 'active', ?)`
        )
        .run(convId, row.identityId, nowIso);

      this.db.raw
        .prepare(
          `INSERT OR IGNORE INTO cycle_record (id, conversation_id, status, started_at, input_json)
           VALUES (?, ?, 'running', ?, '{}')`
        )
        .run(row.id, convId, nowIso);

      const result = await this.pipeline.execute({
        toolId: payload.toolId,
        input: payload.input,
        identityId: row.identityId,
        cycleId: row.id,
        causationId: row.id,
        caller: this.callerFor(row.identityId),
      });
      if (!result.success) {
        // Which of the two failures this was, in the message. `markFailed` records the
        // message and nothing else about the outcome survives, so a row that says only
        // "returned failure" cannot tell someone reading it later whether the tool was
        // refused at the gate or ran and broke partway.
        throw new Error(
          result.attempted
            ? `Tool ${payload.toolId} was called and failed: ${result.error ?? 'no reason recorded'}`
            : `Tool ${payload.toolId} was never called: ${result.error ?? 'no reason recorded'}`,
        );
      }
    } else {
      // Exhaustive check
      const _exhaustive: never = payload;
      throw new Error(`Unknown task payload kind: ${JSON.stringify(_exhaustive)}`);
    }
  }

  /**
   * Resolves the identity a task runs as.
   *
   * This used to fabricate a synthetic `owner` with `mayAccessTools: ['*']` for
   * every task on the grounds that authz was checked at schedule time. That made
   * task scheduling a privilege-escalation path: anything that reached
   * `scheduleTask` executed with full owner rights regardless of who asked. The
   * row is now read back and authorization re-evaluated at execution time, which
   * is also the only way a permission revoked between scheduling and execution
   * can take effect.
   */
  private callerFor(identityId: string): Identity {
    const identity = this.identityRepo.getIdentity(identityId);
    if (!identity) {
      throw new Error(`Task identity ${identityId} not found; refusing to execute`);
    }
    if (identity.status !== 'active') {
      throw new Error(`Task identity ${identityId} is ${identity.status}; refusing to execute`);
    }
    return identity;
  }

  private markCompleted(taskId: string): void {
    const now = new Date().toISOString();
    this.db.raw
      .prepare(
        `UPDATE task SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, taskId);
  }

  private markFailed(row: TaskRow, error: string, now: number): void {
    const isoNow = new Date(now).toISOString();
    if (row.attempt + 1 >= row.maxAttempts) {
      this.db.raw
        .prepare(
          `UPDATE task SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, isoNow, row.id);
      this.publish('task.failed', { taskId: row.id, error, attempt: row.attempt + 1 });
    } else {
      const delay = Math.min(
        this.retryBaseMs * Math.pow(2, row.attempt) + Math.random() * 100,
        this.retryMaxMs,
      );
      const nextDue = new Date(now + delay).toISOString();
      this.db.raw
        .prepare(
          `UPDATE task SET status = 'pending', last_error = ?, due_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(error, nextDue, isoNow, row.id);
      this.publish('task.retry_scheduled', { taskId: row.id, error, nextDue, attempt: row.attempt + 1 });
    }
  }

  private mapRow(row: Record<string, unknown>): TaskRow {
    const payload = JSON.parse(row['payload_json'] as string) as TaskPayload;
    return {
      id: row['id'] as string,
      identityId: row['identity_id'] as string,
      kind: row['kind'] as TaskKind,
      payload,
      dueAt: row['due_at'] ? new Date(row['due_at'] as string).getTime() : null,
      status: row['status'] as TaskStatus,
      attempt: Number(row['attempt'] ?? 0),
      maxAttempts: Number(row['max_attempts'] ?? 1),
      createdAt: new Date(row['created_at'] as string).getTime(),
      updatedAt: new Date(row['updated_at'] as string).getTime(),
      completedAt: row['completed_at'] ? new Date(row['completed_at'] as string).getTime() : null,
      lastError: (row['last_error'] as string | null) ?? null,
    };
  }

  /**
   * Announce that something happened to a task, without making the caller wait
   * and without letting a failed announcement take the process down.
   *
   * Both halves are load-bearing. `scheduleTask` returns an id the caller will
   * use; the row is already committed by then, so waiting on the event would
   * make a durable write slower for no gain. But the thirteen call sites used to
   * write `void this.publish(...)` over a promise nothing caught, and
   * `server/main.ts` turns an unhandled rejection into a shutdown — so a
   * `SQLITE_BUSY` on the event insert during a sweep would stop the server
   * *after* the task was scheduled and the id handed out.
   *
   * Returning `void` rather than a promise is what makes that unrepeatable: there
   * is no rejection left for a call site to forget.
   */
  private publish(type: DomainEventType, payload: Record<string, unknown>): void {
    const bus = this.eventBus;
    if (!bus) return;
    void bus
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
