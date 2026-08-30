// ===================================================================
// EVENT SYSTEM (Requirement #27: Event-Driven Cognition)
// ===================================================================
//
// Madhurita's cognition is not triggered solely by user questions.
// She reasons about meaningful events: arrivals, departures, messages,
// task state changes, loop state changes, environmental changes,
// scheduled events, learning, corrections, memory operations, etc.
//
// This module provides:
// 1. Type-safe event emission
// 2. Subscription registry for cognition triggers
// 3. Persistence to authoritative state
// 4. Helper functions for the most common event types
//
// Events are stored in the database so that:
// - Cognition can process missed events after restart
// - Awareness is grounded in real recorded state
// - Debugging and observability is possible
// - No events are lost during transient failures

import { EventEmitter } from 'events';
import { db } from './db.js';
import type { SystemEvent } from './db.js';

// ===================================================================
// EVENT TYPES AND IMPORTANCE SCORING
// ===================================================================

export type SystemEventType = SystemEvent['eventType'];

/**
 * Default importance scoring for each event type.
 * Higher = more likely to trigger cognition.
 * Final importance is also modulated by payload signals at emit time.
 */
const DEFAULT_IMPORTANCE: Record<SystemEventType, number> = {
  user_arrival: 70,
  user_departure: 30,
  reconnection: 50,
  new_message: 60,
  task_state_change: 45,
  loop_state_change: 55,
  environment_change: 40,
  scheduled_event: 60,
  new_learning: 50,
  correction: 75,
  behavior_change: 65,
  memory_created: 30,
  memory_superseded: 25,
  task_due: 80,
  loop_resolved: 60,
  relationship_inferred: 40,
  commitment_made: 75,
};

// ===================================================================
// EVENT SUBSCRIPTION
// ===================================================================

export type EventHandler = (event: SystemEvent) => void | Promise<void>;

/**
 * Central event bus.
 * Extends Node's EventEmitter so the rest of the system can also
 * use plain `.on()` listeners when convenient.
 */
class MadhuritaEventBus extends EventEmitter {
  /**
   * Register a typed event handler. Returns an unsubscribe function.
   */
  onEvent(type: SystemEventType | '*', handler: EventHandler): () => void {
    this.on(type, handler as any);
    return () => this.off(type, handler as any);
  }

  /**
   * Emit a persisted system event.
   * All subscribers receive the event after it has been recorded.
   */
  async emitEvent(event: SystemEvent): Promise<void> {
    // Persist first (authoritative source of truth)
    db.recordSystemEvent(event);

    // Notify specific-type subscribers
    this.emit(event.eventType, event);

    // Notify wildcard subscribers
    this.emit('*', event);
  }
}

export const eventBus = new MadhuritaEventBus();

// ===================================================================
// EVENT CONSTRUCTION HELPERS
// ===================================================================

let eventCounter = 0;

function generateEventId(): string {
  eventCounter += 1;
  return `event_${Date.now()}_${eventCounter}_${Math.random().toString(36).substring(2, 7)}`;
}

function getISTDateTime(): { iso: string; ist: string } {
  const now = new Date();
  return {
    iso: now.toISOString(),
    ist: now.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
    }),
  };
}

function buildEvent(
  eventType: SystemEventType,
  identityId: string | undefined,
  payload: any,
  importanceOverride?: number
): SystemEvent {
  const { iso, ist } = getISTDateTime();
  const baseImportance = DEFAULT_IMPORTANCE[eventType] ?? 40;
  const importance = Math.max(0, Math.min(100, importanceOverride ?? baseImportance));

  return {
    eventId: generateEventId(),
    eventType,
    timestamp: iso,
    timestampIST: ist,
    identityId,
    payload,
    importance,
    processed: false,
    cognitionTriggered: false,
  };
}

// ===================================================================
// PUBLIC EMIT HELPERS
// ===================================================================

export async function emitUserArrival(
  identityId: string,
  name: string,
  channel: 'text' | 'voice',
  isReturningUser: boolean,
  metadata?: any
): Promise<SystemEvent> {
  const importance = isReturningUser ? 65 : 75; // Returning is slightly less novel
  const event = buildEvent('user_arrival', identityId, {
    name,
    channel,
    isReturningUser,
    metadata,
  }, importance);
  await eventBus.emitEvent(event);
  return event;
}

