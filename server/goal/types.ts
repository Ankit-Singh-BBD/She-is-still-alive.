/**
 * B10.s3: Useful initiative — the shapes.
 *
 * Four ideas, kept apart on purpose (see `manager.ts` for why each boundary is
 * where it is):
 *
 *  - **Goal** — an owner-approved standing intention, with its scope, schedule,
 *    limits and dependencies.
 *  - **Eligibility** — whether work may proceed *now*. Says nothing about
 *    whether to mention it.
 *  - **Notification** — whether to say something, and when. This is where quiet
 *    hours live.
 *  - **Selection** — which of several permitted actions is the most useful one.
 */

import type { EligibilityContext } from './manager.js';

export type GoalId = string;
export type GoalOutcomeId = string;

/**
 * What the owner approved.
 *
 * `metadata` is required rather than optional so a goal round-tripped through
 * the database is the same shape going out as coming in — an optional field that
 * the row always stores as `'{}'` would be two shapes for one thing.
 */
export interface Goal {
  id: GoalId;
  identityId: string;
  title: string;
  description: string;

  /**
   * What this goal may touch.
   *
   * A `blocked*` entry always beats an `allowed*` one, and an empty `allowed*`
   * list permits nothing of that kind. Both rules point the same way: scope the
   * owner never widened is not permission. `'*'` and a trailing `':*'` are
   * honoured as wildcards, so `'rss:*'` covers a feed without enumerating it.
   */
  scope: {
    allowedSources: string[];
    allowedActions: string[];
    allowedTools: string[];
    allowedTopics: string[];
    blockedSources: string[];
    blockedActions: string[];
    blockedTools: string[];
    blockedTopics: string[];
  };

  /**
   * When work may happen — a window, not a promise.
   *
   * `cron` records the cadence the owner asked for; the manager evaluates the
   * `startTime`/`endTime` window and `daysOfWeek`, which is what a caller
   * actually asks about ("may she work right now"). A window that wraps midnight
   * is honoured as one span.
   */
  schedule: {
    /** IANA zone, recorded for display and for whoever schedules the cron. */
    timezone: string;
    /** Standard 5-field cron, in the zone above. */
    cron: string;
    /** `HH:MM`, local. Absent means every hour of the permitted days. */
    startTime?: string;
    endTime?: string;
    /** 0-6, Sunday first. Absent or empty means every day. */
    daysOfWeek?: number[];
  };

  /** What work may cost. Spend is summed from `GoalOutcome`, never from memory. */
  limits: {
    /** Cap on one continuous run. */
    maxRuntimeMs: number;
    /** Cap on everything this goal spends in one local day. */
    maxDailyRuntimeMs: number;
    modelBudget: {
      maxTokensPerDay: number;
      /** Microsats: 1/1,000,000 of a satoshi. */
      maxCostPerDayMicrosats: number;
    };
  };

  /**
   * What must be true for work to be possible at all.
   *
   * Checked against state the caller supplies (see `EligibilityContext`), because
   * whether `web_search` is healthy is the health registry's judgement and a
   * second copy of it here would eventually disagree.
   */
  dependencies: {
    requiredCapabilities: string[];
    requiredPeople: string[];
    requiredWorldModel: string[];
    /** Capabilities whose being *in use* blocks this goal (e.g. `voice_input`). */
    blockedIfCapabilities: string[];
  };

  status: 'active' | 'paused' | 'archived';
  /** 0-1. Above `GoalManagerOptions.notifyAbovePriority`, starting work is worth saying. */
  priority: number;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  /** Last time eligibility was evaluated, for the owner's own audit of her. */
  lastEvaluatedAt?: number;
  metadata: Record<string, unknown>;
}

/**
 * What a goal did, with its evidence.
 *
 * Also the only thing the daily budget is computed from, which is why
 * `runtimeMs`, `tokensUsed` and `costMicrosats` are not optional: an outcome
 * that recorded no cost would be work that was never paid for.
 */
export interface GoalOutcome {
  id: GoalOutcomeId;
  goalId: GoalId;
  identityId: string;

  actionTaken: string;
  toolUsed?: string;
  sourcesConsulted: string[];
  summary: string;

  /** `verified` means something outside the model checked. Same rule as everywhere. */
  verified: boolean;
  verifiedAt?: number;
  provenance: Record<string, unknown>;

  startedAt: number;
  completedAt: number;
  runtimeMs: number;

  tokensUsed: number;
  costMicrosats: number;

  success: boolean;
  errorMessage?: string;
  blockersEncountered: string[];

  createdAt: number;
  updatedAt: number;
}

/** What one goal has spent since the start of the local day. */
export interface SpendToDate {
  /** Start of the local day the spend was summed from. */
  since: number;
  runtimeMs: number;
  tokens: number;
  costMicrosats: number;
  runs: number;
}

