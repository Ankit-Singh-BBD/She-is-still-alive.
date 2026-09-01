-- P15: Loop metadata table to support complex specs
CREATE TABLE IF NOT EXISTS loop_metadata (
  loop_id TEXT PRIMARY KEY,
  trigger_spec_json TEXT NOT NULL,
  action_spec_json TEXT NOT NULL,
  FOREIGN KEY(loop_id) REFERENCES open_loop(id) ON DELETE CASCADE
);
