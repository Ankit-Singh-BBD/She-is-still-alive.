/**
 * The durable, ordered stream of everything that happened.
 *
 * Book VIII.3: an event is **committed before any handler runs**, delivery is
 * **bounded**, and the log is **replayable by `seq`**. All three are load-bearing, and
 * two of them constrain this file in ways that are easy to undo by accident.
 *
 * ## Append and deliver are two operations, on purpose
 *
 * `publish` is `append` followed by `deliver`. They are separable because Book IX.5
 * requires a mutation and its event to land together — *"Every mutation is a
 * transaction. Transactions include: all table writes for the mutation, the
 * corresponding `domain_event` append… The system never has a partial state."*
 *
 * `publish` cannot satisfy that. It is `async`, and `better-sqlite3`'s
 * `db.transaction()` is synchronous — an `await` inside one is not inside it at all —
 * so a caller doing `INSERT INTO task …` and then `await publish('task.scheduled')`
 * has written two autocommits. A crash between them leaves a task row that no
 * projection ever counted: `/api/state` reads `pendingCount` from the table while the
 * live count came from the event, and the two disagree until a restart.
 *
 * So `append` is **synchronous** and returns the row's real `id` and `seq`. A writer
 * calls it inside its own `db.raw.transaction()`, and calls `deliver` after the
 * commit. `server/cognition/stages/12.ts` already did exactly this by hand, with its
 * own copy of the nine-column INSERT; it now calls `append` and the column list exists
 * once.
 *
 * ## A handler that throws is reported, never swallowed
 *
 * `deliver` fans out with `Promise.allSettled` — one subscriber must not be able to
 * fail another, and must not fail the publisher, which is what "bounded" means. But
 * the results used to be discarded: `await Promise.allSettled(...)` with the array
 * unbound. So when `RuntimeStateProjector.project` threw, `flow.currentState` froze,
 * `GET /api/state` and the SSE stream served that frozen snapshot indefinitely, and
 * nothing anywhere said so. `RealtimeFlow` carried a comment claiming the opposite —
 * *"A throwing projector is not caught"* — and it was true of that file and false one
 * layer up.
 *
 * `report` is the same seam `RealtimeFlow` has, defaulting to `console.error`. It is
 * the only thing here that writes anywhere but the table.
 *
 * ## Why the type is checked on the way in and on the way out
 *
 * Book VIII.3 promises *"untyped events are rejected at the boundary"*. `mapRow` used
 * to do `row['type'] as DomainEventType` — a cast, not a check — and
 * `loops/manager.ts` does the same to a trigger spec read from the database. A loop
 * subscribed to a string that is not an event type is a loop that silently never
 * fires. `DOMAIN_EVENT_TYPES` makes the union checkable at runtime, and it is derived
 * from the same list `EVENT_TOUCHES` is keyed by.
 */

import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import { isDomainEventType } from './types.js';
import type {
  DomainEvent,
  DomainEventType,
  EventBusOptions,
  EventHandler,
  PersistedDomainEvent,
  PublishEvent,
} from './types.js';

interface Subscription {
  types: ReadonlySet<DomainEventType> | null;
  handler: EventHandler;
}

