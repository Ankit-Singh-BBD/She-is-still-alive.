import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QualityManager } from '@client/components/visual/QualityManager.js';
import { RealtimeFlow } from '@server/realtime/flow.js';
import { EventBus } from '@server/events/event-bus.js';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { TokenBudgetManager, DEFAULT_STAGE_TOKEN_BUDGETS } from '@server/cognition/budgets.js';
import type { RuntimeState, BroadcastMessage, Subscriber } from '@server/realtime/types.js';
import type { Identity } from '@server/identity/types.js';
import * as path from 'node:path';

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

describe('P26: Performance Pass (Part XXII.2 / XXII.3)', () => {
  describe('Visual Performance — DPR Cap, Particle Scaling, Quality Tiers', () => {
    it('selectInitialTier respects mobile and tablet viewports to aggressively scale down', () => {
      expect(QualityManager.selectInitialTier('mobile')).toBe('LOW');
      expect(QualityManager.selectInitialTier('tablet')).toBe('MEDIUM');
      expect(QualityManager.selectInitialTier('desktop')).toBe('HIGH');
    });

    it('DPR cap strictly limits to <= 2.0 based on tier (P26 requirement)', () => {
      expect(QualityManager.getTierConfig('ULTRA').dprCap).toBe(2.0);
      expect(QualityManager.getTierConfig('HIGH').dprCap).toBe(1.75);
      expect(QualityManager.getTierConfig('MEDIUM').dprCap).toBe(1.5);
      expect(QualityManager.getTierConfig('LOW').dprCap).toBe(1.25);
    });

    it('particle scaling reduces particleCount based on prefersReducedMotion (0.3x)', () => {
      const ultraNormal = QualityManager.getTierConfig('ULTRA', false);
      const ultraReduced = QualityManager.getTierConfig('ULTRA', true);

      expect(ultraNormal.particleCount).toBe(150);
      expect(ultraReduced.particleCount).toBe(Math.floor(150 * 0.3)); // 45

      const highNormal = QualityManager.getTierConfig('HIGH', false);
      const highReduced = QualityManager.getTierConfig('HIGH', true);

      expect(highNormal.particleCount).toBe(100);
      expect(highReduced.particleCount).toBe(Math.floor(100 * 0.3)); // 30

      const lowNormal = QualityManager.getTierConfig('LOW', false);
      const lowReduced = QualityManager.getTierConfig('LOW', true);

      expect(lowNormal.particleCount).toBe(25);
      // Math.max(10, Math.floor(25 * 0.3)) => Math.max(10, 7) => 10
      expect(lowReduced.particleCount).toBe(10);

      // Also verifies postEnabled and shadowEnabled toggle nicely based on tier
      expect(ultraNormal.postEnabled).toBe(true);
      expect(ultraReduced.postEnabled).toBe(false);
      expect(highNormal.shadowEnabled).toBe(true);
      expect(highReduced.shadowEnabled).toBe(true); // shadows remain on HIGH
    });

    it('QualityManager gracefully degrades the tier on performance breach', () => {
      expect(QualityManager.downgradeTier('ULTRA')).toBe('HIGH');
      expect(QualityManager.downgradeTier('HIGH')).toBe('MEDIUM');
      expect(QualityManager.downgradeTier('MEDIUM')).toBe('LOW');
      expect(QualityManager.downgradeTier('LOW')).toBe('LOW');
    });

    it('mobile tier enforces simplified water quality and no post-processing', () => {
      const mobileConfig = QualityManager.getTierConfig('LOW', false);
      expect(mobileConfig.waterQuality).toBe('simplified');
      expect(mobileConfig.postEnabled).toBe(false);
      expect(mobileConfig.shadowEnabled).toBe(false);
    });
  });

  describe('Realtime Coalescing — 50ms Sliding Window', () => {
    let eventBus: EventBus;
    let flow: RealtimeFlow;
    let initialState: RuntimeState;

    beforeEach(() => {
      initialState = createInitialState();
      const db = new Database({ path: ':memory:' });
      runMigrations(db, migrationsDir);
      eventBus = new EventBus(db, { handlerDeadlineMs: 50 });
      flow = new RealtimeFlow(eventBus, initialState);
    });

    it('RealtimeFlow constructor configures a default 50ms coalesceWindowMs', () => {
      // @ts-expect-error test introspection
      expect(flow.coalesceWindowMs).toBe(50);
    });

    it('coalesces 10 rapid mutations on same key within 50ms window without dropped data', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      // Fire 10 rapid events of the same type (same coalesceKey)
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          eventBus.publish({ type: 'task.scheduled', payload: { id: i + 1 } })
        )
      );

      // Wait for the coalesce window + processing
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should receive exactly 1 coalesced message (the last one)
      expect(subscriber.messages.length).toBe(1);
      expect(subscriber.messages[0]!.seq).toBe(10);
      expect(subscriber.messages[0]!.payload).toEqual({ id: 10 });
    });

    it('does not coalesce events of different types (different coalesceKeys)', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      await eventBus.publish({ type: 'task.scheduled', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.completed', payload: { id: 1 } });
      await eventBus.publish({ type: 'task.failed', payload: { id: 1 } });
      await eventBus.publish({ type: 'memory.appended', payload: { id: 1 } });
      await eventBus.publish({ type: 'config.changed', payload: { key: 'test' } });

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should receive all 5 distinct messages
      expect(subscriber.messages.length).toBe(5);
      expect(subscriber.messages.map((m) => m.type)).toEqual([
        'task.scheduled',
        'task.completed',
        'task.failed',
        'memory.appended',
        'config.changed',
      ]);
    });

    it('explicit coalesceKey in broadcast is respected', async () => {
      flow.start();
      const subscriber = createMockSubscriber('sub-1');
      flow.subscribe(subscriber);

      // Synchronous burst with same explicit coalesceKey
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(subscriber.messages.length).toBe(1);
      expect(subscriber.messages[0]!.seq).toBe(3);
      expect(subscriber.messages[0]!.payload).toEqual({ data: 'third' });
    });
  });

  describe('LLM Token Budgets — Hard Ceilings & Truncation Safety', () => {
    it('DEFAULT_STAGE_TOKEN_BUDGETS aligns with cycle latency targets (<800ms cognitive, <300ms text)', () => {
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.UNDERSTAND.maxInputTokens).toBeLessThanOrEqual(1024);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.UNDERSTAND.hardCeiling).toBeLessThanOrEqual(512);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.REASON.maxInputTokens).toBeLessThanOrEqual(2048);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.REASON.hardCeiling).toBeLessThanOrEqual(1024);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.DECIDE.maxInputTokens).toBeLessThanOrEqual(1024);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.DECIDE.hardCeiling).toBeLessThanOrEqual(512);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.RESPOND.maxInputTokens).toBeLessThanOrEqual(2048);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.RESPOND.hardCeiling).toBeLessThanOrEqual(1024);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.LEARN.maxInputTokens).toBeLessThanOrEqual(2048);
      expect(DEFAULT_STAGE_TOKEN_BUDGETS.LEARN.hardCeiling).toBeLessThanOrEqual(1024);
    });

    it('TokenBudgetManager securely limits requested generation tokens up to the hardCeiling', () => {
      const mgr = new TokenBudgetManager();
      const budget = mgr.getBudget('RESPOND'); // hardCeiling: 1024

      // Valid request, below limit
      expect(mgr.enforceCeiling('RESPOND', 512)).toBe(512);

      // Default when 0 or negative
      expect(mgr.enforceCeiling('RESPOND', 0)).toBe(budget.maxOutputTokens);
      expect(mgr.enforceCeiling('RESPOND', -1)).toBe(budget.maxOutputTokens);

      // Truncated at hard-ceiling
      expect(mgr.enforceCeiling('RESPOND', 20000)).toBe(budget.hardCeiling);
    });

    it('TokenBudgetManager estimates tokens using 4 chars per token heuristic', () => {
      const mgr = new TokenBudgetManager();

      // 4 chars = 1 token
      expect(mgr.estimateTokens('1234')).toBe(1);
      expect(mgr.estimateTokens('12345678')).toBe(2);
      expect(mgr.estimateTokens('')).toBe(0);
    });

    it('TokenBudgetManager truncates large payloads to fit within stage maxInputTokens', () => {
      const mgr = new TokenBudgetManager();
      const budget = mgr.getBudget('UNDERSTAND'); // maxInputTokens: 1024 => 4096 chars
      const exactFit = 'x'.repeat(4096);
      const overflow = 'x'.repeat(5000);

      expect(mgr.truncateToBudget('UNDERSTAND', exactFit)).toBe(exactFit);
      expect(mgr.truncateToBudget('UNDERSTAND', overflow)).toBe(exactFit + '... [TRUNCATED]');

      // Test with different stage (REASON has 2048 maxInputTokens = 8192 chars)
      const reasonBudget = mgr.getBudget('REASON');
      const reasonExact = 'y'.repeat(8192);
      const reasonOverflow = 'y'.repeat(9000);
      expect(mgr.truncateToBudget('REASON', reasonExact)).toBe(reasonExact);
      expect(mgr.truncateToBudget('REASON', reasonOverflow)).toBe(reasonExact + '... [TRUNCATED]');
    });

    it('TokenBudgetManager allows custom per-stage budget overrides', () => {
      const mgr = new TokenBudgetManager({
        UNDERSTAND: { maxInputTokens: 512, maxOutputTokens: 128, hardCeiling: 256 },
      });

      const custom = mgr.getBudget('UNDERSTAND');
      expect(custom.maxInputTokens).toBe(512);
      expect(custom.maxOutputTokens).toBe(128);
      expect(custom.hardCeiling).toBe(256);

      // Unmodified stages fall back to defaults
      expect(mgr.getBudget('REASON').maxInputTokens).toBe(2048);
    });
  });

  describe('Quality Tier Adaptive Downgrade', () => {
    it('suggestNextTier returns downgraded tier when monitor signals breach', async () => {
      const { PerformanceMonitor, suggestNextTier } = await import('@client/components/visual/PerformanceMonitor.js');
      const monitor = new PerformanceMonitor();

      monitor.onFrame(100); // initialize

      // Simulate 12 consecutive breached frames (> FRAME_BUDGET_MS)
      for (let i = 1; i <= 12; i++) {
        monitor.onFrame(100 + i * 20); // 20ms per frame = 50fps (below 55fps budget)
      }

      expect(monitor.shouldDowngrade()).toBe(true);

      const next = suggestNextTier('ULTRA', monitor, QualityManager.downgradeTier);
      expect(next).toBe('HIGH');
    });

    it('suggestNextTier maintains tier when monitor is healthy', async () => {
      const { PerformanceMonitor, suggestNextTier } = await import('@client/components/visual/PerformanceMonitor.js');
      const monitor = new PerformanceMonitor();

      monitor.onFrame(100); // initialize

      // Simulate healthy frames
      for (let i = 1; i <= 10; i++) {
        monitor.onFrame(100 + i * 16); // 16ms per frame = 62.5fps (above 55fps budget)
      }

      expect(monitor.shouldDowngrade()).toBe(false);

      const next = suggestNextTier('HIGH', monitor, QualityManager.downgradeTier);
      expect(next).toBe('HIGH');
    });
  });
});
