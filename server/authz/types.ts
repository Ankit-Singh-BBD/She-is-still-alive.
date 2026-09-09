import type { ActionClearance, Identity } from '@server/identity/types.js';

/**
 * Everything `check()` reads about the caller, and nothing else.
 *
 * It took an `Identity` and used three of its ten fields. That mattered twice. The
 * first time was a defect: stages 6 and 7 were handed an `Identity` bound when the
 * runtime was *constructed*, and the fix — `effectiveCaller` in
 * `server/cognition/stages/2.ts` — had to spread a stale object and overwrite exactly
 * these three, because the type demanded seven more it would never look at.
 *
 * The second time was a stage that had the three fields and no `Identity` to put them
 * in. Stage 10 learns from `IdentifiedStimulus`, whose `callerPermissions` stage 2
 * resolves every cycle; fabricating a `displayName` and an `enrolledAt` to satisfy the
 * signature would have been inventing facts to ask a question that does not depend on
 * them.
 *
 * So the parameter says what it needs. Every existing call site passes a whole
 * `Identity` and still type-checks — structurally, an `Identity` is an `AuthzCaller`.
 */
export type AuthzCaller = Pick<Identity, 'id' | 'kind' | 'permissions'>;

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
