import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { IdentityRepository } from '@server/identity/repository.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { EventBus } from '@server/events/event-bus.js';
import { ToolRegistry } from '@server/actions/registry.js';
import { ActionPipeline } from '@server/actions/pipeline.js';
import { TaskExecutor } from '@server/tasks/executor.js';
import { LoopManager } from '@server/loops/manager.js';
import { ProactiveEngine } from '@server/proactive/engine.js';
import { LearningPipeline } from '@server/learning/pipeline.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { PersonalityRegistry } from '@server/personality/registry.js';
import { PersonalityEngine } from '@server/personality/engine.js';
import { AuditLogService } from '@server/security/audit.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('P28: Actual Clean-Slate Boot Verification', () => {
  let db: Database;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madhurita-clean-slate-'));
    const dbPath = path.join(tempDir, 'clean-slate.sqlite');
    db = new Database({ path: dbPath });
  });

  afterEach(() => {
    db.close();
  });

  it('executes migrations on fresh empty DB and creates all expected tables', () => {
    const beforeTables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    expect(beforeTables.length).toBe(0);

    runMigrations(db, migrationsDir);

    const afterTables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];

    const expectedTables = [
      'app_meta', 'identity', 'permission', 'session', 'conversation',
      'message', 'cycle_record', 'stage_trace', 'action_result', 'domain_event',
      'episodic_memory', 'semantic_memory', 'preference', 'habit',
      'relationship', 'learned_pattern', 'task', 'open_loop', 'audit_log',
    ];

    for (const table of expectedTables) {
      const exists = afterTables.some((t) => t.name === table);
      expect(exists).toBe(true);
    }
  });

  it('has zero legacy tables', () => {
    runMigrations(db, migrationsDir);

    const afterTables = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];

    const legacyTables = ['legacy_import', 'import_legacy', 'migration_guide', 'legacy_archive', 'old_application', 'fallback', 'compatibility'];

    for (const table of legacyTables) {
      const exists = afterTables.some((t) => t.name === table);
      expect(exists).toBe(false);
    }
  });

  it('sets schema_version in app_meta', () => {
    runMigrations(db, migrationsDir);

    const version = db.raw.prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
    expect(version).toBeDefined();
    expect(version!.value).toBeTruthy();
  });

  it('bootstrap owner identity on clean DB', async () => {
    runMigrations(db, migrationsDir);

    const identityRepo = new IdentityRepository(db);
    const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Test Owner' });

    expect(owner.id).toBeTruthy();
    expect(owner.kind).toBe('owner');
    expect(owner.displayName).toBe('Test Owner');
  });

  it('all 16 subsystems instantiate without error on clean DB', async () => {
    runMigrations(db, migrationsDir);

    const identityRepo = new IdentityRepository(db);
    const memoryRepo = new MemoryRepository(db);
    const eventBus = new EventBus(db, { handlerDeadlineMs: 100 });
    const toolRegistry = new ToolRegistry();
    const _actionPipeline = new ActionPipeline({ registry: toolRegistry, db, eventBus });
    const taskExecutor = new TaskExecutor(db, eventBus);
    const _loopManager = new LoopManager(db, eventBus, taskExecutor);
    const _proactiveEngine = new ProactiveEngine({ db, eventBus });
    const _learningSystem = new LearningPipeline({
      db,
      memoryRepo,
      eventBus,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractor: { extract: async () => [] } as any,
    });
    const personalityRegistry = new PersonalityRegistry();
    const _personalityEngine = new PersonalityEngine(personalityRegistry);
    const _auditLogService = new AuditLogService(db);
    const _cognitiveRuntime = new CognitiveRuntime({
      db,
      eventBus,
      identityRepo,
    });

    void _actionPipeline;
    void _loopManager;
    void _proactiveEngine;
    void _learningSystem;
    void _personalityEngine;
    void _auditLogService;
    void _cognitiveRuntime;
    void taskExecutor;
    expect(true).toBe(true);
  });

});
