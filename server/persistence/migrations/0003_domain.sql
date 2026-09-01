-- P04: Domain Schema Migration
-- All domain tables per Build Book Part IX.3 (excluding domain_event which is added in P06)

-- 1. Conversation
CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_identity ON conversation(identity_id);

-- 2. Message
CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user', 'assistant', 'system'
  text TEXT NOT NULL,
  audio_ref TEXT,
  metadata_json TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(conversation_id) REFERENCES conversation(id) ON DELETE CASCADE,
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_message_conversation ON message(conversation_id);

-- 3. Cycle Record
CREATE TABLE IF NOT EXISTS cycle_record (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running', -- 'running', 'completed', 'interrupted', 'failed'
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  FOREIGN KEY(conversation_id) REFERENCES conversation(id)
);

CREATE INDEX IF NOT EXISTS idx_cycle_record_conversation ON cycle_record(conversation_id);

-- 4. Stage Trace
CREATE TABLE IF NOT EXISTS stage_trace (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  stage INTEGER NOT NULL,
  stage_name TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  input_json TEXT,
  output_json TEXT,
  error TEXT,
  FOREIGN KEY(cycle_id) REFERENCES cycle_record(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_stage_trace_cycle ON stage_trace(cycle_id);

-- 5. Action Result
CREATE TABLE IF NOT EXISTS action_result (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  persisted_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(cycle_id) REFERENCES cycle_record(id)
);

CREATE INDEX IF NOT EXISTS idx_action_result_cycle ON action_result(cycle_id);

-- 6. Episodic Memory
CREATE TABLE IF NOT EXISTS episodic_memory (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',
  sensitivity TEXT NOT NULL DEFAULT 'person_shared',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_kind TEXT NOT NULL DEFAULT 'conversation',
  provenance_json TEXT,
  summary TEXT NOT NULL,
  details TEXT,
  embedding TEXT,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  importance REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_identity ON episodic_memory(identity_id, lifecycle_status);

-- 7. Semantic Memory
CREATE TABLE IF NOT EXISTS semantic_memory (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',
  sensitivity TEXT NOT NULL DEFAULT 'person_shared',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_kind TEXT NOT NULL DEFAULT 'conversation',
  provenance_json TEXT,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_cycle TEXT,
  embedding TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(source_cycle) REFERENCES cycle_record(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_identity ON semantic_memory(identity_id, lifecycle_status);

-- 8. Preference
CREATE TABLE IF NOT EXISTS preference (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',
  sensitivity TEXT NOT NULL DEFAULT 'person_shared',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_kind TEXT NOT NULL DEFAULT 'conversation',
  provenance_json TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  stated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_preference_identity ON preference(identity_id, key);

-- 9. Habit
CREATE TABLE IF NOT EXISTS habit (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',
  sensitivity TEXT NOT NULL DEFAULT 'person_shared',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_kind TEXT NOT NULL DEFAULT 'observation',
  provenance_json TEXT,
  pattern TEXT NOT NULL,
  frequency TEXT,
  last_observed TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_habit_identity ON habit(identity_id, lifecycle_status);

-- 10. Relationship
CREATE TABLE IF NOT EXISTS relationship (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  relation TEXT NOT NULL,
  notes TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  sensitivity TEXT NOT NULL DEFAULT 'owner_only',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(owner_id) REFERENCES identity(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_relationship_owner ON relationship(owner_id, lifecycle_status);

-- 11. Learned Pattern
CREATE TABLE IF NOT EXISTS learned_pattern (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL DEFAULT 'person',
  sensitivity TEXT NOT NULL DEFAULT 'person_shared',
  confidence REAL NOT NULL DEFAULT 1.0,
  source_kind TEXT NOT NULL DEFAULT 'system',
  provenance_json TEXT,
  pattern TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active',
  deleted_at TEXT,
  deleted_by TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id),
  FOREIGN KEY(deleted_by) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_learned_pattern_identity ON learned_pattern(identity_id, lifecycle_status);

-- 12. Task
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_task_identity_status ON task(identity_id, status);

-- 13. Open Loop
CREATE TABLE IF NOT EXISTS open_loop (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_progress TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT,
  context_json TEXT,
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_open_loop_identity ON open_loop(identity_id, status);

-- 14. Proactive Decision
CREATE TABLE IF NOT EXISTS proactive_decision (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  urgency REAL NOT NULL,
  novelty REAL NOT NULL,
  interruption_cost REAL NOT NULL,
  acted_at TEXT,
  reason_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_proactive_decision_identity ON proactive_decision(identity_id);

-- 15. Audit Log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  metadata_json TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(actor_id) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, timestamp);

-- 16. Backup Metadata
CREATE TABLE IF NOT EXISTS backup_metadata (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  restored_from TEXT,
  status TEXT NOT NULL DEFAULT 'completed'
);