const INSERT_EVENT = `INSERT INTO domain_event (
  id, type, payload_json, identity_id, cycle_id, timestamp,
  causation_id, correlation_id, version
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class EventBus {
  private readonly db: Database;
  private readonly handlerDeadlineMs: number;
  private readonly report: (what: string, error: unknown) => void;
  private readonly subscriptions = new Set<Subscription>();

  constructor(db?: Database, options: EventBusOptions = {}) {
    this.db = db ?? getDatabase();
    this.handlerDeadlineMs = options.handlerDeadlineMs ?? 100;
    this.report =
      options.report ??
      ((what, error) => {
        console.error(`[events] ${what}:`, error);
      });
  }

  /**
   * @param types the event types this handler wants, or all of them when omitted.
   * @throws if a type is not a `DomainEventType` — a subscription to a name nothing
   *   can ever publish is silence the subscriber cannot distinguish from "it has not
   *   happened yet", and the caller is usually passing a string from the database.
   */
  subscribe(handler: EventHandler, types?: readonly DomainEventType[]): () => void {
    for (const type of types ?? []) {
      if (!isDomainEventType(type)) {
        throw new Error(`Cannot subscribe to '${String(type)}': not a domain event type`);
      }
    }
    const subscription: Subscription = {
      handler,
      types: types ? new Set(types) : null,
    };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }

  /**
   * Writes the event and hands it to every matching subscriber.
   *
   * For a write that must land with a table mutation, use `append` inside the
   * caller's transaction and `deliver` after it commits. See the header.
   */
  async publish<T extends DomainEventType, P>(
    input: PublishEvent<T, P>,
  ): Promise<PersistedDomainEvent<T, P>> {
    const persisted = this.append(input);
    await this.deliver(persisted);
    return persisted;
  }

  /**
   * Writes one event and returns the row, without delivering it.
   *
   * Synchronous so it can be called inside `db.raw.transaction(...)` — that is the
   * entire reason it exists. Delivering is then the caller's job, after the commit.
   */
  append<T extends DomainEventType, P>(input: PublishEvent<T, P>): PersistedDomainEvent<T, P> {
    const event: DomainEvent<T, P> = {
      id: ulid(),
      type: input.type,
      payload: input.payload,
      identityId: input.identityId,
      cycleId: input.cycleId,
      timestamp: input.timestamp ?? Date.now(),
      causationId: input.causationId,
      correlationId: input.correlationId,
      version: input.version ?? 1,
    };

    const result = this.db.raw
      .prepare(INSERT_EVENT)
      .run(
        event.id,
        event.type,
        JSON.stringify(event.payload),
        event.identityId ?? null,
        event.cycleId ?? null,
        new Date(event.timestamp).toISOString(),
        event.causationId ?? null,
        event.correlationId ?? null,
        event.version,
      );

    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  replay(fromSequence = 0, limit?: number): PersistedDomainEvent[] {
    const query = `SELECT seq, id, type, payload_json, identity_id, cycle_id,
                          timestamp, causation_id, correlation_id, version
                   FROM domain_event
                   WHERE seq > ?
                   ORDER BY seq ASC${limit === undefined ? '' : ' LIMIT ?'}`;
    const rows = (limit === undefined
      ? this.db.raw.prepare(query).all(fromSequence)
      : this.db.raw.prepare(query).all(fromSequence, limit)) as Record<string, unknown>[];
    return rows.map((row) => this.mapRow(row)).filter((event): event is PersistedDomainEvent => event !== undefined);
  }

  /** The highest `seq` written, or 0 for an empty log. Where a boot replay starts from. */
  lastSequence(): number {
    const row = this.db.raw.prepare(`SELECT MAX(seq) AS seq FROM domain_event`).get() as
      | { seq: number | null }
      | undefined;
    return Number(row?.seq ?? 0);
  }

  /**
   * Hands one already-written event to every matching subscriber.
   *
   * Never rejects: one handler's failure must not fail the publisher or the other
   * handlers. Every rejection is reported instead — which is the difference between a
   * projector that broke and a projector nobody noticed had broken.
   */
  async deliver(event: PersistedDomainEvent): Promise<void> {
    const matching = [...this.subscriptions].filter(
      (subscription) => subscription.types === null || subscription.types.has(event.type),
    );
    const settled = await Promise.allSettled(
      matching.map((subscription) => this.runWithDeadline(subscription.handler, event)),
    );
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        this.report(`subscriber of ${event.type} (event ${event.id})`, outcome.reason);
      }
    }
  }

  private async runWithDeadline(handler: EventHandler, event: PersistedDomainEvent): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => handler(event)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.handlerDeadlineMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * A row as an event, or `undefined` when the row is not one.
   *
   * A `type` no longer in the union means the log outlived a rename. Skipping it and
   * saying so is the honest reading: casting it would hand a subscriber an event whose
   * name it will never match, and throwing would make one bad row stop a replay of
   * every good one after it.
   */
  private mapRow(row: Record<string, unknown>): PersistedDomainEvent | undefined {
    const type = row['type'];
    if (!isDomainEventType(type)) {
      this.report(`event ${String(row['id'])} in the log`, new Error(`Unknown type '${String(type)}'`));
      return undefined;
    }
    return {
      seq: Number(row['seq']),
      id: row['id'] as string,
      type,
      payload: JSON.parse(row['payload_json'] as string) as unknown,
      identityId: (row['identity_id'] as string | null) ?? undefined,
      cycleId: (row['cycle_id'] as string | null) ?? undefined,
      timestamp: new Date(row['timestamp'] as string).getTime(),
      causationId: (row['causation_id'] as string | null) ?? undefined,
      correlationId: (row['correlation_id'] as string | null) ?? undefined,
      version: Number(row['version']),
    };
  }
}
