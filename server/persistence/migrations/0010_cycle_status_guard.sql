-- P28 hardening: constrain `cycle_record.status` to the statuses that exist.
--
-- 0003 declared the column with a comment listing 'running', 'completed',
-- 'interrupted', 'failed' and no constraint. The comment was already wrong —
-- the runtime also writes 'degraded' (a cycle that answered but had a stage
-- fail and fall back), which is the distinction that keeps a cycle from
-- claiming clean success over a stage that threw. A comment cannot enforce
-- anything, so a typo or a future status would have been stored silently and
-- read back as truth.
--
-- Enforced with triggers rather than a CHECK constraint: adding a CHECK in
-- SQLite requires rebuilding the table, and `cycle_record` is the target of
-- foreign keys from `stage_trace`, `action_result` and `domain_event`. A rename
-- rewrites those references, so the rebuild is a real risk to run on a live
-- database for a guarantee triggers give exactly.

CREATE TRIGGER IF NOT EXISTS trg_cycle_record_status_insert
BEFORE INSERT ON cycle_record
WHEN NEW.status NOT IN ('running', 'completed', 'degraded', 'interrupted', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'invalid cycle_record.status');
END;

CREATE TRIGGER IF NOT EXISTS trg_cycle_record_status_update
BEFORE UPDATE OF status ON cycle_record
WHEN NEW.status NOT IN ('running', 'completed', 'degraded', 'interrupted', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'invalid cycle_record.status');
END;
