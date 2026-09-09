/**
 * The realtime contract of Build Book XVI, driven through a real event bus.
 *
 * `RealtimeFlow` is stage 4 of XVI.1 — the one place `RuntimeState` advances — plus
 * the UI edge out of it. So everything asserted here is one of two things: what the
 * state says after an event, and what one client is handed.
 *
 * ## What is deliberately not here
 *
 * The three "Disconnect/Reconnect Replay via fromSequence" cases this file used to
 * carry called `eventBus.replayTo` and never touched the flow: they tested the bus
 * through a variable that happened to be in scope. Replay from a sequence number is
 * `EventBus`'s own contract and is covered in `tests/p06/events.test.ts`; the end of
 * the wire a browser actually reconnects on — `Last-Event-ID`, bounded, against a
 * version that must not run backwards — is `tests/http/transport.test.ts` ('replays
 * only the events a reconnecting client missed', 'never sends a version that goes
 * backwards, or an id a replay cannot use').
 *
 * The 50ms window's own value is `tests/p26/perf.test.ts`, along with the plain
 * same-key collapse. Everything below runs with `coalesceWindowMs: 0`, which still
 * collapses a synchronous burst — the drain lands on a microtask, so a producer
 * cannot outrun it within one tick — without making a test sleep to see a frame.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

import { EventBus } from '@server/events/event-bus.js';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { RealtimeFlow } from '@server/realtime/flow.js';
import type { BroadcastMessage, RuntimeState, Subscriber } from '@server/realtime/types.js';

const migrationsDir = path.join(path.resolve(__dirname, '..', '..'), 'server/persistence/migrations');

/**
 * A `RuntimeState` with nothing in it, built by hand on purpose.
 *
 * The flow must work with no database behind the state — `project` is an option, not
 * a dependency — and that is the configuration every case below runs in except the
 * one that passes the hook. Every count is zero because nothing has happened yet,
 * and `lastCompletedStage` is `undefined` rather than a stage name for the same
 * reason: naming one before a cycle has run reports work nobody did.
 */
function emptyState(): RuntimeState {
  const enrolled = Date.UTC(2026, 8, 5, 9, 0, 0);
  return {
    version: 0,
    identity: {
      id: 'owner',
      kind: 'owner',
      displayName: 'Owner',
      enrolledAt: enrolled,
      lastSeenAt: enrolled,
      status: 'active',
    },
    presence: { activeActor: 'owner', recentActors: ['owner'], sessionStartedAt: enrolled },
    environment: {
      timeOfDay: 'day',
      weather: { condition: 'unknown' },
      derivedPalette: { primary: '#0b0b0c', secondary: '#17171a', accent: '#8a8f98' },
    },
    cognitive: {
      currentStage: 'PERCEIVE',
      cycleId: '',
      cycleStartedAt: 0,
      lastCompletedStage: undefined,
    },
    voice: { live: 'disconnected', reason: '', canHear: false },
    memory: {
      episodicCount: 0,
      semanticCount: 0,
      preferenceCount: 0,
      habitCount: 0,
      relationshipCount: 0,
      learnedPatternCount: 0,
      lastConsolidationAt: 0,
    },
    loops: { activeCount: 0, pausedCount: 0 },
    tasks: { pendingCount: 0, runningCount: 0, failedCount: 0 },
    lastMutation: { eventId: '', type: '', timestamp: 0 },
  };
}

interface Recorder extends Subscriber {
  /** Every message this subscriber was handed, in the order it was handed them. */
  readonly seen: BroadcastMessage[];
  /** How many times a `send` began while another was still in flight. Must stay 0. */
  readonly overlaps: () => number;
  /** From now on every `send` blocks until {@link Recorder.release}. */
  hold: () => void;
  release: () => void;
  /** The next `send` rejects with this, once — a socket that has gone. */
  rejectNext: (error: Error) => void;
}

