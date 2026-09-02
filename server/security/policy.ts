import type { Identity } from '../identity/types.js';
import type { ScopedMemoryItem, RetrievalRequest } from '../memory/types.js';
import type { AuthzDecision } from '../authz/types.js';
import { check } from '../authz/index.js';

export class SecurityPolicy {
  /**
   * 1. Identity Enumeration Policy
   * Only the owner can list all identities.
   * A 'person' can only list themselves (or public identities).
   * A 'guest' cannot enumerate any identities.
   */
  static filterIdentitiesForCaller(caller: Identity, identities: Identity[]): Identity[] {
    if (caller.kind === 'owner') {
      return identities; // full visibility
    }
    if (caller.kind === 'person') {
      return identities.filter(id => id.id === caller.id); // only self
    }
    // guest gets none
    return [];
  }

  /**
   * 2. Knowledge Retrieval Policy (Memory Isolation)
   * Already implemented in MemoryRetrieval.isAllowedByPolicy,
   * but mirrored here for reference or testable standalone check.
   */
  static canAccessMemory(caller: Identity, memoryIdentityId: string, sensitivity: string): boolean {
    const isOwner = caller.kind === 'owner';
    const isAboutCaller = memoryIdentityId === caller.id;

    if (!isOwner && !isAboutCaller) {
      return false;
    }

    if (sensitivity === 'system_internal') return isOwner;
    if (sensitivity === 'owner_only') return isOwner;
    if (sensitivity === 'person_shared') return isOwner || isAboutCaller;
    if (sensitivity === 'public') return true;

    return false;
  }

  /**
   * 4. Action Authorization Policy
   * Rejects unauthorized tool proposals before execution.
   */
  static authorizeToolExecution(caller: Identity, toolId: string, clearanceRequired: 'safe' | 'all'): AuthzDecision {
    return check(caller, 'tool:execute', { type: 'tool', toolId, clearanceRequired });
  }
}