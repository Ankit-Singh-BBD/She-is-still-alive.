/**
 * P16 — Scoped Guest Learning Policy
 *
 * Implements Build Book Part XIII.4:
 *
 * | Information Subject | Application Policy Outcome |
 * |---|---|
 * | Small talk / idle context | Transient only, discarded after session. |
 * | Guest's own preferences | Saved as Guest-scoped `preference`. Completely isolated from Owner. |
 * | General behavioral patterns | May be saved as `learned_pattern` (e.g. "guests often ask X"). |
 * | Information about the Owner | Quarantine: Saved as `unverified_semantic` with Guest provenance. Owner confirmation required. |
 * | Sensitive/Private | Discarded unless explicitly authorized. |
 *
 * Regardless of identity:
 * - Transient emotional state is never learned as permanent memory.
 * - Unverified claims about third parties are discarded.
 * - Anything the owner later marks as wrong or soft-deletes is removed.
 */

import type { LearningCandidate, ScopedLearningDecision, GuestLearningPolicy } from './types.js';
import type { IdentityKind } from '@server/identity/types.js';

export class DefaultGuestLearningPolicy implements GuestLearningPolicy {
  evaluate(candidate: LearningCandidate, callerId: string, callerKind: IdentityKind): ScopedLearningDecision {
    // 1. Owner learning has broad permissions
    if (callerKind === 'owner') {
      return this.evaluateOwner(candidate);
    }

    // 2. Person (known non-owner) learning
    if (callerKind === 'person') {
      return this.evaluatePerson(candidate);
    }

    // 3. Guest learning has strict isolation
    return this.evaluateGuest(candidate);
  }

  private evaluateOwner(candidate: LearningCandidate): ScopedLearningDecision {
    // Owner can learn in all domains, with appropriate sensitivities
    const sensitivity = candidate.domain === 'relationship' ? 'owner_only' : 'person_shared';
    return {
      action: 'persist',
      sensitivity,
      subjectKind: 'owner',
      sourceKind: 'conversation',
    };
  }

  private evaluatePerson(candidate: LearningCandidate): ScopedLearningDecision {
    // Person can learn their own preferences, patterns, and episodic memories
    // But cannot write directly to owner-scoped memory
    if (candidate.domain === 'preference') {
      return {
        action: 'persist',
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'conversation',
      };
    }

    if (candidate.domain === 'learned_pattern') {
      return {
        action: 'persist',
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'system',
      };
    }

    if (candidate.domain === 'episodic') {
      return {
        action: 'persist',
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'conversation',
      };
    }

    // Semantic facts about owner go through quarantine
    if (candidate.domain === 'semantic') {
      const content = candidate.content as Record<string, unknown>;
      if (content['subject'] === 'owner' || content['target'] === 'owner') {
        return {
          action: 'quarantine',
          quarantineReason: 'Person-originated information about Owner requires owner confirmation',
          sensitivity: 'owner_only',
          subjectKind: 'owner',
          sourceKind: 'conversation',
        };
      }
      return {
        action: 'persist',
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'conversation',
      };
    }

    return {
      action: 'discard',
      discardReason: `Domain ${candidate.domain} not allowed for non-owner`,
    };
  }

  private evaluateGuest(candidate: LearningCandidate): ScopedLearningDecision {
    // Guest Policy Table:
    // 1. Guest's own preferences -> Saved as Guest-scoped preference
    if (candidate.domain === 'preference') {
      return {
        action: 'persist',
        sensitivity: 'public',
        subjectKind: 'guest',
        sourceKind: 'conversation',
      };
    }

    // 2. General behavioral patterns -> May be saved as learned_pattern
    if (candidate.domain === 'learned_pattern') {
      return {
        action: 'persist',
        sensitivity: 'public',
        subjectKind: 'guest',
        sourceKind: 'system',
      };
    }

    // 3. Information about the Owner -> Quarantine
    if (candidate.domain === 'semantic') {
      const content = candidate.content as Record<string, unknown>;
      if (content['subject'] === 'owner' || content['target'] === 'owner') {
        return {
          action: 'quarantine',
          quarantineReason: 'Guest-originated information about Owner requires owner confirmation',
          sensitivity: 'owner_only',
          subjectKind: 'owner',
          sourceKind: 'conversation',
        };
      }
      // General semantic facts from guests are discarded to prevent hallucinated truth
      return {
        action: 'discard',
        discardReason: 'Guest semantic facts about non-owner subjects are not retained',
      };
    }

    // 4. Small talk / idle context -> Discarded
    if (candidate.domain === 'episodic') {
      return {
        action: 'discard',
        discardReason: 'Guest episodic context is transient and discarded after session',
      };
    }

    // 5. Relationships from guests -> Discarded
    if (candidate.domain === 'relationship') {
      return {
        action: 'discard',
        discardReason: 'Guests cannot define relationship records',
      };
    }

    // 6. Habits from guests -> Discarded
    if (candidate.domain === 'habit') {
      return {
        action: 'discard',
        discardReason: 'Guest habits are not tracked',
      };
    }

    return {
      action: 'discard',
      discardReason: 'Guest candidate rejected by policy',
    };
  }
}