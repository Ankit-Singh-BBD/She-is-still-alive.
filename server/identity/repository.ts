import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import { ulid } from 'ulid';
import type {
  Identity,
  IdentityKind,
  IdentityStatus,
  PermissionSet,
  Session,
} from './types.js';
import { hashPassphrase, verifyPassphrase } from './crypto.js';

/**
 * Default permission sets per identity kind.
 */
export const DEFAULT_PERMISSIONS: Record<IdentityKind, PermissionSet> = {
  owner: {
    mayReadMemories: true,
    mayReadConversations: true,
    mayTriggerActions: 'all',
    mayEnrollNewKnowledge: true,
    mayMutatePreferences: true,
    mayAccessTools: ['*'],
    mayBeHeardInVoice: true,
    mayReceiveProactiveMessages: true,
  },
  person: {
    mayReadMemories: true,
    mayReadConversations: true,
    mayTriggerActions: 'safe',
    mayEnrollNewKnowledge: false,
    mayMutatePreferences: false,
    mayAccessTools: [],
    mayBeHeardInVoice: true,
    mayReceiveProactiveMessages: true,
  },
  guest: {
    mayReadMemories: false,
    mayReadConversations: false,
    mayTriggerActions: 'none',
    mayEnrollNewKnowledge: false,
    mayMutatePreferences: false,
    mayAccessTools: [],
    mayBeHeardInVoice: false,
    mayReceiveProactiveMessages: false,
  },
};

