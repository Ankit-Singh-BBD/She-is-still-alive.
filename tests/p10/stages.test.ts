import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { resolve } from 'node:path';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { learn } from '@server/cognition/stages/10.js';
import { update } from '@server/cognition/stages/11.js';
import { persist } from '@server/cognition/stages/12.js';
import type {
  IdentifiedStimulus,
  RecalledContext,
  AuthorizedDecision,
  AuthorizedResponse,
  AuditEntry,
} from '@server/cognition/types.js';

describe('Cognitive Loop - Stages 10-12 (LEARN .. PERSIST)', () => {
  let db: Database;
  let memoryRepo: MemoryRepository;
  const ownerId = 'usr_00000000000000000000000001';
  const guestId = 'usr_guest00000000000000000001';

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));

    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', 'Owner', 'active', 0, 0)`).run(ownerId);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(ownerId, JSON.stringify(DEFAULT_PERMISSIONS.owner));
    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'guest', 'Guest', 'active', 0, 0)`).run(guestId);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(guestId, JSON.stringify(DEFAULT_PERMISSIONS.guest));
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv1', ?)`).run(ownerId);
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-guest', ?)`).run(guestId);
    db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json) VALUES (?, 'conv1', 'running', ?, '{}')`).run('cycle1', new Date().toISOString());

    memoryRepo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeContext(identityId: string, kind: 'owner' | 'guest', payload: string): RecalledContext {
    const identified: IdentifiedStimulus = {
      source: 'text',
      payload,
      receivedAt: Date.now(),
      identityId,
      conversationId: kind === 'guest' ? 'conv-guest' : 'conv1',
      identityKind: kind,
      callerPermissions: DEFAULT_PERMISSIONS[kind],
      inputType: 'user_message'
    };
    return {
      stimulus: identified,
      episodic: [],
      semantic: [],
      preferences: [],
      habits: [],
      relationships: [],
      learnedPatterns: [],
      retrievedAt: Date.now()
    };
  }

  const defaultDecision: AuthorizedDecision = {
    proposal: { action: 'respond', rationale: 'test' },
    authorized: true,
    clearanceChecked: true
  };
  const defaultResponse: AuthorizedResponse = { text: 'ok', voiceEnabled: false, disclosuresApplied: [], redacted: false };

  describe('Stage 10: LEARN (Scoped Guest Learning Policy)', () => {
    it('extracts Owner explicit preferences via rules (no LLM)', async () => {
      const recalled = makeContext(ownerId, 'owner', 'I prefer dark mode');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      expect(delta.memories.length).toBe(1);
      const mem = delta.memories[0]!;
      expect(mem.domain).toBe('preference');
      expect(mem.data['value']).toBe('dark mode');
      expect(mem.sensitivity).toBe('person_shared');
      expect(mem.data['identityId']).toBe(ownerId);
      expect(mem.provenance.extractor).toBe('rule');
    });

    it('quarantines Guest observations about Owner (Part XIII.4)', async () => {
      const recalled = makeContext(guestId, 'guest', 'The owner likes spicy food');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      expect(delta.memories.length).toBe(1);
      const mem = delta.memories[0]!;
      expect(mem.domain).toBe('preference');
      expect(mem.data['value']).toBe('spicy food');
      // Must map identity back to the guest as it is unverified claim about owner by a guest
      expect(mem.data['identityId']).toBe(guestId);
      expect(mem.provenance.validatedBy).toBe('owner_confirmation');
    });

    it('allows Guest to safely declare their own preferences', async () => {
      const recalled = makeContext(guestId, 'guest', 'I love jazz music');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      expect(delta.memories.length).toBe(1);
      const mem = delta.memories[0]!;
      expect(mem.domain).toBe('preference');
      expect(mem.data['value']).toBe('jazz music');
      // Should be assigned to the guest
      expect(mem.data['identityId']).toBe(guestId);
      expect(mem.provenance.validatedBy).toBe('app_rule');
    });

    it('discards small talk', async () => {
      const recalled = makeContext(ownerId, 'owner', 'Good morning');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);
      expect(delta.memories.length).toBe(0);
    });
  });

  describe('Stage 11: UPDATE (Domain Writes)', () => {
    it('applies authorized learning delta to memory tables', async () => {
      const recalled = makeContext(ownerId, 'owner', 'I prefer dark mode');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      const updateResult = await update(delta, { memoryRepo });
      expect(updateResult.applied).toBe(1);
      expect(updateResult.skipped).toBe(0);
      expect(updateResult.errors.length).toBe(0);

      // Verify persistence
      const prefs = memoryRepo.listPreferences(ownerId);
      expect(prefs.length).toBe(1);
      expect(prefs[0]?.value).toBe('dark mode');
    });
  });

  describe('Stage 12: PERSIST (Transactional Comit)', () => {
    it('commits cycle_record update, domain_event, and audit_log atomically', async () => {
      const cycleId = 'cycle1';
      const auditEntry: AuditEntry = {
        actorId: ownerId,
        action: 'disclosure:redact',
        resource: 'response',
        decision: 'redacted',
        at: Date.now()
      };

      const persistInput = {
        cycleId,
        status: 'completed' as const,
        completedAt: Date.now(),
        identityId: ownerId,
        actionResults: [],
        decision: defaultDecision,
        response: defaultResponse,
        learningDelta: undefined,
        updateResult: undefined,
        audit: [auditEntry],
        stages: []
      };

      const result = await persist(persistInput, { db });
      expect(result.cycleRecordId).toBe(cycleId);
      expect(result.eventsEmitted).toBeGreaterThan(0);

      // Verify cycle record status
      const cycle = db.raw.prepare(`SELECT status FROM cycle_record WHERE id = ?`).get(cycleId) as any;
      expect(cycle.status).toBe('completed');

      // Verify audit logic
      const audits = db.raw.prepare(`SELECT * FROM audit_log WHERE actor_id = ?`).all(ownerId) as any[];
      expect(audits.length).toBe(1);
      expect(audits[0].action).toBe('disclosure:redact');

      // Verify domain events
      const events = db.raw.prepare(`SELECT * FROM domain_event WHERE cycle_id = ? ORDER BY seq`).all(cycleId) as any[];
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1].type).toBe('cycle.completed');
    });
  });
});
