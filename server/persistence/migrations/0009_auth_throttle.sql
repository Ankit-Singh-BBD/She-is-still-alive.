-- P28 hardening: throttle credential verification.
--
-- `verifyOwnerPassphrase()` and `verifyRecoveryCode()` could be called without
-- limit. Argon2 makes each attempt expensive, which slows an attacker down but
-- does not stop one — and it makes the *defender* pay for every guess, so an
-- unbounded attempt stream is also a CPU exhaustion path against a process that
-- is single-threaded for the rest of its work.
--
-- Attempts are counted per scope and persisted, so a restart does not hand an
-- attacker a fresh budget. Recovery codes are counted separately from the
-- passphrase: a lockout on one must not lock the owner out of the path that
-- exists to recover from being locked out.
--
--   scope           — 'passphrase:<identityId>' or 'recovery:<identityId>'
--   failed_count    — consecutive failures; reset to zero on success
--   locked_until    — while in the future, attempts are refused without the
--                     hash even being computed

CREATE TABLE IF NOT EXISTS auth_attempt (
  scope TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  first_failed_at TEXT,
  last_failed_at TEXT,
  locked_until TEXT
);
