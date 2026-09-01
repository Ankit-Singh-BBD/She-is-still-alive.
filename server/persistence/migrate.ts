import fs from 'node:fs';
import path from 'node:path';
import { type Database } from './db.js';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export function initializeMigrationsTable(db: Database): void {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function getAppliedMigrationVersion(db: Database): number {
  const row = db.raw
    .prepare('SELECT value FROM app_meta WHERE key = ?')
    .get('schema_version') as { value: string } | undefined;

  if (!row) return 0;
  return parseInt(row.value, 10);
}

export function setAppliedMigrationVersion(db: Database, version: number): void {
  db.raw
    .prepare(
      `
    INSERT INTO app_meta (key, value, updated_at)
    VALUES ('schema_version', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    `
    )
    .run(version.toString());
}

export function resolveMigrations(migrationsDir: string): Migration[] {
  if (!fs.existsSync(migrationsDir)) return [];

  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql'));

  const migrations: Migration[] = [];

  for (const file of files) {
    const match = file.match(/^(\d+)_/);
    if (!match) continue;

    const id = parseInt(match[1] as string, 10);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

    migrations.push({
      id,
      name: file,
      sql,
    });
  }

  // Ensure they are ordered by ID ascending
  return migrations.sort((a, b) => a.id - b.id);
}

export function runMigrations(db: Database, migrationsDir: string): void {
  initializeMigrationsTable(db);
  const currentVersion = getAppliedMigrationVersion(db);

  const allMigrations = resolveMigrations(migrationsDir);
  const pendingMigrations = allMigrations.filter((m) => m.id > currentVersion);

  if (pendingMigrations.length === 0) {
    return;
  }

  // Run all pending migrations in a single transaction if possible
  // NOTE: Schema changes are transactional in SQLite.
  db.transaction(() => {
    for (const migration of pendingMigrations) {
      db.raw.exec(migration.sql);
      setAppliedMigrationVersion(db, migration.id);
    }
  });
}
