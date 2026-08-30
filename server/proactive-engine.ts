// ===================================================================
// PROACTIVE REASONING ENGINE (Requirement #18: Proactive Reasoning)
// ===================================================================
//
// Decides when Madhurita should initiate cognition (speak, act, ask, etc.)
// without a user prompt. Driven by:
// - Recent events (event system)
// - Awareness state (presence, world state)
// - Open loops
// - Due tasks
// - Failed operations requiring follow-up
//
// Scoring:
// importance × confidence > speakThreshold  → speak
// any(task due) AND user present             → follow up
// failed operations unrecovered             → acknowledge/act
// new arrival                                → welcome (if owner)
// long absence with open loops               → follow up

import { db } from './db.js';
import { awarenessEngine } from './awareness-engine.js';
import { cognitiveDecisionEngine } from './cognitive-decision-engine.js';
import { responseGenerator } from './response-generator.js';
import { eventCognition } from './event-cognition.js';
import { auth } from './auth.js';

export interface ProactiveOpportunity {
  trigger: string;
  reason: string;
  priority: number;
  context: any;
  decisionRequired: 'speak' | 'act' | 'ask' | 'silent' | 'follow_up' | 'acknowledge' | 'wait';
}

class ProactiveReasoningEngine {
  private tickInterval: NodeJS.Timeout | null = null;
  private lastTickAt: string | null = null;
  private recentlyActedOn: Map<string, number> = new Map();
  private readonly DEDUP_WINDOW_MS = 30 * 60 * 1000; // 30 min dedup

  start(intervalMs: number = 2 * 60_000): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = setInterval(() => {
      this.tick().catch(err => console.error('[PROACTIVE-ENGINE] tick error:', err.message));
    }, intervalMs);
    console.log(`[PROACTIVE-ENGINE] Started (interval: ${intervalMs}ms)`);
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * One reasoning tick: identify opportunities, score them, decide.
   */
  async tick(): Promise<{ opportunities: ProactiveOpportunity[]; acted: number }> {
    const snapshot = awarenessEngine.snapshot();
    const opportunities: ProactiveOpportunity[] = [];
    const now = Date.now();

    // 1. Owner arrival / reconnection → welcome
    const owner = db.getOwner();
    if (owner && snapshot.presence.totalActive > 0) {
      const ownerPresent = snapshot.presence.activeSessions.some(s => s.identityId === owner.id);
      if (ownerPresent) {
        opportunities.push({
          trigger: 'owner_present',
          reason: 'Owner is present and active',
          priority: 70,
          context: { ownerId: owner.id, name: owner.name },
          decisionRequired: 'wait', // Don't immediately speak; let user initiate
        });
      }
    }

    // 2. Tasks due now → proactive follow-up
    const dueTasks = db.getDueTasks();
    for (const task of dueTasks.slice(0, 3)) {
      const dedupKey = `task_due:${task.id}`;
      if (this.recentlyActedOn.has(dedupKey) && (now - this.recentlyActedOn.get(dedupKey)!) < this.DEDUP_WINDOW_MS) {
        continue;
      }
      opportunities.push({
        trigger: 'task_due',
        reason: `Task "${task.title}" is due${task.dueAt ? ` (at ${task.dueAt})` : ''}`,
        priority: task.priority === 'high' ? 90 : 70,
        context: { taskId: task.id, title: task.title, dueAt: task.dueAt },
        decisionRequired: 'follow_up',
      });
      this.recentlyActedOn.set(dedupKey, now);
    }

    // 3. Open loops older than 7 days → check relevance
    const openLoops = snapshot.pendingAttention.openLoops;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const loop of openLoops.slice(0, 3)) {
      const createdMs = loop.createdAtISO ? new Date(loop.createdAtISO).getTime() : 0;
      if (createdMs < sevenDaysAgo) {
        const dedupKey = `stale_loop:${loop.id}`;
        if (this.recentlyActedOn.has(dedupKey) && (now - this.recentlyActedOn.get(dedupKey)!) < this.DEDUP_WINDOW_MS) {
          continue;
        }
        opportunities.push({
          trigger: 'stale_loop',
          reason: `Open loop "${loop.name}" is over 7 days old`,
          priority: 40,
          context: { loopId: loop.id, name: loop.name, age: now - createdMs },
          decisionRequired: 'silent', // Just be aware; don't bug user
        });
        this.recentlyActedOn.set(dedupKey, now);
      }
    }

    // 4. Unrecovered failed operations → acknowledge
    const failedOps = snapshot.pendingAttention.failedOperations;
    for (const op of failedOps.slice(0, 2)) {
      const dedupKey = `failed_op:${op.operationId}`;
      if (this.recentlyActedOn.has(dedupKey) && (now - this.recentlyActedOn.get(dedupKey)!) < this.DEDUP_WINDOW_MS) {
        continue;
      }
      opportunities.push({
        trigger: 'failed_operation',
        reason: `Operation "${op.operationType}" failed: ${op.error}`,
        priority: 60,
        context: { operationId: op.operationId, type: op.operationType },
        decisionRequired: 'silent', // Record for self-improvement; don't act yet
      });
      this.recentlyActedOn.set(dedupKey, now);
    }

    // 5. Recent high-importance unprocessed events → cognition
    const unprocessed = snapshot.recentEvents.unprocessed;
    for (const evt of unprocessed.slice(0, 5)) {
      const cognitionDecision = eventCognition.decide(evt);
      if (cognitionDecision.shouldProcess && cognitionDecision.priority !== 'low') {
        opportunities.push({
          trigger: `event:${evt.eventType}`,
          reason: cognitionDecision.reason,
          priority: evt.importance,
          context: { eventId: evt.eventId, eventType: evt.eventType, payload: evt.payload },
          decisionRequired: 'act',
        });
      }
    }

    this.lastTickAt = new Date().toISOString();
    return { opportunities, acted: opportunities.length };
  }

  /**
   * Run an opportunity through the full cognitive pipeline.
   * Used for events that warrant LLM reasoning.
   */
  async actOnOpportunity(opportunity: ProactiveOpportunity): Promise<{ acted: boolean; response: string }> {
    // For now, just log the decision
    console.log(`[PROACTIVE-ENGINE] Opportunity: ${opportunity.trigger} (priority ${opportunity.priority}) → ${opportunity.decisionRequired}`);
    return { acted: false, response: '' };
  }

  getLastTickAt(): string | null {
    return this.lastTickAt;
  }
}

export const proactiveEngine = new ProactiveReasoningEngine();
