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
});