export async function emitUserDeparture(
  identityId: string,
  name: string,
  reason?: 'explicit' | 'timeout' | 'connection_lost'
): Promise<SystemEvent> {
  const event = buildEvent('user_departure', identityId, {
    name,
    reason,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitReconnection(
  identityId: string,
  name: string,
  elapsedSeconds: number
): Promise<SystemEvent> {
  const event = buildEvent('reconnection', identityId, {
    name,
    elapsedSeconds,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitNewMessage(
  identityId: string,
  from: string,
  to: string,
  content: string,
  metadata?: any
): Promise<SystemEvent> {
  const event = buildEvent('new_message', identityId, {
    from,
    to,
    content,
    metadata,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitTaskStateChange(
  taskId: string,
  identityId: string,
  previousState: string,
  newState: string,
  taskTitle: string
): Promise<SystemEvent> {
  const event = buildEvent('task_state_change', identityId, {
    taskId,
    previousState,
    newState,
    taskTitle,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitLoopStateChange(
  loopId: string,
  identityId: string,
  previousState: string,
  newState: string,
  description: string
): Promise<SystemEvent> {
  const event = buildEvent('loop_state_change', identityId, {
    loopId,
    previousState,
    newState,
    description,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitEnvironmentChange(
  changeType: string,
  description: string,
  payload?: any
): Promise<SystemEvent> {
  const event = buildEvent('environment_change', undefined, {
    changeType,
    description,
    ...payload,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitScheduledEvent(
  name: string,
  scheduledFor: string,
  payload: any
): Promise<SystemEvent> {
  const event = buildEvent('scheduled_event', undefined, {
    name,
    scheduledFor,
    payload,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitNewLearning(
  identityId: string,
  category: string,
  description: string,
  memoryId?: string
): Promise<SystemEvent> {
  const event = buildEvent('new_learning', identityId, {
    category,
    description,
    memoryId,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitCorrection(
  identityId: string,
  correctedFact: string,
  correctFact: string,
  memoryId?: string
): Promise<SystemEvent> {
  const event = buildEvent('correction', identityId, {
    correctedFact,
    correctFact,
    memoryId,
  }, 80);
  await eventBus.emitEvent(event);
  return event;
}

export async function emitTaskDue(
  taskId: string,
  identityId: string,
  taskTitle: string,
  dueAt: string,
  overdue: boolean
): Promise<SystemEvent> {
  const event = buildEvent('task_due', identityId, {
    taskId,
    taskTitle,
    dueAt,
    overdue,
  }, overdue ? 95 : 80);
  await eventBus.emitEvent(event);
  return event;
}

export async function emitLoopResolved(
  loopId: string,
  identityId: string,
  description: string,
  resolvedHow: string
): Promise<SystemEvent> {
  const event = buildEvent('loop_resolved', identityId, {
    loopId,
    description,
    resolvedHow,
  });
  await eventBus.emitEvent(event);
  return event;
}

export async function emitCommitmentMade(
  identityId: string,
  commitment: string,
  context: string
): Promise<SystemEvent> {
  const event = buildEvent('commitment_made', identityId, {
    commitment,
    context,
  });
  await eventBus.emitEvent(event);
  return event;
}

// ===================================================================
// REPLAY / DRAIN HELPERS
// ===================================================================

/**
 * Process all unprocessed events (used after restart to catch up).
 * Returns the number of events drained.
 */
export async function drainUnprocessedEvents(handler: EventHandler): Promise<number> {
  const unprocessed = db.getUnprocessedSystemEvents(200);
  let count = 0;
  for (const event of unprocessed) {
    try {
      await handler(event);
      db.markSystemEventProcessed(event.eventId, true, []);
      count += 1;
    } catch (err: any) {
      db.markSystemEventProcessed(event.eventId, false, []);
      console.error(`[EVENT-SYSTEM] drain handler error for ${event.eventId}:`, err.message);
    }
  }
  if (count > 0) {
    console.log(`[EVENT-SYSTEM] Drained ${count} unprocessed events`);
  }
  return count;
}
