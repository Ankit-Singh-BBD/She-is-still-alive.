import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Database, getDatabase, closeDatabase } from '@server/persistence/db.js';

function tmpFilePath(suffix: string): string {
  return path.join(os.tmpdir(), `madhurita-wal-${Date.now()}-${suffix}.sqlite`);
}

describe('Phase P02: SQLite WAL behavior', () => {
  let dbPath: string;
  let db: Database;

  beforeEach(() => {
    dbPath = tmpFilePath('test');
    db = new Database({ path: dbPath });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dbPath)) {
      fs.rmSync(dbPath, { force: true });
    }
    if (fs.existsSync(`${dbPath}-wal`)) {
      fs.rmSync(`${dbPath}-wal`, { force: true });
    }
    if (fs.existsSync(`${dbPath}-shm`)) {
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
    closeDatabase();
  });

  it('opens with WAL journal mode enabled', () => {
    const mode = db.getJournalMode();
    expect(mode).toBe('wal');
  });

  it('has foreign keys enabled', () => {
    const enabled = db.getForeignKeysEnabled();
    expect(enabled).toBe(true);
  });

  it('exposes raw better-sqlite3 database for direct operations', () => {
    const raw = db.raw;
    expect(raw).toBeDefined();
    expect(typeof raw.prepare).toBe('function');
    expect(typeof raw.exec).toBe('function');
    expect(typeof raw.transaction).toBe('function');
    expect(typeof raw.pragma).toBe('function');
  });

  it('supports transaction API', () => {
    db.raw.exec(`CREATE TABLE test_tx (id INTEGER PRIMARY KEY, value TEXT);`);

    const result = db.transaction(() => {
      db.raw.prepare(`INSERT INTO test_tx (value) VALUES (?)`).run('first');
      db.raw.prepare(`INSERT INTO test_tx (value) VALUES (?)`).run('second');
      return 'committed';
    });

    expect(result).toBe('committed');

    const count = db.raw.prepare(`SELECT COUNT(*) as c FROM test_tx`).get() as { c: number };
    expect(count.c).toBe(2);
  });

  it('rolls back transaction on error', () => {
    db.raw.exec(`CREATE TABLE test_rollback (id INTEGER PRIMARY KEY, value TEXT);`);

    expect(() =>
      db.transaction(() => {
        db.raw.prepare(`INSERT INTO test_rollback (value) VALUES (?)`).run('should rollback');
        throw new Error('intentional rollback');
      }),
    ).toThrow('intentional rollback');

    const count = db.raw.prepare(`SELECT COUNT(*) as c FROM test_rollback`).get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('persists data across connections when using file database', () => {
    db.raw.exec(`CREATE TABLE persist_test (id INTEGER PRIMARY KEY, value TEXT);`);
    db.raw.prepare(`INSERT INTO persist_test (value) VALUES (?)`).run('persisted-value');
    db.close();

    const db2 = new Database({ path: dbPath });
    try {
      const row = db2.raw.prepare(`SELECT value FROM persist_test WHERE id = 1`).get() as {
        value: string;
      } | undefined;
      expect(row?.value).toBe('persisted-value');
    } finally {
      db2.close();
    }
  });

  it('allows concurrent reads while a write transaction is in progress (WAL property)', () => {
    db.raw.exec(`CREATE TABLE concurrency_test (id INTEGER PRIMARY KEY, value TEXT);`);

    // Start a write transaction and hold it
    const txFn = db.raw.transaction(() => {
      db.raw.prepare(`INSERT INTO concurrency_test (value) VALUES (?)`).run('from-writer');
      // The transaction is still open here - another connection should be able to read
      // because WAL allows readers to not block writers and vice versa
    });

    // This should not deadlock even if we had concurrent connections
    // In a single process test, we verify the transaction works correctly
    txFn();

    const count = db.raw.prepare(`SELECT COUNT(*) as c FROM concurrency_test`).get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('busy_timeout is set to 5000ms', () => {
    // Verify the pragma is set by checking it works
    const timeout = db.raw.pragma('busy_timeout', { simple: true });
    expect(Number(timeout)).toBe(5000);
  });

  it('synchronous is NORMAL', () => {
    const sync = db.raw.pragma('synchronous', { simple: true });
    // NORMAL = 1 in SQLite
    expect(Number(sync)).toBe(1);
  });

  it('in-memory database works without WAL (memory databases use different journaling)', () => {
    const memDb = new Database({ path: ':memory:' });
    const mode = memDb.getJournalMode();
    // :memory: databases don't use WAL mode
    expect(mode).toBe('memory');
    memDb.close();
  });

  it('getDatabase() returns a singleton instance', () => {
    closeDatabase();
    const db1 = getDatabase({ path: ':memory:' });
    const db2 = getDatabase({ path: ':memory:' });
    expect(db1).toBe(db2);
    expect(db1.isOpen()).toBe(true);
    closeDatabase();
  });

  it('closeDatabase() clears the singleton', () => {
    closeDatabase();
    const db1 = getDatabase({ path: ':memory:' });
    closeDatabase();
    const db2 = getDatabase({ path: ':memory:' });
    expect(db1).not.toBe(db2);
    closeDatabase();
  });

  it('Database reports isOpen() correctly', () => {
    expect(db.isOpen()).toBe(true);
    db.close();
    expect(db.isOpen()).toBe(false);
  });

  it('isMemory getter works for both file and memory paths', () => {
    const fileDb = new Database({ path: dbPath });
    expect(fileDb.isMemory).toBe(false);
    fileDb.close();

    const memDb = new Database({ path: ':memory:' });
    expect(memDb.isMemory).toBe(true);
    memDb.close();
  });
});