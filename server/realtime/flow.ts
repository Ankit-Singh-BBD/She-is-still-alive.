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

  constructor(
    private eventBus: EventBus,
    initialState: RuntimeState,
    options: RealtimeFlowOptions = {}
  ) {
    this.currentState = initialState;
    this.coalesceWindowMs = options.coalesceWindowMs ?? 50; // default to 50ms per Part XXII.2
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
    this.currentState = {
      ...this.currentState,
      version: event.seq, // version increments monotonically based on persistence
      lastMutation: {
        eventId: event.id,
        type: event.type,
        timestamp: event.timestamp,
      },
    };
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
