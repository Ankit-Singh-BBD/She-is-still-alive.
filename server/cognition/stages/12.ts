/**
 * Stage 12: PERSIST
 *
 * Atomic commit of every artifact produced by the cycle (Build Book Part VII.1
 * stage 12, Part X.4.3). The application — not the LLM — is the only thing
 * that may write to the durable record.
 *
 * What lands in the database inside a single transaction:
 *
 *   1. `cycle_record` — the cycle header (status + completed_at), updated to
 *      its terminal value. The row is created in `running` state at the start
 *      of the cycle; stage 12 closes it.
 *   2. `stage_trace` — one row per stage, already inserted by the runtime as
 *      it advances; stage 12 is the *commit* point, not a re-insert. The
 *      final transaction is what makes the cycle's trace durable in the
 *      presence of a crash.
 *   3. `domain_event` — an append-only ordered stream of events emitted by
 *      the cycle (Part VIII). One `cycle.completed` event is published per
 *      successful cycle; failures emit `cycle.failed`.
 *   4. `audit_log` — every disclosure decision collected into the cycle's
 *      `CycleAuditBuffer` by stage 9, persisted with the rest of the cycle
 *      so a cycle never splits its audit story across two writes.
 *
 * P10 rollback contract: with no learning delta, no action results, and no
 * audit entries, persist reports `eventsEmitted: 1` (the cycle.completed
 * event), `auditEntriesWritten: 0`, and `committedAt: Date.now()`. The
 * cycle is still closed; a missing stage 11/12 must not leave the cycle
 * `running`.
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import type {
  ActionResult,
  AuditEntry,
  AuthorizedDecision,
  AuthorizedLearningDelta,
  AuthorizedResponse,
  CycleStatus,
  StageTrace,
  UpdateResult,
  PersistResult,
} from '../types.js';

export interface PersistOptions {
  db?: Database | undefined;
  /** EventBus wired by the runtime; if absent, events are still written to
   * `domain_event` but not re-dispatched to any in-process subscriber. */
  eventBus?: EventBus | undefined;
}

export interface DomainEvent {
  type: string;
  payload: Record<string, unknown>;
  identityId?: string | undefined;
  cycleId?: string | undefined;
}

export interface PersistInput {
  cycleId: string;
  status: CycleStatus;
  completedAt: number;
  identityId: string;
  /** Action results to record as `action_result` domain events (one per tool). */
  actionResults: ActionResult[];
  /** Authorized decision — used to record the `cycle.decided` event payload. */
  decision: AuthorizedDecision | undefined;
  /** Authorized response — used to record the `cycle.responded` event payload. */
  response: AuthorizedResponse | undefined;
  /** Learning delta committed by stage 11 — used to record `cycle.learned`. */
  learningDelta: AuthorizedLearningDelta | undefined;
  /** Stage 11 outcome — used to record `cycle.updated`. */
  updateResult: UpdateResult | undefined;
  /** Disclosure / authorization decisions collected by the audit buffer. */
  audit: AuditEntry[];
  /** Stage traces recorded during the cycle. Persisted here so the cycle's
   * audit and trace are committed in a single transaction. */
  stages: StageTrace[];
}

