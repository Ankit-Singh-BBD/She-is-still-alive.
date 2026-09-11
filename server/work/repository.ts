/**
 * B03 — Durable work repository. One requestId → one job, one failed write → no half-job.
 */
import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import {
  AcceptJobInputSchema,
  SCHEMA_VERSION,
  validateNoCycles,
  type AcceptJobInput,
  type WorkSnapshot,
} from './contracts.js';
import { createHash } from 'node:crypto';

function hashBytes(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export class WorkRepository {
  constructor(private readonly db: Database) {}

  accept(input: AcceptJobInput): { jobId: string; created: boolean } {
    const parsed = AcceptJobInputSchema.parse({ ...input, schemaVersion: SCHEMA_VERSION });
    const cycleErr = validateNoCycles(parsed.steps as { position: number; dependsOnPositions?: number[] }[]);
    if (cycleErr) throw new Error(cycleErr);
    for (const s of parsed.steps) {
      if ((s.maxAttempts ?? 3) > 10) throw new Error('maxAttempts exceeds 10');
    }

    // Idempotent acceptance — same (identityId, requestId) returns same job.
    const existing = this.db.raw
      .prepare(`SELECT id FROM work_job WHERE identity_id = ? AND request_id = ?`)
      .get(parsed.identityId, parsed.requestId) as { id: string } | undefined;
    if (existing) return { jobId: existing.id, created: false };

    const now = Date.now();
    const jobId = ulid();

    try {
      this.db.transaction(() => {
        this.db.raw
          .prepare(
            `INSERT INTO work_job (id, identity_id, request_id, goal, status, version, created_at, updated_at, deadline_at, max_runtime_ms, max_model_calls, model_calls_used, max_cost_units, cost_units_used, priority, schema_version)
             VALUES (?, ?, ?, ?, 'queued', 1, ?, ?, ?, ?, ?, 0, ?, 0, ?, 1)`,
          )
          .run(
            jobId,
            parsed.identityId,
            parsed.requestId,
            parsed.goal,
            now,
            now,
            parsed.deadlineAt ?? null,
            parsed.maxRuntimeMs ?? null,
            parsed.maxModelCalls ?? null,
            parsed.maxCostUnits ?? null,
            parsed.priority ?? 0.5,
          );

        const posToId = new Map<number, string>();
        for (const s of parsed.steps) {
          const stepId = ulid();
          posToId.set(s.position, stepId);
          this.db.raw
            .prepare(
              `INSERT INTO work_step (id, job_id, position, tool_id, input_json, status, version, next_eligible_at, max_attempts, fence, schema_version)
               VALUES (?, ?, ?, ?, ?, 'pending', 1, 0, ?, 0, 1)`,
            )
            .run(stepId, jobId, s.position, s.toolId, s.inputJson, s.maxAttempts ?? 3);
        }
        for (const s of parsed.steps) {
          for (const dep of s.dependsOnPositions ?? []) {
            const stepId = posToId.get(s.position) as string;
            const depId = posToId.get(dep) as string;
            this.db.raw.prepare(`INSERT INTO work_dependency (step_id, depends_on) VALUES (?, ?)`).run(stepId, depId);
          }
        }
        // Outbox for accepted — published after commit via coordinator.
        this.db.raw
          .prepare(
            `INSERT INTO work_outbox (id, job_id, job_version, type, payload_json, created_at) VALUES (?, ?, 1, 'work.accepted', ?, ?)`,
          )
          .run(ulid(), jobId, JSON.stringify({ requestId: parsed.requestId, goal: parsed.goal }), now);
      });
    } catch (err) {
      // Concurrent accept with same (identity_id, request_id) races past the
      // pre-check above; UNIQUE(identity_id, request_id) then throws.
      // Treat as idempotent success — return the winner's id.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE') || msg.includes('unique') || msg.includes('constraint')) {
        const winner = this.db.raw
          .prepare(`SELECT id FROM work_job WHERE identity_id = ? AND request_id = ?`)
          .get(parsed.identityId, parsed.requestId) as { id: string } | undefined;
        if (winner) return { jobId: winner.id, created: false };
      }
      throw err;
    }

    return { jobId, created: true };
  }

  getSnapshot(jobId: string): WorkSnapshot | null {
    const job = this.db.raw.prepare(`SELECT * FROM work_job WHERE id = ?`).get(jobId) as Record<string, unknown> | undefined;
    if (!job) return null;
    const steps = this.db.raw.prepare(`SELECT * FROM work_step WHERE job_id = ? ORDER BY position ASC`).all(jobId) as Record<string, unknown>[];
    const artifacts = this.db.raw
      .prepare(`SELECT * FROM work_artifact WHERE job_id = ? ORDER BY created_at ASC`)
      .all(jobId) as Record<string, unknown>[];
    return {
      schemaVersion: 1,
      job: this.mapJob(job),
      steps: steps.map((s) => this.mapStep(s)),
      artifacts: artifacts.map((a) => this.mapArtifact(a)),
      blockers: [],
      allowedControls: this.allowedControls(String(job['status'] ?? '')),
    };
  }

  /**
   * Conditional update guarded by version — callers pass expectedVersion, 409 on mismatch.
   * Prevents stale expectedVersion overwriting newer state (B03 gate).
   */
  updateJobStatus(jobId: string, expectedVersion: number, nextStatus: string): boolean {
    const res = this.db.raw
      .prepare(`UPDATE work_job SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
      .run(nextStatus, Date.now(), jobId, expectedVersion);
    return res.changes > 0;
  }

  persistArtifact(
    jobId: string,
    stepId: string,
    content: string,
    kind: string,
    mediaType: string,
    /** When set, appends a new version of that artifact. Otherwise creates a new logical artifact. */
    artifactId?: string,
  ): { artifactId: string; version: number } {
    const hash = hashBytes(content);
    let targetId = artifactId;
    let version: number;
    if (targetId) {
      const row = this.db.raw
        .prepare(`SELECT MAX(version) AS v FROM work_artifact WHERE artifact_id = ?`)
        .get(targetId) as { v: number | null } | undefined;
      version = ((row?.v as number | null) ?? 0) + 1;
    } else {
      targetId = ulid();
      version = 1;
    }
    const contentRef = `artifact://${targetId}/v${version}`;
    this.db.raw
      .prepare(
        `INSERT INTO work_artifact (artifact_id, version, job_id, step_id, kind, media_type, content_hash, content_ref, created_at, verification_status, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1)`,
      )
      .run(targetId, version, jobId, stepId, kind, mediaType, hash, contentRef, Date.now());
    return { artifactId: targetId, version };
  }

  verifyArtifactBytes(artifactId: string, version: number, bytes: string): boolean {
    const row = this.db.raw
      .prepare(`SELECT content_hash FROM work_artifact WHERE artifact_id = ? AND version = ?`)
      .get(artifactId, version) as { content_hash: string } | undefined;
    if (!row) return false;
    return hashBytes(bytes) === row.content_hash;
  }

  private mapJob(r: Record<string, unknown>): WorkSnapshot['job'] {
    return {
      id: String(r['id']),
      identityId: String(r['identity_id']),
      requestId: String(r['request_id']),
      goal: String(r['goal']),
      status: String(r['status']) as WorkSnapshot['job']['status'],
      version: Number(r['version']),
      createdAt: Number(r['created_at']),
      updatedAt: Number(r['updated_at']),
      deadlineAt: r['deadline_at'] !== null ? Number(r['deadline_at']) : null,
      maxRuntimeMs: r['max_runtime_ms'] !== null ? Number(r['max_runtime_ms']) : null,
      maxModelCalls: r['max_model_calls'] !== null ? Number(r['max_model_calls']) : null,
      modelCallsUsed: Number(r['model_calls_used']),
      maxCostUnits: r['max_cost_units'] !== null ? Number(r['max_cost_units']) : null,
      costUnitsUsed: Number(r['cost_units_used']),
      priority: Number(r['priority']),
      controlIntent: (r['control_intent'] as 'cancel' | 'pause' | null) ?? null,
      schemaVersion: 1,
    };
  }

  private mapStep(r: Record<string, unknown>): WorkSnapshot['steps'][number] {
    return {
      id: String(r['id']),
      jobId: String(r['job_id']),
      position: Number(r['position']),
      toolId: String(r['tool_id']),
      inputJson: String(r['input_json']),
      status: String(r['status']) as WorkSnapshot['steps'][number]['status'],
      version: Number(r['version']),
      nextEligibleAt: Number(r['next_eligible_at']),
      maxAttempts: Number(r['max_attempts']),
      leaseOwner: (r['lease_owner'] as string | null) ?? null,
      leaseExpiresAt: r['lease_expires_at'] !== null ? Number(r['lease_expires_at']) : null,
      fence: Number(r['fence']),
      schemaVersion: 1,
    };
  }

  private mapArtifact(r: Record<string, unknown>): WorkSnapshot['artifacts'][number] {
    return {
      artifactId: String(r['artifact_id']),
      version: Number(r['version']),
      jobId: String(r['job_id']),
      stepId: String(r['step_id']),
      kind: String(r['kind']),
      mediaType: String(r['media_type']),
      contentHash: String(r['content_hash']),
      contentRef: String(r['content_ref']),
      createdAt: Number(r['created_at']),
      verificationStatus: String(r['verification_status']) as WorkSnapshot['artifacts'][number]['verificationStatus'],
      schemaVersion: 1,
    };
  }

  private allowedControls(status: string): WorkSnapshot['allowedControls'] {
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return [];
    if (status === 'paused') return ['resume', 'cancel'];
    return ['pause', 'cancel'];
  }
}
