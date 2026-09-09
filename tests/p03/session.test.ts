import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { IdentityRepository } from '@server/identity/repository.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('Phase P03: Session Management & Expiry', () => {
  let db: Database;
  let repo: IdentityRepository;
  let ownerId: string;

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    repo = new IdentityRepository(db);

    const owner = await repo.createIdentity({
      kind: 'owner',
      displayName: 'Owner User',
      passphrase: 'secure-passphrase-123',
    });
    ownerId = owner.id;
  });

  it('creates and retrieves a valid session', () => {
    const expiresAt = Date.now() + 1000 * 60 * 60; // 1 hour
    const session = repo.createSession(ownerId, expiresAt);

    expect(session.id).toBeDefined();
    expect(session.identityId).toBe(ownerId);
    expect(session.expiresAt).toBe(expiresAt);

    const fetched = repo.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.identityId).toBe(ownerId);

    const validated = repo.validateSession(session.id);
    expect(validated).not.toBeNull();
    expect(validated?.id).toBe(session.id);
  });

  it('rejects an expired session', () => {
    const pastExpiresAt = Date.now() - 1000; // expired 1s ago
    const session = repo.createSession(ownerId, pastExpiresAt);

    const validated = repo.validateSession(session.id);
    expect(validated).toBeNull();
  });

  it('revokes a specific session', () => {
    const expiresAt = Date.now() + 1000 * 60 * 60;
    const session = repo.createSession(ownerId, expiresAt);

    expect(repo.validateSession(session.id)).not.toBeNull();

    repo.revokeSession(session.id);
    expect(repo.validateSession(session.id)).toBeNull();
  });

  it('revokes all sessions for an identity', () => {
    const expiresAt = Date.now() + 1000 * 60 * 60;
    const session1 = repo.createSession(ownerId, expiresAt);
    const session2 = repo.createSession(ownerId, expiresAt);

    expect(repo.validateSession(session1.id)).not.toBeNull();
    expect(repo.validateSession(session2.id)).not.toBeNull();

    repo.revokeAllSessions(ownerId);

    expect(repo.validateSession(session1.id)).toBeNull();
    expect(repo.validateSession(session2.id)).toBeNull();
  });

  it('supports sliding window session extension', () => {
    const initialExpiry = Date.now() + 1000 * 60 * 30; // 30 mins
    const session = repo.createSession(ownerId, initialExpiry);

    const extendedExpiry = Date.now() + 1000 * 60 * 60 * 12; // 12 hours
    const extended = repo.extendSession(session.id, extendedExpiry);
    expect(extended).toBe(true);

    const fetched = repo.getSession(session.id);
    expect(fetched?.expiresAt).toBe(extendedExpiry);
  });

  it('cleans up expired sessions', () => {
    const pastExpiresAt = Date.now() - 10000;
    repo.createSession(ownerId, pastExpiresAt);
    repo.createSession(ownerId, pastExpiresAt);

    const validExpiry = Date.now() + 1000 * 60 * 60;
    const validSession = repo.createSession(ownerId, validExpiry);

    const cleaned = repo.cleanupExpiredSessions();
    expect(cleaned).toBeGreaterThanOrEqual(2);

    expect(repo.validateSession(validSession.id)).not.toBeNull();
  });

  describe('bearer tokens', () => {
    it('stores only a hash, so a database read yields nothing replayable', () => {
      const session = repo.createSession(ownerId, Date.now() + 3600_000);

      expect(session.token).not.toBe(session.id);
      expect(session.token.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url

      const row = db.raw
        .prepare(`SELECT token_hash FROM session WHERE id = ?`)
        .get(session.id) as { token_hash: string };
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(session.token);

      // Nothing anywhere in the row is the token itself.
      const full = JSON.stringify(
        db.raw.prepare(`SELECT * FROM session WHERE id = ?`).get(session.id),
      );
      expect(full).not.toContain(session.token);
    });

    it('authenticates the token it issued, and nothing else', () => {
      const session = repo.createSession(ownerId, Date.now() + 3600_000);

      const authed = repo.authenticateSessionToken(session.token);
      expect(authed?.id).toBe(session.id);
      expect(authed?.identityId).toBe(ownerId);

      expect(repo.authenticateSessionToken('not-a-real-token')).toBeNull();
      expect(repo.authenticateSessionToken('')).toBeNull();
    });

    it('refuses the session id as a credential', () => {
      // The regression this pins: `id` used to *be* the token. It is a public
      // handle now, and a public handle must not authenticate.
      const session = repo.createSession(ownerId, Date.now() + 3600_000);
      expect(repo.authenticateSessionToken(session.id)).toBeNull();
    });

    it('issues a distinct token per session', () => {
      const a = repo.createSession(ownerId, Date.now() + 3600_000);
      const b = repo.createSession(ownerId, Date.now() + 3600_000);
      expect(a.token).not.toBe(b.token);
      expect(repo.authenticateSessionToken(a.token)?.id).toBe(a.id);
      expect(repo.authenticateSessionToken(b.token)?.id).toBe(b.id);
    });

    it('applies expiry and revocation to the token path too', () => {
      const expired = repo.createSession(ownerId, Date.now() - 1000);
      expect(repo.authenticateSessionToken(expired.token)).toBeNull();

      const live = repo.createSession(ownerId, Date.now() + 3600_000);
      expect(repo.authenticateSessionToken(live.token)).not.toBeNull();
      repo.revokeSession(live.id);
      expect(repo.authenticateSessionToken(live.token)).toBeNull();

      const bulk = repo.createSession(ownerId, Date.now() + 3600_000);
      repo.revokeAllSessions(ownerId);
      expect(repo.authenticateSessionToken(bulk.token)).toBeNull();
    });
  });
});
