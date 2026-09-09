/**
 * P17 — Proactive Engine Types
 *
 * Implements Build Book Part XIV: Proactive Engine & Decision Tree
 */

import type { IdentityKind } from '@server/identity/types.js';

export type ProactiveDecisionKind = 'speak' | 'act' | 'ask' | 'wait' | 'silent';

export type ProactiveDecision =
  | { kind: 'speak'; channel: 'text' | 'voice'; priority: 'low' | 'normal' | 'high'; text: string }
  | { kind: 'act'; toolId: string; payload: unknown }
  | { kind: 'ask'; question: string }
  | { kind: 'wait'; until: number }
  | { kind: 'silent' };

export interface ProactiveCandidate {
  id?: string;
  identityId: string;
  callerKind?: IdentityKind;
  topic: string;
  decision: ProactiveDecision;
  urgency: number; // 0..1
  novelty: number; // 0..1
  interruptionCost: number; // 0..1
  contextCompatibility: number; // 0..1
  reasoning?: string;
  /**
   * How many times this candidate has already been deferred. Set by the engine
   * when it replays a candidate off the deferral queue; a fresh proposal leaves
   * it absent, which reads as 0.
   *
   * The decision tree needs it because a candidate that keeps deferring is not
   * being scheduled, it is being abandoned slowly — past the configured limit
   * the tree says so instead of promising another "later".
   */
  deferCount?: number;
}

export type ProactiveAction = 'emit' | 'defer' | 'suppress' | 'reject';

export interface ProactiveDecisionOutcome {
  action: ProactiveAction;
  decision: ProactiveDecision;
  reason: string;
  evaluatedAt: number;
  urgency: number;
  novelty: number;
  interruptionCost: number;
  contextCompatibility: number;
  /**
   * ms epoch at which a deferred candidate becomes due for re-evaluation.
   *
   * Present exactly when `action === 'defer'`. A deferral without this is the
   * bug this field exists to make unrepresentable: the engine used to record
   * "defer" with no time attached and no queue to sit in, so "later" was never.
   */
  deferUntil?: number;
}

export interface QuietHoursConfig {
  startHour: number; // e.g. 22 (10 PM)
  endHour: number; // e.g. 7 (7 AM)
}

export interface ProactiveEngineOptions {
  noveltyThreshold?: number;
  urgencyThreshold?: number;
  interruptionCostThreshold?: number;
  contextCompatibilityThreshold?: number;
  topicRateLimitMs?: number;
  quietHours?: QuietHoursConfig;
  enabled?: boolean;
  disabledTopics?: string[];
  /**
   * How long to wait before re-evaluating a candidate deferred for a reason
   * that is not a clock window (an interruption cost above threshold, say —
   * that depends on what the owner is doing, which no config can predict).
   * Doubles per deferral so a candidate that is never welcome stops asking
   * every quarter hour.
   */
  deferBackoffMs?: number;
  /**
   * Deferrals allowed before the tree stops deferring and suppresses instead.
   * A candidate that has been put off this many times is not waiting for a
   * better moment, it is unwanted — and saying so is more honest than a fourth
   * promise of "later".
   */
  maxDeferrals?: number;
}

export interface UserContext {
  isQuietHours?: boolean;
  currentHour?: number;
  userPresence?: 'active' | 'idle' | 'away';
  activeChannel?: 'text' | 'voice' | 'none';
  proactivityEnabled?: boolean;
}

export type ProactiveProposalFn = () => Promise<ProactiveCandidate[]> | ProactiveCandidate[];

export const DEFAULT_PROACTIVE_OPTIONS: Required<ProactiveEngineOptions> = {
  noveltyThreshold: 0.6,
  urgencyThreshold: 0.8,
  interruptionCostThreshold: 0.6,
  contextCompatibilityThreshold: 0.5,
  topicRateLimitMs: 3600000, // 1 hour per topic
  quietHours: { startHour: 22, endHour: 7 },
  enabled: true,
  disabledTopics: [],
  deferBackoffMs: 900000, // 15 minutes, doubling: 15m, 30m, 1h, then give up
  maxDeferrals: 3,
};
