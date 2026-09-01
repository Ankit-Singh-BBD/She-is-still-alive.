import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { IdentityRepository } from '@server/identity/repository.js';
import { executeBootstrap } from '@server/identity/bootstrap.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('Phase P03: Bootstrap Ceremony & Identity', () => {
  let db: Database;
  let repo: IdentityRepository;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    repo = new IdentityRepository(db);
  });

  it('starts with no owner', () => {
    expect(repo.hasOwner()).toBe(false);
    expect(repo.getOwner()).toBeNull();
  });

  it('executes bootstrap ceremony creating the initial owner', async () => {
    const result = await executeBootstrap(repo, {
      displayName: 'Ankit Singh',
      preferredName: 'Ankit',
      passphrase: 'correct-horse-battery-staple',
      recoveryCode: 'recovery-alpha-bravo-charlie',
    });

    expect(result.success).toBe(true);
    expect(result.owner).toBeDefined();
    expect(result.owner?.kind).toBe('owner');
    expect(result.owner?.displayName).toBe('Ankit Singh');
    expect(result.owner?.preferredName).toBe('Ankit');
    expect(result.owner?.relationshipToOwner).toBe('self');
    expect(result.owner?.status).toBe('active');
    expect(result.owner?.permissions?.mayTriggerActions).toBe('all');
    expect(result.owner?.permissions?.mayReadMemories).toBe(true);

    expect(repo.hasOwner()).toBe(true);
    const owner = repo.getOwner();
    expect(owner?.id).toBe(result.owner?.id);
  });

  it('enforces bootstrap invariant: exactly one owner allowed per instance', async () => {
    const first = await executeBootstrap(repo, {
      displayName: 'First Owner',
      passphrase: 'secure-passphrase-123',
    });
    expect(first.success).toBe(true);

    const second = await executeBootstrap(repo, {
      displayName: 'Second Owner Impostor',
      passphrase: 'another-passphrase-456',
    });

    expect(second.success).toBe(false);
    expect(second.error).toContain('already bootstrapped');
  });

  it('rejects bootstrap with weak passphrase or empty name', async () => {
    const shortPass = await executeBootstrap(repo, {
      displayName: 'Ankit',
      passphrase: 'short',
    });
    expect(shortPass.success).toBe(false);
    expect(shortPass.error).toContain('at least 8 characters');

    const emptyName = await executeBootstrap(repo, {
      displayName: '   ',
      passphrase: 'valid-passphrase-123',
    });
    expect(emptyName.success).toBe(false);
    expect(emptyName.error).toContain('Display name is required');
  });

  it('verifies owner passphrase and recovery code correctly', async () => {
    await executeBootstrap(repo, {
      displayName: 'Ankit',
      passphrase: 'my-super-secret-passphrase',
      recoveryCode: 'secret-recovery-1234',
    });

    const authedByPass = await repo.verifyOwnerPassphrase('my-super-secret-passphrase');
    expect(authedByPass).not.toBeNull();
    expect(authedByPass?.displayName).toBe('Ankit');

    const failedPass = await repo.verifyOwnerPassphrase('wrong-passphrase');
    expect(failedPass).toBeNull();

    const authedByRecovery = await repo.verifyRecoveryCode('secret-recovery-1234');
    expect(authedByRecovery).not.toBeNull();
    expect(authedByRecovery?.displayName).toBe('Ankit');

    const failedRecovery = await repo.verifyRecoveryCode('wrong-recovery-code');
    expect(failedRecovery).toBeNull();
  });
});
