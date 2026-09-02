import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { ImportLegacyScript } from '../../scripts/migrate/import_legacy.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { IdentityRepository } from '@server/identity/repository.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('P28: Rollout & Migration (Part XXV.2)', () => {
  let db: Database;
  let legacyDb: Database;
  let identityRepo: IdentityRepository;
  let memoryRepo: MemoryRepository;
  let importer: ImportLegacyScript;
  let tempDir: string;
  let legacyDbPath: string;

  beforeEach(async () => {
    // Setup destination DB
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    identityRepo = new IdentityRepository(db);
    memoryRepo = new MemoryRepository(db);

    // Setup legacy DB layout in temp file (memory DB can't be opened by two connections easily the way better-sqlite3 handles dual-db sometimes, so let's just make a file)
    tempDir = await fs.mkdtemp(path.join(__dirname, 'legacy-test-'));
    legacyDbPath = path.join(tempDir, 'legacy.sqlite');
    legacyDb = new Database({ path: legacyDbPath });

    // Seed legacy db with old schema
    legacyDb.raw.exec(`
      CREATE TABLE old_users ( id TEXT, name TEXT, role TEXT );
      CREATE TABLE old_memories ( id TEXT, user_id TEXT, text TEXT, category TEXT );
    `);

    importer = new ImportLegacyScript(db, legacyDb);
  });

  afterEach(async () => {
    db.close();
    legacyDb.close();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('dry-run test', () => {
    it('simulates import without modifying destination DB', async () => {
      legacyDb.raw.prepare(`INSERT INTO old_users VALUES ('u1', 'Test Owner', 'admin')`).run();
      legacyDb.raw.prepare(`INSERT INTO old_memories VALUES ('m1', 'u1', 'Likes blue', 'preference')`).run();

      const stats = await importer.run({ dryRun: true });
      expect(stats.identitiesScanned).toBe(1);
      expect(stats.memoriesScanned).toBe(1);

      const allIdentities = identityRepo.listIdentities();
      expect(allIdentities.length).toBe(0); // unaltered
    });
  });

  describe('validated import', () => {
    it('requires owner confirmation, applies provenance, and scopes to new Knowledge Retrieval Policy', async () => {
      legacyDb.raw.prepare(`INSERT INTO old_users VALUES ('u1', 'Test Owner', 'admin')`).run();
      legacyDb.raw.prepare(`INSERT INTO old_users VALUES ('u2', 'Test Guest', 'guest')`).run();
      legacyDb.raw.prepare(`INSERT INTO old_memories VALUES ('m1', 'u1', 'Likes blue', 'preference')`).run();

      // Owner confirmation must be passed in
      const stats = await importer.run({ dryRun: false, ownerConfirmed: true });
      expect(stats.identitiesImported).toBe(2);
      expect(stats.memoriesImported).toBe(1);

      const allIdentities = identityRepo.listIdentities();
      expect(allIdentities.length).toBe(2);
      const owner = allIdentities.find(i => i.displayName === 'Test Owner')!;

      const mems = memoryRepo.listPreferences(owner.id);
      expect(mems.length).toBe(1);

      const mem = mems[0]!;
      expect(mem.value).toBe('Likes blue');
      expect(mem.sensitivity).toBe('owner_only'); // Mapped securely
      expect(mem.provenance).toBeDefined();
      expect(mem.provenance.extractor).toBe('legacy_import');
    });

    it('fails if ownerConfirmation is not provided', async () => {
       await expect(importer.run({ dryRun: false, ownerConfirmed: false }))
         .rejects.toThrow(/Owner confirmation required/);
    });
  });

  describe('rollback test', () => {
    it('rolls back completely if an error occurs during import transaction', async () => {
      legacyDb.raw.prepare(`INSERT INTO old_users VALUES ('u1', 'Test Owner', 'admin')`).run();
      legacyDb.raw.prepare(`INSERT INTO old_memories VALUES ('m1', 'u1', 'Likes blue', 'preference')`).run();

      // Corrupt a foreign key constraint or inject a failure midway by making db reject an insert
      // For instance, let's close or add a constraint that fails on second insert
      const badImporter = new ImportLegacyScript(db, legacyDb);

      // Let's create an identity that conflicts or create a trigger that throws
      db.raw.exec(`
        CREATE TRIGGER fail_on_memory BEFORE INSERT ON preference
        BEGIN
          SELECT RAISE(FAIL, 'Simulated import failure');
        END;
      `);

      await expect(badImporter.run({ dryRun: false, ownerConfirmed: true }))
        .rejects.toThrow('Simulated import failure');

      // Verify that the identity that was inserted before preference was rolled back atomically
      const allIdentities = identityRepo.listIdentities();
      expect(allIdentities.length).toBe(0);
      const allPreferences = memoryRepo.listPreferences();
      expect(allPreferences.length).toBe(0);
    });
  });

  describe('dual-DB and archive', () => {
    it('never writes to the old database (preserved as archive)', async () => {
      legacyDb.raw.prepare(`INSERT INTO old_users VALUES ('u1', 'Test Owner', 'admin')`).run();

      const stats = await importer.run({ dryRun: false, ownerConfirmed: true });
      expect(stats.identitiesImported).toBe(1);

      // Old DB structure is untouched, no new tables added
      const tables = legacyDb.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {name: string}[];
      expect(tables.map(t => t.name)).not.toContain('identity'); // New schema table
      expect(tables.map(t => t.name)).toContain('old_users');
    });
  });
});
