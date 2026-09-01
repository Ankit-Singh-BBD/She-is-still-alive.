import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import type { MemoryProvenance } from '@server/memory/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('Phase P05: Memory Domains & Knowledge Retrieval Policy', () => {
  let db: Database;
  let repo: MemoryRepository;
  let retrieval: MemoryRetrieval;

  const mockProvenance: MemoryProvenance = {
    sourceCycleId: '01HX0000000000000000000001',
    sourceConversationId: '01HX0000000000000000000002',
    sourceMessageIds: ['01HX0000000000000000000003'],
    extractedAt: Date.now(),
    extractor: 'rule',
    confidence: 1.0,
    validatedBy: 'app_rule',
  };

  const ownerId = '01HXOWNER00000000000000001';
  const personId = '01HXPERSON0000000000000001';
  const guestId = '01HXGUEST00000000000000001';

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);

    // Insert dummy identities for foreign key integrity
    db.raw
      .prepare(
        `
      INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
      VALUES
        (?, 'owner', 'Owner User', 'active', datetime('now'), datetime('now')),
        (?, 'person', 'Known Person', 'active', datetime('now'), datetime('now')),
        (?, 'guest', 'Guest User', 'active', datetime('now'), datetime('now'))
    `
      )
      .run(ownerId, personId, guestId);

    repo = new MemoryRepository(db);
    retrieval = new MemoryRetrieval(repo);
  });

  describe('1. Episodic Memory CRUD & Lifecycle', () => {
    it('creates and retrieves an episodic memory with full provenance', () => {
      const mem = repo.createEpisodic({
        identityId: ownerId,
        summary: 'Met with Alice to discuss Q3 roadmap',
        details: 'Discussed timeline, milestones, and hiring targets.',
        occurredAt: 1700000000000,
        importance: 0.8,
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 0.95,
        sourceKind: 'conversation',
        provenance: mockProvenance,
      });

      expect(mem.id).toBeDefined();
      expect(mem.summary).toBe('Met with Alice to discuss Q3 roadmap');
      expect(mem.importance).toBe(0.8);
      expect(mem.lifecycleStatus).toBe('active');
      expect(mem.provenance.sourceCycleId).toBe(mockProvenance.sourceCycleId);

      const retrieved = repo.getEpisodic(mem.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.summary).toBe(mem.summary);
      expect(retrieved?.details).toBe(mem.details);
      expect(retrieved?.provenance.extractedAt).toBe(mockProvenance.extractedAt);
    });

    it('handles soft-delete, active listing, and restore', () => {
      const mem = repo.createEpisodic({
        identityId: ownerId,
        summary: 'Temporary event',
        provenance: mockProvenance,
      });

      expect(repo.listEpisodic(ownerId)).toHaveLength(1);

      // Soft delete
      const deleted = repo.softDeleteEpisodic(mem.id, ownerId);
      expect(deleted).toBe(true);

      // Should not appear in default list
      expect(repo.listEpisodic(ownerId)).toHaveLength(0);
      // But exists in deleted list
      expect(repo.listEpisodic(ownerId, true)).toHaveLength(1);

      // Restore
      const restored = repo.restoreEpisodic(mem.id);
      expect(restored).toBe(true);
      expect(repo.listEpisodic(ownerId)).toHaveLength(1);
    });
  });

  describe('2. Semantic Memory CRUD', () => {
    it('creates, retrieves, and lists semantic facts', () => {
      const fact = repo.createSemantic({
        identityId: ownerId,
        subject: 'Ankit',
        predicate: 'prefers_language',
        object: 'TypeScript',
        confidence: 1.0,
        sensitivity: 'person_shared',
        provenance: mockProvenance,
      });

      expect(fact.id).toBeDefined();
      expect(fact.subject).toBe('Ankit');
      expect(fact.predicate).toBe('prefers_language');
      expect(fact.object).toBe('TypeScript');

      const retrieved = repo.getSemantic(fact.id);
      expect(retrieved?.predicate).toBe('prefers_language');
      expect(retrieved?.object).toBe('TypeScript');
    });
  });

  describe('3. Preference CRUD & Idempotent Updates', () => {
    it('creates and upserts preferences by key', () => {
      const pref1 = repo.setPreference({
        identityId: ownerId,
        key: 'theme',
        value: 'dark',
        provenance: mockProvenance,
      });

      expect(pref1.value).toBe('dark');
      expect(repo.getPreference(ownerId, 'theme')?.value).toBe('dark');

      // Update same key
      const pref2 = repo.setPreference({
        identityId: ownerId,
        key: 'theme',
        value: 'system',
        provenance: mockProvenance,
      });

      expect(pref2.id).toBe(pref1.id);
      expect(pref2.value).toBe('system');
      expect(repo.getPreference(ownerId, 'theme')?.value).toBe('system');
      expect(repo.listPreferences(ownerId)).toHaveLength(1);
    });
  });

  describe('4. Habit CRUD', () => {
    it('tracks observed behavioral habits', () => {
      const habit = repo.createHabit({
        identityId: personId,
        pattern: 'Drinks coffee at 9:00 AM',
        frequency: 'daily',
        lastObserved: 1700000000000,
        provenance: mockProvenance,
      });

      expect(habit.id).toBeDefined();
      expect(habit.pattern).toBe('Drinks coffee at 9:00 AM');
      expect(habit.frequency).toBe('daily');

      const list = repo.listHabits(personId);
      expect(list).toHaveLength(1);
      expect(list[0]?.pattern).toBe(habit.pattern);
    });
  });

  describe('5. Relationship CRUD', () => {
    it('manages personal relationships of the owner', () => {
      const rel = repo.createRelationship({
        ownerId,
        name: 'Madhurita',
        relation: 'AI Companion',
        notes: 'Core cognitive partner',
        importance: 1.0,
      });

      expect(rel.id).toBeDefined();
      expect(rel.name).toBe('Madhurita');
      expect(rel.relation).toBe('AI Companion');
      expect(rel.importance).toBe(1.0);

      const list = repo.listRelationships(ownerId);
      expect(list).toHaveLength(1);
      expect(list[0]?.name).toBe('Madhurita');
    });
  });

  describe('6. Learned Patterns CRUD', () => {
    it('records generalized patterns with evidence counts', () => {
      const pattern = repo.createLearnedPattern({
        identityId: ownerId,
        pattern: 'Prefers concise bullet points in code reviews',
        evidenceCount: 5,
        confidence: 0.9,
        provenance: mockProvenance,
      });

      expect(pattern.id).toBeDefined();
      expect(pattern.pattern).toContain('concise bullet points');
      expect(pattern.evidenceCount).toBe(5);

      const retrieved = repo.getLearnedPattern(pattern.id);
      expect(retrieved?.evidenceCount).toBe(5);
    });
  });

  describe('7. Knowledge Retrieval Policy (Layer 2 & Identity Isolation)', () => {
    beforeEach(() => {
      // Seed data across owner, person, and guest
      repo.createEpisodic({
        identityId: ownerId,
        summary: 'Owner secret project planning notes',
        importance: 0.9,
        sensitivity: 'owner_only',
        occurredAt: Date.now() - 1000,
        provenance: mockProvenance,
      });

      repo.createEpisodic({
        identityId: ownerId,
        summary: 'General shared discussion on weather',
        importance: 0.3,
        sensitivity: 'public',
        occurredAt: Date.now() - 2000,
        provenance: mockProvenance,
      });

      repo.createEpisodic({
        identityId: personId,
        summary: 'Person private notes on vacation',
        importance: 0.5,
        sensitivity: 'person_shared',
        occurredAt: Date.now() - 3000,
        provenance: mockProvenance,
      });

      repo.createPreference({
        identityId: guestId,
        key: 'guest_topic',
        value: 'tech_support',
        sensitivity: 'public',
        provenance: mockProvenance,
      });
    });

    it('Guest cannot retrieve owner memories or other person memories (Invariant B.1/F.1)', async () => {
      const result = await retrieval.retrieve({
        callerId: guestId,
        callerKind: 'guest',
        query: 'project weather notes',
        domains: ['episodic', 'semantic', 'preference', 'habit', 'relationship', 'learned_pattern'],
        limit: 10,
        recencyWeight: 0.4,
        importanceWeight: 0.3,
        similarityWeight: 0.3,
        excludeSoftDeleted: true,
      });

      // Guest should not see any owner or person items
      for (const item of result.items) {
        expect(item.identityId).toBe(guestId);
      }
    });

    it('Owner can retrieve all sensitivity tiers for owner and search across domains', async () => {
      const result = await retrieval.retrieve({
        callerId: ownerId,
        callerKind: 'owner',
        query: 'secret project',
        domains: ['episodic'],
        limit: 10,
        recencyWeight: 0.2,
        importanceWeight: 0.3,
        similarityWeight: 0.5,
        excludeSoftDeleted: true,
      });

      expect(result.items.length).toBeGreaterThan(0);
      const topItem = result.items[0];
      expect(topItem?.summary).toContain('secret project planning');
      expect(topItem?.sensitivity).toBe('owner_only');
    });

    it('Person cannot retrieve owner_only sensitivity memories', async () => {
      const result = await retrieval.retrieve({
        callerId: personId,
        callerKind: 'person',
        query: 'secret project',
        domains: ['episodic'],
        limit: 10,
        recencyWeight: 0.2,
        importanceWeight: 0.3,
        similarityWeight: 0.5,
        excludeSoftDeleted: true,
      });

      for (const item of result.items) {
        expect(item.sensitivity).not.toBe('owner_only');
        expect(item.identityId).toBe(personId);
      }
    });

    it('Excludes soft-deleted memories from retrieval by default', async () => {
      const mem = repo.createEpisodic({
        identityId: ownerId,
        summary: 'Memory to be soft-deleted',
        provenance: mockProvenance,
      });

      repo.softDeleteEpisodic(mem.id, ownerId);

      const result = await retrieval.retrieve({
        callerId: ownerId,
        callerKind: 'owner',
        query: 'soft-deleted',
        domains: ['episodic'],
        limit: 10,
        recencyWeight: 0.4,
        importanceWeight: 0.3,
        similarityWeight: 0.3,
        excludeSoftDeleted: true,
      });

      const ids = result.items.map((i) => i.id);
      expect(ids).not.toContain(mem.id);
    });
  });
});
