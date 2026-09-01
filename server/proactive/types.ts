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
};
