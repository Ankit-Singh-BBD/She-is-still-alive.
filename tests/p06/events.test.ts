import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { EventBus } from '@server/events/event-bus.js';
import type { PersistedDomainEvent } from '@server/events/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('Phase P06: Event System', () => {
  let db: Database;
  let bus: EventBus;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    bus = new EventBus(db, { handlerDeadlineMs: 50 });
  });

  it('persists the domain_event table on migration', () => {
    const row = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='domain_event'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('domain_event');
  });

  it('publishes a single event and dispatches to subscribers in order', async () => {
    const seen: string[] = [];
    bus.subscribe((e) => {
      seen.push(e.type);
    }, undefined);

    const ev = await bus.publish({
      type: 'memory.appended',
      payload: { kind: 'episodic' },
    });

    expect(seen).toEqual(['memory.appended']);
    expect(ev.seq).toBeGreaterThan(0);
  });

  it('orders events by sequence number across multiple publishes', async () => {
    const order: number[] = [];
    bus.subscribe((e) => {
      order.push(e.seq);
    });

    await bus.publish({ type: 'cycle.started', payload: { i: 1 } });
    await bus.publish({ type: 'cycle.stage.completed', payload: { i: 2 } });
    await bus.publish({ type: 'cycle.completed', payload: { i: 3 } });

    expect(order).toEqual([1, 2, 3]);
  });

  it('replays all events in order from sequence 0', async () => {
    await bus.publish({ type: 'boot.completed', payload: {} });
    await bus.publish({ type: 'cycle.started', payload: { id: 'c1' } });
    await bus.publish({ type: 'cycle.completed', payload: { id: 'c1' } });

    const replayed = bus.replay(0);
    expect(replayed).toHaveLength(3);
    expect(replayed.map((e) => e.type)).toEqual([
      'boot.completed',
      'cycle.started',
      'cycle.completed',
    ]);
    expect(replayed[0]?.seq).toBe(1);
    expect(replayed[2]?.seq).toBe(3);
  });

  it('replays to a fresh subscriber reaching the same state', async () => {
    await bus.publish({ type: 'memory.appended', payload: { a: 1 } });
    await bus.publish({ type: 'memory.appended', payload: { a: 2 } });

    const seen: number[] = [];
    await bus.replayTo((e) => {
      seen.push((e.payload as { a: number }).a);
    });

    expect(seen).toEqual([1, 2]);
  });

  it('replays only from a given starting sequence', async () => {
    await bus.publish({ type: 'memory.appended', payload: { i: 1 } });
    await bus.publish({ type: 'memory.appended', payload: { i: 2 } });
    await bus.publish({ type: 'memory.appended', payload: { i: 3 } });

    const from2 = bus.replay(1);
    expect(from2).toHaveLength(2);
    expect(from2[0]?.seq).toBe(2);
  });

  it('filters by event type for subscribers', async () => {
    const memoryEvents: PersistedDomainEvent[] = [];
    bus.subscribe(
      (e) => {
        memoryEvents.push(e);
      },
      ['memory.appended'],
    );

    await bus.publish({ type: 'memory.appended', payload: { n: 1 } });
    await bus.publish({ type: 'cycle.started', payload: { n: 2 } });
    await bus.publish({ type: 'memory.appended', payload: { n: 3 } });

    expect(memoryEvents.map((e) => e.type)).toEqual([
      'memory.appended',
      'memory.appended',
    ]);
  });

  it('a slow handler does not block the bus or other handlers', async () => {
    const start = Date.now();
    let fastFinished = false;

    bus.subscribe(async () => {
      // Slow handler: never resolves within deadline
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });

    bus.subscribe(() => {
      fastFinished = true;
    });

    await bus.publish({ type: 'memory.appended', payload: { n: 1 } });

    // The fast handler should run well before the slow handler's 1s timeout
    expect(fastFinished).toBe(true);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('round-trips payloads through JSON with faithful shape', async () => {
    const payload = { tag: 'complex', list: [1, 2, 3], nested: { a: 'b' } };
    const ev = await bus.publish({ type: 'memory.appended', payload });

    const replayed = bus.replay(0)[0];
    expect(replayed?.payload).toEqual(payload);
    expect(ev.payload).toEqual(payload);
  });

  it('maintains the order guarantee: subscribers see events in seq order', async () => {
    const delivered: number[] = [];
    bus.subscribe((e) => {
      delivered.push(e.seq);
    });

    for (let i = 0; i < 10; i++) {
      await bus.publish({ type: 'action.executed', payload: { i } });
    }

    expect(delivered).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
