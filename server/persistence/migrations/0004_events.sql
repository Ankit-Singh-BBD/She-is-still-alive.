-- P06: Append-only ordered domain event log
CREATE TABLE IF NOT EXISTS domain_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  identity_id TEXT,
  cycle_id TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  causation_id TEXT,
  correlation_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(cycle_id) REFERENCES cycle_record(id)
);

CREATE INDEX IF NOT EXISTS idx_domain_event_type_seq ON domain_event(type, seq);
CREATE INDEX IF NOT EXISTS idx_domain_event_identity_seq ON domain_event(identity_id, seq);
