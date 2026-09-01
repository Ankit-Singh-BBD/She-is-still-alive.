import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { EventBus } from '@server/events/event-bus.js';
import { IdentityRepository, DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { ProactiveDecisionTree } from '@server/proactive/decision-tree.js';
import { ProactiveEngine } from '@server/proactive/engine.js';
import type { ProactiveCandidate } from '@server/proactive/types.js';
import type { Identity } from '@server/identity/types.js';

describe('Proactive Engine & Decision Tree (P17)', () => {
  let db: Database;
  let eventBus: EventBus;
  let identityRepo: IdentityRepository;

  const owner: Identity = {
    id: 'usr_owner0000000000000000001',
    kind: 'owner',
    displayName: 'Owner',
    status: 'active',
    enrolledAt: 0,
    lastSeenAt: 0,
    permissions: DEFAULT_PERMISSIONS.owner,
  };

  const guest: Identity = {
    id: 'usr_guest0000000000000000001',
    kind: 'guest',
    displayName: 'Guest',
    status: 'active',
    enrolledAt: 0,
    lastSeenAt: 0,
    permissions: DEFAULT_PERMISSIONS.guest,
  };

  const person: Identity = {
    id: 'usr_person000000000000000001',
    kind: 'person',
    displayName: 'Friend',
    status: 'active',
    enrolledAt: 0,
    lastSeenAt: 0,
    permissions: DEFAULT_PERMISSIONS.person,
  };

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));

    // Insert Identities
    for (const id of [owner, guest, person]) {
      db.raw
        .prepare(
          `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0)`,
        )
        .run(id.id, id.kind, id.displayName, id.status);
      db.raw
        .prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`)
        .run(id.id, JSON.stringify(id.permissions));
    }

    eventBus = new EventBus(db);
    identityRepo = new IdentityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  const validCandidate: ProactiveCandidate = {
    identityId: owner.id,
    callerKind: 'owner',
    topic: 'daily_briefing',
    decision: {
      kind: 'speak',
      channel: 'text',
      priority: 'normal',
      text: 'Good morning! Here is your daily summary.',
    },
    urgency: 0.5,
    novelty: 0.8,
    interruptionCost: 0.3,
    contextCompatibility: 0.9,
  };

  describe('ProactiveDecisionTree', () => {
    const tree = new ProactiveDecisionTree();
    const notRateLimited = () => false;

    it('rejects guest sessions without exception', () => {
      const outcome = tree.evaluate(
        { ...validCandidate, callerKind: 'guest', identityId: guest.id },
        guest,
        notRateLimited,
      );
      expect(outcome.action).toBe('reject');
      expect(outcome.reason).toContain('Guest');
    });

    it('rejects identities lacking proactive permission', () => {
      const restrictedPerson: Identity = {
        ...person,
        permissions: { ...DEFAULT_PERMISSIONS.person, mayReceiveProactiveMessages: false },
      };
      const outcome = tree.evaluate(
        { ...validCandidate, callerKind: 'person', identityId: restrictedPerson.id },
        restrictedPerson,
        notRateLimited,
      );
      expect(outcome.action).toBe('reject');
      expect(outcome.reason).toContain('not authorized');
    });

    it('suppresses if proactivity is globally disabled or topic is disabled', () => {
      const disabledTree = new ProactiveDecisionTree({ enabled: false });
      expect(disabledTree.evaluate(validCandidate, owner, notRateLimited).action).toBe('suppress');

      const topicDisabledTree = new ProactiveDecisionTree({ disabledTopics: ['daily_briefing'] });
      expect(topicDisabledTree.evaluate(validCandidate, owner, notRateLimited).action).toBe('suppress');

      const silentCandidate: ProactiveCandidate = {
        ...validCandidate,
        decision: { kind: 'silent' },
      };
      expect(tree.evaluate(silentCandidate, owner, notRateLimited).action).toBe('suppress');
    });

    it('urgent candidate bypasses quiet hours and novelty gates', () => {
      const urgentCandidate: ProactiveCandidate = {
        ...validCandidate,
        urgency: 0.95, // Above 0.8 threshold
        novelty: 0.1, // Low novelty would normally suppress
        interruptionCost: 0.9, // High cost would normally defer
      };
      const outcome = tree.evaluate(urgentCandidate, owner, notRateLimited, { isQuietHours: true });
      expect(outcome.action).toBe('emit');
      expect(outcome.reason).toContain('Urgent');
    });

    it('suppresses if topic is rate limited', () => {
      const isRateLimited = (_id: string, topic: string) => topic === 'daily_briefing';
      const outcome = tree.evaluate(validCandidate, owner, isRateLimited);
      expect(outcome.action).toBe('suppress');
      expect(outcome.reason).toContain('rate-limited');
    });

    it('suppresses if novelty is below threshold', () => {
      const lowNovelty = { ...validCandidate, novelty: 0.3 };
      const outcome = tree.evaluate(lowNovelty, owner, notRateLimited);
      expect(outcome.action).toBe('suppress');
      expect(outcome.reason).toContain('Novelty score');
    });

    it('defers during quiet hours window', () => {
      const outcome = tree.evaluate(validCandidate, owner, notRateLimited, { currentHour: 23 }); // 11 PM
      expect(outcome.action).toBe('defer');
      expect(outcome.reason).toContain('quiet hours');
    });

    it('defers if interruption cost exceeds threshold', () => {
      const highCost = { ...validCandidate, interruptionCost: 0.85 };
      const outcome = tree.evaluate(highCost, owner, notRateLimited, { currentHour: 14 });
      expect(outcome.action).toBe('defer');
      expect(outcome.reason).toContain('Interruption cost');
    });

    it('suppresses if context compatibility is below threshold', () => {
      const incompatible = { ...validCandidate, contextCompatibility: 0.2 };
      const outcome = tree.evaluate(incompatible, owner, notRateLimited, { currentHour: 14 });
      expect(outcome.action).toBe('suppress');
      expect(outcome.reason).toContain('Context compatibility');
    });

    it('emits when all validation criteria pass', () => {
      const outcome = tree.evaluate(validCandidate, owner, notRateLimited, { currentHour: 14 });
      expect(outcome.action).toBe('emit');
    });
  });

  describe('ProactiveEngine', () => {
    it('persists decisions in SQLite and emits events to EventBus', async () => {
      const engine = new ProactiveEngine({
        db,
        eventBus,
        identityRepo,
      });

      const events: string[] = [];
      eventBus.subscribe((evt) => {
        events.push(evt.type);
      });

      // 1. Emit candidate
      const result = engine.evaluate(validCandidate, { currentHour: 14 });
      expect(result.outcome.action).toBe('emit');
      expect(result.decisionId).toBeDefined();

      // Check SQLite persistence
      const row = db.raw
        .prepare(`SELECT * FROM proactive_decision WHERE id = ?`)
        .get(result.decisionId) as { id: string; urgency: number; novelty: number };
      expect(row).toBeDefined();
      expect(row.id).toBe(result.decisionId);
      expect(row.urgency).toBe(validCandidate.urgency);

      // Check delivered
      await engine.markDelivered(result.decisionId, 'text');
      const updatedRow = db.raw
        .prepare(`SELECT acted_at FROM proactive_decision WHERE id = ?`)
        .get(result.decisionId) as { acted_at: string };
      expect(updatedRow.acted_at).not.toBeNull();

      // 2. Second candidate on same topic should be rate-limited
      const secondResult = engine.evaluate(validCandidate, { currentHour: 14 });
      expect(secondResult.outcome.action).toBe('suppress');
      expect(secondResult.outcome.reason).toContain('rate-limited');

      // Wait for async event emission to complete
      await new Promise(r => setTimeout(r, 0));

      // Verify domain events
      expect(events).toContain('proactive.decision');
      expect(events).toContain('proactive.delivered');
      expect(events).toContain('proactive.suppressed');
    });

    it('runs batch proposals via runCycle', async () => {
      const engine = new ProactiveEngine({
        db,
        eventBus,
        identityRepo,
      });

      const results = await engine.runCycle(
        async () => [
          validCandidate,
          { ...validCandidate, topic: 'weather_warning', urgency: 0.95 },
        ],
        { currentHour: 14 },
      );

      expect(results.length).toBe(2);
      expect(results[0]?.outcome.action).toBe('emit');
      expect(results[1]?.outcome.action).toBe('emit');
    });
  });
});
