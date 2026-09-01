/**
 * P06 durable, ordered, replayable event bus.
 * Events are committed before handlers run; each handler has a deadline.
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
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

export class EventBus {
  private readonly db: Database;
  private readonly handlerDeadlineMs: number;
  private readonly subscriptions = new Set<Subscription>();

  constructor(db?: Database, options: EventBusOptions = {}) {
    this.db = db ?? getDatabase();
    this.handlerDeadlineMs = options.handlerDeadlineMs ?? 100;
  }

  subscribe(handler: EventHandler, types?: readonly DomainEventType[]): () => void {
    const subscription: Subscription = {
      handler,
      types: types ? new Set(types) : null,
    };
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
  }

  async publish<T extends DomainEventType, P>(
    input: PublishEvent<T, P>,
  ): Promise<PersistedDomainEvent<T, P>> {
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
      .prepare(
        `INSERT INTO domain_event (
          id, type, payload_json, identity_id, cycle_id, timestamp,
          causation_id, correlation_id, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
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

    const persisted = { ...event, seq: Number(result.lastInsertRowid) };
    await this.deliver(persisted);
    return persisted;
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
    return rows.map((row) => this.mapRow(row));
  }

  async replayTo(handler: EventHandler, fromSequence = 0): Promise<void> {
    for (const event of this.replay(fromSequence)) {
      await this.runWithDeadline(handler, event);
    }
  }

  async deliver(event: PersistedDomainEvent): Promise<void> {
    const matching = [...this.subscriptions].filter(
      (subscription) => subscription.types === null || subscription.types.has(event.type),
    );
    await Promise.allSettled(
      matching.map((subscription) => this.runWithDeadline(subscription.handler, event)),
    );
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

  private mapRow(row: Record<string, unknown>): PersistedDomainEvent {
    return {
      seq: Number(row['seq']),
      id: row['id'] as string,
      type: row['type'] as DomainEventType,
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
