/**
 * Stage 2: IDENTIFY
 * Application responsibility: Authenticate caller, classify input type, attach context.
 *
 * The caller is resolved from the identity store. An unknown, dormant, or
 * revoked identity is deliberately downgraded to guest clearance rather than
 * being trusted at its claimed kind — authentication failures must never
 * fail *open* (Build Book Part II.4).
 */

import type { IdentityRepository } from '@server/identity/repository.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { Identity, IdentityKind, PermissionSet } from '@server/identity/types.js';
import type { AuthzCaller } from '@server/authz/types.js';
import type { RawStimulus, IdentifiedStimulus } from '../types.js';

export function identify(
  stimulus: RawStimulus,
  identityRepo?: IdentityRepository,
): IdentifiedStimulus {
  let identityKind: IdentityKind = 'guest';
  let permissions: PermissionSet = DEFAULT_PERMISSIONS.guest;
  let displayName = 'Guest';
  let authenticated = false;

  const identity = identityRepo?.getIdentity(stimulus.identityId) ?? null;
  if (identity && identity.status === 'active') {
    identityKind = identity.kind;
    permissions = identity.permissions ?? DEFAULT_PERMISSIONS[identity.kind];
    displayName = identity.displayName;
    authenticated = true;
  }

  return {
    ...stimulus,
    identityKind,
    callerPermissions: permissions,
    inputType: classifyInput(stimulus.source),
    attachedContext: `Caller: ${displayName} (${identityKind}${authenticated ? '' : ', unauthenticated'})`,
  };
}

/**
 * The caller as this cycle's authorization gates must see them.
 *
 * Stage 2 above is the only place that re-reads the identity per cycle, and it
 * produces the two fields `authz.check()` actually reasons from: the kind, downgraded
 * to `guest` when the enrolment is not active, and the permission set that goes with
 * it. Stages 6 and 7 then authorize against an `Identity`, and the one they were given
 * was bound when the runtime was *constructed* — `runtimeFor(caller.identity)`. On
 * `POST /api/chat` that is a fresh read per request, so it was invisible there. On the
 * voice socket the runtime is built once at accept (`server/http/ws.ts:189`) and every
 * later frame reruns all twelve stages, so a permission revoked mid-call was not seen
 * by the gate until the socket closed — while stage 2, three stages earlier, had
 * already read the new value and put it in `callerPermissions` where nothing looked.
 *
 * Two representations of the caller's rights, one fresh and unread, one stale and
 * authoritative. This composes them into the one the gates use, so there is again a
 * single answer to "what may this caller do" and it is the current one.
 *
 * `id`, `kind` and `permissions` are exactly what `check()` reads, and all three come
 * from the stimulus side — including `id`, so a runtime built for one caller cannot
 * authorize a cycle belonging to another.
 *
 * Nothing of `bound` is carried through. It used to be spread in for the rest of an
 * `Identity`'s shape, which meant seven construction-time fields — `displayName`,
 * `status`, `lastSeenAt` among them — rode along beside the three fresh ones. Unread
 * today, and that is the whole trouble with it: the defect this function exists to fix
 * was a field nobody thought was being read either. `AuthzCaller` is the three, so a
 * stale one cannot be present to be read later. `bound` remains the parameter because
 * its *absence* is the signal — no authenticated identity, which stage 6 reports as
 * `unavailable` rather than as a denial.
 */
export function effectiveCaller(
  identified: IdentifiedStimulus,
  bound: Identity | undefined,
): AuthzCaller | undefined {
  if (!bound) return undefined;
  return {
    id: identified.identityId,
    kind: identified.identityKind,
    permissions: identified.callerPermissions,
  };
}

function classifyInput(source: RawStimulus['source']): IdentifiedStimulus['inputType'] {
  switch (source) {
    case 'system':
      return 'system_event';
    case 'proactive':
      return 'proactive_trigger';
    case 'text':
    case 'audio':
    default:
      return 'user_message';
  }
}
