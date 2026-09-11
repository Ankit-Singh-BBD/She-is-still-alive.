/**
 * B04 — Leased coordinator. Executes one owned step at a time.
 * Claim is atomic (version+fence+lease), execution is outside txn, fence protects commit.
 */
import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import type { WorkRepository } from './repository.js';
import type { ToolRegistry } from '@server/actions/registry.js';
import type { Identity } from '@server/identity/types.js';

export interface CoordinatorOpts {
  workerId?: string;
  leaseMs?: number;
  outboxBatch?: number;
}

type Clock = () => number;

function nowMs(clock?: Clock): number {
  return clock ? clock() : Date.now();
}

export class WorkCoordinator {
  private readonly db: Database;
  private readonly repo: WorkRepository;
  private readonly registry: ToolRegistry;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly outboxBatch: number;
  private readonly clock: Clock;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight = new Set<string>();

  constructor(db: Database, repo: WorkRepository, registry: ToolRegistry, opts: CoordinatorOpts & { clock?: Clock } = {}) {
    this.db = db;
    this.repo = repo;
    this.registry = registry;
    this.workerId = opts.workerId ?? `worker-${ulid().slice(-6)}`;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.outboxBatch = opts.outboxBatch ?? 20;
    this.clock = opts.clock ?? (() => Date.now());
  }

  /**
   * Dependency-ready pending steps whose blockers are verified, not yet leased.
   * Small query — scanned each tick.
   */
  private findReadySteps(limit = 5): { id: string; job_id: string; position: number; tool_id: string; input_json: string; fence: number; version: number }[] {
    // eligible if: pending && next_eligible_at <= now && all depends_on are verified && job not terminal/paused
    return this.db.raw
      .prepare(
        `SELECT s.id, s.job_id, s.position, s.tool_id, s.input_json, s.fence, s.version
         FROM work_step s
         JOIN work_job j ON j.id = s.job_id
         WHERE s.status = 'pending'
           AND s.next_eligible_at <= ?
           AND j.status IN ('queued','running')
           AND NOT EXISTS (
             SELECT 1 FROM work_dependency d
             JOIN work_step dep ON dep.id = d.depends_on
             WHERE d.step_id = s.id AND dep.status != 'verified'
           )
         ORDER BY j.priority DESC, s.position ASC
         LIMIT ?`,
      )
      .all(nowMs(this.clock), limit) as never;
  }

  /**
   * Atomic claim: version-guarded, sets lease + fence increment, inserts attempt.
   * Two coordinators racing — only one wins (changes==1).
   */
  tryClaim(stepId: string): { claimed: boolean; fence: number; attemptId: string | null } {
    const row = this.db.raw.prepare(`SELECT version, fence, job_id FROM work_step WHERE id=?`).get(stepId) as
      | { version: number; fence: number; job_id: string }
      | undefined;
    if (!row) return { claimed: false, fence: -1, attemptId: null };
    const newFence = row.fence + 1;
    const attemptId = ulid();
    const leaseExp = nowMs(this.clock) + this.leaseMs;
    const occurrenceKey = `${stepId}:${newFence}`;
    const idempotencyKey = `${stepId}:${newFence}:${attemptId.slice(-6)}`;
    let claimed = false;
    try {
      this.db.transaction(() => {
        const res = this.db.raw
          .prepare(
            `UPDATE work_step SET status='running', version=version+1, fence=?, lease_owner=?, lease_expires_at=? WHERE id=? AND version=? AND status='pending'`,
          )
          .run(newFence, this.workerId, leaseExp, stepId, row.version);
        if (res.changes !== 1) throw new Error('claim-lost');
        this.db.raw
          .prepare(
            `INSERT INTO work_attempt (id, step_id, occurrence_key, ordinal, fence, status, started_at, idempotency_key)
             VALUES (?, ?, ?, 1, ?, 'started', ?, ?)`,
          )
          .run(attemptId, stepId, occurrenceKey, newFence, nowMs(this.clock), idempotencyKey);
        // job moves queued->running on first claim
        this.db.raw
          .prepare(`UPDATE work_job SET status='running', version=version+1, updated_at=? WHERE id=? AND status='queued'`)
          .run(nowMs(this.clock), row.job_id);
      });
      claimed = true;
    } catch {
      return { claimed: false, fence: row.fence, attemptId: null };
    }
    return { claimed, fence: newFence, attemptId };
  }

