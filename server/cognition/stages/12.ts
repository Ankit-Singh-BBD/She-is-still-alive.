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
 *   5. `message` — the conversation's turns: what was said to her, and the
 *      response stage 9 authorized. Here rather than in a writer of its own for
 *      the same reason as the audit entries: a cycle that committed its trace
 *      and lost its transcript would leave her remembering that she answered
 *      without any record of what she answered.
 *
 * P10 rollback contract: with no learning delta, no action results, and no
 * audit entries, persist reports `eventsEmitted: 1` (the cycle.completed
 * event), `auditEntriesWritten: 0`, and `committedAt: Date.now()`. The
 * cycle is still closed; a missing stage 11/12 must not leave the cycle
 * `running`.
 */

import { ulid } from '@server/persistence/ids.js';
import { appendTurns, type TurnDraft } from '@server/conversations/messages.js';
import type { Database } from '@server/persistence/db.js';
import { EventBus } from '@server/events/event-bus.js';
import type { DomainEventType, PersistedDomainEvent } from '@server/events/types.js';
import { appendAuditEntries } from '@server/security/audit.js';
import type { InterruptionCause } from '../gate.js';
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
  type: DomainEventType;
  payload: Record<string, unknown>;
  identityId?: string | undefined;
  cycleId?: string | undefined;
}

export interface PersistInput {
  cycleId: string;
  status: CycleStatus;
  /**
   * Stage failures the cycle survived via fallback, joined into one string.
   * Persisted on `cycle_record.error` so a `degraded` row says what degraded.
   */
  error?: string | undefined;
  completedAt: number;
  /**
   * When the cycle began, carried onto the terminal event.
   *
   * A subscriber that wants to say "she thought about this for 1.8 seconds" would
   * otherwise have to remember `cycle.started` and pair the two by id, and any
   * subscriber that came up mid-cycle could not.
   */
  startedAt: number;
  identityId: string;
  /**
   * The conversation this cycle belongs to, already resolved by the runtime.
   *
   * Required, and not read off the stimulus: `message.conversation_id` is a
   * foreign key, and the stimulus is allowed to arrive without a conversation
   * (the runtime opens one). Taking the resolved id here is what stops the
   * transcript being written against a guess.
   */
  conversationId: string;
  /**
   * What was said and what she answered, in order. Written inside this stage's
   * transaction. Empty when the stimulus carried no text and no response was
   * authorized — a system trigger, say — which is a cycle with nothing to
   * transcribe rather than a failure.
   */
  turns: readonly TurnDraft[];
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
  /**
   * Set exactly when a later stimulus displaced this cycle (Build Book VII.5),
   * which is also the only way `status` is ever `'interrupted'`.
   *
   * Carried this far so the cancellation is in the durable log rather than
   * inferred from a short trace list: VII.5 requires it be recorded and "never
   * silently dropped", and the two cycles name each other.
   */
  interruption?: InterruptionCause | undefined;
}