export async function persist(
  input: PersistInput,
  opts: PersistOptions = {},
): Promise<PersistResult> {
  const db = opts.db;
  if (!db) {
    // Without a database the persist stage is a no-op; the rollback contract
    // still wants us to report the attempt rather than throw.
    return { cycleRecordId: input.cycleId, committedAt: Date.now(), eventsEmitted: 0 };
  }

  const events: DomainEvent[] = buildDomainEvents(input);
  const eventsEmitted = events.length;

  // One transaction: cycle close + audit entries + domain event stream. If any
  // insert throws, none of them land; the cycle keeps its `running` row and a
  // higher layer can retry.
  db.raw.transaction(() => {
    // 1. Close the cycle record.
    db.raw
      .prepare(
        `UPDATE cycle_record
            SET status = ?, completed_at = ?
          WHERE id = ?`,
      )
      .run(input.status, new Date(input.completedAt).toISOString(), input.cycleId);

    // 2. Persist stage traces.
    const insertTrace = db.raw.prepare(
      `INSERT INTO stage_trace
         (id, cycle_id, stage, stage_name, started_at, completed_at, input_json, output_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const trace of input.stages) {
      insertTrace.run(
        ulid(),
        input.cycleId,
        trace.stage,
        trace.stageName,
        new Date(trace.startedAt).toISOString(),
        trace.completedAt ? new Date(trace.completedAt).toISOString() : null,
        trace.inputJson,
        trace.outputJson ?? null,
        trace.error ?? null,
      );
    }

    // 3. Append audit log entries from the cycle's buffer.
    const insertAudit = db.raw.prepare(
      `INSERT INTO audit_log
         (id, actor_id, action, resource, decision, reason, metadata_json, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of input.audit) {
      insertAudit.run(
        ulid(),
        entry.actorId,
        entry.action,
        entry.resource,
        entry.decision,
        entry.reason ?? null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        new Date(entry.at).toISOString(),
      );
    }

    // 4. Append domain events to the ordered stream.
    const insertEvent = db.raw.prepare(
      `INSERT INTO domain_event
         (id, type, payload_json, identity_id, cycle_id, timestamp,
          causation_id, correlation_id, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ev of events) {
      insertEvent.run(
        ulid(),
        ev.type,
        JSON.stringify(ev.payload),
        ev.identityId ?? null,
        ev.cycleId ?? null,
        new Date(input.completedAt).toISOString(),
        null,
        null,
        1,
      );
    }
  })();

  // 4. Best-effort in-process delivery — never inside the transaction. The
  //    rows are already committed above; we just re-dispatch to in-memory
  //    subscribers. Delivery is explicitly separated from persistence so this
  //    stage does not double-insert into `domain_event` (EventBus.publish
  //    performs its own INSERT). A failed dispatch must not roll back the
  //    persisted record.
  if (opts.eventBus) {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const persisted = {
        id: ulid(),
        type: ev.type as any,
        payload: ev.payload,
        identityId: ev.identityId,
        cycleId: ev.cycleId,
        timestamp: input.completedAt,
        causationId: undefined,
        correlationId: undefined,
        version: 1 as const,
        seq: -1,
      } as any;
      try {
        await opts.eventBus.deliver(persisted);
      } catch {
        // The row is already committed; subscribers that miss an event recover
        // by replaying `domain_event` ordered by `seq`.
      }
    }
  }

  return {
    cycleRecordId: input.cycleId,
    committedAt: Date.now(),
    eventsEmitted,
  };
}

/**
 * Builds the canonical event stream for one cycle. The order is part of the
 * contract: a replay must show decide → act → verify → respond → learn →
 * update → completed, with `completed` always last.
 */
function buildDomainEvents(input: PersistInput): DomainEvent[] {
  const events: DomainEvent[] = [];
  const base = { identityId: input.identityId, cycleId: input.cycleId };

  if (input.decision) {
    events.push({
      type: 'cycle.decided',
      payload: {
        action: input.decision.proposal.action,
        authorized: input.decision.authorized,
        reason: input.decision.reason ?? null,
      },
      ...base,
    });
  }

  for (const result of input.actionResults) {
    events.push({
      type: 'cycle.action',
      payload: {
        toolId: result.toolId,
        success: result.success,
        verified: result.verified,
        error: result.error ?? null,
      },
      ...base,
    });
  }

  if (input.response) {
    events.push({
      type: 'cycle.responded',
      payload: {
        redacted: input.response.redacted,
        disclosuresApplied: input.response.disclosuresApplied,
      },
      ...base,
    });
  }

  if (input.learningDelta && input.learningDelta.memories.length > 0) {
    events.push({
      type: 'cycle.learned',
      payload: {
        extracted: input.learningDelta.memories.length,
        domains: countByDomain(input.learningDelta),
      },
      ...base,
    });
  }

  if (input.updateResult && (input.updateResult.applied > 0 || input.updateResult.errors.length > 0)) {
    events.push({
      type: 'cycle.updated',
      payload: {
        applied: input.updateResult.applied,
        skipped: input.updateResult.skipped,
        errors: input.updateResult.errors,
      },
      ...base,
    });
  }

  events.push({
    type: input.status === 'completed' ? 'cycle.completed' : 'cycle.failed',
    payload: {
      status: input.status,
      completedAt: input.completedAt,
    },
    ...base,
  });

  return events;
}

function countByDomain(delta: AuthorizedLearningDelta): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of delta.memories) {
    counts[m.domain] = (counts[m.domain] ?? 0) + 1;
  }
  return counts;
}
