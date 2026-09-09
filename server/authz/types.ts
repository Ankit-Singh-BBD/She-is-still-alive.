import type { ActionClearance } from '@server/identity/types.js';

/**
 * The closed set of authorizable actions.
 *
 * This must stay closed. It previously ended with `| string`, which collapsed
 * the union to `string`: every typo type-checked, and the exhaustiveness of
 * `check()` could not be verified by the compiler. Adding an action here and
 * forgetting its case in `check()` is now a build error rather than a silent
 * fall-through to deny.
 */
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
  | 'proactive:receive';

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
