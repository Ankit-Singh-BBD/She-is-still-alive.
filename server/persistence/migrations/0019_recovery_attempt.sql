-- B10.s2: Bounded recovery
-- Track recovery attempts for components/services to implement bounded retry with backoff

CREATE TABLE IF NOT EXISTS recovery_attempt (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  recovery_type TEXT NOT NULL, -- 'retry', 'reconnect', 'reconcile', 'reroute'
  attempt_number INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER, -- NULL means still in progress
  success INTEGER NOT NULL DEFAULT 0, -- 0 = failed/in progress, 1 = succeeded
  error_message TEXT, -- NULL if succeeded or not yet failed
  next_attempt_at INTEGER, -- When next retry is allowed (for backoff)
  max_attempts INTEGER NOT NULL,
  base_delay_ms INTEGER NOT NULL,
  max_delay_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_recovery_attempt_component ON recovery_attempt(component_id);
CREATE INDEX IF NOT EXISTS idx_recovery_attempt_next ON recovery_attempt(next_attempt_at) WHERE next_attempt_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recovery_attempt_in_progress ON recovery_attempt(ended_at) WHERE ended_at IS NULL;