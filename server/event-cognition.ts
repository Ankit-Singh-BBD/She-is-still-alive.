// ===================================================================
// EVENT-DRIVEN COGNITION (Requirement #27: Event-Driven Cognition)
// ===================================================================
//
// Subscribes to the event bus and decides whether to trigger cognition
// for each event. This is where event-driven cognition lives in code.
//
// Decision is currently rule-based for performance and reliability,
// but each decision is recorded. The decision feeds into the awareness
// engine which combines events with other signals (open loops, recent
// tasks, memories, world state) to decide whether to speak, act,
// ask, or remain silent.

import { eventBus, drainUnprocessedEvents, type EventHandler } from './event-system.js';
import type { SystemEvent } from './db.js';
import { db } from './db.js';

// ===================================================================
// EVENT-DRIVEN COGNITION CONFIGURATION
// ===================================================================

/**
 * Minimum importance score that triggers cognition.
 * Events below this are recorded but not cognitively processed.
 */
const IMPORTANCE_THRESHOLD = 40;

/**
 * Event types that always require cognition regardless of importance.
 */
const ALWAYS_COGNIZE: ReadonlySet<string> = new Set([
  'user_arrival',
  'reconnection',
  'correction',
  'commitment_made',
  'task_due',
  'loop_resolved',
]);

/**
 * Event types that should be aggregated (e.g. memory_created) before cognition.
 */
const LOW_PRIORITY_AGGREGATE: ReadonlySet<string> = new Set([
  'memory_created',
  'memory_superseded',
  'relationship_inferred',
]);

// ===================================================================
// EVENT-DRIVEN COGNITION ENGINE
// ===================================================================

export interface CognitionDecision {
  shouldProcess: boolean;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  aggregatedCount?: number;
}

class EventCognitionEngine {
  private recentDecisions: Array<{ eventId: string; decision: CognitionDecision; at: string }> = [];
  private lowPriorityBuffer: SystemEvent[] = [];

  constructor() {
    this.subscribe();
  }

  /**
   * Subscribe to the event bus and decide on every event.
   */
  private subscribe(): void {
    eventBus.on('*', (event: SystemEvent) => {
      const decision = this.decide(event);
      this.recordDecision(event, decision);
    });

    // Also subscribe to specific high-priority types so they always run cognition
    for (const type of ALWAYS_COGNIZE) {
      eventBus.on(type, (event: SystemEvent) => {
        const decision = this.decide(event);
        this.recordDecision(event, decision);
      });
    }
  }

  /**
   * Decide whether to cognitively process an event.
   */
  decide(event: SystemEvent): CognitionDecision {
    // Always-cognize types
    if (ALWAYS_COGNIZE.has(event.eventType)) {
      return {
        shouldProcess: true,
        reason: `Event type '${event.eventType}' requires cognition`,
        priority: event.importance >= 70 ? 'high' : 'medium',
      };
    }

    // Aggregate low-priority events
    if (LOW_PRIORITY_AGGREGATE.has(event.eventType)) {
      this.lowPriorityBuffer.push(event);
      // Flush every 5 aggregated events
      if (this.lowPriorityBuffer.length >= 5) {
        const count = this.lowPriorityBuffer.length;
        this.lowPriorityBuffer = [];
        return {
          shouldProcess: true,
          reason: `Aggregated ${count} low-priority events for batch cognition`,
          priority: 'low',
          aggregatedCount: count,
        };
      }
      return {
        shouldProcess: false,
        reason: 'Buffered for aggregation',
        priority: 'low',
      };
    }

    // Importance-based decision
    if (event.importance >= IMPORTANCE_THRESHOLD) {
      return {
        shouldProcess: true,
        reason: `Importance ${event.importance} >= threshold ${IMPORTANCE_THRESHOLD}`,
        priority: event.importance >= 70 ? 'high' : 'medium',
      };
    }

    return {
      shouldProcess: false,
      reason: `Importance ${event.importance} below threshold`,
      priority: 'low',
    };
  }

  /**
   * Record the decision for observability and self-evaluation.
   */
  private recordDecision(event: SystemEvent, decision: CognitionDecision): void {
    this.recentDecisions.push({
      eventId: event.eventId,
      decision,
      at: new Date().toISOString(),
    });
    if (this.recentDecisions.length > 200) {
      this.recentDecisions = this.recentDecisions.slice(-200);
    }
  }

  /**
   * Get recent decisions for debugging and self-evaluation.
   */
  getRecentDecisions(limit: number = 50): typeof this.recentDecisions {
    return this.recentDecisions.slice(-limit);
  }

  /**
   * Mark an event as cognitively processed.
   */
  markProcessed(event: SystemEvent, triggeredActions: string[]): void {
    db.markSystemEventProcessed(event.eventId, true, triggeredActions);
  }
}

export const eventCognition = new EventCognitionEngine();

// ===================================================================
// STARTUP: DRAIN UNPROCESSED EVENTS
// ===================================================================

/**
 * On startup, drain any events recorded but not cognitively processed
 * (e.g. events that occurred during downtime).
 */
export async function startEventCognitionDrain(): Promise<void> {
  const handler: EventHandler = async (event) => {
    const decision = eventCognition.decide(event);
    if (decision.shouldProcess) {
      console.log(`[EVENT-COGNITION] Drained ${event.eventType} (${event.eventId}): ${decision.reason}`);
      // Real handler will be wired in by the awareness engine.
      // For now, this proves the drain path works.
      eventCognition.markProcessed(event, ['drained']);
    } else {
      db.markSystemEventProcessed(event.eventId, false, []);
    }
  };

  await drainUnprocessedEvents(handler);
}