export async function persist(
  input: PersistInput,
  opts: PersistOptions = {},
): Promise<PersistResult> {
  const db = opts.db;
  if (!db) {
    // Without a database the persist stage is a no-op; the rollback contract
    // still wants us to report the attempt rather than throw.
    return {
      cycleRecordId: input.cycleId,
      committedAt: Date.now(),
      eventsEmitted: 0,
      turnsWritten: 0,
    };
  }

  const events: DomainEvent[] = buildDomainEvents(input);
  const eventsEmitted = events.length;
  let turnsWritten = 0;
  /**
   * The identity and sequence number each event actually landed with, in the
   * order they were written.
   *
   * Collected inside the transaction because that is the only place they exist:
   * `seq` is `domain_event`'s `INTEGER PRIMARY KEY`, so it is assigned by the
   * insert and is not knowable before it. The in-process re-dispatch below used
   * to invent `seq: -1` and a fresh `ulid()` instead of reading these back,
   * which broke two things that both look like they work:
   *
   *  - `RealtimeFlow` sets `RuntimeState.version = event.seq`, so every cycle
   *    drove the version *backwards* to -1 — a counter documented as monotonic
   *    that was not.
   *  - `SseSubscriber` writes `id: <seq>`, which is what `EventSource` echoes as
   *    `Last-Event-ID`. With -1 on the wire a reconnecting client asked to be
   *    replayed from -1, `replayMissed` read that as "no useful cursor" and sent
   *    nothing, and the client silently lost every event of the cycle it
   *    disconnected during. The comment below promised exactly that recovery.
   */
  const written: { id: string; seq: number }[] = [];

  /**
   * Who writes the event rows.
   *
   * The runtime's bus when there is one, and a subscriber-less bus over the same
   * database when there is not — `append` only writes, so the fallback produces
   * byte-identical rows and simply delivers to nobody, which is exactly what the
   * no-bus contract above says happens.
   */
  const eventWriter = opts.eventBus ?? new EventBus(db);

  // One transaction: cycle close + audit entries + domain event stream. If any
  // insert throws, none of them land; the cycle keeps its `running` row and a
  // higher layer can retry.
  db.raw.transaction(() => {
    // 1. Close the cycle record.
    //
    // The verdict is written here and not left to `stage_trace`. A trace row is keyed
    // by stage number and kept for tracing; the cycle's own decision and answer are
    // what anything reading the cycle back needs — the consolidation sweep, which
    // builds the learning prompt from them, and her own account of a turn whose
    // runtime no longer exists. `output_json` had been declared since the first
    // schema and filled by nothing.
    db.raw
      .prepare(
        `UPDATE cycle_record
            SET status = ?, completed_at = ?, error = ?, decision_json = ?, output_json = ?
          WHERE id = ?`,
      )
      .run(
        input.status,
        new Date(input.completedAt).toISOString(),
        input.error ?? null,
        input.decision === undefined ? null : JSON.stringify(input.decision),
        input.response === undefined ? null : JSON.stringify(input.response),
        input.cycleId,
      );

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
    //
    // Through `appendAuditEntries`, not a local INSERT: this stage used to
    // write eight columns and leave `seq`/`prev_hash`/`entry_hash` NULL, so
    // every disclosure decision a cycle recorded was unchained — no tamper
    // evidence, and `verifyIntegrity()` reports it as an error. The helper
    // requires the open transaction we are already inside, which is what keeps
    // the cycle's audit entries committed together with its other artifacts.
    appendAuditEntries(
      db,
      input.audit.map((entry) => ({
        actorId: entry.actorId,
        action: entry.action,
        resource: entry.resource,
        decision: entry.decision,
        reason: entry.reason ?? null,
        metadata: entry.metadata ?? null,
        timestamp: entry.at,
      })),
    );

    // 4. Append the conversation's turns.
    //
    // Inside this transaction, through the transcript module's own writer, so
    // the SQL lives next to the reader stage 3 uses rather than being spelled
    // out twice. `appendTurns` skips an empty line and returns what it wrote, so
    // the count below is rows and not intentions.
    turnsWritten = appendTurns(db, input.conversationId, input.turns).length;

    // 5. Append domain events to the ordered stream.
    //
    // Through `EventBus.append`, which is synchronous precisely so it can be called
    // from inside this transaction — the nine-column INSERT used to be spelled out
    // here as well as in the bus, so a migration adding a column would have updated
    // one of them. What `append` does not do is deliver; that is step 6, after the
    // commit, and the separation is the point.
    for (const ev of events) {
      const row = eventWriter.append({
        type: ev.type,
        payload: ev.payload,
        identityId: ev.identityId,
        cycleId: ev.cycleId,
        timestamp: input.completedAt,
      });
      written.push({ id: row.id, seq: row.seq });
    }
  })();

  // 6. Best-effort in-process delivery — never inside the transaction. The
  //    rows are already committed above; we just re-dispatch to in-memory
  //    subscribers. Delivery is explicitly separated from persistence so this
  //    stage does not double-insert into `domain_event` (EventBus.publish
  //    performs its own INSERT). A failed dispatch must not roll back the
  //    persisted record.
  //
  //    What is dispatched is the row, not a copy of the intention: the `id` and
  //    `seq` are the ones the insert assigned, so a subscriber that keeps
  //    `lastMutation.eventId` names a row that exists and a client that echoes
  //    `Last-Event-ID` names a cursor `EventBus.replay` can honour.
  if (opts.eventBus) {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      const row = written[i];
      if (row === undefined) continue;
      const persisted: PersistedDomainEvent = {
        id: row.id,
        type: ev.type,
        payload: ev.payload,
        identityId: ev.identityId,
        cycleId: ev.cycleId,
        timestamp: input.completedAt,
        causationId: undefined,
        correlationId: undefined,
        version: 1 as const,
        seq: row.seq,
      };
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
    turnsWritten,
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
    // `proposal.action` is what will be *carried out*, which on a refusal is the
    // `clarify` fallback. Reporting only that made a denied tool call replay as a
    // clarification nobody asked for, and left a subscriber watching for refusals
    // with nothing to watch. `proposed` is what she actually put forward, and
    // `clearance` says which of the four things the gate did.
    events.push({
      type: 'cycle.decided',
      payload: {
        action: input.decision.proposal.action,
        proposed: (input.decision.refusedProposal ?? input.decision.proposal).action,
        authorized: input.decision.authorized,
        clearance: input.decision.clearance.kind,
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
        // `attempted` alongside `success`, because a subscriber reading only the
        // latter cannot tell a refusal from a call that went out and threw — and the
        // event log is where that question gets asked long after the cycle is gone.
        attempted: result.attempted,
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

  // The terminal event, one per cycle.
  //
  // For an interrupted cycle this *is* the interruption event: `cycle.interrupted`
  // has been a declared event type with no publisher since P06, and this is it.
  // The cause rides on the terminal payload rather than on a second event of the
  // same type — emitting both would make one interrupted cycle replay as two
  // interruptions, and double-count for any subscriber tallying them.
  events.push({
    // 'degraded' is a real outcome, not a success: the cycle answered, but a
    // stage failed on the way. It reports as `cycle.degraded` so subscribers
    // (and she herself) can tell the difference. 'interrupted' is not a failure
    // either — it is a cycle that was correctly abandoned.
    type:
      input.status === 'completed'
        ? 'cycle.completed'
        : input.status === 'degraded'
          ? 'cycle.degraded'
          : input.status === 'interrupted'
            ? 'cycle.interrupted'
            : 'cycle.failed',
    payload: {
      status: input.status,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      // There is no `endedAtStage` here. It was written as the constant `'PERSIST'`,
      // and a field that is always a constant is not state: every terminal event is
      // published from inside this transaction, so *holding one* is already proof
      // PERSIST ran, whatever the outcome. `server/http/state.ts` reads it that way
      // and needs nothing from the payload to do so.
      //
      // What a reader actually wants from a `cycle.degraded` — which stage threw — is
      // not this field either. That is in the cycle's `stage_trace` rows, and in the
      // `fellBackAt` list the caller is handed.
      //
      // Present exactly when a later stimulus displaced this cycle, so a replay
      // shows *what* stopped it and how far it got — not merely that it stopped.
      ...(input.interruption
        ? {
            interruptedBy: {
              byCycleId: input.interruption.byCycleId,
              bySource: input.interruption.bySource,
              at: input.interruption.at,
            },
            stagesCompleted: input.stages.filter((s) => s.error === undefined).length,
          }
        : {}),
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
