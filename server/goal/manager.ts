/**
 * B10.s3: Useful initiative — what she is allowed to start on her own.
 *
 * A standing goal is the owner's durable, revocable answer to a question the
 * rest of the system never asked: *may she begin something nobody requested?*
 * Everything before this milestone was reactive or reflexive — a cycle answered
 * a stimulus, a sensor reported a row that had gone wrong. None of it could
 * decide to do something useful.
 *
 * ## Four things a goal carries, and why each is separate
 *
 *  - **Scope** is a permission, not a preference. `allowedTools` is checked
 *    before a tool is proposed, and a `blocked*` entry wins over an `allowed*`
 *    one, so revoking is always stronger than granting. A goal cannot widen its
 *    own scope; only the owner can.
 *  - **Schedule** is when work *may* happen. It is a window, not a promise.
 *  - **Limits** are what work may *cost*, and they are computed from
 *    `goal_outcome` rows rather than from a counter in memory. A process that
 *    restarts at 4pm having already spent its hour does not get a second hour.
 *  - **Dependencies** are what must be true for work to be possible at all —
 *    a capability that must be healthy, a part of the world model that must be
 *    known.
 *
 * ## Eligibility and notification are different questions
 *
 * This is the distinction the slice exists to get right. *Eligible* means the
 * work is permitted, affordable and possible right now. *Notifiable* means she
 * should say something about it. Quiet hours bear on the second and not the
 * first: a goal may consolidate memory or read a feed at 3am and say nothing,
 * because doing quiet work is not an interruption. What quiet hours forbid is
 * *waking him about it*.
 *
 * Conflating the two produces one of two failures, and both were live options
 * before this file: either she goes idle for nine hours a night because the
 * quiet-hours check gated the work, or she does the work and announces it at
 * 3am because the only check was on eligibility.
 *
 * ## Nothing is invented
 *
 * `getUsefulNextAction` returns `null` when there is no real candidate, and the
 * only source of candidates is a `GoalCandidateSource` supplied by the caller —
 * something reading the task queue, the world model, the health registry. With
 * no source wired there are no candidates, which is the honest state. A
 * placeholder "work on <goal title>" candidate would have made every active goal
 * permanently ready with nothing behind it: busyness she could report and never
 * account for.
 */

import { ulid } from 'ulid';

import type { Database } from '@server/persistence/db.js';
import type { QuietHoursConfig, UserContext } from '@server/proactive/types.js';

import type {
  Goal,
  GoalId,
  GoalOutcome,
  GoalManagerOptions,
  EligibilityResult,
  NotificationDecision,
  ScopeRequest,
  ScopeDecision,
  SelectionScores,
  SpendToDate,
  UsefulWorkCandidate,
  UsefulNextAction,
  GoalCandidateSource,
} from './types.js';

/**
 * How the four selection factors are weighted into one number.
 *
 * Owner priority carries the same weight as urgency on purpose: a goal the owner
 * marked important should not be permanently outranked by a goal that merely
 * has a deadline.
 */
const SELECTION_WEIGHTS = {
  urgency: 0.3,
  ownerPriority: 0.3,
  expectedBenefit: 0.25,
  dependencyScore: 0.15,
} as const;

/** Quiet hours default to the same window `ProactiveEngine` uses. */
const DEFAULT_QUIET_HOURS: QuietHoursConfig = { startHour: 22, endHour: 7 };

/** The priority above which starting work is worth telling the owner about. */
const DEFAULT_NOTIFY_ABOVE_PRIORITY = 0.8;

export class GoalManager {
  private readonly quietHours: QuietHoursConfig;
  private readonly notifyAbovePriority: number;

  constructor(
    private readonly db: Database,
    private readonly options: GoalManagerOptions = {},
  ) {
    this.quietHours = options.quietHours ?? DEFAULT_QUIET_HOURS;
    this.notifyAbovePriority = options.notifyAbovePriority ?? DEFAULT_NOTIFY_ABOVE_PRIORITY;
  }

  // ── Registration and lifecycle ─────────────────────────────────────────────

