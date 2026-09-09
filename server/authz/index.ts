import type { Identity } from '@server/identity/types.js';
import type { AuthzAction, AuthzResource, AuthzDecision } from './types.js';

export * from './types.js';

/**
 * Pure, deterministic, side-effect-free authorization check.
 * Evaluates caller permissions against the requested action and resource.
 */
export function check(
  caller: Identity,
  action: AuthzAction,
  resource?: AuthzResource
): AuthzDecision {
  const perms = caller.permissions;
  if (!perms) {
    return deny(caller, action, 'No permissions configured for identity', resource);
  }

  // Owner always allowed an escape hatch for system-level overrides,
  // but let's stick to explicit permission checks primarily for transparency.
  const isOwner = caller.kind === 'owner';

  switch (action) {
    case 'memory:read':
      if (!perms.mayReadMemories) {
        return deny(caller, action, 'Missing mayReadMemories permission', resource);
      }
      if (resource?.sensitivity === 'owner_only' && !isOwner) {
        return deny(caller, action, 'Sensitivity is owner_only', resource);
      }
      return allow(caller, action, resource);

    case 'memory:write':
    case 'knowledge:enroll':
      if (!perms.mayEnrollNewKnowledge) {
        return deny(caller, action, 'Missing mayEnrollNewKnowledge permission', resource);
      }
      return allow(caller, action, resource);

    case 'conversation:read':
      if (!perms.mayReadConversations) {
        return deny(caller, action, 'Missing mayReadConversations permission', resource);
      }
      return allow(caller, action, resource);

    // Writing into a conversation is speaking into it. `conversation:write` was
    // declared but had no case, so it fell through to the default deny — which
    // looked safe but meant even the owner could not be authorized to write, and
    // the omission was invisible. Reading a conversation is the floor for
    // writing to it; a caller who may not read it may not append to it either.
    case 'conversation:write':
      if (!perms.mayReadConversations) {
        return deny(caller, action, 'Missing mayReadConversations permission', resource);
      }
      if (resource?.ownerId && resource.ownerId !== caller.id && !isOwner) {
        return deny(caller, action, "Cannot write into another identity's conversation", resource);
      }
      return allow(caller, action, resource);

    case 'preference:mutate':
      if (!perms.mayMutatePreferences) {
        return deny(caller, action, 'Missing mayMutatePreferences permission', resource);
      }
      if (resource?.ownerId && resource.ownerId !== caller.id && !isOwner) {
        return deny(caller, action, 'Cannot mutate preferences of another identity', resource);
      }
      return allow(caller, action, resource);

    case 'action:trigger':
      if (perms.mayTriggerActions === 'none') {
        return deny(caller, action, 'Action triggering is completely disabled for caller', resource);
      }
      if (resource?.clearanceRequired === 'all' && perms.mayTriggerActions !== 'all') {
        return deny(caller, action, 'Action requires all clearance, caller only has safe or none', resource);
      }
      return allow(caller, action, resource);

    case 'tool:execute': {
      if (perms.mayTriggerActions === 'none') {
        return deny(caller, action, 'Denied by authorization policy: tool execution is disabled for caller', resource);
      }
      const toolId = resource?.toolId;
      if (!toolId) {
        return deny(caller, action, 'No toolId specified in resource', resource);
      }
      // Check explicit tool access
      if (!perms.mayAccessTools.includes('*') && !perms.mayAccessTools.includes(toolId)) {
        return deny(caller, action, `Tool '${toolId}' is not in allowed tool access list`, resource);
      }
      // Check clearance
      if (resource?.clearanceRequired === 'all' && perms.mayTriggerActions !== 'all') {
        return deny(caller, action, 'Tool requires all clearance, caller only has safe or none', resource);
      }
      return allow(caller, action, resource);
    }

    case 'voice:participate':
      if (!perms.mayBeHeardInVoice) {
        return deny(caller, action, 'Missing mayBeHeardInVoice permission', resource);
      }
      return allow(caller, action, resource);

    case 'proactive:receive':
      if (!perms.mayReceiveProactiveMessages) {
        return deny(caller, action, 'Missing mayReceiveProactiveMessages permission', resource);
      }
      return allow(caller, action, resource);

    default: {
      // Unreachable while `AuthzAction` stays closed and every member has a
      // case above — that is the point: adding an action without handling it
      // fails this assignment at compile time. At runtime an unrecognized
      // action still denies, because a caller from untyped code must not get a
      // decision this function never reasoned about.
      const unhandled: never = action;
      return deny(caller, unhandled, `Unknown action: ${String(unhandled)}`, resource);
    }
  }
}

function allow(caller: Identity, action: AuthzAction, resource?: AuthzResource): AuthzDecision {
  return {
    allowed: true,
    callerId: caller.id,
    action,
    resource,
  };
}

function deny(
  caller: Identity,
  action: AuthzAction,
  reason: string,
  resource?: AuthzResource
): AuthzDecision {
  return {
    allowed: false,
    reason,
    callerId: caller.id,
    action,
    resource,
  };
}
