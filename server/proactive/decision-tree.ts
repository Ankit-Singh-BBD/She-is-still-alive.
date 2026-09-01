/**
 * P17 — Proactive Decision Tree
 *
 * Implements the deterministic multi-step decision tree from Build Book Part XIV:
 * 1. Authorization & Global Enablement
 * 2. Urgency Check (Urgent candidates bypass non-critical gates)
 * 3. Topic Anti-Spam Rate Limit Check
 * 4. Novelty Check
 * 5. Good Timing / Quiet Hours Check
 * 6. Interruption Cost Check
 * 7. User Context Compatibility Check
 * 8. Emit Decision
 */

import type { Identity } from '@server/identity/types.js';
import type {
  ProactiveCandidate,
  ProactiveDecisionOutcome,
  ProactiveEngineOptions,
  UserContext,
  QuietHoursConfig,
} from './types.js';
import { DEFAULT_PROACTIVE_OPTIONS } from './types.js';

export class ProactiveDecisionTree {
  private readonly options: Required<ProactiveEngineOptions>;

  constructor(options?: ProactiveEngineOptions) {
    this.options = { ...DEFAULT_PROACTIVE_OPTIONS, ...options };
  }

  /**
   * Evaluate a proactive candidate against deterministic application policy.
   *
   * @param candidate The LLM or system-proposed proactive candidate
   * @param identity The recipient identity (if resolved)
   * @param isRateLimitedFn Function to check whether topic is rate limited
   * @param userContext Contextual information about recipient/environment
   */
  evaluate(
    candidate: ProactiveCandidate,
    identity: Identity | undefined,
    isRateLimitedFn: (identityId: string, topic: string) => boolean,
    userContext?: UserContext,
  ): ProactiveDecisionOutcome {
    const now = Date.now();
    const callerKind = candidate.callerKind ?? identity?.kind ?? 'guest';

    const baseOutcome = {
      decision: candidate.decision,
      evaluatedAt: now,
      urgency: candidate.urgency,
      novelty: candidate.novelty,
      interruptionCost: candidate.interruptionCost,
      contextCompatibility: candidate.contextCompatibility,
    };

    // 1. Authorization & Global Gates
    // A. Guest isolation: Guest sessions NEVER receive proactive output
    if (callerKind === 'guest') {
      return {
        ...baseOutcome,
        action: 'reject',
        reason: 'Guest sessions never receive proactive messages',
      };
    }

    // B. Identity permissions
    if (identity && identity.permissions && identity.permissions.mayReceiveProactiveMessages === false) {
      return {
        ...baseOutcome,
        action: 'reject',
        reason: 'Identity is not authorized to receive proactive messages',
      };
    }

    // C. Global enablement
    if (this.options.enabled === false || userContext?.proactivityEnabled === false) {
      return {
        ...baseOutcome,
        action: 'suppress',
        reason: 'Proactivity is globally disabled',
      };
    }

    // D. Topic disabled
    if (this.options.disabledTopics.includes(candidate.topic)) {
      return {
        ...baseOutcome,
        action: 'suppress',
        reason: `Proactive topic '${candidate.topic}' is disabled`,
      };
    }

    // E. Silent candidate
    if (candidate.decision.kind === 'silent') {
      return {
        ...baseOutcome,
        action: 'suppress',
        reason: 'Proactive decision is silent',
      };
    }

    // 2. Urgency Check
    // Urgent items (urgency >= threshold) bypass quiet hours, novelty, and interruption cost
    if (candidate.urgency >= this.options.urgencyThreshold) {
      return {
        ...baseOutcome,
        action: 'emit',
        reason: `Urgent candidate (${candidate.urgency} >= ${this.options.urgencyThreshold}) authorized for immediate emission`,
      };
    }

    // 3. Topic Anti-Spam Rate Limit
    if (isRateLimitedFn(candidate.identityId, candidate.topic)) {
      return {
        ...baseOutcome,
        action: 'suppress',
        reason: `Topic '${candidate.topic}' is rate-limited (max 1 per window)`,
      };
    }

    // 4. Novelty Check
    if (candidate.novelty < this.options.noveltyThreshold) {
      return {
        ...baseOutcome,
        action: 'suppress',
        reason: `Novelty score ${candidate.novelty} is below threshold ${this.options.noveltyThreshold}`,
      };
    }

    // 5. Good Timing / Quiet Hours Check
    const inQuietHours =
      userContext?.isQuietHours ??
      this.isWithinQuietHours(userContext?.currentHour ?? new Date().getHours(), this.options.quietHours);

    if (inQuietHours) {
      return {
        ...baseOutcome,
        action: 'defer',
        reason: 'Candidate deferred due to quiet hours window',
      };
    }

    // 6. Interruption Cost Check
    if (candidate.interruptionCost > this.options.interruptionCostThreshold) {
      return {
        ...baseOutcome,
        action: 'defer',
        reason: `Interruption cost ${candidate.interruptionCost} exceeds threshold ${this.options.interruptionCostThreshold}`,
      };
    }

    // 7. User Context Compatibility Check
    if (candidate.contextCompatibility < this.options.contextCompatibilityThreshold) {
      return {
        ...baseOutcome,
        action: 'suppress',
        reason: `Context compatibility ${candidate.contextCompatibility} is below threshold ${this.options.contextCompatibilityThreshold}`,
      };
    }

    // 8. All application gates passed -> EMIT
    return {
      ...baseOutcome,
      action: 'emit',
      reason: 'All proactive application validation criteria passed',
    };
  }

  private isWithinQuietHours(currentHour: number, config: QuietHoursConfig): boolean {
    const { startHour, endHour } = config;
    if (startHour === endHour) {
      return false;
    }
    if (startHour > endHour) {
      // e.g. 22:00 to 07:00
      return currentHour >= startHour || currentHour < endHour;
    }
    // e.g. 01:00 to 06:00
    return currentHour >= startHour && currentHour < endHour;
  }
}
