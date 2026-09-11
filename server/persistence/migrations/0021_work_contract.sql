-- B03: Work contract tables. PLANNED records from WORK-CONTRACT.md.
-- UNIQUE(identity_id,request_id) deduplicates retried acceptance. Version+fence for fencing.
CREATE TABLE IF NOT EXISTS work_job (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES identity(id),
  request_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_approval','blocked','paused','verifying','completed','failed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deadline_at INTEGER,
  max_runtime_ms INTEGER,
  max_model_calls INTEGER,
  model_calls_used INTEGER NOT NULL DEFAULT 0,
  max_cost_units INTEGER,
  cost_units_used INTEGER NOT NULL DEFAULT 0,
  priority REAL NOT NULL DEFAULT 0.5 CHECK (priority >= 0 AND priority <= 1),
  control_intent TEXT CHECK (control_intent IN ('cancel','pause')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(identity_id, request_id)
);

CREATE TABLE IF NOT EXISTS work_step (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES work_job(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  tool_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','retry_wait','reconciling','waiting_approval','blocked','verified','failed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  fence INTEGER NOT NULL DEFAULT 0,
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(job_id, position)
);

CREATE TABLE IF NOT EXISTS work_dependency (
  step_id TEXT NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  PRIMARY KEY(step_id, depends_on)
);

CREATE TABLE IF NOT EXISTS work_attempt (
  id TEXT PRIMARY KEY,
  step_id TEXT NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','returned','verified','failed','unknown')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  idempotency_key TEXT NOT NULL,
  provider_receipt TEXT,
  result_json TEXT,
  error_code TEXT,
  verification_json TEXT,
  UNIQUE(step_id, occurrence_key, ordinal)
);

CREATE TABLE IF NOT EXISTS work_artifact (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  job_id TEXT NOT NULL REFERENCES work_job(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL REFERENCES work_step(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  media_type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pending','verified','failed')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(artifact_id, version)
);

CREATE TABLE IF NOT EXISTS work_outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES work_job(id) ON DELETE CASCADE,
  job_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS work_approval (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES work_job(id) ON DELETE CASCADE,
  plan_hash TEXT NOT NULL,
  action_scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_job_status ON work_job(status);
CREATE INDEX IF NOT EXISTS idx_work_step_job ON work_step(job_id);
CREATE INDEX IF NOT EXISTS idx_work_artifact_job ON work_artifact(job_id);