  /**
   * Executes the tool outside any transaction. Budget reservation would go here.
   * Returns raw result/error for fence-protected commit.
   */
  async executeStep(
    step: { id: string; job_id: string; tool_id: string; input_json: string },
    caller: Identity,
    fence: number,
    attemptId: string,
  ): Promise<{ ok: boolean; output?: unknown; error?: string; receipt?: string }> {
    const tool = this.registry.get(step.tool_id);
    if (!tool) return { ok: false, error: `unknown tool ${step.tool_id}` };
    let input: unknown;
    try {
      input = JSON.parse(step.input_json);
    } catch {
      input = step.input_json;
    }
    try {
      const out = await this.registry.execute(step.tool_id, input, {
        identityId: caller.id,
        cycleId: step.job_id,
        causationId: attemptId,
        caller,
      });
      return { ok: true, output: out, receipt: `ok:${step.tool_id}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Fence-protected commit. Only the fence that owns the lease may write.
   * On mismatch — stale write is dropped.
   */
  commitAttempt(
    stepId: string,
    fence: number,
    attemptId: string,
    result: { ok: boolean; output?: unknown; error?: string; receipt?: string },
  ): boolean {
    let committed = false;
    this.db.transaction(() => {
      const step = this.db.raw.prepare(`SELECT fence, status, job_id FROM work_step WHERE id=?`).get(stepId) as
        | { fence: number; status: string; job_id: string }
        | undefined;
      if (!step || step.fence !== fence || step.status !== 'running') return;
      const attStatus = result.ok ? 'returned' : 'failed';
      this.db.raw
        .prepare(
          `UPDATE work_attempt SET status=?, ended_at=?, result_json=?, error_code=?, provider_receipt=? WHERE id=? AND fence=?`,
        )
        .run(attStatus, nowMs(this.clock), result.ok ? JSON.stringify(result.output) : null, result.error ?? null, result.receipt ?? null, attemptId, fence);
      if (result.ok) {
        this.db.raw.prepare(`UPDATE work_step SET status='verified', version=version+1, lease_owner=NULL, lease_expires_at=NULL WHERE id=? AND fence=?`).run(stepId, fence);
        // if all steps verified -> job completed
        const pending = this.db.raw
          .prepare(`SELECT COUNT(*) as c FROM work_step WHERE job_id=? AND status!='verified'`)
          .get(step.job_id) as { c: number };
        if (pending.c === 0) {
          this.db.raw.prepare(`UPDATE work_job SET status='completed', version=version+1, updated_at=? WHERE id=?`).run(nowMs(this.clock), step.job_id);
          this.db.raw
            .prepare(`INSERT INTO work_outbox (id, job_id, job_version, type, payload_json, created_at) VALUES (?, ?, (SELECT version FROM work_job WHERE id=?), 'work.completed', ?, ?)`)
            .run(ulid(), step.job_id, step.job_id, JSON.stringify({ jobId: step.job_id }), nowMs(this.clock));
        }
      } else {
        // check maxAttempts
        const s = this.db.raw.prepare(`SELECT max_attempts FROM work_step WHERE id=?`).get(stepId) as { max_attempts: number };
        const attempts = this.db.raw.prepare(`SELECT COUNT(*) as c FROM work_attempt WHERE step_id=?`).get(stepId) as { c: number };
        if (attempts.c >= s.max_attempts) {
          this.db.raw.prepare(`UPDATE work_step SET status='failed', version=version+1, lease_owner=NULL, lease_expires_at=NULL WHERE id=?`).run(stepId);
          this.db.raw.prepare(`UPDATE work_job SET status='failed', version=version+1, updated_at=? WHERE id=?`).run(nowMs(this.clock), step.job_id);
        } else {
          const backoff = Math.min(1000 * Math.pow(2, attempts.c), 30_000);
          this.db.raw
            .prepare(`UPDATE work_step SET status='pending', version=version+1, next_eligible_at=?, lease_owner=NULL, lease_expires_at=NULL WHERE id=?`)
            .run(nowMs(this.clock) + backoff, stepId);
        }
      }
      committed = true;
    });
    return committed;
  }

  /** Single tick: find ready, claim, execute, commit for one step. Used by tests. */
  async tickOnce(caller: Identity): Promise<string | null> {
    const ready = this.findReadySteps(1);
    if (ready.length === 0) return null;
    const s = ready[0]!;
    const claim = this.tryClaim(s.id);
    if (!claim.claimed || !claim.attemptId) return null;
    const res = await this.executeStep({ id: s.id, job_id: s.job_id, tool_id: s.tool_id, input_json: s.input_json }, caller, claim.fence, claim.attemptId);
    this.commitAttempt(s.id, claim.fence, claim.attemptId, res);
    return s.id;
  }

  /** Run all ready steps sequentially until none remain (used in tests). */
  async drain(caller: Identity, maxLoops = 100): Promise<void> {
    for (let i = 0; i < maxLoops; i++) {
      const id = await this.tickOnce(caller);
      if (!id) break;
    }
  }

  /** Expired leases -> reconciling */
  reconcileExpired(): number {
    const res = this.db.raw
      .prepare(`UPDATE work_step SET status='reconciling', version=version+1 WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`)
      .run(nowMs(this.clock));
    return res.changes;
  }

  /** Control: pause/cancel/resume guarded by expectedVersion */
  control(jobId: string, expectedVersion: number, intent: 'pause' | 'cancel' | 'resume'): boolean {
    const job = this.db.raw.prepare(`SELECT status, version FROM work_job WHERE id=?`).get(jobId) as
      | { status: string; version: number }
      | undefined;
    if (!job || job.version !== expectedVersion) return false;
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') return false;
    let next: string | null = null;
    if (intent === 'pause' && (job.status === 'queued' || job.status === 'running')) next = 'paused';
    else if (intent === 'cancel') next = 'cancelled';
    else if (intent === 'resume' && job.status === 'paused') next = 'running';
    else return false;
    const res = this.db.raw.prepare(`UPDATE work_job SET status=?, version=version+1, updated_at=?, control_intent=? WHERE id=? AND version=?`).run(next, nowMs(this.clock), null, jobId, expectedVersion);
    if (res.changes === 1 && next === 'cancelled') {
      this.db.raw.prepare(`UPDATE work_step SET status='cancelled', version=version+1 WHERE job_id=? AND status IN ('pending','retry_wait','reconciling','blocked')`).run(jobId);
    }
    return res.changes === 1;
  }

  /** Outbox: fetch unpublished rows for delivery, mark published after. */
  fetchOutbox(): { id: string; job_id: string; type: string; payload_json: string }[] {
    return this.db.raw
      .prepare(`SELECT id, job_id, type, payload_json FROM work_outbox WHERE published_at IS NULL ORDER BY created_at ASC LIMIT ?`)
      .all(this.outboxBatch) as never;
  }
  markOutboxPublished(ids: string[]): void {
    const stmt = this.db.raw.prepare(`UPDATE work_outbox SET published_at=? WHERE id=?`);
    const now = nowMs(this.clock);
    for (const id of ids) stmt.run(now, id);
  }

  start(pollMs = 1000): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.reconcileExpired();
      this.timer = setTimeout(loop, pollMs);
    };
    this.timer = setTimeout(loop, pollMs);
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
