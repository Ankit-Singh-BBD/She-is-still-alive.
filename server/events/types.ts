/** P06 durable event system types. */

/**
 * Every fact worth keeping. One name per thing that happened.
 *
 * An **array**, not a bare union, because Book VIII.3 promises *"untyped events are
 * rejected at the boundary"* and a TypeScript union cannot reject anything at runtime.
 * `EventBus.mapRow` used to cast — `row['type'] as DomainEventType` — and
 * `server/loops/manager.ts` casts a trigger spec read out of the database the same
 * way, so a loop could subscribe to a name nothing publishes and simply never fire.
 * `DomainEventType` is derived from this list, so the two cannot drift.
 *
 * `'audio.frame'` used to be in here and is deliberately gone. `EventBus.publish`
 * writes a row and awaits every handler per event; a microphone produces twenty
 * frames a second, so declaring audio a domain event meant 1,200 rows a minute of
 * a payload nobody would ever query. Audio is transport — it belongs on the
 * socket and nowhere else. What is durable about a spoken turn is what was heard
 * and what was said, which is `'voice.transcript'`.
 *
 * Two members have no publish site and both are kept deliberately, because the
 * *operation* is absent rather than the wiring: `config.changed` (nothing reloads
 * config — `loadConfig` runs once at boot) and `identity.revoked` (authz revokes
 * sessions, never identities; `server/identity/repository.ts` says so). Whoever adds
 * either operation publishes the matching event in the same change.
 */
export const DOMAIN_EVENT_TYPES = [
  'memory.appended',
  'memory.consolidated',
  'task.scheduled',
  'task.claimed',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.retry_scheduled',
  'loop.opened',
  'loop.closed',
  'loop.paused',
  'loop.resumed',
  'loop.evaluated',
  'loop.task_created',
  'action.executed',
  'action.failed',
  'identity.enrolled',
  'identity.revoked',
  'boot.completed',
  'config.changed',
  'backup.completed',
  'error.raised',
  'cycle.started',
  'cycle.stage.completed',
  'cycle.decided',
  'cycle.action',
  'cycle.responded',
  'cycle.learned',
  'cycle.updated',
  'cycle.completed',
  'cycle.degraded',
  'cycle.failed',
  'cycle.interrupted',
  'session.connected',
  'session.disconnected',
  'environment.changed',
  'voice.state',
  'voice.transcript',
  'proactive.decision',
  'proactive.delivered',
  'proactive.deferred',
  'proactive.suppressed',
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

const DOMAIN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(DOMAIN_EVENT_TYPES);

/** Whether a value read from the database or a config file names a real event. */
export function isDomainEventType(value: unknown): value is DomainEventType {
  return typeof value === 'string' && DOMAIN_EVENT_TYPE_SET.has(value);
}

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
  /**
   * Where a subscriber's failure is reported.
   *
   * Defaults to `console.error`. Injectable so a test can assert that a throwing
   * handler was *noticed* — the bug this exists for was `Promise.allSettled`'s results
   * being discarded, which is invisible by construction until you look for it.
   */
  report?: ((what: string, error: unknown) => void) | undefined;
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
