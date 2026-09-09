import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { EventBus } from '@server/events/event-bus.js';
import { IdentityRepository, DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { ProactiveDecisionTree } from '@server/proactive/decision-tree.js';
import { ProactiveEngine } from '@server/proactive/engine.js';
import type { ProactiveCandidate, ProactiveEngineOptions } from '@server/proactive/types.js';
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

  describe('deferral queue', () => {
    /**
     * The gap these cover: 'defer' was evaluated, persisted with no due time,
     * published as `proactive.suppressed`, and then dropped. Nothing ever looked
     * at a deferred candidate again — not when quiet hours ended, not ever — so
     * "later" meant "never". That is a dishonest verdict, not just a missing
     * feature, which is why it belongs with the rest of the honesty fixes.
     */

    const costly: ProactiveCandidate = { ...validCandidate, interruptionCost: 0.85 };

    const newEngine = (options?: ProactiveEngineOptions): ProactiveEngine =>
      new ProactiveEngine({ db, eventBus, identityRepo, ...(options ? { options } : {}) });

    it('attaches a due time to every deferral', () => {
      const tree = new ProactiveDecisionTree();

      const quiet = tree.evaluate(validCandidate, owner, () => false, { currentHour: 23 });
      expect(quiet.action).toBe('defer');
      expect(quiet.deferUntil).toBeGreaterThan(quiet.evaluatedAt);
      // The end of the default quiet window, not an arbitrary backoff.
      expect(new Date(quiet.deferUntil!).getHours()).toBe(7);

      const busy = tree.evaluate(costly, owner, () => false, { currentHour: 14 });
      expect(busy.action).toBe('defer');
      expect(busy.deferUntil).toBe(busy.evaluatedAt + 900_000);
    });

    it('backs off further each time the same candidate is deferred', () => {
      const tree = new ProactiveDecisionTree();

      const once = tree.evaluate({ ...costly, deferCount: 1 }, owner, () => false, { currentHour: 14 });
      expect(once.deferUntil).toBe(once.evaluatedAt + 1_800_000);

      const twice = tree.evaluate({ ...costly, deferCount: 2 }, owner, () => false, { currentHour: 14 });
      expect(twice.deferUntil).toBe(twice.evaluatedAt + 3_600_000);
    });

    it('abandons a candidate instead of deferring it a fourth time', () => {
      const tree = new ProactiveDecisionTree();
      const outcome = tree.evaluate({ ...costly, deferCount: 3 }, owner, () => false, { currentHour: 14 });

      expect(outcome.action).toBe('suppress');
      expect(outcome.reason).toContain('abandoning');
      expect(outcome.deferUntil).toBeUndefined();
    });
    it('queues a deferred candidate with its due time, and leaves it alone until then', () => {
      const engine = newEngine();
      const result = engine.evaluate(validCandidate, { currentHour: 23 });
      expect(result.outcome.action).toBe('defer');

      const pending = engine.pendingDeferrals();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.decisionId).toBe(result.decisionId);
      expect(pending[0]?.deferCount).toBe(1);
      expect(pending[0]?.deferredUntil).toBe(result.outcome.deferUntil);
    });

    it('re-evaluates and emits once the window opens', async () => {
      const engine = newEngine();
      const deferred = engine.evaluate(validCandidate, { currentHour: 23 });
      const dueAt = deferred.outcome.deferUntil!;

      // Nothing is due a millisecond early.
      expect(await engine.processDeferred({ currentHour: 6 }, dueAt - 1)).toHaveLength(0);
      expect(engine.pendingDeferrals()).toHaveLength(1);

      const replayed = await engine.processDeferred({ currentHour: 9 }, dueAt);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.outcome.action).toBe('emit');
      // The same decision row, not a duplicate: the candidate kept its identity
      // across the wait, so an audit reads one decision that was postponed and
      // then made — not two unrelated ones.
      expect(replayed[0]?.decisionId).toBe(deferred.decisionId);
      expect(engine.pendingDeferrals()).toHaveLength(0);
    });

    it('does not replay a deferral twice', async () => {
      const engine = newEngine();
      const deferred = engine.evaluate(validCandidate, { currentHour: 23 });
      const dueAt = deferred.outcome.deferUntil!;

      expect(await engine.processDeferred({ currentHour: 9 }, dueAt)).toHaveLength(1);
      expect(await engine.processDeferred({ currentHour: 9 }, dueAt + 60_000)).toHaveLength(0);
    });
    it('applies current authorization when a deferral returns, not the verdict it left with', async () => {
      const engine = newEngine();
      const deferred = engine.evaluate(
        { ...validCandidate, identityId: person.id, callerKind: 'person' },
        { currentHour: 23 },
      );
      expect(deferred.outcome.action).toBe('defer');

      // Consent is withdrawn while the message waits out the night. A queue that
      // replayed the stored verdict would deliver something the application
      // would refuse if asked today.
      identityRepo.updatePermissions(person.id, {
        ...DEFAULT_PERMISSIONS.person,
        mayReceiveProactiveMessages: false,
      });

      const replayed = await engine.processDeferred({ currentHour: 9 }, deferred.outcome.deferUntil!);
      expect(replayed[0]?.outcome.action).toBe('reject');
      expect(replayed[0]?.outcome.reason).toContain('not authorized');
    });

    it('publishes proactive.deferred, not proactive.suppressed', async () => {
      const engine = newEngine();
      const events: { type: string; payload: unknown }[] = [];
      eventBus.subscribe((evt) => {
        events.push({ type: evt.type, payload: evt.payload });
      });

      const result = engine.evaluate(validCandidate, { currentHour: 23 });
      await new Promise((r) => setTimeout(r, 0));

      // `proactive.deferred` was declared in the event union and never
      // published; a deferral went out as a suppression, so no subscriber could
      // tell "not now, at 07:00" from "no".
      const deferredEvent = events.find((e) => e.type === 'proactive.deferred');
      expect(deferredEvent).toBeDefined();
      expect(events.some((e) => e.type === 'proactive.suppressed')).toBe(false);
      expect(deferredEvent?.payload).toMatchObject({
        decisionId: result.decisionId,
        deferUntil: result.outcome.deferUntil,
        deferCount: 1,
      });
    });
    it('rate-limits on what was actually said, so a deferral does not block its own return', async () => {
      const engine = newEngine();

      // A suppressed attempt never reached anyone, so it must not stand in the
      // way of the next attempt at the same topic.
      engine.evaluate({ ...validCandidate, topic: 'quiet_topic', novelty: 0.1 }, { currentHour: 14 });
      expect(engine.isRateLimited(owner.id, 'quiet_topic')).toBe(false);

      // An emitted one does.
      engine.evaluate({ ...validCandidate, topic: 'spoken_topic' }, { currentHour: 14 });
      expect(engine.isRateLimited(owner.id, 'spoken_topic')).toBe(true);

      // And a deferral is not something said. This is the trap the queue would
      // have fallen into: the deferral's own row rate-limited its
      // re-evaluation, so every deferred candidate came back only to be refused
      // as a repeat of the attempt that had never happened.
      const deferred = engine.evaluate({ ...validCandidate, topic: 'night_topic' }, { currentHour: 23 });
      expect(engine.isRateLimited(owner.id, 'night_topic')).toBe(false);

      const replayed = await engine.processDeferred({ currentHour: 9 }, deferred.outcome.deferUntil!);
      expect(replayed[0]?.outcome.action).toBe('emit');
      expect(engine.isRateLimited(owner.id, 'night_topic')).toBe(true);
    });

    it('gives up on a candidate that is never welcome, rather than deferring forever', async () => {
      const engine = newEngine({ deferBackoffMs: 1000, maxDeferrals: 2 });

      const first = engine.evaluate(costly, { currentHour: 14 });
      expect(first.outcome.action).toBe('defer');

      const second = await engine.processDeferred({ currentHour: 14 }, first.outcome.deferUntil!);
      expect(second[0]?.outcome.action).toBe('defer');

      const third = await engine.processDeferred({ currentHour: 14 }, second[0]!.outcome.deferUntil!);
      expect(third[0]?.outcome.action).toBe('suppress');
      expect(third[0]?.outcome.reason).toContain('abandoning');
      expect(engine.pendingDeferrals()).toHaveLength(0);
    });

    it('resolves a deferral it cannot reconstruct instead of leaving it pending forever', async () => {
      const engine = newEngine();
      db.raw
        .prepare(
          `INSERT INTO proactive_decision (id, identity_id, decision, urgency, novelty, interruption_cost,
             action, deferred_until, defer_count, candidate_json)
           VALUES ('orphan', ?, '{"topic":"lost"}', 0.5, 0.8, 0.3, 'defer', ?, 1, NULL)`,
        )
        .run(owner.id, new Date(Date.now() - 1000).toISOString());

      expect(engine.pendingDeferrals()).toHaveLength(1);
      expect(await engine.processDeferred({ currentHour: 14 })).toHaveLength(0);
      expect(engine.pendingDeferrals()).toHaveLength(0);

      const row = db.raw
        .prepare(`SELECT action, reason_json FROM proactive_decision WHERE id = 'orphan'`)
        .get() as { action: string; reason_json: string };
      expect(row.action).toBe('suppress');
      expect(row.reason_json).toContain('could not be reconstructed');
    });
  });
});
