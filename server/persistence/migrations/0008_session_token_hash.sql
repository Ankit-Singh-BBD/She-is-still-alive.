-- P28 hardening: session tokens are hashed at rest.
--
-- `createSession()` returned a ULID and stored that same value as the row's
-- primary key, so the bearer credential sat in the database in plaintext:
-- anyone who could read the file — a stolen backup, a copied WAL, a support
-- dump — could resume any live session. A ULID is also not a secret; it is a
-- timestamp plus randomness from a PRNG chosen for uniqueness, not for
-- unguessability.
--
-- The split this introduces:
--   id          — non-secret record handle. Safe to log, revoke and audit by.
--   token_hash  — sha256 of a 256-bit random token issued once, at creation,
--                 and never stored. Authentication looks the session up by
--                 this hash, so a database read yields nothing replayable.
--
-- sha256 rather than Argon2 on purpose: the token is 256 bits of CSPRNG output,
-- so there is no dictionary to slow down, and authentication happens on every
-- request.
--
-- Nullable because sessions created before this migration have no token. They
-- cannot be authenticated (there is nothing to hash against) — `id` alone is
-- no longer a credential, which is the point. Those sessions must be re-issued.

ALTER TABLE session ADD COLUMN token_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_token_hash ON session(token_hash);
