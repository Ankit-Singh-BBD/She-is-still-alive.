import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import { IdentityRepository, DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { ActionPipeline } from '@server/actions/pipeline.js';
import { ToolRegistry } from '@server/actions/registry.js';
import { SecurityPolicy } from '@server/security/policy.js';
import { respond } from '@server/cognition/stages/9.js';
import { z } from 'zod';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('P27: Security Pass Verification (Part XXIII.3)', () => {
  let db: Database;
  let identityRepo: IdentityRepository;
  let memoryRepo: MemoryRepository;
  let retrieval: MemoryRetrieval;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    identityRepo = new IdentityRepository(db);
    memoryRepo = new MemoryRepository(db);
    retrieval = new MemoryRetrieval(memoryRepo);
  });

  describe('1. guest cannot enumerate owner identities', () => {
    it('applies identity enumeration filtering based on caller kind', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const person = await identityRepo.createIdentity({ kind: 'person', displayName: 'Person' });
      const guest = await identityRepo.createIdentity({ kind: 'guest', displayName: 'Guest' });

      const all = identityRepo.listIdentities();

      const ownerView = SecurityPolicy.filterIdentitiesForCaller(owner, all);
      expect(ownerView.length).toBe(3);

      const personView = SecurityPolicy.filterIdentitiesForCaller(person, all);
      expect(personView.length).toBe(1);
      expect(personView[0]!.id).toBe(person.id);

      const guestView = SecurityPolicy.filterIdentitiesForCaller(guest, all);
      expect(guestView.length).toBe(0);
    });
  });

  describe('2. person cannot read anothers memory', () => {
    it('MemoryRetrieval strictly isolates semantic memory to the caller identity unless owner', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const personA = await identityRepo.createIdentity({ kind: 'person', displayName: 'Person A' });
      const personB = await identityRepo.createIdentity({ kind: 'person', displayName: 'Person B' });

      memoryRepo.createSemantic({
        identityId: personA.id,
        subject: 'personA',
        predicate: 'likes',
        object: 'apples',
        sensitivity: 'person_shared',
        confidence: 0.9,
        provenance: { sourceCycleId: 'cyc-1', sourceConversationId: 'conv-1', sourceMessageIds: [], extractedAt: 0, extractor: 'llm', confidence: 0.9, validatedBy: 'auto_policy' },
      });

      const resultB = await retrieval.retrieve({
        callerId: personB.id,
        callerKind: personB.kind,
        query: 'apples',
        domains: ['semantic'],
        limit: 10,
        similarityWeight: 1,
        importanceWeight: 0,
        recencyWeight: 0,
        excludeSoftDeleted: true,
      });
      expect(resultB.items.length).toBe(0);

      const resultOwner = await retrieval.retrieve({
        callerId: owner.id,
        callerKind: owner.kind,
        query: 'apples',
        domains: ['semantic'],
        limit: 10,
        similarityWeight: 1,
        importanceWeight: 0,
        recencyWeight: 0,
        excludeSoftDeleted: true,
      });
      expect(resultOwner.items.length).toBe(1);
    });
  });

  describe('3. all tool inputs validated against schema before execution', () => {
    it('ActionPipeline stageUnderstand uses inputSchema and rejects bad payloads', async () => {
      const registry = new ToolRegistry();
      registry.register({
        id: 'secure.tool',
        name: 'Secure Tool',
        description: 'Test',
        inputSchema: z.object({ age: z.number() }),
        clearanceRequired: 'safe',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async (input: unknown) => {
          return { val: (input as { age: number }).age * 2 };
        },
      });

      const pipeline = new ActionPipeline({ registry, db });
      const caller = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-1', ?)`).run(caller.id);
      const __cid1 = 'cyc-1-' + caller.id.slice(0, 8);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(__cid1, 'conv-1');

      const result = await pipeline.execute({
        toolId: 'secure.tool',
        input: { age: 'not a number' },
        identityId: caller.id,
        cycleId: __cid1,
        causationId: 'evt-1',
        caller,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Input validation failed');
    });

    it('ActionPipeline strips unknown properties from valid payloads', async () => {
      let capturedInput: unknown = null;
      const strictRegistry = new ToolRegistry();
      strictRegistry.register({
        id: 'strict.tool',
        name: 'Strict Tool',
        description: 'Test',
        inputSchema: z.object({ name: z.string() }),
        clearanceRequired: 'safe',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async (input: unknown) => {
          capturedInput = input;
          return { msg: 'ok' };
        },
      });

      const pipeline = new ActionPipeline({ registry: strictRegistry, db });
      const caller = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-2', ?)`).run(caller.id);
      const __cid2 = 'cyc-2-' + caller.id.slice(0, 8);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(__cid2, 'conv-2');

      const result = await pipeline.execute({
        toolId: 'strict.tool',
        input: { name: 'alice', hack: 'drop me' },
        identityId: caller.id,
        cycleId: __cid2,
        causationId: 'evt-1',
        caller,
      });

      expect(result.success).toBe(true);
      expect((capturedInput as Record<string, unknown>)['name']).toBe('alice');
      expect((capturedInput as Record<string, unknown>)['hack']).toBeUndefined();
    });
  });

  describe('4. application rejects unauthorized LLM tool-execution proposal before EXECUTE', () => {
    it('AUTHORIZE stage intercepts execution based on Identity clearance', async () => {
      const registry = new ToolRegistry();
      registry.register({
        id: 'nuke.db',
        name: 'Nuke',
        description: 'Dangerous action',
        inputSchema: z.object({}),
        clearanceRequired: 'all',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async () => {
          return { destroyed: true };
        },
      });

      const pipeline = new ActionPipeline({ registry, db });
      const person = await identityRepo.createIdentity({ kind: 'person', displayName: 'Person' });
      // Grant tool access but not 'all' clearance
      person.permissions = { ...DEFAULT_PERMISSIONS.person, mayTriggerActions: 'safe', mayAccessTools: ['nuke.db'] };

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-3', ?)`).run(person.id);
      const __cid3 = 'cyc-3-' + person.id.slice(0, 8);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(__cid3, 'conv-3');

      const result = await pipeline.execute({
        toolId: 'nuke.db',
        input: {},
        identityId: person.id,
        cycleId: __cid3,
        causationId: 'evt-1',
        caller: person,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/all clearance, caller only has safe/);
    });
  });

  describe('5. application redacts LLM-drafted response if violates Knowledge Disclosure Policy', () => {
    it('redacts unverified claims and records disclosure suppression', async () => {
      const caller = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const recalled = {
        stimulus: { identityId: caller.id, identityKind: caller.kind, callerPermissions: caller.permissions, payload: 'test' },
        episodic: [],
        semantic: [],
        preferences: [],
        habits: [],
        relationships: [],
        learnedPatterns: [],
      };
      const decision = { allowed: true, proposal: { action: 'execute_tool' as const } };

      const mockLLM = {
        draftResponse: vi.fn().mockResolvedValue({
          text: 'I have completed the task and deleted the records.',
          voicePreferred: true,
        }),
      };

      const auditMessages: unknown[] = [];
      const auditCollector = { record: (msg: unknown) => auditMessages.push(msg), drain: () => [] as unknown[] };

      const response = await respond(
        recalled as never,
        decision as never,
        [{ toolId: 'delete.tool', success: true, verified: false }],
        undefined,
        { llm: mockLLM, audit: auditCollector },
      );

      expect(response.redacted).toBe(true);
      expect(response.text).toContain('I started on that, but I could not confirm it actually went through');
      expect(response.disclosuresApplied).toContain('unverified_claim_suppression');
      expect(auditMessages.some((a) => (a as { action: string }).action === 'disclosure:suppress_unverified_claim')).toBe(true);
    });

    it('redacts secrets of retrieved memory items explicitly', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const person = await identityRepo.createIdentity({ kind: 'person', displayName: 'Person' });
      // Memory belongs to owner, sensitivity is owner_only - not disclosable to person
      const secretMemory = {
        id: 'mem-1',
        domain: 'preference',
        identityId: owner.id,
        subjectKind: 'person',
        sensitivity: 'owner_only',
        confidence: 1,
        createdAt: 0,
        updatedAt: 0,
        similarityScore: 1,
        key: 'apiKey',
        value: 'sk-ant-very-secret-key-1234',
      };
      const recalled = {
        stimulus: { identityId: person.id, identityKind: person.kind, callerPermissions: person.permissions, payload: 'what is the key?' },
        episodic: [],
        semantic: [],
        preferences: [secretMemory],
        habits: [],
        relationships: [],
        learnedPatterns: [],
      };

      const decision = { allowed: true, proposal: { action: 'respond' as const } };
      const mockLLM = {
        draftResponse: vi.fn().mockResolvedValue({
          text: 'Your key is sk-ant-very-secret-key-1234, save it.',
          voicePreferred: true,
        }),
      };

      const auditCollector = { record: vi.fn(), drain: () => [] as unknown[] };
      const response = await respond(recalled as never, decision as never, [], undefined, { llm: mockLLM, audit: auditCollector });

      expect(response.redacted).toBe(true);
      expect(response.text).not.toContain('sk-ant-very-secret-key-1234');
      expect(response.text).toContain('[redacted]');
    });
  });
  describe('6. encrypted backups at rest', () => {
    it('creates an encrypted backup, verifies integrity, and restores properly', async () => {
      const { createEncryptedBackup, restoreEncryptedBackup, verifyBackupIntegrity } = await import('@server/backup/backup.js');
      const fs = await import('node:fs/promises');
      const os = await import('node:os');
      const crypto = await import('node:crypto');
      const path = await import('node:path');

      // Setup a temp DB with data to backup
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'madhurita-backup-test-'));
      const dbPath = path.join(tempDir, 'source.sqlite');
      const sourceDb = new Database({ path: dbPath });
      runMigrations(sourceDb, migrationsDir);
      
      // Seed some data to verify it survives restore
      sourceDb.raw.prepare(`INSERT INTO app_meta (key, value) VALUES ('backup_test_seed', 'success')`).run();

      const passphrase = 'correct-horse-battery-staple';
      const manifest = await createEncryptedBackup(sourceDb, tempDir, passphrase);
      expect(manifest.status).toBe('completed');
      
      // Verify integrity
      const integrity = await verifyBackupIntegrity(tempDir, manifest);
      expect(integrity.valid).toBe(true);
      expect(integrity.computedSha256).toBe(manifest.sha256);
      
      // Tamper check
      const backupFilePath = path.join(tempDir, `backup-${manifest.id}.enc`);
      const ogFile = await fs.readFile(backupFilePath);
      ogFile[50] = ogFile[50]! ^ 0x01; // flip a bit in ciphertext
      await fs.writeFile(backupFilePath, ogFile);
      const tamperedIntegrity = await verifyBackupIntegrity(tempDir, manifest);
      expect(tamperedIntegrity.valid).toBe(false);
      
      // Revert tamper & restore
      ogFile[50] = ogFile[50]! ^ 0x01; 
      await fs.writeFile(backupFilePath, ogFile);
      
      const restoredPath = await restoreEncryptedBackup(tempDir, manifest.id, passphrase, tempDir);
      const restoredDb = new Database({ path: restoredPath });
      const row = restoredDb.raw.prepare(`SELECT value FROM app_meta WHERE key = 'backup_test_seed'`).get() as { value: string };
      expect(row.value).toBe('success');
      
      // Cleanup
      sourceDb.close();
      restoredDb.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    });
  });

  describe('7. audit log hardening', () => {
    it('scrubs secrets from audit log records', async () => {
      const { AuditLogService } = await import('@server/security/audit.js');
      const audit = new AuditLogService(db);
      
      audit.log({
        action: 'test:action',
        resource: 'system',
        decision: 'allowed',
        metadata: {
          apiKey: 'sk-1234567890',
          nested: {
            passphrase: 'super-secret',
            publicField: 'safe'
          },
          url: 'https://api.example.com/?api_key=sk-1234567890'
        },
        reason: 'User provided passphrase: "super-secret"'
      });
      
      const records = audit.query({ action: 'test:action' });
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.metadataJson).not.toContain('sk-1234567890');
      expect(record.metadataJson).not.toContain('super-secret');
      expect(record.metadataJson).toContain('[redacted]');
      expect(record.metadataJson).toContain('safe'); // non-secret fields remain
      expect(record.reason).not.toContain('super-secret');
    });
    
    it('detects tampering (missing required fields / gaps via db constraints outside of code)', async () => {
      const { AuditLogService } = await import('@server/security/audit.js');
      const audit = new AuditLogService(db);

      const id = audit.log({
        action: 'tamper:action',
        resource: 'system',
        decision: 'allowed'
      });

      let integrity = audit.verifyIntegrity();
      expect(integrity.valid).toBe(true);

      // Manual tamper simulating direct sqlite manipulation
      // Use empty string which passes NOT NULL but is semantically incomplete
      db.raw.prepare(`UPDATE audit_log SET action = '' WHERE id = ?`).run(id);

      integrity = audit.verifyIntegrity();
      expect(integrity.valid).toBe(false);
      expect(integrity.errors[0]).toContain('Incomplete audit record:');
    });
  });
});
