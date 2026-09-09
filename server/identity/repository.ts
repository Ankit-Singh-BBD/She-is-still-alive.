import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import { ulid } from 'ulid';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AuthOutcome,
  Identity,
  IdentityKind,
  IdentityStatus,
  IssuedSession,
  PermissionSet,
  Session,
} from './types.js';
import { hashPassphrase, verifyPassphrase } from './crypto.js';

/**
 * Credential throttling policy.
 *
 * Argon2 already makes a single guess expensive; these bounds make a *stream* of
 * guesses pointless, and stop an attacker from spending our CPU to do it. The
 * lockout grows so a forgetful owner is inconvenienced for seconds while an
 * attacker is stalled for a quarter of an hour per attempt.
 */
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_LOCKOUT_BASE_MS = 30_000;
const AUTH_LOCKOUT_MAX_MS = 15 * 60_000;

/** Bytes of CSPRNG output behind a session token. */
const SESSION_TOKEN_BYTES = 32;


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
  private readonly eventBus: EventBus | undefined;

  /**
   * The event bus is optional so that tests and scripts can construct a
   * repository over a bare database. When the composition root passes one,
   * enrolment becomes observable to the rest of the application instead of
   * being a silent row: `identity.enrolled` is published after the
   * transaction commits.
   *
   * There is deliberately no `identity.revoked` publish here. That event has
   * no publish site because the *operation* does not exist — this repository
   * revokes sessions, never identities. Adding the publish without the
   * operation would be the same class of lie as an event type declared in the
   * union and never emitted.
   */
  constructor(db?: Database, eventBus?: EventBus) {
    this.db = db ?? getDatabase();
    this.eventBus = eventBus;
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

    // Published after the commit, never inside it: the event row belongs to
    // the bus's own write, and a subscriber must not be able to roll back an
    // enrolment that already succeeded.
    if (this.eventBus) {
      await this.eventBus.publish({
        type: 'identity.enrolled',
        payload: {
          identityId: identity.id,
          kind: identity.kind,
          displayName: identity.displayName,
          hasCredential: passphraseHash !== null,
        },
        identityId: identity.id,
        cycleId: undefined,
        timestamp: identity.enrolledAt,
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      });
    }

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
   * Validates the owner passphrase, subject to the lockout policy.
   *
   * Returns an `AuthOutcome` rather than `Identity | null` because a refused
   * attempt and a wrong passphrase are different facts, and the old signature
   * could only report them as the same one. A locked-out attempt does not run
   * Argon2 at all — refusing before the expensive part is what makes the
   * throttle protect us as well as the credential.
   */
  async verifyOwnerPassphrase(passphrase: string): Promise<AuthOutcome> {
    const owner = this.getOwner();
    if (!owner) return { ok: false, reason: 'no_owner' };

    return this.checkCredential(`passphrase:${owner.id}`, owner, passphrase, () => {
      const credRow = this.db.raw
        .prepare(`SELECT passphrase_hash FROM identity_credential WHERE identity_id = ?`)
        .get(owner.id) as { passphrase_hash: string | null } | undefined;
      return credRow?.passphrase_hash ?? null;
    });
  }

  /**
   * Validates the owner recovery code, subject to its own lockout counter.
   *
   * Counted separately from the passphrase on purpose: locking the recovery path
   * because the passphrase was mistyped would lock the owner out of the thing
   * that exists to recover from exactly that.
   */
  async verifyRecoveryCode(recoveryCode: string): Promise<AuthOutcome> {
    const owner = this.getOwner();
    if (!owner) return { ok: false, reason: 'no_owner' };

    return this.checkCredential(`recovery:${owner.id}`, owner, recoveryCode, () => {
      const credRow = this.db.raw
        .prepare(`SELECT recovery_code_hash FROM identity_credential WHERE identity_id = ?`)
        .get(owner.id) as { recovery_code_hash: string | null } | undefined;
      return credRow?.recovery_code_hash ?? null;
    });
  }

  /**
   * Shared throttle + verify path for every stored credential.
   *
   * `loadHash` is a thunk so the stored hash is not even read when the scope is
   * locked out.
   */
  private async checkCredential(
    scope: string,
    identity: Identity,
    secret: string,
    loadHash: () => string | null,
  ): Promise<AuthOutcome> {
    const lock = this.getAuthLockout(scope);
    if (lock) {
      return {
        ok: false,
        reason: 'locked_out',
        failedCount: lock.failedCount,
        lockedUntil: lock.lockedUntil,
      };
    }

    const storedHash = loadHash();
    if (!storedHash) return { ok: false, reason: 'no_credential' };

    const valid = await verifyPassphrase(secret, storedHash);
    if (!valid) {
      const state = this.recordAuthFailure(scope);
      return {
        ok: false,
        reason: 'wrong_credential',
        failedCount: state.failedCount,
        lockedUntil: state.lockedUntil,
      };
    }

    this.clearAuthFailures(scope);
    this.updateLastSeen(identity.id);
    return { ok: true, identity };
  }

  /**
   * Reports an active lockout for a scope, or null when attempts are allowed.
   * `scope` is `passphrase:<identityId>` or `recovery:<identityId>`.
   */
  getAuthLockout(scope: string): { failedCount: number; lockedUntil: number } | null {
    const row = this.db.raw
      .prepare(`SELECT failed_count, locked_until FROM auth_attempt WHERE scope = ?`)
      .get(scope) as { failed_count: number; locked_until: string | null } | undefined;

    if (!row?.locked_until) return null;
    const lockedUntil = new Date(row.locked_until).getTime();
    if (Number.isNaN(lockedUntil) || lockedUntil <= Date.now()) return null;

    return { failedCount: row.failed_count, lockedUntil };
  }

  private recordAuthFailure(scope: string): { failedCount: number; lockedUntil: number | undefined } {
    const nowIso = new Date().toISOString();
    const row = this.db.raw
      .prepare(`SELECT failed_count FROM auth_attempt WHERE scope = ?`)
      .get(scope) as { failed_count: number } | undefined;

    const failedCount = (row?.failed_count ?? 0) + 1;

    // Every failure past the threshold extends the wait, doubling each time and
    // capped so the owner is never locked out permanently by someone else's
    // guessing.
    let lockedUntil: number | undefined;
    if (failedCount >= AUTH_MAX_ATTEMPTS) {
      const over = failedCount - AUTH_MAX_ATTEMPTS;
      const waitMs = Math.min(AUTH_LOCKOUT_BASE_MS * 2 ** over, AUTH_LOCKOUT_MAX_MS);
      lockedUntil = Date.now() + waitMs;
    }

    this.db.raw
      .prepare(
        `INSERT INTO auth_attempt (scope, failed_count, first_failed_at, last_failed_at, locked_until)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           failed_count = excluded.failed_count,
           last_failed_at = excluded.last_failed_at,
           locked_until = excluded.locked_until`,
      )
      .run(
        scope,
        failedCount,
        nowIso,
        nowIso,
        lockedUntil === undefined ? null : new Date(lockedUntil).toISOString(),
      );

    return { failedCount, lockedUntil };
  }

  /** Clears the counter after a success; a valid credential ends the streak. */
  private clearAuthFailures(scope: string): void {
    this.db.raw.prepare(`DELETE FROM auth_attempt WHERE scope = ?`).run(scope);
  }


  /**
   * Creates a session and issues its bearer token.
   *
   * The returned `token` is the credential and exists only here — the database
   * stores its sha256. `id` is a non-secret handle for revoking and auditing.
   * The two were previously the same ULID, which meant read access to the
   * database file was read access to every live session.
   */
  createSession(identityId: string, expiresAt: number): IssuedSession {
    const id = ulid();
    const now = Date.now();
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');

    this.db.raw
      .prepare(
        `INSERT INTO session (id, identity_id, issued_at, expires_at, token_hash)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        identityId,
        new Date(now).toISOString(),
        new Date(expiresAt).toISOString(),
        hashSessionToken(token),
      );

    return { id, identityId, issuedAt: now, expiresAt, revokedAt: undefined, token };
  }

  /**
   * Authenticates a bearer token: the only function that turns a credential into
   * a session. Applies the same expiry and revocation checks as
   * `validateSession`, which by design cannot authenticate anything.
   */
  authenticateSessionToken(token: string): Session | null {
    if (!token) return null;

    const row = this.db.raw
      .prepare(
        `SELECT id, identity_id, issued_at, expires_at, revoked_at, token_hash
           FROM session
          WHERE token_hash = ?`,
      )
      .get(hashSessionToken(token)) as
      | {
          id: string;
          identity_id: string;
          issued_at: string;
          expires_at: string;
          revoked_at: string | null;
          token_hash: string;
        }
      | undefined;

    if (!row) return null;
    // Indexed lookup already required an exact match; the constant-time compare
    // is here so the shape of this function does not invite a later change to a
    // scan-and-compare that would leak the hash a byte at a time.
    if (!constantTimeEquals(row.token_hash, hashSessionToken(token))) return null;

    const session: Session = {
      id: row.id,
      identityId: row.identity_id,
      issuedAt: new Date(row.issued_at).getTime(),
      expiresAt: new Date(row.expires_at).getTime(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).getTime() : undefined,
    };

    if (session.expiresAt < Date.now()) return null;
    if (session.revokedAt !== undefined) return null;

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
   * Checks a session *record* by its non-secret id: not expired, not revoked.
   *
   * This is not authentication and must never be reached from a transport with
   * a caller-supplied value — `id` is a public handle, so accepting it as proof
   * of identity would undo the point of hashing the token. Use
   * `authenticateSessionToken()` for anything that arrived over the wire.
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

/**
 * sha256 of a session token. Fast on purpose: the token is 256 bits of CSPRNG
 * output, so there is no dictionary for a slow KDF to defend against, and this
 * runs on every authenticated request.
 */
function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
