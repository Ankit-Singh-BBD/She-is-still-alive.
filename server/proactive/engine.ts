/**
 * P17 — Proactive Engine
 *
 * Implements Build Book Part XIV: Proactive Engine & Decision Tree
 *
 * The engine wraps the deterministic decision tree with:
 * - Per-identity, per-topic rate limiting backed by the proactive_decision table
 * - Persistence of every evaluation to `proactive_decision` for auditability
 * - A durable deferral queue: a candidate the tree defers is re-evaluated when
 *   its window opens, rather than being announced as suppressed and forgotten
 * - Domain event emission: `proactive.decision`, `proactive.delivered`,
 *   `proactive.deferred`, `proactive.suppressed`
 * - Identity lookup via the optional IdentityRepository
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import type {
  ProactiveCandidate,
  ProactiveDecisionOutcome,
  ProactiveEngineOptions,
  ProactiveProposalFn,
  UserContext,
} from './types.js';
import { DEFAULT_PROACTIVE_OPTIONS } from './types.js';
import { ProactiveDecisionTree } from './decision-tree.js';

export interface ProactiveEngineDeps {
  db: Database;
  eventBus?: EventBus;
  identityRepo?: IdentityRepository;
  options?: ProactiveEngineOptions;
}

export interface ProactiveEvaluationResult {
  candidate: ProactiveCandidate;
  outcome: ProactiveDecisionOutcome;
  decisionId: string;
}

export class ProactiveEngine {
  private readonly db: Database;
  private readonly eventBus: EventBus | undefined;
  private readonly identityRepo: IdentityRepository | undefined;
  private readonly tree: ProactiveDecisionTree;
  private readonly options: Required<ProactiveEngineOptions>;
  private readonly emitEvents: boolean;

  constructor(deps: ProactiveEngineDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.identityRepo = deps.identityRepo;
    this.options = { ...DEFAULT_PROACTIVE_OPTIONS, ...(deps.options ?? {}) };
    this.tree = new ProactiveDecisionTree(this.options);
    this.emitEvents = Boolean(this.eventBus);
  }

  /**
   * Evaluate a single proactive candidate.
   */
  evaluate(
    candidate: ProactiveCandidate,
    userContext?: UserContext,
  ): ProactiveEvaluationResult {
    const identity = this.resolveIdentity(candidate.identityId);
    const outcome = this.tree.evaluate(
      candidate,
      identity,
      (identityId, topic) => this.isRateLimited(identityId, topic),
      userContext,
    );
    const decisionId = this.persistDecision(candidate, outcome);

    void this.dispatchDecisionEvent(decisionId, candidate, outcome);

    return { candidate, outcome, decisionId };
  }

  /**
   * Propose candidates via the supplied async proposer, then evaluate each one.
   * Returns only the candidates that the decision tree authorized for emission.
   */
  async runCycle(
    proposer: ProactiveProposalFn,
    userContext?: UserContext,
  ): Promise<ProactiveEvaluationResult[]> {
    const candidates = await proposer();
    const results: ProactiveEvaluationResult[] = [];
    for (const candidate of candidates) {
      const result = this.evaluate(candidate, userContext);
      results.push(result);
    }
    return results;
  }

  /**
   * Mark a previously-emitted proactive decision as delivered.
   */
  async markDelivered(decisionId: string, deliveryChannel?: string): Promise<void> {
    this.db.raw
      .prepare(`UPDATE proactive_decision SET acted_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), decisionId);

    if (this.emitEvents && this.eventBus) {
      await this.eventBus.publish({
        type: 'proactive.delivered',
        payload: { decisionId, deliveryChannel },
        identityId: undefined,
        cycleId: undefined,
        timestamp: Date.now(),
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      });
    }
  }

  /**
   * Re-evaluates every deferral whose window has opened.
   *
   * This is the other half of `defer`. Without it the tree's third and sixth
   * gates were suppressions with a softer name: a candidate held back for quiet
   * hours was persisted, announced, and never looked at again.
   *
   * Re-evaluation runs the *whole* tree, not just the gate that deferred. A
   * candidate may have waited nine hours; in that time the recipient's
   * permission could have been revoked, proactivity could have been switched
   * off, or the topic could have been disabled — and a queue that replayed the
   * old verdict would deliver a message the application would refuse today.
   *
   * Returns one result per candidate it actually claimed, in due order.
   */
  async processDeferred(
    userContext?: UserContext,
    now: number = Date.now(),
  ): Promise<ProactiveEvaluationResult[]> {
    const due = this.db.raw
      .prepare(
        `SELECT id, candidate_json, defer_count FROM proactive_decision
          WHERE deferred_until IS NOT NULL AND deferred_until <= ?
          ORDER BY deferred_until ASC`,
      )
      .all(new Date(now).toISOString()) as {
      id: string;
      candidate_json: string | null;
      defer_count: number;
    }[];

    const results: ProactiveEvaluationResult[] = [];

    for (const row of due) {
      // Clearing `deferred_until` *is* the claim: it is the same conditional
      // update the task executor uses, and it means a second sweep running
      // concurrently finds nothing to do rather than emitting this candidate
      // twice.
      const claim = this.db.raw
        .prepare(
          `UPDATE proactive_decision SET deferred_until = NULL
            WHERE id = ? AND deferred_until IS NOT NULL`,
        )
        .run(row.id);
      if (claim.changes === 0) continue;

      const candidate = this.parseCandidate(row.id, row.candidate_json, row.defer_count);
      if (!candidate) {
        // A deferral we cannot reconstruct cannot be re-evaluated. Record that
        // plainly instead of leaving the row claiming to be pending forever.
        this.db.raw
          .prepare(
            `UPDATE proactive_decision
                SET action = 'suppress', evaluated_at = ?, reason_json = ?
              WHERE id = ?`,
          )
          .run(
            new Date(now).toISOString(),
            JSON.stringify({
              reason: 'Deferred candidate could not be reconstructed for re-evaluation',
              action: 'suppress',
              evaluatedAt: now,
            }),
            row.id,
          );
        continue;
      }

      results.push(this.evaluate(candidate, userContext));
    }

    return results;
  }

  /** Deferrals still waiting, soonest first. Diagnostics and tests. */
  pendingDeferrals(): { decisionId: string; deferredUntil: number; deferCount: number }[] {
    const rows = this.db.raw
      .prepare(
        `SELECT id, deferred_until, defer_count FROM proactive_decision
          WHERE deferred_until IS NOT NULL ORDER BY deferred_until ASC`,
      )
      .all() as { id: string; deferred_until: string; defer_count: number }[];

    return rows.map((r) => ({
      decisionId: r.id,
      deferredUntil: new Date(r.deferred_until).getTime(),
      deferCount: r.defer_count,
    }));
  }

  /**
   * Check whether the given (identity, topic) pair is currently rate-limited.
   *
   * Only emitted decisions count. The limit exists so the same topic is not
   * *raised* twice in a window, and a suppressed or deferred decision was never
   * raised — counting those made the engine rate-limit itself, so a candidate
   * that deferred at 23:00 came back at 07:00 and was refused as a repeat of the
   * attempt that had never happened. Rows written before `action` existed read
   * as unknown, and unknown is not emitted.
   */
  isRateLimited(identityId: string, topic: string): boolean {
    const windowMs = this.options.topicRateLimitMs;
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const row = this.db.raw
      .prepare(
        `SELECT id FROM proactive_decision
         WHERE identity_id = ? AND decision LIKE ?
           AND action = 'emit'
           AND COALESCE(evaluated_at, created_at) >= ?
         ORDER BY COALESCE(evaluated_at, created_at) DESC LIMIT 1`,
      )
      .get(identityId, `%"topic":"${topic}"%`, sinceIso) as { id: string } | undefined;
    return Boolean(row);
  }

  private parseCandidate(
    id: string,
    candidateJson: string | null,
    deferCount: number,
  ): ProactiveCandidate | null {
    if (!candidateJson) return null;
    try {
      const parsed = JSON.parse(candidateJson) as ProactiveCandidate;
      if (!parsed.identityId || !parsed.topic || !parsed.decision) return null;
      return { ...parsed, id, deferCount };
    } catch {
      return null;
    }
  }

  private resolveIdentity(identityId: string): Identity | undefined {
    if (!this.identityRepo) return undefined;
    return this.identityRepo.getIdentity(identityId) ?? undefined;
  }

  private persistDecision(
    candidate: ProactiveCandidate,
    outcome: ProactiveDecisionOutcome,
  ): string {
    const id = candidate.id ?? ulid();
    const decisionJson = this.serializeDecision(candidate);
    const reasonJson = JSON.stringify({
      reason: outcome.reason,
      action: outcome.action,
      evaluatedAt: outcome.evaluatedAt,
    });
    const nowIso = new Date().toISOString();
    const evaluatedAtIso = new Date(outcome.evaluatedAt).toISOString();

    // A deferral that resolves keeps its row: same id, new verdict, and
    // `deferred_until` back to NULL so the sweep stops seeing it. The durable
    // history of how it got there is the domain event stream, not this row.
    const priorDeferCount = candidate.deferCount ?? 0;
    const deferCount = outcome.action === 'defer' ? priorDeferCount + 1 : priorDeferCount;
    const deferredUntil =
      outcome.action === 'defer' && outcome.deferUntil !== undefined
        ? new Date(outcome.deferUntil).toISOString()
        : null;

    this.db.raw
      .prepare(
        `INSERT INTO proactive_decision (
          id, identity_id, decision, urgency, novelty, interruption_cost, acted_at, reason_json, created_at,
          action, evaluated_at, deferred_until, defer_count, candidate_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          decision = excluded.decision,
          urgency = excluded.urgency,
          novelty = excluded.novelty,
          interruption_cost = excluded.interruption_cost,
          reason_json = excluded.reason_json,
          action = excluded.action,
          evaluated_at = excluded.evaluated_at,
          deferred_until = excluded.deferred_until,
          defer_count = excluded.defer_count,
          candidate_json = excluded.candidate_json`,
      )
      .run(
        id,
        candidate.identityId,
        decisionJson,
        outcome.urgency,
        outcome.novelty,
        outcome.interruptionCost,
        null,
        reasonJson,
        nowIso,
        outcome.action,
        evaluatedAtIso,
        deferredUntil,
        deferCount,
        JSON.stringify({ ...candidate, id, deferCount }),
      );

    return id;
  }

  private serializeDecision(candidate: ProactiveCandidate): string {
    // Embed topic into a parseable JSON envelope so the rate-limit LIKE query
    // can find recent decisions per (identity, topic).
    return JSON.stringify({ topic: candidate.topic, decision: candidate.decision });
  }

  private async dispatchDecisionEvent(
    decisionId: string,
    candidate: ProactiveCandidate,
    outcome: ProactiveDecisionOutcome,
  ): Promise<void> {
    if (!this.emitEvents || !this.eventBus) return;

    const base = {
      identityId: candidate.identityId,
      cycleId: undefined,
      timestamp: outcome.evaluatedAt,
      causationId: undefined,
      correlationId: undefined,
      version: 1,
    };

    if (outcome.action === 'emit') {
      await this.eventBus.publish({
        ...base,
        type: 'proactive.decision',
        payload: {
          decisionId,
          topic: candidate.topic,
          identityId: candidate.identityId,
          action: outcome.action,
          reason: outcome.reason,
          decision: outcome.decision,
        },
      });
    } else if (outcome.action === 'defer') {
      // `proactive.deferred` was declared in the event union and never
      // published: a deferral went out as `proactive.suppressed`, so nothing
      // downstream could tell "not now, at 07:00" from "no". They are different
      // facts and the payload now carries the difference.
      await this.eventBus.publish({
        ...base,
        type: 'proactive.deferred',
        payload: {
          decisionId,
          topic: candidate.topic,
          identityId: candidate.identityId,
          action: outcome.action,
          reason: outcome.reason,
          deferUntil: outcome.deferUntil,
          deferCount: (candidate.deferCount ?? 0) + 1,
        },
      });
    } else if (outcome.action === 'suppress') {
      await this.eventBus.publish({
        ...base,
        type: 'proactive.suppressed',
        payload: {
          decisionId,
          topic: candidate.topic,
          identityId: candidate.identityId,
          action: outcome.action,
          reason: outcome.reason,
        },
      });
    }
    // 'reject' is silent — internal authorization failure, not a proactive attempt.
  }
}
