-- B10.s1: Worker lease table for health probing
-- Tracks leases of workers on targets for health monitoring

CREATE TABLE IF NOT EXISTS work_lease (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  owner_worker_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_work_lease_target ON work_lease(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_work_lease_owner ON work_lease(owner_worker_id);
CREATE INDEX IF NOT EXISTS idx_work_lease_expires ON work_lease(expires_at);
CREATE INDEX IF NOT EXISTS idx_work_lease_released ON work_lease(released_at);