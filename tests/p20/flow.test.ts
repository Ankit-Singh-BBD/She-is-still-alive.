import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { RealtimeFlow } from '@server/realtime/flow.js';
import { EventBus } from '@server/events/event-bus.js';
import type { RuntimeState, BroadcastMessage, Subscriber } from '@server/realtime/types.js';
import type { Identity } from '@server/identity/types.js';
import type { PersistedDomainEvent } from '@server/events/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

// Helper to create a minimal RuntimeState for testing
function createInitialState(): RuntimeState {
  const identity: Identity = {
    id: 'test-identity',
    kind: 'owner',
    displayName: 'Test Owner',
    enrolledAt: Date.now(),
    lastSeenAt: Date.now(),
    status: 'active',
  };

  return {
    version: 0,
    identity,
    presence: {
      activeActor: 'test-identity',
      recentActors: ['test-identity'],
      sessionStartedAt: Date.now(),
    },
    environment: {
      timeOfDay: 'day',
      weather: { condition: 'clear' },
      location: { lat: 0, lng: 0 },
      derivedPalette: { primary: '#fff', secondary: '#ccc', accent: '#f00' },
    },
    cognitive: {
      currentStage: 'PERCEIVE',
      cycleId: 'test-cycle',
      cycleStartedAt: Date.now(),
      lastCompletedStage: 'PERSIST',
      attention: {},
    },
    voice: {
      live: 'disconnected',
      energy: 0,
      ttsEnergy: 0,
      frequencyBands: [],
      voiceId: 'test-voice',
    },
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
    pendingActions: [],
    lastMutation: {
      eventId: '',
      type: '',
      timestamp: 0,
    },
  };
}

// Helper to create a mock subscriber
function createMockSubscriber(id: string): Subscriber & { messages: BroadcastMessage[] } {
  const messages: BroadcastMessage[] = [];
  return {
    id,
    send: vi.fn(async (msg: BroadcastMessage) => {
      messages.push(msg);
    }),
    messages,
  };
}

