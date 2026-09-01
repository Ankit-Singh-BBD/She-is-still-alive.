import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { resolve } from 'node:path';
import { MemoryRepository } from '@server/memory/repository.js';
import { IdentityRepository, DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { EventBus } from '@server/events/event-bus.js';
import { LearningPipeline } from '@server/learning/pipeline.js';
import type {
  LearningExtractor,
  CycleRecord,
  Message,
} from '@server/learning/types.js';
import type { Identity } from '@server/identity/types.js';

describe('Learning Pipeline (P16)', () => {
  let db: Database;
  let eventBus: EventBus;
  let memoryRepo: MemoryRepository;
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

    // Insert Mock Conversation and Cycle Record for foreign key constraints
    db.raw
      .prepare(`INSERT INTO conversation (id, identity_id, channel, status) VALUES (?, ?, ?, ?)`)
      .run('conv_001', guest.id, 'text', 'active');

    db.raw
      .prepare(`INSERT INTO cycle_record (id, conversation_id, status) VALUES (?, ?, ?)`)
      .run('cyc_001', 'conv_001', 'completed');

    eventBus = new EventBus(db);
    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  const createMockCycle = (identityId: string): CycleRecord => ({
    id: 'cyc_001',
    identityId,
    conversationId: 'conv_001',
    startedAt: Date.now() - 1000,
    completedAt: Date.now(),
    status: 'completed',
  });

  const createMockMessages = (): Message[] => [
    { id: 'msg_1', conversationId: 'conv_001', role: 'user', text: 'I love dark roast coffee.', timestamp: Date.now() - 500 },
    { id: 'msg_2', conversationId: 'conv_001', role: 'assistant', text: 'Got it!', timestamp: Date.now() },
  ];

  it('filters candidates below confidence or importance thresholds', async () => {
    const mockExtractor: LearningExtractor = {
      extract: async () => [
        {
          domain: 'preference',
          callerId: owner.id,
          callerKind: 'owner',
          content: { key: 'coffee', value: 'dark roast' },
          confidence: 0.5, // Below 0.7 threshold
          importance: 0.8,
          reasoning: 'Low confidence test',
        },
        {
          domain: 'preference',
          callerId: owner.id,
          callerKind: 'owner',
          content: { key: 'tea', value: 'green tea' },
          confidence: 0.9,
          importance: 0.2, // Below 0.5 threshold
          reasoning: 'Low importance test',
        },
      ],
    };

    const pipeline = new LearningPipeline({
      db,
      eventBus,
      memoryRepo,
      identityRepo,
      extractor: mockExtractor,
    });

    const result = await pipeline.processCycle(createMockCycle(owner.id), createMockMessages());
    expect(result.learned).toBe(false);
    expect(result.count).toBe(0);
    expect(result.details.length).toBe(2);
    expect(result.details[0]?.decision.action).toBe('discard');
    expect(result.details[1]?.decision.action).toBe('discard');
  });

  it('enforces Scoped Guest Learning Policy for guests', async () => {
    const mockExtractor: LearningExtractor = {
      extract: async () => [
        // 1. Guest preference -> Allowed, public/isolated
        {
          domain: 'preference',
          callerId: guest.id,
          callerKind: 'guest',
          content: { key: 'language', value: 'es' },
          confidence: 0.9,
          importance: 0.7,
          reasoning: 'Guest preference',
        },
        // 2. Guest episodic small talk -> Discarded
        {
          domain: 'episodic',
          callerId: guest.id,
          callerKind: 'guest',
          content: { summary: 'Talked about weather' },
          confidence: 0.9,
          importance: 0.8,
          reasoning: 'Small talk',
        },
        // 3. Guest claim about owner -> Quarantined
        {
          domain: 'semantic',
          callerId: guest.id,
          callerKind: 'guest',
          content: { subject: 'owner', predicate: 'lives_in', object: 'Tokyo' },
          confidence: 0.9,
          importance: 0.9,
          reasoning: 'Claim about owner',
        },
      ],
    };

    const pipeline = new LearningPipeline({
      db,
      eventBus,
      memoryRepo,
      identityRepo,
      extractor: mockExtractor,
    });

    const result = await pipeline.processCycle(createMockCycle(guest.id), createMockMessages());
    expect(result.count).toBe(2); // 1 preference persisted + 1 quarantined

    const pref = memoryRepo.getPreference(guest.id, 'language');
    expect(pref).not.toBeNull();
    expect(pref?.value).toBe('es');
    expect(pref?.subjectKind).toBe('guest');

    // Quarantined semantic memory is recorded in DB with archived status
    const quarantined = db.raw.prepare(`SELECT * FROM semantic_memory WHERE identity_id = ?`).all(guest.id) as Array<{ lifecycle_status: string }>;
    expect(quarantined.length).toBe(1);
    expect(quarantined[0]?.lifecycle_status).toBe('archived');
  });

  it('deduplicates and updates existing preference and increments learned pattern evidence', async () => {
    // Pre-seed a preference
    memoryRepo.createPreference({
      identityId: owner.id,
      key: 'theme',
      value: 'light',
      provenance: {
        sourceCycleId: 'c1',
        sourceConversationId: 'cv1',
        sourceMessageIds: [],
        extractedAt: Date.now(),
        extractor: 'rule',
        confidence: 1.0,
        validatedBy: 'app_rule',
      },
    });

    // Pre-seed a learned pattern
    memoryRepo.createLearnedPattern({
      identityId: owner.id,
      pattern: 'night owl',
      evidenceCount: 1,
      provenance: {
        sourceCycleId: 'c1',
        sourceConversationId: 'cv1',
        sourceMessageIds: [],
        extractedAt: Date.now(),
        extractor: 'rule',
        confidence: 1.0,
        validatedBy: 'app_rule',
      },
    });

    const mockExtractor: LearningExtractor = {
      extract: async () => [
        {
          domain: 'preference',
          callerId: owner.id,
          callerKind: 'owner',
          content: { key: 'theme', value: 'dark' }, // update to dark
          confidence: 0.95,
          importance: 0.9,
          reasoning: 'Updated preference',
        },
        {
          domain: 'learned_pattern',
          callerId: owner.id,
          callerKind: 'owner',
          content: { pattern: 'night owl' }, // reinforces pattern
          confidence: 0.9,
          importance: 0.8,
          reasoning: 'More evidence',
        },
      ],
    };

    const pipeline = new LearningPipeline({
      db,
      eventBus,
      memoryRepo,
      identityRepo,
      extractor: mockExtractor,
    });

    const result = await pipeline.processCycle(createMockCycle(owner.id), createMockMessages());
    expect(result.count).toBe(2);
    expect(result.details[0]?.dedupe.action).toBe('update');
    expect(result.details[1]?.dedupe.action).toBe('update');

    // Verify preference updated
    const pref = memoryRepo.getPreference(owner.id, 'theme');
    expect(pref?.value).toBe('dark');

    // Verify pattern evidence count incremented
    const patterns = memoryRepo.listLearnedPatterns(owner.id);
    expect(patterns[0]?.evidenceCount).toBe(2);
  });
});
