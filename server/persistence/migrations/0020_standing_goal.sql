-- B10.s3: Useful initiative — approved standing goals
--
-- A standing goal is the owner's durable answer to "what may she start on her
-- own". It has to outlive the process for the same reason a reminder does: a
-- goal held in a `Map` would mean every restart silently revoked every approval
-- the owner ever gave, and she would go quiet without anything saying why.
--
-- The four JSON columns (scope, schedule, limits, dependencies) are stored whole
-- rather than exploded into columns because nothing queries inside them — the
-- manager loads a goal and evaluates it in memory. Exploding them would buy
-- indexes no reader wants and cost a migration every time a scope grows a field.

CREATE TABLE IF NOT EXISTS standing_goal (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  -- allowedSources/Actions/Tools/Topics and their blocked counterparts
  scope_json TEXT NOT NULL,
  -- timezone, cron, startTime/endTime, daysOfWeek
  schedule_json TEXT NOT NULL,
  -- maxRuntimeMs, maxDailyRuntimeMs, modelBudget
  limits_json TEXT NOT NULL,
  -- requiredCapabilities/People/WorldModel, blockedIfCapabilities
  dependencies_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  priority REAL NOT NULL CHECK (priority >= 0 AND priority <= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_evaluated_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_standing_goal_identity ON standing_goal(identity_id);
CREATE INDEX IF NOT EXISTS idx_standing_goal_active ON standing_goal(status) WHERE status = 'active';

-- What a goal actually did, with its evidence.
--
-- This table is not a log. It is the only source the daily budget is computed
-- from, so a restart cannot hand a goal a fresh hour of runtime it already
-- spent; and `verified` here means the same thing it means everywhere else in
-- this repository — something outside the model checked.
CREATE TABLE IF NOT EXISTS goal_outcome (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  tool_used TEXT,
  sources_consulted_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at INTEGER,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  runtime_ms INTEGER NOT NULL,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost_microsats INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  blockers_encountered_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_outcome_goal ON goal_outcome(goal_id);
-- The budget query: everything one goal spent since a given instant.
CREATE INDEX IF NOT EXISTS idx_goal_outcome_goal_started ON goal_outcome(goal_id, started_at);
