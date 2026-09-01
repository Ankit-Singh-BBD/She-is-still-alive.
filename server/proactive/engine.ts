/**
 * P17 — Proactive Engine
 *
 * Implements Build Book Part XIV: Proactive Engine & Decision Tree
 *
 * The engine wraps the deterministic decision tree with:
 * - Per-identity, per-topic rate limiting backed by the proactive_decision table
 * - Persistence of every evaluation to `proactive_decision` for auditability
 * - Domain event emission: `proactive.decision`, `proactive.delivered`, `proactive.suppressed`
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
   * Check whether the given (identity, topic) pair is currently rate-limited.
   */
  isRateLimited(identityId: string, topic: string): boolean {
    const windowMs = this.options.topicRateLimitMs;
    const sinceIso = new Date(Date.now() - windowMs).toISOString();
    const row = this.db.raw
      .prepare(
        `SELECT created_at FROM proactive_decision
         WHERE identity_id = ? AND decision LIKE ?
           AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(identityId, `%"topic":"${topic}"%`, sinceIso) as { created_at: string } | undefined;
    return Boolean(row);
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

    this.db.raw
      .prepare(
        `INSERT INTO proactive_decision (
          id, identity_id, decision, urgency, novelty, interruption_cost, acted_at, reason_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          decision = excluded.decision,
          urgency = excluded.urgency,
          novelty = excluded.novelty,
          interruption_cost = excluded.interruption_cost,
          reason_json = excluded.reason_json`,
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

    if (outcome.action === 'emit') {
      await this.eventBus.publish({
        type: 'proactive.decision',
        payload: {
          decisionId,
          topic: candidate.topic,
          identityId: candidate.identityId,
          action: outcome.action,
          reason: outcome.reason,
          decision: outcome.decision,
        },
        identityId: candidate.identityId,
        cycleId: undefined,
        timestamp: outcome.evaluatedAt,
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      });
    } else if (outcome.action === 'suppress' || outcome.action === 'defer') {
      await this.eventBus.publish({
        type: 'proactive.suppressed',
        payload: {
          decisionId,
          topic: candidate.topic,
          identityId: candidate.identityId,
          action: outcome.action,
          reason: outcome.reason,
        },
        identityId: candidate.identityId,
        cycleId: undefined,
        timestamp: outcome.evaluatedAt,
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      });
    }
    // 'reject' is silent — internal authorization failure, not a proactive attempt.
  }
}