/**
 * A client that remembers what it received, and can stall or fail on demand.
 *
 * `overlaps` is the part that is not bookkeeping: two drains over one queue would not
 * duplicate a message, they would interleave their awaits and write frames in an
 * order neither of them chose. A subscriber is the only place that is observable.
 */
function recorder(id: string): Recorder {
  const seen: BroadcastMessage[] = [];
  let inFlight = 0;
  let overlapped = 0;
  let holding = false;
  let release: (() => void) | undefined;
  let rejection: Error | undefined;

  return {
    id,
    seen,
    async send(message: BroadcastMessage): Promise<void> {
      seen.push(message);
      inFlight += 1;
      if (inFlight > 1) overlapped += 1;
      try {
        if (rejection !== undefined) {
          const error = rejection;
          rejection = undefined;
          throw error;
        }
        if (holding) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      } finally {
        inFlight -= 1;
      }
    },
    overlaps: () => overlapped,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      release?.();
      release = undefined;
    },
    rejectNext: (error: Error) => {
      rejection = error;
    },
  };
}

/** One turn of the loop: enough for a zero-window drain and the sends inside it. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('P20: RealtimeFlow — stage 4 of the XVI.1 chain, and the UI edge out of it', () => {
  let db: Database;
  let eventBus: EventBus;
  let flow: RealtimeFlow;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    eventBus = new EventBus(db);
    flow = new RealtimeFlow(eventBus, emptyState(), { coalesceWindowMs: 0 });
    flow.start();
  });

  afterEach(() => {
    flow.stop();
    db.close();
  });

  describe('The state advance', () => {
    it('folds every committed event into the version and the last mutation', async () => {
      const first = await eventBus.publish({ type: 'memory.appended', payload: { id: 'm1' } });
      const newest = await eventBus.publish({ type: 'task.scheduled', payload: { id: 't1' } });

      // Read straight after `await publish` and already current: the flow's handler is
      // synchronous, so the state is advanced before `deliver` returns and a publisher
      // can read its own write back out. `presence.ts` depends on this — it answers a
      // new connection with `getSnapshot()`.
      const state = flow.getSnapshot();
      expect(first.seq).toBeLessThan(newest.seq);
      expect(state.version).toBe(newest.seq);
      expect(state.lastMutation).toEqual({
        eventId: newest.id,
        type: 'task.scheduled',
        timestamp: newest.timestamp,
      });
    });

    it('does not walk the version backwards when an older event is delivered late', async () => {
      const first = await eventBus.publish({ type: 'task.scheduled', payload: { n: 1 } });
      const newest = await eventBus.publish({ type: 'task.completed', payload: { n: 2 } });

      // What stage 12 does: a cycle's events are committed in one transaction and then
      // delivered one at a time, each awaited — and every one of those awaits lets an
      // independent publisher (an SSE connect, the autonomic loop, a weather sweep)
      // insert *and* deliver a later seq first. The flow then sees an older one.
      await eventBus.deliver(first);

      const state = flow.getSnapshot();
      // `replayMissed` uses this as the upper bound of a reconnect replay: assigning
      // instead of raising would answer "already current" to a client an event behind
      // and lose that event for good.
      expect(state.version).toBe(newest.seq);
      // XVI.2's rule for the channel, applied to the field this class owns: never a
      // stale value after a newer one.
      expect(state.lastMutation.eventId).toBe(newest.id);
      expect(state.lastMutation.type).toBe('task.completed');
    });

    it('still hands the late event to the client, because the frames are a log', async () => {
      const client = recorder('late-frames');
      flow.subscribe(client);

      const first = await eventBus.publish({ type: 'task.scheduled', payload: { n: 1 } });
      const newest = await eventBus.publish({ type: 'task.completed', payload: { n: 2 } });
      await eventBus.deliver(first);
      await settle();

      // Suppressing an out-of-order frame would trade a duplicate for an omission, and
      // the state frame `presence.ts` sends after every event is read at send time, so
      // nothing stale can follow this one.
      expect(client.seen.map((message) => message.seq)).toEqual([
        first.seq,
        newest.seq,
        first.seq,
      ]);
      expect(flow.getSnapshot().version).toBe(newest.seq);
    });

    it('runs the projection hook against a state already stamped with the event', async () => {
      const stampedVersions: number[] = [];
      const projected = new RealtimeFlow(eventBus, emptyState(), {
        coalesceWindowMs: 0,
        project: (previous) => {
          stampedVersions.push(previous.version);
          return {
            ...previous,
            memory: { ...previous.memory, episodicCount: previous.memory.episodicCount + 1 },
          };
        },
      });
      projected.start();

      const event = await eventBus.publish({ type: 'memory.appended', payload: {} });
      projected.stop();

      // The hook cannot be the thing that forgets to advance the version: it is handed
      // a state whose version and lastMutation are already this event's.
      expect(stampedVersions).toEqual([event.seq]);
      expect(projected.getSnapshot().version).toBe(event.seq);
      // And without it nothing but those two fields would ever move — which is the
      // whole reason the option exists.
      expect(projected.getSnapshot().memory.episodicCount).toBe(1);
      expect(flow.getSnapshot().memory.episodicCount).toBe(0);
    });
  });

  describe('XVI.2 — coalescing is the backpressure', () => {
    it('collapses the queue of a client that has stopped draining, instead of growing it', async () => {
      const slow = recorder('slow');
      slow.hold();
      flow.subscribe(slow);

      await eventBus.publish({ type: 'task.scheduled', payload: { n: 1 } });
      await settle();
      // The first frame is in flight and the socket is not accepting it.
      expect(slow.seen).toHaveLength(1);

      for (const n of [2, 3, 4, 5]) {
        await eventBus.publish({ type: 'task.scheduled', payload: { n } });
      }
      await settle();
      // Nothing was written past the one that is stuck, and nothing queued behind it
      // beyond a single slot — the publishes above never waited on this subscriber,
      // because a frame is written from the drain and not from the handler.
      expect(slow.seen).toHaveLength(1);
      expect(flow.getSnapshot().version).toBe(5);

      slow.release();
      await settle();

      // Four events, one frame: the newest replaced the three behind it under the same
      // key. That is the drop the design asks for, and the state above kept all five.
      expect(slow.seen).toHaveLength(2);
      expect(slow.seen[1]!.payload).toEqual({ n: 5 });
      // Picked up by the drain that was already running, not by a second one.
      expect(slow.overlaps()).toBe(0);
    });

    it('holds one slot per key, and writes them oldest-key-first', async () => {
      const slow = recorder('ordered');
      slow.hold();
      flow.subscribe(slow);

      const inFlight = await eventBus.publish({ type: 'memory.appended', payload: { n: 1 } });
      await settle();

      await eventBus.publish({ type: 'task.scheduled', payload: { n: 2 } });
      await eventBus.publish({ type: 'loop.opened', payload: { n: 3 } });
      // Same key as `n: 2`, so it takes that slot — and keeps its position rather than
      // moving to the back. Order is by when that part of the state first went stale,
      // not by when the newest word about it arrived.
      await eventBus.publish({ type: 'task.scheduled', payload: { n: 4 } });

      slow.release();
      await settle();

      expect(slow.seen.map((message) => message.payload)).toEqual([{ n: 1 }, { n: 4 }, { n: 3 }]);
      expect(slow.seen[0]!.seq).toBe(inFlight.seq);
      expect(slow.overlaps()).toBe(0);
    });

    it('gives every client its own queue, so a stalled one cannot hold up a healthy one', async () => {
      const stalled = recorder('stalled');
      stalled.hold();
      const healthy = recorder('healthy');
      flow.subscribe(stalled);
      flow.subscribe(healthy);

      await eventBus.publish({ type: 'task.scheduled', payload: { n: 1 } });
      await eventBus.publish({ type: 'task.completed', payload: { n: 2 } });
      await settle();

      expect(healthy.seen.map((message) => message.type)).toEqual([
        'task.scheduled',
        'task.completed',
      ]);
      expect(stalled.seen).toHaveLength(1);

      stalled.release();
      await settle();
      expect(stalled.seen).toHaveLength(2);
    });

    it('coalesces an unkeyed frame with nothing', async () => {
      const client = recorder('unkeyed');
      flow.subscribe(client);

      // Same type, no `coalesceKey`: a producer that did not say "this supersedes the
      // last one like it" must not have it assumed. `handleEvent` always says so; the
      // voice and presence layers, which may put a frame on this channel without a row
      // in `domain_event` behind it, do not have to.
      flow.broadcast({ seq: 7, type: 'voice.transcript', payload: { text: 'first' }, timestamp: 1 });
      flow.broadcast({ seq: 8, type: 'voice.transcript', payload: { text: 'second' }, timestamp: 2 });
      await settle();

      expect(client.seen.map((message) => message.payload)).toEqual([
        { text: 'first' },
        { text: 'second' },
      ]);
    });
  });

  describe('Subscribers, and what happens when one breaks', () => {
    it('registers one fan-out per id, and follows the log once', async () => {
      const client = recorder('twice');
      flow.subscribe(client);
      flow.subscribe(client);
      // A second `start` subscribing to the bus again would double-apply every event
      // as well as duplicating every frame.
      flow.start();

      const event = await eventBus.publish({ type: 'boot.completed', payload: {} });
      await settle();

      expect(client.seen).toHaveLength(1);
      expect(flow.getSnapshot().version).toBe(event.seq);
    });

    it('sends nothing to a subscriber that unsubscribed while a drain was armed', async () => {
      const leaving = recorder('leaving');
      flow.subscribe(leaving);

      // Queue a frame and take the subscriber away in the same tick. The armed
      // microtask cannot be cancelled, so the drain has to check the registry itself.
      flow.broadcast({ seq: 1, type: 'session.disconnected', payload: {}, timestamp: 1 });
      flow.unsubscribe('leaving');
      await settle();

      expect(leaving.seen).toEqual([]);
    });

    it('stops following the log on stop, and leaves the subscriber registered', async () => {
      const client = recorder('after-stop');
      flow.subscribe(client);
      flow.stop();

      const event = await eventBus.publish({ type: 'task.failed', payload: {} });
      await settle();
      expect(client.seen).toEqual([]);
      expect(flow.getSnapshot().version).toBe(0);

      // The socket is the owner's to close — `presence.ts` unsubscribes on `close` —
      // so the channel still works after `stop`, which is what lets the HTTP layer put
      // a last frame through it during shutdown.
      flow.broadcast({ seq: event.seq, type: 'session.disconnected', payload: {}, timestamp: 1 });
      await settle();
      expect(client.seen).toHaveLength(1);
    });

    it('reports a client whose send rejects, once, and keeps serving it', async () => {
      const reported: string[] = [];
      const own = new RealtimeFlow(eventBus, emptyState(), {
        coalesceWindowMs: 0,
        report: (what, error) => {
          reported.push(`${what}: ${(error as Error).message}`);
        },
      });
      own.start();

      const broken = recorder('broken');
      own.subscribe(broken);
      broken.rejectNext(new Error('socket gone'));

      await eventBus.publish({ type: 'task.scheduled', payload: { n: 1 } });
      await settle();

      // Through the injected hook and not through `publishError`: that one publishes
      // `error.raised` into the bus this flow subscribes to, so a failed write would be
      // broadcast back to the client that failed, fail again, and publish again.
      expect(reported).toEqual(['realtime fan-out to broken: socket gone']);

      // The frame that was in flight is not retried — it left the queue before the
      // write — and the next event arms the next attempt.
      await eventBus.publish({ type: 'task.completed', payload: { n: 2 } });
      await settle();
      own.stop();

      expect(broken.seen.map((message) => message.payload)).toEqual([{ n: 1 }, { n: 2 }]);
      expect(reported).toHaveLength(1);
    });
  });
});
