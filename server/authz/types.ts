import type { ActionClearance } from '@server/identity/types.js';

export type AuthzAction =
  | 'memory:read'
  | 'memory:write'
  | 'conversation:read'
  | 'conversation:write'
  | 'action:trigger'
  | 'tool:execute'
  | 'knowledge:enroll'
  | 'preference:mutate'
  | 'voice:participate'
  | 'proactive:receive'
  | string;

export interface AuthzResource {
  type: string;
  id?: string | undefined;
  ownerId?: string | undefined;
  sensitivity?: 'low' | 'medium' | 'high' | 'owner_only' | undefined;
  clearanceRequired?: ActionClearance | undefined;
  toolId?: string | undefined;
  [key: string]: unknown;
}

export interface AuthzDecision {
  allowed: boolean;
  reason?: string | undefined;
  callerId: string;
  action: AuthzAction;
  resource?: AuthzResource | undefined;
}
