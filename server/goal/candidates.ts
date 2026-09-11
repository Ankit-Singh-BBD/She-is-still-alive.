/**
 * B10.s3: where useful work actually comes from.
 *
 * `GoalManager` decides whether a candidate is permitted, affordable and worth
 * starting. It deliberately cannot invent one. This file is the other half: it
 * turns rows that already exist — open loops, health observations, exhausted
 * recovery attempts — into candidates, and hands them to the manager to judge.
 *
 * ## Why this is not part of the manager
 *
 * Because the manager's refusal to invent work is only meaningful if the
 * inventing happens somewhere it can be audited. A `generatePotentialActions()`
 * private method would have been the same file deciding both what could be done
 * and whether it was allowed, and the first placeholder anyone added to it would
 * have made every active goal permanently "ready" with nothing behind it.
 *
 * ## Every candidate here cites a row
 *
 * A stalled loop candidate names the loop and how long it has been quiet. A
 * health candidate names the component, its status and when it was last checked.
 * If the reader cannot follow a candidate back to a row, it should not be here.
 *
 * ## Scope, not topic-matching, decides who may do the work
 *
 * Each candidate declares what it would touch (`source`, `action`, `topic`) and
 * `GoalManager.permits` checks that against the goal the owner approved. So a
 * goal scoped to `internal:health` never picks up work on his open threads, and
 * nothing here has to know which goals exist.
 */

import type { LoopManager } from '@server/loops/manager.js';
import type { HealthRegistry } from '@server/health/registry.js';
import type { RecoveryManager } from '@server/health/recovery.js';

import type { GoalCandidateSource, UsefulWorkCandidate } from './types.js';

/** How long an open loop may go without progress before advancing it is useful. */
export const DEFAULT_LOOP_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

/**
 * Rough costs, and honestly named.
 *
 * These are what the *estimate* fields are for: the manager compares them
 * against a per-run cap and what is left of today's budget, so being wrong here
 * costs a refusal or an overrun, not a false claim. The real spend is whatever
 * `recordOutcome` writes after the fact.
 */
const ESTIMATES = {
  advanceLoop: { runtimeMs: 90_000, tokens: 1_500, costMicrosats: 3_000 },
  investigateHealth: { runtimeMs: 60_000, tokens: 800, costMicrosats: 1_500 },
} as const;

export interface CandidateSourceDeps {
  readonly loops: LoopManager;
  readonly healthRegistry: HealthRegistry;
  /**
   * Optional. When present, a component whose automatic recovery has already
   * been tried and failed carries that as a blocker — which is what turns a
   * routine maintenance action into something worth telling the owner.
   */
  readonly recovery?: RecoveryManager;
  readonly loopStaleAfterMs?: number;
}

/**
 * A candidate source over real rows.
 *
 * Returns `[]` rather than throwing when a reader fails, for the same reason
 * `Noticing.sweep` collects errors: one broken reader is a gap in what she can
 * propose, not a reason for the whole initiative path to go dark. The failure is
 * still visible — the manager records no outcome and the sensor reports nothing.
 */
export function createCandidateSource(deps: CandidateSourceDeps): GoalCandidateSource {
  const staleAfterMs = deps.loopStaleAfterMs ?? DEFAULT_LOOP_STALE_AFTER_MS;

  return (goal) => {
    const now = Date.now();
    const candidates: UsefulWorkCandidate[] = [];

    // ── Open loops that have gone quiet ──
    //
    // `Noticing`'s `loop.stalled` sensor *tells* him a thread has stopped. This
    // is the other response to the same row: she works out where it stands and
    // what is needed next. Both are legitimate and they are not duplicates —
    // one is a report, one is work.
    try {
      for (const loop of deps.loops.getActiveLoops(goal.identityId)) {
        const quietFor = now - loop.lastProgressAt;
        if (quietFor < staleAfterMs) continue;

        const hours = Math.round(quietFor / 3_600_000);
        candidates.push({
          goalId: goal.id,
          actionDescription:
            `Work out where "${describeLoop(loop.summary, loop.topic)}" stands and what it needs ` +
            `next — no progress in ${hours} hour${hours === 1 ? '' : 's'}`,
          estimatedRuntimeMs: ESTIMATES.advanceLoop.runtimeMs,
          estimatedTokens: ESTIMATES.advanceLoop.tokens,
          estimatedCostMicrosats: ESTIMATES.advanceLoop.costMicrosats,
          scope: { source: 'internal:loops', action: 'summarize', topic: 'open-threads' },
          // Staleness is the deadline: a thread quiet for a day is more urgent
          // than one quiet for half of one, and neither reaches the ceiling.
          urgency: quietFor >= 24 * 60 * 60 * 1000 ? 0.7 : quietFor >= staleAfterMs * 1.5 ? 0.6 : 0.45,
          expectedBenefit: 0.6,
          blockers: [],
          metadata: { loopId: loop.id, topic: loop.topic, quietForMs: quietFor },
        });
      }
    } catch {
      // A loop reader that fails proposes nothing. See the header.
    }

    // ── Components that are not well ──
    try {
      for (const obs of deps.healthRegistry.getAllObservations()) {
        if (obs.status !== 'degraded' && obs.status !== 'unavailable') continue;

        // A component whose bounded recovery has already been spent is not
        // something she can fix on her own — that is a blocker, and blockers are
        // notifiable at any priority.
        const blockers = recoveryExhausted(deps.recovery, obs.componentId)
          ? ['automatic recovery has already been tried and did not restore it']
          : [];

        const affected = obs.affectedCapabilities ?? [];
        candidates.push({
          goalId: goal.id,
          actionDescription:
            `Look into why ${obs.componentId} is ${obs.status}` +
            (affected.length > 0 ? ` — it affects ${affected.join(', ')}` : ''),
          estimatedRuntimeMs: ESTIMATES.investigateHealth.runtimeMs,
          estimatedTokens: ESTIMATES.investigateHealth.tokens,
          estimatedCostMicrosats: ESTIMATES.investigateHealth.costMicrosats,
          scope: { source: 'internal:health', action: 'reconcile', topic: 'maintenance' },
          urgency: obs.status === 'unavailable' ? 0.7 : 0.5,
          // Work on something more capabilities depend on is worth more.
          expectedBenefit: affected.length > 1 ? 0.75 : 0.6,
          blockers,
          metadata: {
            componentId: obs.componentId,
            status: obs.status,
            checkedAt: obs.checkedAt,
            affectedCapabilities: affected,
          },
        });
      }
    } catch {
      // A health reader that fails proposes nothing. See the header.
    }

    return candidates;
  };
}

/**
 * Whether bounded recovery for a component has been spent.
 *
 * `false` when there is no recovery manager wired, which is the honest answer:
 * nothing was tried, so nothing was exhausted. Reporting `true` there would put
 * a blocker on the candidate that no attempt stands behind.
 */
function recoveryExhausted(recovery: RecoveryManager | undefined, componentId: string): boolean {
  if (recovery === undefined) return false;
  try {
    const attempts = recovery.getRecentAttempts(componentId, undefined, 5);
    return attempts.length > 0 && attempts.every((attempt) => !attempt.success);
  } catch {
    return false;
  }
}

/** A loop in plain words, preferring its own summary over its topic slug. */
function describeLoop(summary: string | undefined | null, topic: string): string {
  const trimmed = summary?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : topic;
}
