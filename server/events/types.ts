/** P06 durable event system types. */

export type DomainEventType =
  | 'memory.appended'
  | 'memory.consolidated'
  | 'task.scheduled'
  | 'task.claimed'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.retry_scheduled'
  | 'loop.opened'
  | 'loop.closed'
  | 'loop.paused'
  | 'loop.resumed'
  | 'loop.evaluated'
  | 'loop.task_created'
  | 'action.executed'
  | 'action.failed'
  | 'identity.enrolled'
  | 'identity.revoked'
  | 'boot.completed'
  | 'config.changed'
  | 'backup.completed'
  | 'error.raised'
  | 'cycle.started'
  | 'cycle.stage.completed'
  | 'cycle.completed'
  | 'cycle.interrupted'
  | 'session.connected'
  | 'session.disconnected'
  | 'audio.frame'
  | 'proactive.decision'
  | 'proactive.delivered'
  | 'proactive.suppressed';

export interface DomainEvent<T extends DomainEventType = DomainEventType, P = unknown> {
  id: string;
  type: T;
  payload: P;
  identityId?: string | undefined;
  cycleId?: string | undefined;
  timestamp: number;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  version: number;
}

export interface PersistedDomainEvent<T extends DomainEventType = DomainEventType, P = unknown>
  extends DomainEvent<T, P> {
  seq: number;
}

export type EventHandler<T extends DomainEvent = DomainEvent> = (
  event: PersistedDomainEvent<T['type'], T['payload']>,
) => void | Promise<void>;

export interface EventBusOptions {
  handlerDeadlineMs?: number | undefined;
}

export interface PublishEvent<T extends DomainEventType, P> {
  type: T;
  payload: P;
  identityId?: string | undefined;
  cycleId?: string | undefined;
  timestamp?: number | undefined;
  causationId?: string | undefined;
  correlationId?: string | undefined;
  version?: number | undefined;
}
