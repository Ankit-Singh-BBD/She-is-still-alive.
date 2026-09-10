-- B09.s1: Memory Correction with Supersession
--
-- Defect: No mechanism exists to correct a preference/fact while retaining history.
-- Current setPreference() overwrites the same (identity_id, key) row, destroying provenance
-- of what was believed before. No way to link old assertion → new assertion, no way to mark
-- old as superseded, no retrieval filter to exclude superseded from active facts.
--
-- Solution: Add 'superseded' to lifecycle_status, create memory_correction link table.
-- NULL for old rows means they were never corrected (still active/soft_deleted/archived/consolidated).
-- 'superseded' means correction exists pointing away from this row.

-- 1. Add memory_correction table
CREATE TABLE IF NOT EXISTS memory_correction (
  id TEXT PRIMARY KEY,
  old_memory_id TEXT NOT NULL,
  new_memory_id TEXT NOT NULL,
  domain TEXT NOT NULL, -- 'episodic'|'semantic'|'preference'|'habit'|'relationship'|'learned_pattern'
  identity_id TEXT NOT NULL,
  reason TEXT,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(identity_id) REFERENCES identity(id)
);

CREATE INDEX IF NOT EXISTS idx_memory_correction_old ON memory_correction(old_memory_id, domain);
CREATE INDEX IF NOT EXISTS idx_memory_correction_new ON memory_correction(new_memory_id, domain);
CREATE INDEX IF NOT EXISTS idx_memory_correction_identity ON memory_correction(identity_id);

-- 2. Lifecycle status guard trigger to validate 'superseded' alongside existing values
-- (Cannot add CHECK constraint without rebuilding FKs; use trigger per 0010 pattern)

CREATE TRIGGER IF NOT EXISTS episodic_memory_lifecycle_guard
BEFORE INSERT ON episodic_memory
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'consolidated', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'episodic_memory.lifecycle_status must be active|consolidated|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS episodic_memory_lifecycle_update_guard
BEFORE UPDATE OF lifecycle_status ON episodic_memory
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'consolidated', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'episodic_memory.lifecycle_status must be active|consolidated|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS semantic_memory_lifecycle_guard
BEFORE INSERT ON semantic_memory
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'semantic_memory.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS semantic_memory_lifecycle_update_guard
BEFORE UPDATE OF lifecycle_status ON semantic_memory
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'semantic_memory.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS preference_lifecycle_guard
BEFORE INSERT ON preference
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'preference.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS preference_lifecycle_update_guard
BEFORE UPDATE OF lifecycle_status ON preference
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'preference.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS habit_lifecycle_guard
BEFORE INSERT ON habit
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'habit.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS habit_lifecycle_update_guard
BEFORE UPDATE OF lifecycle_status ON habit
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'habit.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS relationship_lifecycle_guard
BEFORE INSERT ON relationship
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'relationship.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS relationship_lifecycle_update_guard
BEFORE UPDATE OF lifecycle_status ON relationship
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'relationship.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS learned_pattern_lifecycle_guard
BEFORE INSERT ON learned_pattern
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'learned_pattern.lifecycle_status must be active|archived|soft_deleted|superseded');
END;

CREATE TRIGGER IF NOT EXISTS learned_pattern_lifecycle_update_guard
BEFORE UPDATE OF lifecycle_status ON learned_pattern
FOR EACH ROW
WHEN NEW.lifecycle_status NOT IN ('active', 'archived', 'soft_deleted', 'superseded')
BEGIN
  SELECT RAISE(ABORT, 'learned_pattern.lifecycle_status must be active|archived|soft_deleted|superseded');
END;