describe('P20 Realtime Flow Contract', () => {
  let eventBus: EventBus;
  let flow: RealtimeFlow;
  let initialState: RuntimeState;

  beforeEach(() => {
    initialState = createInitialState();
    const db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    eventBus = new EventBus(db, { handlerDeadlineMs: 50 });
    // Use 0ms coalescing for most tests to get immediate microtask draining
    flow = new RealtimeFlow(eventBus, initialState, { coalesceWindowMs: 0 });
  });

  describe('7-Stage Event Delivery and Monotonic Sequence Versioning', () => {
    it('applies events to state and increments version monotonically', async () => {
      flow.start();

      // Publish multiple events
      await eventBus.publish({
        type: 'task.scheduled',
        payload: { taskId: 'task-1' },
      });

      await eventBus.publish({
        type: 'task.scheduled',
        payload: { taskId: 'task-2' },
      });

      await eventBus.publish({
        type: 'task.completed',
        payload: { taskId: 'task-1' },
      });

      const snapshot = flow.getSnapshot();
      expect(snapshot.version).toBe(3); // 3 events = seq 1, 2, 3
      expect(snapshot.lastMutation.type).toBe('task.completed');
      expect(snapshot.lastMutation.eventId).toBeDefined();
      expect(snapshot.lastMutation.timestamp).toBeGreaterThan(0);
    });

    it('broadcasts messages with correct sequence numbers', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      await eventBus.publish({
        type: 'memory.appended',
        payload: { memoryId: 'mem-1' },
      });

      await eventBus.publish({
        type: 'memory.appended',
        payload: { memoryId: 'mem-2' },
      });

      // Wait for async drain
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(2);
      expect(subscriber.messages[0]!.seq).toBe(1);
      expect(subscriber.messages[1]!.seq).toBe(2);
      expect(subscriber.messages[0]!.type).toBe('memory.appended');
      expect(subscriber.messages[1]!.type).toBe('memory.appended');
      expect(subscriber.messages[0]!.coalesceKey).toBe('memory.appended');
      expect(subscriber.messages[1]!.coalesceKey).toBe('memory.appended');
    });

    it('includes timestamp in broadcast messages', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      const beforePublish = Date.now();
      await eventBus.publish({
        type: 'config.changed',
        payload: { key: 'test' },
      });
      const afterPublish = Date.now();

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(1);
      expect(subscriber.messages[0]!.timestamp).toBeGreaterThanOrEqual(beforePublish);
      expect(subscriber.messages[0]!.timestamp).toBeLessThanOrEqual(afterPublish);
    });
  });

  describe('Coalescing Backpressure', () => {
    it('coalesces consecutive events with same coalesceKey', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      // Concurrent publishes exercise coalescing — sequential awaits would drain between inserts.
      await Promise.all([
        eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } }),
        eventBus.publish({ type: 'task.scheduled', payload: { id: 2 } }),
        eventBus.publish({ type: 'task.scheduled', payload: { id: 3 } }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(1);
      expect(subscriber.messages[0]!.seq).toBe(3);
      expect(subscriber.messages[0]!.payload).toEqual({ id: 3 });
    });

    it('does not coalesce events of different types', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      await eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.completed', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.failed', payload: { id: 1 } });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(3);
      expect(subscriber.messages[0]!.type).toBe('task.scheduled');
      expect(subscriber.messages[1]!.type).toBe('task.completed');
      expect(subscriber.messages[2]!.type).toBe('task.failed');
    });

    it('uses explicit coalesceKey when provided in broadcast', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      // Synchronous burst — all three queued before the first drain tick.
      flow.broadcast({
        seq: 1,
        type: 'custom.event',
        payload: { data: 'first' },
        timestamp: Date.now(),
        coalesceKey: 'custom-coalesce',
      });
      flow.broadcast({
        seq: 2,
        type: 'custom.event',
        payload: { data: 'second' },
        timestamp: Date.now(),
        coalesceKey: 'custom-coalesce',
      });
      flow.broadcast({
        seq: 3,
        type: 'custom.event',
        payload: { data: 'third' },
        timestamp: Date.now(),
        coalesceKey: 'custom-coalesce',
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(1);
      expect(subscriber.messages[0]!.seq).toBe(3);
      expect(subscriber.messages[0]!.payload).toEqual({ data: 'third' });
    });
  });

  describe('Non-blocking Slow Subscriber Behavior', () => {
    it('does not block producer when subscriber is slow', async () => {
      flow.start();
      const slowSubscriber = createMockSubscriber('slow-sub');

      // Make subscriber slow by adding delay to send
      let resolveSlow: () => void;
      const slowPromise = new Promise<void>(resolve => { resolveSlow = resolve; });
      slowSubscriber.send = vi.fn(async (msg: BroadcastMessage) => {
        slowSubscriber.messages.push(msg);
        await slowPromise; // Wait for release
      });
      flow.subscribe(slowSubscriber);

      const fastSubscriber = createMockSubscriber('fast-sub');
      flow.subscribe(fastSubscriber);

      // Publish several events concurrently to trigger coalescing for fast subscriber
      await Promise.all([
        eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } }),
        eventBus.publish({ type: 'task.scheduled', payload: { id: 2 } }),
        eventBus.publish({ type: 'task.scheduled', payload: { id: 3 } }),
      ]);

      // Fast subscriber should receive immediately (coalesced to latest)
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(fastSubscriber.messages.length).toBe(1);
      expect(fastSubscriber.messages[0]!.seq).toBe(3);

      // Slow subscriber hasn't finished yet but producer didn't block
      // Release slow subscriber
      resolveSlow!();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(slowSubscriber.messages.length).toBe(1);
      expect(slowSubscriber.messages[0]!.seq).toBe(3);
    });

    it('handles multiple slow subscribers without blocking', async () => {
      flow.start();

      let resolveSlow1: () => void;
      let resolveSlow2: () => void;

      const slowPromise1 = new Promise<void>(resolve => { resolveSlow1 = resolve; });
      const slowPromise2 = new Promise<void>(resolve => { resolveSlow2 = resolve; });

      const slowSubscriber1 = createMockSubscriber('slow-1');
      slowSubscriber1.send = vi.fn(async (msg: BroadcastMessage) => {
        slowSubscriber1.messages.push(msg);
        await slowPromise1;
      });
      flow.subscribe(slowSubscriber1);

      const slowSubscriber2 = createMockSubscriber('slow-2');
      slowSubscriber2.send = vi.fn(async (msg: BroadcastMessage) => {
        slowSubscriber2.messages.push(msg);
        await slowPromise2;
      });
      flow.subscribe(slowSubscriber2);

      // Producer should not block
      const start = Date.now();
      await eventBus.publish({ type: 'loop.evaluated', payload: { loopId: 'loop-1' } });
      const publishTime = Date.now() - start;

      // Publish should complete quickly (non-blocking)
      expect(publishTime).toBeLessThan(50); // Should be near-instant

      resolveSlow1!();
      resolveSlow2!();
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(slowSubscriber1.messages.length).toBe(1);
      expect(slowSubscriber2.messages.length).toBe(1);
    });
  });

  describe('Sequential Queue Draining', () => {
    it('drains queue in order messages were received', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      // Publish different types (no coalescing)
      await eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.claimed', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.completed', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.failed', payload: { id: 2 } });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(4);
      expect(subscriber.messages[0]!.type).toBe('task.scheduled');
      expect(subscriber.messages[1]!.type).toBe('task.claimed');
      expect(subscriber.messages[2]!.type).toBe('task.completed');
      expect(subscriber.messages[3]!.type).toBe('task.failed');
      expect(subscriber.messages[0]!.seq).toBe(1);
      expect(subscriber.messages[1]!.seq).toBe(2);
      expect(subscriber.messages[2]!.seq).toBe(3);
      expect(subscriber.messages[3]!.seq).toBe(4);
    });

    it('processes messages that arrive during drain', async () => {
      flow.start();
      let drainCount = 0;

      const subscriber = createMockSubscriber('sub-1');
      subscriber.send = vi.fn(async (msg: BroadcastMessage) => {
        subscriber.messages.push(msg);
        drainCount++;
        // Inject a fresh broadcast with a different coalesce key mid-drain.
        if (drainCount === 1) {
          flow.broadcast({
            seq: 5,
            type: 'custom.midflight',
            payload: { id: 5 },
            timestamp: Date.now(),
            coalesceKey: 'midflight-key',
          });
        }
      });
      flow.subscribe(subscriber);

      // Concurrent burst to coalesce into a single first message.
      await Promise.all([
        eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } }),
        eventBus.publish({ type: 'task.scheduled', payload: { id: 2 } }),
        eventBus.publish({ type: 'task.scheduled', payload: { id: 3 } }),
      ]);

      await new Promise(resolve => setTimeout(resolve, 10));

      // Coalesced (seq 3) + the new midflight broadcast (seq 5) which has its own coalesce key.
      expect(subscriber.messages.length).toBe(2);
      expect(subscriber.messages[0]!.seq).toBe(3);
      expect(subscriber.messages[1]!.seq).toBe(5);
    });
  });

  describe('Disconnect/Reconnect Replay via fromSequence', () => {
    it('replays events from sequence number on reconnect', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      // Three distinct event types so the live subscriber receives all three.
      await eventBus.publish({ type: 'memory.appended', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.completed', payload: { id: 2 } });
      await eventBus.publish({ type: 'memory.appended', payload: { id: 3 } });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(3);
      expect(subscriber.messages[2]!.seq).toBe(3);

      // Reconnect replay from seq 2 should yield only the event at seq 3.
      const replaySubscriber = createMockSubscriber('replay-sub');
      await eventBus.replayTo(replaySubscriber.send as any, 2);

      expect(replaySubscriber.messages.length).toBe(1);
      expect(replaySubscriber.messages[0]!.seq).toBe(3);
    });

    it('replays all events from sequence 0', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      await eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.completed', payload: { id: 1 } });

      await new Promise(resolve => setTimeout(resolve, 10));

      // New subscriber replays from start
      const replaySubscriber = createMockSubscriber('replay-sub');
      await eventBus.replayTo(replaySubscriber.send as any, 0);

      expect(replaySubscriber.messages.length).toBe(2);
      expect(replaySubscriber.messages[0]!.seq).toBe(1);
      expect(replaySubscriber.messages[1]!.seq).toBe(2);
    });

    it('replay does not include events at or before fromSequence', async () => {
      flow.start();
      await eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.scheduled', payload: { id: 2 } });
      await eventBus.publish({ type: 'task.scheduled', payload: { id: 3 } });

      const replaySubscriber = createMockSubscriber('replay-sub');
      await eventBus.replayTo(replaySubscriber.send as any, 2);

      // Only seq > 2, so only seq 3
      expect(replaySubscriber.messages.length).toBe(1);
      expect(replaySubscriber.messages[0]!.seq).toBe(3);
    });
  });

  describe('Subscriber Management', () => {
    it('allows subscribing and unsubscribing', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      await eventBus.publish({ type: 'config.changed', payload: { key: 'test' } });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(1);

      flow.unsubscribe('sub-1');

      await eventBus.publish({ type: 'config.changed', payload: { key: 'test2' } });
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should not receive after unsubscribe
      expect(subscriber.messages.length).toBe(1);
    });

    it('does not duplicate subscriber on double subscribe', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);
      flow.subscribe(subscriber); // Second subscribe should be ignored

      await eventBus.publish({ type: 'config.changed', payload: { key: 'test' } });
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(subscriber.messages.length).toBe(1);
    });
  });

  describe('Stop and Cleanup', () => {
    it('stops receiving events after stop()', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      await eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } });
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(subscriber.messages.length).toBe(1);

      flow.stop();

      await eventBus.publish({ type: 'task.scheduled', payload: { id: 2 } });
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should not receive after stop
      expect(subscriber.messages.length).toBe(1);
    });
  });
});