export class IdentityRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
  }

  /**
   * Creates a new identity with the given kind.
   * For owner, also creates credentials if passphrase/recoveryCode provided.
   */
  async createIdentity(params: {
    kind: IdentityKind;
    displayName: string;
    preferredName?: string | undefined;
    relationshipToOwner?: Identity['relationshipToOwner'];
    passphrase?: string | undefined;
    recoveryCode?: string | undefined;
    permissions?: PermissionSet | undefined;
  }): Promise<Identity> {
    const id = ulid();
    const now = Date.now();
    const permissions = params.permissions ?? DEFAULT_PERMISSIONS[params.kind];

    const identity: Identity = {
      id,
      kind: params.kind,
      displayName: params.displayName,
      preferredName: params.preferredName,
      relationshipToOwner: params.relationshipToOwner,
      permissions,
      enrolledAt: now,
      lastSeenAt: now,
      status: 'active',
    };

    // Compute hashes outside transaction if needed
    let passphraseHash: string | null = null;
    let recoveryCodeHash: string | null = null;
    if (params.kind === 'owner' && params.passphrase) {
      passphraseHash = await hashPassphrase(params.passphrase);
      if (params.recoveryCode) {
        recoveryCodeHash = await hashPassphrase(params.recoveryCode);
      }
    }

    this.db.transaction(() => {
      // Insert identity
      this.db.raw
        .prepare(
          `
        INSERT INTO identity (id, kind, display_name, preferred_name, relationship, status, enrolled_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          identity.id,
          identity.kind,
          identity.displayName,
          identity.preferredName ?? null,
          identity.relationshipToOwner ?? null,
          identity.status,
          new Date(identity.enrolledAt).toISOString(),
          new Date(identity.lastSeenAt).toISOString()
        );

      // Insert default permissions (version 1)
      this.db.raw
        .prepare(
          `
        INSERT INTO permission (identity_id, version, json, effective_from)
        VALUES (?, 1, ?, CURRENT_TIMESTAMP)
      `
        )
        .run(identity.id, JSON.stringify(permissions));

      // If owner, create credentials
      if (params.kind === 'owner' && passphraseHash) {
        this.db.raw
          .prepare(
            `
          INSERT INTO identity_credential (identity_id, passphrase_hash, recovery_code_hash, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `
          )
          .run(identity.id, passphraseHash, recoveryCodeHash);
      }
    });

    return identity;
  }

  /**
   * Gets an identity by ID.
   */
  getIdentity(id: string): Identity | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, kind, display_name, preferred_name, relationship, status, enrolled_at, last_seen_at
      FROM identity
      WHERE id = ?
    `
      )
      .get(id) as
      | {
          id: string;
          kind: IdentityKind;
          display_name: string;
          preferred_name: string | null;
          relationship: string | null;
          status: IdentityStatus;
          enrolled_at: string;
          last_seen_at: string;
        }
      | undefined;

    if (!row) return null;

    // Get latest permissions
    const permRow = this.db.raw
      .prepare(
        `
      SELECT json FROM permission WHERE identity_id = ? ORDER BY version DESC LIMIT 1
    `
      )
      .get(id) as { json: string } | undefined;

    return {
      id: row.id,
      kind: row.kind,
      displayName: row.display_name,
      preferredName: row.preferred_name ?? undefined,
      relationshipToOwner:
        (row.relationship as Identity['relationshipToOwner']) ?? undefined,
      permissions: permRow ? JSON.parse(permRow.json) : DEFAULT_PERMISSIONS[row.kind],
      enrolledAt: new Date(row.enrolled_at).getTime(),
      lastSeenAt: new Date(row.last_seen_at).getTime(),
      status: row.status,
    };
  }

  /**
   * Gets the owner identity (there should be exactly one).
   */
  getOwner(): Identity | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id FROM identity WHERE kind = 'owner' AND status = 'active' LIMIT 1
    `
      )
      .get() as { id: string } | undefined;

    if (!row) return null;
    return this.getIdentity(row.id);
  }

  /**
   * Checks if an owner already exists.
   */
  hasOwner(): boolean {
    const row = this.db.raw
      .prepare(
        `
      SELECT 1 FROM identity WHERE kind = 'owner' AND status = 'active' LIMIT 1
    `
      )
      .get();
    return !!row;
  }

  /**
   * Updates identity's last_seen_at.
   */
  updateLastSeen(id: string): void {
    this.db.raw
      .prepare(
        `
      UPDATE identity SET last_seen_at = ? WHERE id = ?
    `
      )
      .run(new Date().toISOString(), id);
  }

  /**
   * Updates identity permissions (creates new version).
   */
  updatePermissions(identityId: string, permissions: PermissionSet): void {
    const currentVersion = this.db.raw
      .prepare(
        `
      SELECT MAX(version) as v FROM permission WHERE identity_id = ?
    `
      )
      .get(identityId) as { v: number | null } | undefined;

    const nextVersion = (currentVersion?.v ?? 0) + 1;

    this.db.raw
      .prepare(
        `
      INSERT INTO permission (identity_id, version, json, effective_from)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    `
      )
      .run(identityId, nextVersion, JSON.stringify(permissions));
  }

  /**
   * Validates owner passphrase.
   */
  async verifyOwnerPassphrase(passphrase: string): Promise<Identity | null> {
    const owner = this.getOwner();
    if (!owner) return null;

    const credRow = this.db.raw
      .prepare(
        `
      SELECT passphrase_hash FROM identity_credential WHERE identity_id = ?
    `
      )
      .get(owner.id) as { passphrase_hash: string } | undefined;

    if (!credRow?.passphrase_hash) return null;

    const valid = await verifyPassphrase(passphrase, credRow.passphrase_hash);
    if (!valid) return null;

    this.updateLastSeen(owner.id);
    return owner;
  }

  /**
   * Validates recovery code.
   */
  async verifyRecoveryCode(recoveryCode: string): Promise<Identity | null> {
    const owner = this.getOwner();
    if (!owner) return null;

    const credRow = this.db.raw
      .prepare(
        `
      SELECT recovery_code_hash FROM identity_credential WHERE identity_id = ?
    `
      )
      .get(owner.id) as { recovery_code_hash: string | null } | undefined;

    if (!credRow?.recovery_code_hash) return null;

    const valid = await verifyPassphrase(recoveryCode, credRow.recovery_code_hash);
    if (!valid) return null;

    this.updateLastSeen(owner.id);
    return owner;
  }

  /**
   * Creates a new session for an identity.
   */
  createSession(identityId: string, expiresAt: number): Session {
    const id = ulid();
    const now = Date.now();

    const session: Session = {
      id,
      identityId,
      issuedAt: now,
      expiresAt,
      revokedAt: undefined,
    };

    this.db.raw
      .prepare(
        `
      INSERT INTO session (id, identity_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?)
    `
      )
      .run(
        session.id,
        session.identityId,
        new Date(session.issuedAt).toISOString(),
        new Date(session.expiresAt).toISOString()
      );

    return session;
  }

  /**
   * Gets a session by ID.
   */
  getSession(sessionId: string): Session | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, identity_id, issued_at, expires_at, revoked_at
      FROM session
      WHERE id = ?
    `
      )
      .get(sessionId) as
      | {
          id: string;
          identity_id: string;
          issued_at: string;
          expires_at: string;
          revoked_at: string | null;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      identityId: row.identity_id,
      issuedAt: new Date(row.issued_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : undefined,
    };
  }

  /**
   * Validates a session (checks expiry and revocation).
   */
  validateSession(sessionId: string): Session | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const now = Date.now();
    if (session.expiresAt < now) return null;
    if (session.revokedAt !== undefined) return null;

    return session;
  }

  /**
   * Revokes a session.
   */
  revokeSession(sessionId: string): void {
    this.db.raw
      .prepare(
        `
      UPDATE session SET revoked_at = ? WHERE id = ?
    `
      )
      .run(new Date().toISOString(), sessionId);
  }

  /**
   * Revokes all sessions for an identity.
   */
  revokeAllSessions(identityId: string): void {
    this.db.raw
      .prepare(
        `
      UPDATE session SET revoked_at = ? WHERE identity_id = ? AND revoked_at IS NULL
    `
      )
      .run(new Date().toISOString(), identityId);
  }

  /**
   * Extends session expiry (sliding window).
   */
  extendSession(sessionId: string, newExpiresAt: number): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    const now = Date.now();
    if (session.expiresAt < now) return false;
    if (session.revokedAt !== undefined) return false;

    this.db.raw
      .prepare(
        `
      UPDATE session SET expires_at = ? WHERE id = ?
    `
      )
      .run(new Date(newExpiresAt).toISOString(), sessionId);

    return true;
  }

  /**
   * Deletes expired sessions (cleanup).
   */
  cleanupExpiredSessions(): number {
    const nowIso = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      DELETE FROM session WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)
    `
      )
      .run(nowIso, nowIso);
    return result.changes;
  }

  /**
   * Lists all identities.
   */
  listIdentities(): Identity[] {
    const rows = this.db.raw
      .prepare(
        `
      SELECT id FROM identity ORDER BY enrolled_at DESC
    `
      )
      .all() as { id: string }[];

    return rows.map((r) => this.getIdentity(r.id)).filter((i): i is Identity => i !== null);
  }
}

export function getIdentityRepository(db?: Database): IdentityRepository {
  return new IdentityRepository(db);
}

export function closeIdentityRepository(): void {
  // No-op for now, uses shared DB
}