  /**
   * Records an owner-approved standing goal.
   *
   * `INSERT OR REPLACE` so re-registering a template on every boot is idempotent
   * rather than an accumulating pile of duplicates — but `created_at` is
   * preserved from any existing row, because when the owner first approved
   * something is not a fact a restart gets to rewrite.
   */
  registerGoal(goal: Goal): void {
    this.validateGoal(goal);

    const existing = this.getGoal(goal.id);
    const createdAt = existing?.createdAt ?? goal.createdAt;
    const now = Date.now();

    this.db.raw
      .prepare(
        `INSERT INTO standing_goal (
           id, identity_id, title, description,
           scope_json, schedule_json, limits_json, dependencies_json,
           status, priority, created_at, updated_at,
           expires_at, last_evaluated_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           identity_id = excluded.identity_id,
           title = excluded.title,
           description = excluded.description,
           scope_json = excluded.scope_json,
           schedule_json = excluded.schedule_json,
           limits_json = excluded.limits_json,
           dependencies_json = excluded.dependencies_json,
           status = excluded.status,
           priority = excluded.priority,
           updated_at = excluded.updated_at,
           expires_at = excluded.expires_at,
           metadata_json = excluded.metadata_json`,
      )
      .run(
        goal.id,
        goal.identityId,
        goal.title,
        goal.description,
        JSON.stringify(goal.scope),
        JSON.stringify(goal.schedule),
        JSON.stringify(goal.limits),
        JSON.stringify(goal.dependencies),
        goal.status,
        goal.priority,
        createdAt,
        now,
        goal.expiresAt ?? null,
        goal.lastEvaluatedAt ?? null,
        JSON.stringify(goal.metadata ?? {}),
      );
  }

  getGoal(id: GoalId): Goal | undefined {
    const row = this.db.raw
      .prepare(`SELECT * FROM standing_goal WHERE id = ?`)
      .get(id) as GoalRow | undefined;
    return row ? hydrateGoal(row) : undefined;
  }

  /**
   * Goals that are active and unexpired, highest priority first.
   *
   * Expiry is evaluated here rather than swept: a goal that expired while the
   * process was down must be inert the moment it comes back up, and a sweep
   * cannot promise that.
   */
  listActiveGoals(identityId?: string, now: number = Date.now()): Goal[] {
    const rows = (
      identityId === undefined
        ? this.db.raw
            .prepare(`SELECT * FROM standing_goal WHERE status = 'active' ORDER BY priority DESC`)
            .all()
        : this.db.raw
            .prepare(
              `SELECT * FROM standing_goal
                WHERE status = 'active' AND identity_id = ?
                ORDER BY priority DESC`,
            )
            .all(identityId)
    ) as GoalRow[];

    return rows
      .map(hydrateGoal)
      .filter((goal) => goal.expiresAt === undefined || goal.expiresAt > now);
  }

  listAllGoals(): Goal[] {
    const rows = this.db.raw
      .prepare(`SELECT * FROM standing_goal ORDER BY priority DESC`)
      .all() as GoalRow[];
    return rows.map(hydrateGoal);
  }

  /**
   * Pauses, archives or reactivates a goal.
   *
   * Throws on an unknown id rather than doing nothing: the caller is the owner
   * revoking permission, and a silent no-op there is the failure mode where she
   * keeps working on something he believes he stopped.
   */
  updateGoalStatus(goalId: GoalId, status: Goal['status']): void {
    const changed = this.db.raw
      .prepare(`UPDATE standing_goal SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), goalId).changes;
    if (changed === 0) {
      throw new Error(`Goal '${goalId}' not found`);
    }
  }

  /** Records that eligibility was evaluated, for the owner's own audit of her. */
  markEvaluated(goalId: GoalId, at: number = Date.now()): void {
    this.db.raw
      .prepare(`UPDATE standing_goal SET last_evaluated_at = ?, updated_at = ? WHERE id = ?`)
      .run(at, at, goalId);
  }

  // ── Scope ──────────────────────────────────────────────────────────────────

  /**
   * Whether a goal's scope permits one concrete request.
   *
   * Blocked beats allowed, and an empty `allowed*` list means "nothing of this
   * kind" rather than "anything". Both rules point the same way: a scope the
   * owner never widened cannot be read as permission.
   *
   * `*` is honoured as a wildcard within a list, and a trailing `:*` matches a
   * prefix, so `rss:*` covers `rss:techcrunch` without enumerating feeds.
   */
  permits(goalId: GoalId, request: ScopeRequest): ScopeDecision {
    const goal = this.getGoal(goalId);
    if (!goal) {
      return { permitted: false, reason: `Goal '${goalId}' not found` };
    }
    if (goal.status !== 'active') {
      return { permitted: false, reason: `Goal is ${goal.status}` };
    }

    const checks: [keyof ScopeRequest, string[], string[], string][] = [
      ['source', goal.scope.allowedSources, goal.scope.blockedSources, 'source'],
      ['action', goal.scope.allowedActions, goal.scope.blockedActions, 'action'],
      ['tool', goal.scope.allowedTools, goal.scope.blockedTools, 'tool'],
      ['topic', goal.scope.allowedTopics, goal.scope.blockedTopics, 'topic'],
    ];

    for (const [key, allowed, blocked, label] of checks) {
      const value = request[key];
      if (value === undefined) continue;
      if (matchesAny(value, blocked)) {
        return { permitted: false, reason: `${label} '${value}' is blocked by this goal's scope` };
      }
      if (!matchesAny(value, allowed)) {
        return {
          permitted: false,
          reason: `${label} '${value}' is not in this goal's allowed ${label}s`,
        };
      }
    }

