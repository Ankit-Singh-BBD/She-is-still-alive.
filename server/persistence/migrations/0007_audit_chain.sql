-- P28 hardening: tamper-evident audit log.
--
-- `verifyIntegrity()` previously only checked that required fields were
-- non-NULL and timestamps parseable. A well-formed row could be modified,
-- reordered, or deleted outright and verification still reported `valid: true`
-- — an integrity check that cannot detect tampering is worse than none,
-- because it is quoted as evidence.
--
-- These three columns make each entry commit to its predecessor:
--   seq        — dense, monotonic chain position. A gap proves a deletion.
--   prev_hash  — the previous entry's `entry_hash` (genesis: 64 zeros).
--   entry_hash — sha256 over this entry's fields *and* prev_hash, so editing
--                any field or reordering the chain breaks every link after it.
--
-- Nullable because rows written before this migration have no hash. They are
-- reported as `unchained` by verifyIntegrity() rather than silently accepted;
-- `AuditLogService.backfillChain()` chains them in place.

ALTER TABLE audit_log ADD COLUMN seq INTEGER;
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN entry_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_seq ON audit_log(seq);