/**
 * Whether work may proceed now — and if not, exactly what is in the way.
 *
 * Every blocking reason is a separate boolean as well as a sentence, so a caller
 * can act on the cause and a person can read it.
 */
export interface EligibilityResult {
  eligible: boolean;
  /** Empty when eligible; otherwise the single most proximate cause. */
  reason: string;
  missingDependencies: string[];
  blockedByCapabilities: string[];
  /**
   * Whether dependency state was actually available to check.
   *
   * `false` means the caller supplied none, so the two lists above are empty
   * because nothing was checked — not because everything was satisfied. An
   * unchecked dependency reported as satisfied is exactly the kind of false
   * clean bill this field exists to prevent.
   */
  dependenciesChecked: boolean;
  outsideSchedule: boolean;
  budgetExceeded: boolean;
  runtimeExceeded: boolean;
  /** What has been spent today, so a caller can explain the refusal. */
  spend: SpendToDate;
  /**
   * When this might next be eligible, when that is knowable.
   *
   * Absent rather than guessed for a missing capability: nothing here can
   * predict when something outside will be fixed.
   */
  nextAvailableAt?: number | undefined;
}

/**
 * Whether to say something about this work, and when.
 *
 * Separate from eligibility because quiet hours bear on speaking and not on
 * working: quiet work at 3am is not an interruption, and announcing it is.
 */
export interface NotificationDecision {
  notify: boolean;
  reason: string;
  /** True when a notification is owed but held until `deferUntil`. */
  deferred: boolean;
  /** A real instant — quiet hours ending — rather than "later". */
  deferUntil?: number;
}

/** One concrete thing a candidate wants to touch, checked against a goal's scope. */
export interface ScopeRequest {
  source?: string;
  action?: string;
  tool?: string;
  topic?: string;
}

export interface ScopeDecision {
  permitted: boolean;
  /** Empty when permitted; otherwise which term of the scope refused, and why. */
  reason: string;
}

/** How a candidate ranked, and on what. */
export interface SelectionScores {
  urgency: number;
  ownerPriority: number;
  expectedBenefit: number;
  dependencyScore: number;
  /** Weighted composite; the only field selection compares. */
  compositeScore: number;
}

/**
 * One thing that could actually be done, proposed by something that reads real
 * state.
 *
 * `urgency` and `expectedBenefit` are the candidate's own claims because the
 * source knows things this class cannot — a feed that refreshes hourly knows its
 * own deadline. Both default to 0.5 when unclaimed rather than to 1, so an
 * unclaimed candidate cannot outrank one that made an honest case.
 */
export interface UsefulWorkCandidate {
  goalId: GoalId;
  actionDescription: string;
  estimatedRuntimeMs: number;
  estimatedTokens: number;
  estimatedCostMicrosats: number;
  /** What this action touches, for the scope check. Absent means it touches nothing scoped. */
  scope?: ScopeRequest;
  urgency?: number;
  expectedBenefit?: number;
  /** Specific things preventing full completion. Non-empty is notifiable. */
  blockers: string[];
  /** Filled by the manager when it evaluates the candidate. */
  eligibility?: EligibilityResult;
  metadata?: Record<string, unknown>;
}

/**
 * Where candidates come from.
 *
 * A function rather than a table, because the answer to "what would be useful"
 * lives in the task queue, the world model and the health registry — all of
 * which change between one call and the next. With no source wired there are no
 * candidates, which is the honest state; a placeholder would make every active
 * goal permanently ready with nothing behind it.
 */
export type GoalCandidateSource = (
  goal: Goal,
) => Promise<UsefulWorkCandidate[]> | UsefulWorkCandidate[];

/**
 * The single most useful thing she could start right now (journey J02).
 *
 * Carries its own scores and notification decision so the caller does not have
 * to re-derive either — and so a trace can show why this action won and whether
 * anyone was told.
 */
export interface UsefulNextAction {
  action: string;
  /** Why this one, in words that can be checked against `scores`. */
  reason: string;
  goalId: GoalId;
  estimatedRuntimeMs: number;
  blockers: string[];
  eligible: boolean;
  scores: SelectionScores;
  notification: NotificationDecision;
}

export interface GoalManagerOptions {
  /**
   * The window in which she works without saying so. Defaults to the same
   * `22:00`-`07:00` `ProactiveEngine` uses; pass the configured one so there is
   * one definition of quiet in the process.
   */
  quietHours?: { startHour: number; endHour: number };
  /**
   * Priority above which merely *starting* work is worth telling the owner.
   * Blockers and failures are notifiable at any priority.
   */
  notifyAbovePriority?: number;
  /** Default candidate source, overridable per call. */
  candidates?: GoalCandidateSource;
}

export type { EligibilityContext };
