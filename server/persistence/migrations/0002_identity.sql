-- P03: Identity & Auth
-- Tables for Identity, Permission, and Session

CREATE TABLE IF NOT EXISTS identity (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- 'owner', 'person', 'guest'
  display_name TEXT NOT NULL,
  preferred_name TEXT,
  relationship TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'dormant', 'revoked'
  enrolled_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identity_credential (
  identity_id TEXT PRIMARY KEY,
  passphrase_hash TEXT, -- Argon2 or bcrypt hash for owner/person
  recovery_code_hash TEXT, -- Argon2 or bcrypt hash for recovery code
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);

CREATE TABLE IF NOT EXISTS permission (
  identity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  effective_from TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (identity_id, version),
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);