    return { permitted: true, reason: '' };
  }

  // ── Eligibility ────────────────────────────────────────────────────────────

  /**
   * Whether work on a goal may proceed right now.
   *
   * Deliberately says nothing about quiet hours — see the header. What it
   * answers is: is the goal live, is the clock inside its window, is there
   * budget left today, and is every dependency satisfied.
   *
   * `availableCapabilities` and `knownWorldFacts` are passed in rather than read
   * from a registry this class holds, because the honest answer to "is
   * `web_search` available" lives in the health registry and the tool registry,
   * and a second copy of that judgement here would eventually disagree with
   * them. With neither supplied, dependency checks are skipped and
   * `dependenciesChecked` says so — an unchecked dependency is reported as
   * unchecked rather than as satisfied.
   */
  checkEligibility(
    goalId: GoalId,
    context: EligibilityContext = {},
  ): EligibilityResult {
    const now = context.now ?? Date.now();
    const goal = this.getGoal(goalId);

    if (!goal) {
      return ineligible(`Goal '${goalId}' not found`);
    }
    if (goal.status !== 'active') {
      return ineligible(`Goal is ${goal.status}`);
    }
    if (goal.expiresAt !== undefined && goal.expiresAt <= now) {
      return ineligible('Goal has expired');
    }

    const outsideSchedule = !this.withinSchedule(goal, now);

    const spend = this.spendToDate(goalId, now);
    const budgetExceeded =
      spend.runtimeMs >= goal.limits.maxDailyRuntimeMs ||
      spend.tokens >= goal.limits.modelBudget.maxTokensPerDay ||
      spend.costMicrosats >= goal.limits.modelBudget.maxCostPerDayMicrosats;

    // A single run may not be longer than the goal's continuous-runtime cap, nor
    // longer than what is left of today's budget.
    const remainingToday = Math.max(0, goal.limits.maxDailyRuntimeMs - spend.runtimeMs);
    const runtimeExceeded =
      context.estimatedRuntimeMs !== undefined &&
      (context.estimatedRuntimeMs > goal.limits.maxRuntimeMs ||
        context.estimatedRuntimeMs > remainingToday);

    const { missingDependencies, blockedByCapabilities, dependenciesChecked } =
      this.checkDependencies(goal, context);

    const eligible =
      !outsideSchedule &&
      !budgetExceeded &&
      !runtimeExceeded &&
      missingDependencies.length === 0 &&
      blockedByCapabilities.length === 0;

    const reason = eligible
      ? ''
      : outsideSchedule
        ? 'Outside the schedule the owner approved'
        : budgetExceeded
          ? describeBudgetExceeded(goal, spend)
          : runtimeExceeded
            ? `Estimated runtime exceeds what is left today (${remainingToday}ms) or the ` +
              `per-run cap (${goal.limits.maxRuntimeMs}ms)`
            : missingDependencies.length > 0
              ? `Missing dependencies: ${missingDependencies.join(', ')}`
              : `Blocked by active capabilities: ${blockedByCapabilities.join(', ')}`;

    return {
      eligible,
      reason,
      missingDependencies,
      blockedByCapabilities,
      dependenciesChecked,
      outsideSchedule,
      budgetExceeded,
      runtimeExceeded,
      spend,
      ...(eligible ? {} : { nextAvailableAt: this.nextAvailableAt(goal, now, outsideSchedule) }),
    };
  }

  // ── Notification ───────────────────────────────────────────────────────────

  /**
   * Whether to tell the owner about work on this goal, and when.
   *
   * The quiet-hours check lives here and only here. Three things override it,
   * and each is something he would rather be woken for than find out about in
   * the morning:
   *
   *  - a blocker, because the work has stopped and only he can restart it;
   *  - a goal he marked above `notifyAbovePriority`;
   *  - a failure, because silence would read as success.
   *
   * Everything else defers to `endHour`, which is a real time and not "later".
   */
  notificationFor(
    goalId: GoalId,
    event: NotificationEvent,
    context: { now?: number; user?: UserContext } = {},
  ): NotificationDecision {
    const now = context.now ?? Date.now();
    const goal = this.getGoal(goalId);
    if (!goal) {
      return { notify: false, reason: `Goal '${goalId}' not found`, deferred: false };
    }

    const wanted =
      event.kind === 'blocked' ||
      event.kind === 'failed' ||
      goal.priority > this.notifyAbovePriority;

    if (!wanted) {
      return {
        notify: false,
        reason:
          `Routine ${event.kind} on a goal at priority ${goal.priority.toFixed(2)}; ` +
          `the outcome is recorded and he can read it when he asks`,
        deferred: false,
      };
    }

    const quiet = context.user?.isQuietHours ?? this.isQuietHour(now, context.user?.currentHour);
    const urgent = event.kind === 'blocked' || event.kind === 'failed';

    if (quiet && !urgent) {
      const until = this.nextQuietHoursEnd(now);
      return {
        notify: false,
        reason: 'Inside quiet hours; the work itself is permitted, saying so is not',
        deferred: true,
        deferUntil: until,
      };
    }

    return {
      notify: true,
      reason:
        event.kind === 'blocked'
          ? 'Work is blocked and only the owner can unblock it'
          : event.kind === 'failed'
            ? 'Work failed; silence would read as success'
            : `Goal priority ${goal.priority.toFixed(2)} is above the notify threshold`,
      deferred: false,
    };
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /** Scores one candidate action for selection. Pure; reads no clock of its own. */
  scoreWorkAction(goal: Goal, candidate: UsefulWorkCandidate): SelectionScores {
    // Urgency is the candidate's own claim when it makes one — a feed that
    // refreshes hourly knows more about its own deadline than this class does.
    const urgency = clamp01(candidate.urgency ?? 0.5);

    const ownerPriority = clamp01(goal.priority);

    // Benefit is the candidate's claim, discounted by whatever is blocking it:
    // work that cannot finish is worth less than work that can.
    const expectedBenefit = clamp01(
      (candidate.expectedBenefit ?? 0.5) * (candidate.blockers.length === 0 ? 1 : 0.5),
    );

    const dependencyScore = candidate.eligibility?.eligible === true ? 1 : 0.5;

    const compositeScore =
      urgency * SELECTION_WEIGHTS.urgency +
      ownerPriority * SELECTION_WEIGHTS.ownerPriority +
      expectedBenefit * SELECTION_WEIGHTS.expectedBenefit +
      dependencyScore * SELECTION_WEIGHTS.dependencyScore;

    return { urgency, ownerPriority, expectedBenefit, dependencyScore, compositeScore };
  }

  /**
   * The single most useful thing she could start right now, or `null` (J02).
   *
   * `null` is the common and correct answer: no active goals, nothing eligible,
   * or no candidate source wired. Returning a placeholder instead would be
   * inventing work, which is the one thing this subsystem must never do.
   */
  async getUsefulNextAction(
    context: UsefulNextActionContext = {},
  ): Promise<UsefulNextAction | null> {
    const now = context.now ?? Date.now();
    const source = context.candidates ?? this.options.candidates;
    if (source === undefined) return null;

    const goals = this.listActiveGoals(context.identityId, now);
    if (goals.length === 0) return null;

    let best: UsefulNextAction | null = null;
    let bestScore = -1;

    for (const goal of goals) {
      const candidates = await source(goal);
      this.markEvaluated(goal.id, now);

      for (const candidate of candidates) {
        // Scope first: an action the owner never permitted is not a candidate,
        // whatever it would score.
        const scope = this.permits(goal.id, candidate.scope ?? {});
        if (!scope.permitted) continue;

        const eligibility = this.checkEligibility(goal.id, {
          now,
          estimatedRuntimeMs: candidate.estimatedRuntimeMs,
          ...(context.availableCapabilities
            ? { availableCapabilities: context.availableCapabilities }
            : {}),
          ...(context.activeCapabilities
            ? { activeCapabilities: context.activeCapabilities }
            : {}),
          ...(context.knownWorldFacts ? { knownWorldFacts: context.knownWorldFacts } : {}),
        });
        if (!eligibility.eligible) continue;

        const scored = { ...candidate, eligibility };
        const scores = this.scoreWorkAction(goal, scored);
        if (scores.compositeScore <= bestScore) continue;

        const notification = this.notificationFor(
          goal.id,
          { kind: candidate.blockers.length > 0 ? 'blocked' : 'starting' },
          { now, ...(context.user ? { user: context.user } : {}) },
        );

        bestScore = scores.compositeScore;
        best = {
          action: candidate.actionDescription,
          reason: describeSelection(goal, scored, scores),
          goalId: goal.id,
          estimatedRuntimeMs: candidate.estimatedRuntimeMs,
          blockers: candidate.blockers,
          eligible: true,
          scores,
          notification,
        };
      }
    }

    return best;
  }

  // ── Outcomes ───────────────────────────────────────────────────────────────

  /**
   * Records what a goal actually did.
   *
   * This is also the write that spends the budget, which is why it is one row
   * and not a row plus a counter: the budget is a `SUM` over these rows, so an
   * outcome that was recorded was paid for and an outcome that was not, was not.
   */
  recordOutcome(outcome: Omit<GoalOutcome, 'id' | 'createdAt' | 'updatedAt'>): string {
    const id = ulid();
    const now = Date.now();

    this.db.raw
      .prepare(
        `INSERT INTO goal_outcome (
           id, goal_id, identity_id, action_taken, tool_used,
           sources_consulted_json, summary, verified, verified_at, provenance_json,
           started_at, completed_at, runtime_ms, tokens_used, cost_microsats,
           success, error_message, blockers_encountered_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        outcome.goalId,
        outcome.identityId,
        outcome.actionTaken,
        outcome.toolUsed ?? null,
        JSON.stringify(outcome.sourcesConsulted),
        outcome.summary,
        outcome.verified ? 1 : 0,
        outcome.verifiedAt ?? null,
        JSON.stringify(outcome.provenance),
        outcome.startedAt,
        outcome.completedAt,
        outcome.runtimeMs,
        outcome.tokensUsed,
        outcome.costMicrosats,
        outcome.success ? 1 : 0,
        outcome.errorMessage ?? null,
        JSON.stringify(outcome.blockersEncountered),
        now,
        now,
      );

    return id;
  }

  getRecentOutcomes(goalId: GoalId, limit = 10): GoalOutcome[] {
    const rows = this.db.raw
      .prepare(`SELECT * FROM goal_outcome WHERE goal_id = ? ORDER BY started_at DESC LIMIT ?`)
      .all(goalId, limit) as GoalOutcomeRow[];
    return rows.map(hydrateOutcome);
  }

  /**
   * What a goal has spent since the start of the local day.
   *
   * Read from `goal_outcome` rather than kept in memory, so the budget survives
   * a restart. A goal that used its hour before lunch does not get another one
   * because the process was restarted at two.
   */
  spendToDate(goalId: GoalId, now: number = Date.now()): SpendToDate {
    const since = startOfLocalDay(now);
    const row = this.db.raw
      .prepare(
        `SELECT
           COALESCE(SUM(runtime_ms), 0) AS runtime_ms,
           COALESCE(SUM(tokens_used), 0) AS tokens_used,
           COALESCE(SUM(cost_microsats), 0) AS cost_microsats,
           COUNT(*) AS runs
         FROM goal_outcome
         WHERE goal_id = ? AND started_at >= ?`,
      )
      .get(goalId, since) as {
      runtime_ms: number;
      tokens_used: number;
      cost_microsats: number;
      runs: number;
    };

    return {
      since,
      runtimeMs: row.runtime_ms,
      tokens: row.tokens_used,
      costMicrosats: row.cost_microsats,
      runs: row.runs,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private validateGoal(goal: Goal): void {
    if (!goal.id.trim()) throw new Error('Goal must have an id');
    if (!goal.identityId.trim()) throw new Error('Goal must belong to an identity');
    if (!goal.title.trim()) throw new Error('Goal must have a title');
    if (!goal.description.trim()) throw new Error('Goal must have a description');
    if (goal.priority < 0 || goal.priority > 1) {
      throw new Error('Goal priority must be between 0 and 1');
    }
    if (goal.limits.maxRuntimeMs <= 0) {
      throw new Error('Goal maxRuntimeMs must be positive');
    }
    if (goal.limits.maxDailyRuntimeMs <= 0) {
      throw new Error('Goal maxDailyRuntimeMs must be positive');
    }
    if (goal.limits.maxRuntimeMs > goal.limits.maxDailyRuntimeMs) {
      throw new Error('Goal maxRuntimeMs cannot exceed maxDailyRuntimeMs');
    }
    if (goal.limits.modelBudget.maxTokensPerDay < 0) {
      throw new Error('Goal maxTokensPerDay cannot be negative');
    }
    if (goal.limits.modelBudget.maxCostPerDayMicrosats < 0) {
      throw new Error('Goal maxCostPerDayMicrosats cannot be negative');
    }
  }

  /**
   * Whether `now` falls inside the goal's approved window.
   *
   * A window with no `startTime`/`endTime` is every hour; a window that wraps
   * midnight (`22:00`–`02:00`) is honoured as one span rather than read as
   * empty. `daysOfWeek` is checked against the same local clock.
   */
  private withinSchedule(goal: Goal, now: number): boolean {
    const when = new Date(now);

    if (goal.schedule.daysOfWeek !== undefined && goal.schedule.daysOfWeek.length > 0) {
      if (!goal.schedule.daysOfWeek.includes(when.getDay())) return false;
    }

    const { startTime, endTime } = goal.schedule;
    if (startTime === undefined || endTime === undefined) return true;

    const start = parseHhMm(startTime);
    const end = parseHhMm(endTime);
    if (start === undefined || end === undefined) return true;

    const minutes = when.getHours() * 60 + when.getMinutes();
    return start <= end
      ? minutes >= start && minutes <= end
      : minutes >= start || minutes <= end;
  }

  private checkDependencies(
    goal: Goal,
    context: EligibilityContext,
  ): {
    missingDependencies: string[];
    blockedByCapabilities: string[];
    dependenciesChecked: boolean;
  } {
    const missingDependencies: string[] = [];
    const blockedByCapabilities: string[] = [];

    const haveCapabilities = context.availableCapabilities;
    const activeCapabilities = context.activeCapabilities;
    const knownWorldFacts = context.knownWorldFacts;

    const checked =
      haveCapabilities !== undefined ||
      activeCapabilities !== undefined ||
      knownWorldFacts !== undefined;

    if (haveCapabilities !== undefined) {
      for (const needed of goal.dependencies.requiredCapabilities) {
        if (!haveCapabilities.includes(needed)) missingDependencies.push(`capability:${needed}`);
      }
    }
    if (knownWorldFacts !== undefined) {
      for (const needed of goal.dependencies.requiredWorldModel) {
        if (!knownWorldFacts.includes(needed)) missingDependencies.push(`world:${needed}`);
      }
    }
    if (activeCapabilities !== undefined) {
      for (const forbidden of goal.dependencies.blockedIfCapabilities) {
        if (activeCapabilities.includes(forbidden)) blockedByCapabilities.push(forbidden);
      }
    }

    return { missingDependencies, blockedByCapabilities, dependenciesChecked: checked };
  }

  /**
   * When an ineligible goal might next be eligible, if that is knowable.
   *
   * `undefined` rather than a guess when it is not: budget resets at midnight,
   * a schedule reopens at `startTime`, and a missing capability reopens when
   * something outside this class fixes it — which no clock here can predict.
   */
  private nextAvailableAt(goal: Goal, now: number, outsideSchedule: boolean): number | undefined {
    if (outsideSchedule) {
      const start = goal.schedule.startTime === undefined ? undefined : parseHhMm(goal.schedule.startTime);
      if (start === undefined) return undefined;
      const next = new Date(now);
      next.setHours(Math.floor(start / 60), start % 60, 0, 0);
      if (next.getTime() <= now) next.setDate(next.getDate() + 1);
      return next.getTime();
    }
    // Budget: the next local midnight, when `spendToDate` starts over.
    const midnight = new Date(startOfLocalDay(now));
    midnight.setDate(midnight.getDate() + 1);
    return midnight.getTime();
  }

  /** Whether the local hour falls inside the quiet window (may wrap midnight). */
  private isQuietHour(now: number, currentHour?: number): boolean {
    const hour = currentHour ?? new Date(now).getHours();
    const { startHour, endHour } = this.quietHours;
    return startHour <= endHour
      ? hour >= startHour && hour < endHour
      : hour >= startHour || hour < endHour;
  }

  /** The next instant quiet hours end — a real time, not "later". */
  private nextQuietHoursEnd(now: number): number {
    const end = new Date(now);
    end.setHours(this.quietHours.endHour, 0, 0, 0);
    if (end.getTime() <= now) end.setDate(end.getDate() + 1);
    return end.getTime();
  }
}

// ── Call-site shapes ─────────────────────────────────────────────────────────

/**
 * What the caller knows that this class cannot read for itself.
 *
 * Every field is optional and every absence is reported rather than assumed —
 * see `checkEligibility`.
 */
export interface EligibilityContext {
  now?: number;
  /** What this run would cost, when the candidate knows. */
  estimatedRuntimeMs?: number;
  /** Capability ids that are healthy right now (from the health registry). */
  availableCapabilities?: readonly string[];
  /** Capability ids in use right now — `blockedIfCapabilities` is checked against these. */
  activeCapabilities?: readonly string[];
  /** World-model facts that are currently known (`'weather'`, `'calendar'`). */
  knownWorldFacts?: readonly string[];
}

/** Why a notification is being considered. */
export interface NotificationEvent {
  kind: 'starting' | 'completed' | 'blocked' | 'failed';
}

export interface UsefulNextActionContext extends EligibilityContext {
  identityId?: string;
  user?: UserContext;
  /** Overrides the source given at construction, for one call. */
  candidates?: GoalCandidateSource;
}

// ── Row hydration ────────────────────────────────────────────────────────────

interface GoalRow {
  id: string;
  identity_id: string;
  title: string;
  description: string;
  scope_json: string;
  schedule_json: string;
  limits_json: string;
  dependencies_json: string;
  status: string;
  priority: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  last_evaluated_at: number | null;
  metadata_json: string;
}

interface GoalOutcomeRow {
  id: string;
  goal_id: string;
  identity_id: string;
  action_taken: string;
  tool_used: string | null;
  sources_consulted_json: string;
  summary: string;
  verified: number;
  verified_at: number | null;
  provenance_json: string;
  started_at: number;
  completed_at: number;
  runtime_ms: number;
  tokens_used: number;
  cost_microsats: number;
  success: number;
  error_message: string | null;
  blockers_encountered_json: string;
  created_at: number;
  updated_at: number;
}

function hydrateGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    identityId: row.identity_id,
    title: row.title,
    description: row.description,
    scope: JSON.parse(row.scope_json) as Goal['scope'],
    schedule: JSON.parse(row.schedule_json) as Goal['schedule'],
    limits: JSON.parse(row.limits_json) as Goal['limits'],
    dependencies: JSON.parse(row.dependencies_json) as Goal['dependencies'],
    status: row.status as Goal['status'],
    priority: row.priority,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.last_evaluated_at === null ? {} : { lastEvaluatedAt: row.last_evaluated_at }),
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}

function hydrateOutcome(row: GoalOutcomeRow): GoalOutcome {
  return {
    id: row.id,
    goalId: row.goal_id,
    identityId: row.identity_id,
    actionTaken: row.action_taken,
    ...(row.tool_used === null ? {} : { toolUsed: row.tool_used }),
    sourcesConsulted: JSON.parse(row.sources_consulted_json) as string[],
    summary: row.summary,
    verified: row.verified === 1,
    ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
    provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    runtimeMs: row.runtime_ms,
    tokensUsed: row.tokens_used,
    costMicrosats: row.cost_microsats,
    success: row.success === 1,
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    blockersEncountered: JSON.parse(row.blockers_encountered_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Small pure helpers ───────────────────────────────────────────────────────

function ineligible(reason: string): EligibilityResult {
  return {
    eligible: false,
    reason,
    missingDependencies: [],
    blockedByCapabilities: [],
    dependenciesChecked: false,
    outsideSchedule: false,
    budgetExceeded: false,
    runtimeExceeded: false,
    spend: { since: 0, runtimeMs: 0, tokens: 0, costMicrosats: 0, runs: 0 },
  };
}

/**
 * Whether one value is covered by a scope list.
 *
 * `'*'` covers everything; `'rss:*'` covers `'rss:techcrunch'`. An empty list
 * covers nothing, which is what makes an un-widened scope a refusal.
 */
function matchesAny(value: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === value) return true;
    if (pattern.endsWith(':*') && value.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

function describeBudgetExceeded(goal: Goal, spend: SpendToDate): string {
  if (spend.runtimeMs >= goal.limits.maxDailyRuntimeMs) {
    return `Daily runtime budget spent (${spend.runtimeMs}ms of ${goal.limits.maxDailyRuntimeMs}ms)`;
  }
  if (spend.tokens >= goal.limits.modelBudget.maxTokensPerDay) {
    return `Daily token budget spent (${spend.tokens} of ${goal.limits.modelBudget.maxTokensPerDay})`;
  }
  return (
    `Daily cost budget spent (${spend.costMicrosats} of ` +
    `${goal.limits.modelBudget.maxCostPerDayMicrosats} microsats)`
  );
}

/** Why this candidate won, in words the owner can check against the numbers. */
function describeSelection(
  goal: Goal,
  candidate: UsefulWorkCandidate,
  scores: SelectionScores,
): string {
  const parts: string[] = [`serves "${goal.title}"`];
  if (scores.urgency > 0.7) parts.push('time-sensitive');
  if (scores.ownerPriority > 0.7) parts.push('high-priority goal');
  if (scores.expectedBenefit > 0.7) parts.push('high expected benefit');
  if (candidate.blockers.length > 0) {
    parts.push(`blocked by: ${candidate.blockers.join(', ')}`);
  } else {
    parts.push('no blockers');
  }
  return parts.join(', ');
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** `'08:30'` as minutes past midnight, or `undefined` if it is not a time. */
function parseHhMm(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

function startOfLocalDay(now: number): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Goal shapes the owner is likely to want, as starting points.
 *
 * Templates and not registrations: they carry no id and no identity, because a
 * standing goal is something the owner approved for himself and a template
 * nobody approved must not be able to run. `registerGoal` is the approval.
 */
export function createGoalTemplates(): Omit<Goal, 'id' | 'identityId' | 'createdAt' | 'updatedAt'>[] {
  return [
    {
      title: 'Prepare morning brief',
      description: 'Read the feeds, check the calendar, and have the day summarised before he asks',
      scope: {
        allowedSources: ['rss:*', 'api:news', 'api:calendar'],
        allowedActions: ['read', 'summarize', 'notify'],
        allowedTools: ['web_search', 'remember_fact', 'recall_facts'],
        allowedTopics: ['technology', 'productivity', 'news'],
        blockedSources: [],
        blockedActions: ['purchase', 'delete'],
        blockedTools: [],
        blockedTopics: [],
      },
      schedule: {
        timezone: 'Asia/Kolkata',
        cron: '0 8 * * 1-5',
        startTime: '06:00',
        endTime: '10:00',
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      limits: {
        maxRuntimeMs: 300_000,
        maxDailyRuntimeMs: 1_800_000,
        modelBudget: { maxTokensPerDay: 20_000, maxCostPerDayMicrosats: 100_000 },
      },
      dependencies: {
        requiredCapabilities: ['web_search'],
        requiredPeople: [],
        requiredWorldModel: [],
        blockedIfCapabilities: [],
      },
      status: 'active',
      priority: 0.7,
      metadata: {},
    },
    {
      title: 'Keep her own house in order',
      description:
        'Watch component health, reconcile expired leases, and raise anything a probe cannot fix',
      scope: {
        allowedSources: ['internal:health', 'internal:tasks'],
        allowedActions: ['read', 'reconcile', 'notify'],
        allowedTools: [],
        allowedTopics: ['maintenance'],
        blockedSources: [],
        blockedActions: ['purchase', 'delete'],
        blockedTools: [],
        blockedTopics: [],
      },
      schedule: {
        timezone: 'Asia/Kolkata',
        cron: '0 */2 * * *',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
      limits: {
        maxRuntimeMs: 120_000,
        maxDailyRuntimeMs: 900_000,
        modelBudget: { maxTokensPerDay: 4_000, maxCostPerDayMicrosats: 20_000 },
      },
      dependencies: {
        requiredCapabilities: [],
        requiredPeople: [],
        requiredWorldModel: [],
        blockedIfCapabilities: [],
      },
      status: 'active',
      priority: 0.5,
      metadata: {},
    },
    {
      title: 'Keep his open threads moving',
      description:
        'Notice the things he left open that have stopped moving, and work out what each needs next',
      scope: {
        allowedSources: ['internal:loops'],
        allowedActions: ['read', 'summarize', 'notify'],
        allowedTools: ['recall_facts'],
        allowedTopics: ['open-threads'],
        blockedSources: [],
        blockedActions: ['purchase', 'delete'],
        blockedTools: [],
        blockedTopics: [],
      },
      schedule: {
        timezone: 'Asia/Kolkata',
        cron: '0 9,18 * * *',
        // Bounded to waking hours: the work is cheap, but its whole point is to
        // hand him something, and there is no version of that he wants at 4am.
        startTime: '08:00',
        endTime: '21:00',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
      limits: {
        maxRuntimeMs: 180_000,
        maxDailyRuntimeMs: 600_000,
        modelBudget: { maxTokensPerDay: 8_000, maxCostPerDayMicrosats: 40_000 },
      },
      dependencies: {
        requiredCapabilities: [],
        requiredPeople: [],
        requiredWorldModel: [],
        blockedIfCapabilities: ['voice_input'],
      },
      status: 'active',
      priority: 0.55,
      metadata: {},
    },
  ];
}
