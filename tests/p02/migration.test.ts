import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Database } from '@server/persistence/db.js';
import {
  initializeMigrationsTable,
  getAppliedMigrationVersion,
  resolveMigrations,
  runMigrations,
} from '@server/persistence/migrate.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const baselineMigrationsDir = path.join(repoRoot, 'server/persistence/migrations');

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSqlFile(dir: string, fileName: string, sql: string): void {
  fs.writeFileSync(path.join(dir, fileName), sql, 'utf-8');
}

describe('Phase P02: Migration runner', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
  });

  it('initializes the app_meta table on first run', () => {
    initializeMigrationsTable(db);
    const row = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'`)
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.name).toBe('app_meta');
  });

  it('starts at version 0 when no schema_version is recorded', () => {
    initializeMigrationsTable(db);
    expect(getAppliedMigrationVersion(db)).toBe(0);
  });

  it('runs the baseline 0001_init migration from the repository', () => {
    runMigrations(db, baselineMigrationsDir);
    const version = getAppliedMigrationVersion(db);
    expect(version).toBeGreaterThanOrEqual(1);

    const initializedAt = db.raw
      .prepare(`SELECT value FROM app_meta WHERE key = ?`)
      .get('schema_initialized_at') as { value: string } | undefined;
    expect(initializedAt).toBeDefined();
    expect(typeof initializedAt?.value).toBe('string');
    expect(initializedAt?.value.length).toBeGreaterThan(0);
  });

  it('is idempotent — running migrations twice does not re-apply', () => {
    runMigrations(db, baselineMigrationsDir);
    const firstVersion = getAppliedMigrationVersion(db);

    runMigrations(db, baselineMigrationsDir);
    const secondVersion = getAppliedMigrationVersion(db);

    expect(firstVersion).toBe(secondVersion);
    expect(secondVersion).toBeGreaterThanOrEqual(1);
  });

  it('applies migrations in numeric order across multiple files', () => {
    const dir = tmpDir('madhurita-mig-order-');
    try {
      writeSqlFile(dir, '0002_add_thing.sql', `CREATE TABLE thing (id INTEGER PRIMARY KEY);`);
      writeSqlFile(dir, '0003_add_other.sql', `CREATE TABLE other_thing (id INTEGER PRIMARY KEY);`);
      writeSqlFile(dir, '0001_init.sql', `CREATE TABLE init_thing (id INTEGER PRIMARY KEY);`);

      runMigrations(db, dir);
      const version = getAppliedMigrationVersion(db);
      expect(version).toBe(3);

      const tables = db.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('thing', 'other_thing', 'init_thing') ORDER BY name`,
        )
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain('thing');
      expect(names).toContain('other_thing');
      expect(names).toContain('init_thing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only applies migrations whose id is greater than the current version', () => {
    const dir = tmpDir('madhurita-mig-skip-');
    try {
      writeSqlFile(dir, '0001_init.sql', `CREATE TABLE step_one (id INTEGER PRIMARY KEY);`);
      writeSqlFile(dir, '0002_step_two.sql', `CREATE TABLE step_two (id INTEGER PRIMARY KEY);`);

      runMigrations(db, dir);
      const afterFirst = getAppliedMigrationVersion(db);
      expect(afterFirst).toBe(2);

      // Add a third migration and re-run; it should be applied, the first two should not.
      writeSqlFile(dir, '0003_step_three.sql', `CREATE TABLE step_three (id INTEGER PRIMARY KEY);`);
      runMigrations(db, dir);

      const afterSecond = getAppliedMigrationVersion(db);
      expect(afterSecond).toBe(3);

      const stepThree = db.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'step_three'`)
        .get() as { name: string } | undefined;
      expect(stepThree).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves no migrations when the directory is empty', () => {
    const dir = tmpDir('madhurita-mig-empty-');
    try {
      const migrations = resolveMigrations(dir);
      expect(migrations).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores non-sql files in the migrations directory', () => {
    const dir = tmpDir('madhurita-mig-ignore-');
    try {
      writeSqlFile(dir, '0001_init.sql', `CREATE TABLE ignored_test_one (id INTEGER PRIMARY KEY);`);
      writeSqlFile(dir, 'README.md', `# this should be ignored`);
      writeSqlFile(dir, 'notes.txt', `not a migration`);

      runMigrations(db, dir);
      const version = getAppliedMigrationVersion(db);
      expect(version).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
