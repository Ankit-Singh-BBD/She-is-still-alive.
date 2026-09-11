-- B09.s3: Skill Lifecycle Tables
-- Candidate → Evaluated → Promoted/Rejected with versioning and rollback

-- Skill candidates generated from completed jobs
CREATE TABLE IF NOT EXISTS skill_candidate (
  id TEXT PRIMARY KEY,
  source_job_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  context TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('candidate', 'evaluated', 'accepted', 'rejected', 'rolled_back'))
);

CREATE INDEX IF NOT EXISTS idx_skill_candidate_status ON skill_candidate(status);
CREATE INDEX IF NOT EXISTS idx_skill_candidate_expires ON skill_candidate(expires_at);
CREATE INDEX IF NOT EXISTS idx_skill_candidate_source ON skill_candidate(source_job_id);

-- Evaluation results from sandbox on held-out data
CREATE TABLE IF NOT EXISTS skill_evaluated (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  held_out_score REAL NOT NULL,
  baseline_score REAL NOT NULL,
  precision REAL NOT NULL,
  recall REAL NOT NULL,
  f1 REAL NOT NULL,
  statistical_significance INTEGER NOT NULL CHECK(statistical_significance IN (0, 1)),
  errors INTEGER NOT NULL DEFAULT 0,
  robustness_score REAL NOT NULL,
  evaluated_at INTEGER NOT NULL,
  notes TEXT,
  FOREIGN KEY (candidate_id) REFERENCES skill_candidate(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_skill_evaluated_candidate ON skill_evaluated(candidate_id);
CREATE INDEX IF NOT EXISTS idx_skill_evaluated_at ON skill_evaluated(evaluated_at);

-- Promoted skills (versioned, active)
CREATE TABLE IF NOT EXISTS skill_promoted (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  version TEXT NOT NULL,
  previous_version_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  pattern TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public', 'person_shared', 'owner_only', 'system_internal')),
  lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active', 'consolidated', 'archived', 'soft_deleted', 'superseded')) DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (candidate_id) REFERENCES skill_candidate(id) ON DELETE CASCADE,
  FOREIGN KEY (previous_version_id) REFERENCES skill_promoted(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_promoted_candidate ON skill_promoted(candidate_id);
CREATE INDEX IF NOT EXISTS idx_skill_promoted_version ON skill_promoted(version);
CREATE INDEX IF NOT EXISTS idx_skill_promoted_lifecycle ON skill_promoted(lifecycle_status);

-- Rollback history
CREATE TABLE IF NOT EXISTS skill_rollback (
  id TEXT PRIMARY KEY,
  promoted_id TEXT NOT NULL,
  to_version_id TEXT,
  reason TEXT NOT NULL,
  rolled_back_at INTEGER NOT NULL,
  FOREIGN KEY (promoted_id) REFERENCES skill_promoted(id) ON DELETE CASCADE,
  FOREIGN KEY (to_version_id) REFERENCES skill_promoted(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_rollback_promoted ON skill_rollback(promoted_id);
CREATE INDEX IF NOT EXISTS idx_skill_rollback_at ON skill_rollback(rolled_back_at);
