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
import type { IdentityKind, PermissionSet } from '@server/identity/types.js';
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
