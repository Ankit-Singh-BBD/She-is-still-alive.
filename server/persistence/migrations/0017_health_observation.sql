-- B10.s1: Health Observation System
-- Component health tracking with evidence, affected capabilities, and next check schedule

-- Health observations from component probes
CREATE TABLE IF NOT EXISTS health_observation (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('healthy', 'degraded', 'unavailable', 'unknown')),
  evidence_ref TEXT,
  affected_capabilities TEXT,
  next_check_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_observation_component ON health_observation(component_id);
CREATE INDEX IF NOT EXISTS idx_health_observation_checked_at ON health_observation(checked_at);
CREATE INDEX IF NOT EXISTS idx_health_observation_status ON health_observation(status);
CREATE INDEX IF NOT EXISTS idx_health_observation_next_check ON health_observation(next_check_at);

-- Health check history for trend analysis
CREATE TABLE IF NOT EXISTS health_check_history (
  id TEXT PRIMARY KEY,
  component_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  evidence TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_health_history_component ON health_check_history(component_id);
CREATE INDEX IF NOT EXISTS idx_health_history_checked_at ON health_check_history(checked_at);
