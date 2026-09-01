-- P02: Persistence Foundation — Baseline migration.
-- Establishes the `app_meta` table used by the migration runner to track
-- applied schema versions. All future migrations in P03+ add tables to this
-- same database.

CREATE TABLE IF NOT EXISTS app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Track the install moment. The application reads this on boot to
-- reconstruct authoritative durable state.
INSERT OR IGNORE INTO app_meta (key, value, updated_at)
VALUES ('schema_initialized_at', datetime('now'), datetime('now'));
