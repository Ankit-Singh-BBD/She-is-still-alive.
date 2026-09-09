export type IdentityKind = 'owner' | 'person' | 'guest';
export type IdentityStatus = 'active' | 'dormant' | 'revoked';

export interface Identity {
  id: string; // stable ULID
  kind: IdentityKind;
  displayName: string;
  preferredName?: string | undefined;
  relationshipToOwner?:
    | 'self'
    | 'spouse'
    | 'child'
    | 'parent'
    | 'friend'
    | 'colleague'
    | 'other'
    | undefined;
  permissions?: PermissionSet | undefined;
  enrolledAt: number;
  lastSeenAt: number;
  status: IdentityStatus;
}

export type ActionClearance = 'none' | 'safe' | 'all';

export interface PermissionSet {
  mayReadMemories: boolean;
  mayReadConversations: boolean;
  mayTriggerActions: ActionClearance;
  mayEnrollNewKnowledge: boolean;
  mayMutatePreferences: boolean;
  mayAccessTools: string[]; // ToolId[]
  mayBeHeardInVoice: boolean;
  mayReceiveProactiveMessages: boolean;
}

export interface Session {
  /**
   * Non-secret record handle. Safe to log, audit and revoke by. This is
   * deliberately *not* the credential — see `IssuedSession.token`.
   */
  id: string;
  identityId: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number | undefined;
}

/**
 * A session at the moment it is created — the only time the bearer token
 * exists outside the caller's hands. Only its sha256 is stored, so a token that
 * is not kept here cannot be recovered from the database, by us or by anyone
 * who reads the file.
 */
export interface IssuedSession extends Session {
  token: string;
}

/**
 * Result of a credential check.
 *
 * Explicit rather than `Identity | null` because `null` cannot distinguish
 * "wrong passphrase" from "locked out and not even checked" — a caller that
 * cannot tell those apart will report the wrong thing to the owner, and a
 * transport that cannot tell them apart cannot honour a retry window.
 */
export type AuthOutcome =
  | { ok: true; identity: Identity }
  | {
      ok: false;
      reason: 'no_owner' | 'no_credential' | 'wrong_credential' | 'locked_out';
      /** Consecutive failures recorded for this scope, after this attempt. */
      failedCount?: number | undefined;
      /** ms epoch until which further attempts are refused. */
      lockedUntil?: number | undefined;
    };

