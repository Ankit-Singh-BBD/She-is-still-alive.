import type { EventBus } from '../events/event-bus.js';
import type { PersistedDomainEvent } from '../events/types.js';
import type {
  BroadcastMessage,
  RuntimeState,
  Subscriber,
} from './types.js';

export interface QueuedMessage {
  message: BroadcastMessage;
}

export interface RealtimeFlowOptions {
  coalesceWindowMs?: number;
  /**
   * Refreshes the *domain* fields of `RuntimeState` after an event.
   *
   * Without this, `_applyEventToState` sets `version` and `lastMutation` and
   * nothing else — so `memory`, `tasks`, `loops`, `presence`, `cognitive` and
   * `environment` keep whatever the initial state was constructed with, forever,
   * while the version number keeps climbing and telling a subscriber it is up to
   * date. A UI bound to `getSnapshot()` would show six zeroes after a thousand
   * memories were written.
   *
   * It is a hook rather than a repository dependency because this class is a
   * fan-out component: it must stay usable with a hand-written state and no
   * database, which is how every test in `tests/p20` drives it. When absent the
   * behaviour is exactly what it was before the hook existed.
   *
   * The implementation lives in `server/http/state.ts` as `RuntimeStateProjector`.
   */
  project?: ((previous: RuntimeState, event: PersistedDomainEvent) => RuntimeState) | undefined;
}

export class RealtimeFlow {
  private subscribers = new Map<
    string,
    {
      sub: Subscriber;
      queue: Map<string, BroadcastMessage>; // coalesceKey -> message
      isDraining: boolean;
      drainTimer?: NodeJS.Timeout | null;
    }
  >();

  private currentState: RuntimeState;
  private eventBusUnsubscribe?: (() => void) | undefined;
  private coalesceWindowMs: number;
  private project: ((previous: RuntimeState, event: PersistedDomainEvent) => RuntimeState) | undefined;

  constructor(
    private eventBus: EventBus,
    initialState: RuntimeState,
    options: RealtimeFlowOptions = {}
  ) {
    this.currentState = initialState;
    this.coalesceWindowMs = options.coalesceWindowMs ?? 50; // default to 50ms per Part XXII.2
    this.project = options.project;
  }

  public start(): void {
    this.eventBusUnsubscribe = this.eventBus.subscribe(this.handleEvent.bind(this));
  }

  public stop(): void {
    if (this.eventBusUnsubscribe) {
      this.eventBusUnsubscribe();
      this.eventBusUnsubscribe = undefined;
    }
    for (const state of this.subscribers.values()) {
      if (state.drainTimer) {
        clearTimeout(state.drainTimer);
        state.drainTimer = null;
      }
    }
  }

  public getSnapshot(): RuntimeState {
    return this.currentState;
  }

  public subscribe(subscriber: Subscriber): void {
    if (this.subscribers.has(subscriber.id)) return;
    this.subscribers.set(subscriber.id, {
      sub: subscriber,
      queue: new Map(),
      isDraining: false,
      drainTimer: null,
    });
  }

  public unsubscribe(subscriberId: string): void {
    const state = this.subscribers.get(subscriberId);
    if (state && state.drainTimer) {
      clearTimeout(state.drainTimer);
    }
    this.subscribers.delete(subscriberId);
  }

  /**
   * Applies the event to the local RuntimeState copy and broadcasts.
   */
  private async handleEvent(event: PersistedDomainEvent): Promise<void> {
    // 4. RUNTIME UPDATE
    this._applyEventToState(event);

    // Prepare broadcast payload
    const msg: BroadcastMessage = {
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      timestamp: Date.now(),
      coalesceKey: event.type, // Basic coalesce by type
    };

    // 5., 6., 7. UI / VOICE / COGNITIVE UPDATE (broadcast via SSE/WS payload)
    this.broadcast(msg);
  }

  private _applyEventToState(event: PersistedDomainEvent): void {
    const withMutation: RuntimeState = {
      ...this.currentState,
      version: event.seq, // version increments monotonically based on persistence
      lastMutation: {
        eventId: event.id,
        type: event.type,
        timestamp: event.timestamp,
      },
    };

    // The projection runs *after* version and lastMutation are set, so it sees a
    // state already stamped with the event it is projecting and cannot be the
    // thing that forgets to advance the version. A throwing projector is not
    // caught: it would mean the authoritative read behind it failed, and
    // broadcasting a state that silently kept stale counts is the dishonesty
    // this hook exists to remove.
    this.currentState = this.project ? this.project(withMutation, event) : withMutation;
  }

  public broadcast(message: BroadcastMessage): void {
    for (const [id, state] of this.subscribers.entries()) {
      const key = message.coalesceKey ?? (message.field ? `field:${message.field}` : `__seq_${message.seq}`);
      state.queue.set(key, message); // Overwrite if same coalesceKey exists (coalescing)

      // If a coalescing window is configured (> 0), use setTimeout, otherwise microtask
      if (this.coalesceWindowMs > 0) {
        if (!state.drainTimer) {
          state.drainTimer = setTimeout(() => {
            state.drainTimer = null;
            this.drainQueue(id).catch((err) => {
              console.error(`Failed to drain queue for subscriber ${id}:`, err);
            });
          }, this.coalesceWindowMs);
        }
      } else {
        // Defer drain to next microtask so synchronous burst coalesces before first send.
        if (!state.isDraining) {
          state.isDraining = true;
          queueMicrotask(() => {
            this.drainQueue(id).catch((err) => {
              console.error(`Failed to drain queue for subscriber ${id}:`, err);
            });
          });
        }
      }
    }
  }

  private async drainQueue(subscriberId: string): Promise<void> {
    const state = this.subscribers.get(subscriberId);
    if (!state) return;

    try {
      while (state.queue.size > 0) {
        // Get the oldest message based on insertion order logic of Map
        const firstKey = state.queue.keys().next().value;
        if (!firstKey) break;

        const message = state.queue.get(firstKey);
        state.queue.delete(firstKey);

        if (message) {
          await state.sub.send(message);
        }
      }
    } finally {
      state.isDraining = false;
      // If messages arrived while draining that didn't get caught in the loop:
      const current = this.subscribers.get(subscriberId);
      if (current && current.queue.size > 0 && !current.isDraining && !current.drainTimer) {
        if (this.coalesceWindowMs > 0) {
          current.drainTimer = setTimeout(() => {
            current.drainTimer = null;
            this.drainQueue(subscriberId).catch(console.error);
          }, this.coalesceWindowMs);
        } else {
          current.isDraining = true;
          queueMicrotask(() => {
            this.drainQueue(subscriberId).catch(console.error);
          });
        }
      }
    }
  }
}
