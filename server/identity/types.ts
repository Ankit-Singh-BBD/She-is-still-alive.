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
  id: string; // Token ID / Session ID
  identityId: string;
  issuedAt: number;
  expiresAt: number;
  revokedAt?: number | undefined;
}
