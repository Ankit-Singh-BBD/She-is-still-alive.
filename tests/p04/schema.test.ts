import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('Phase P04: Domain Schema', () => {
  let db: Database;

  beforeEach(() => {
    // We must test against a real migrated DB.
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
  });

  const EXPECTED_TABLES = [
    'app_meta',
    'identity',
    'identity_credential',
    'permission',
    'session',
    'conversation',
    'message',
    'cycle_record',
    'stage_trace',
    'action_result',
    'episodic_memory',
    'semantic_memory',
    'preference',
    'habit',
    'relationship',
    'learned_pattern',
    'task',
    'open_loop',
    'proactive_decision',
    'audit_log',
    'backup_metadata',
    // Note: domain_event is added in P06, so it's not expected here
  ];

  it('creates all expected tables', () => {
    const rows = db.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    const tables = rows.map((r) => r.name);

    for (const expected of EXPECTED_TABLES) {
      expect(tables).toContain(expected);
    }
  });

  it('validates all foreign keys (no broken links in empty schema)', () => {
    // Check if foreign keys are enabled
    expect(db.getForeignKeysEnabled()).toBe(true);

    // Run PRAGMA foreign_key_check to ensure no existing violations
    const fkViolations = db.raw.prepare('PRAGMA foreign_key_check').all();
    expect(fkViolations.length).toBe(0);
  });

  it('defines the correct columns and foreign keys for a complex table (e.g. episodic_memory)', () => {
    const tableInfo = db.raw
      .prepare("PRAGMA table_info('episodic_memory')")
      .all() as { name: string }[];
    const columns = tableInfo.map((c) => c.name);

    expect(columns).toContain('id');
    expect(columns).toContain('identity_id');
    expect(columns).toContain('subject_kind');
    expect(columns).toContain('sensitivity');
    expect(columns).toContain('summary');
    expect(columns).toContain('deleted_by');

    const foreignKeyList = db.raw
      .prepare("PRAGMA foreign_key_list('episodic_memory')")
      .all() as { from: string }[];
    const fkFields = foreignKeyList.map((fk) => fk.from);

    expect(fkFields).toContain('identity_id');
    expect(fkFields).toContain('deleted_by');
  });

  it('defines the correct columns and cascading foreign keys for message', () => {
    const foreignKeyList = db.raw
      .prepare("PRAGMA foreign_key_list('message')")
      .all() as { from: string; table: string; on_delete: string }[];

    const convoFk = foreignKeyList.find(fk => fk.from === 'conversation_id');
    expect(convoFk).toBeDefined();
    expect(convoFk?.table).toBe('conversation');
    expect(convoFk?.on_delete).toBe('CASCADE');
  });

  describe('cycle_record.status is constrained, not just commented', () => {
    beforeEach(() => {
      db.raw.prepare(`INSERT INTO identity (id, kind, display_name) VALUES ('id-1', 'owner', 'Owner')`).run();
      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-1', 'id-1')`).run();
    });

    const write = (status: string): void => {
      db.raw
        .prepare(`INSERT INTO cycle_record (id, conversation_id, status) VALUES (?, 'conv-1', ?)`)
        .run(`cycle-${status}`, status);
    };

    it('accepts every status the runtime actually writes', () => {
      // 'degraded' is the one 0003's comment omitted: a cycle that answered but
      // had a stage fail and fall back.
      for (const status of ['running', 'completed', 'degraded', 'interrupted', 'failed']) {
        expect(() => write(status)).not.toThrow();
      }
    });

    it('rejects a status nothing defines, on insert and on update', () => {
      expect(() => write('finished')).toThrow(/invalid cycle_record.status/);

      write('running');
      expect(() =>
        db.raw
          .prepare(`UPDATE cycle_record SET status = 'succeeded' WHERE id = 'cycle-running'`)
          .run(),
      ).toThrow(/invalid cycle_record.status/);

      // The row still holds the value it was written with.
      const row = db.raw
        .prepare(`SELECT status FROM cycle_record WHERE id = 'cycle-running'`)
        .get() as { status: string };
      expect(row.status).toBe('running');
    });
  });
});
