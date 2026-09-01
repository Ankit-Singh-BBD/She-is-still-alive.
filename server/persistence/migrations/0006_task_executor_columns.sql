-- P14: Fill in columns that the shipped task/open_loop tables lacked
-- versus what the services actually use and what the conversations say the
-- tasks rebuilt before these milestones had.

-- task: attempt/last_error were read and written but never created
ALTER TABLE task ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE task ADD COLUMN last_error TEXT;

-- open_loop: updated_at/last_evaluated_at queried and updated but never migrated
ALTER TABLE open_loop ADD COLUMN updated_at TEXT;
ALTER TABLE open_loop ADD COLUMN last_evaluated_at TEXT;
