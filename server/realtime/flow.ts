/**
 * The fan-out: one committed event becomes one state update and one frame per client.
 *
 * ## Which of the seven stages this is
 *
 * Build Book XVI.1 draws the chain as MUTATION → PERSISTENCE → DOMAIN EVENT →
 * RUNTIME UPDATE, and then three edges out of the fourth: UI, VOICE and COGNITIVE
 * UPDATE. This class is stage 4 — `applyToState` is the only place `RuntimeState`
 * advances — and it drives exactly one of the three edges after it, the UI.
 *
 * Worth stating, because the comments this file used to carry read
 * `// 4. RUNTIME UPDATE` and `// 5., 6., 7. UI / VOICE / COGNITIVE UPDATE`, the
 * second of them over a single `broadcast()` call. One fan-out was labelled as
 * three stages, and the other two do not run through here at all:
 *
 *  - **Voice** is upstream of this class, not downstream. `VoiceSession` writes
 *    `{t:'state'}` to its own socket the moment its state machine moves, and
 *    publishes `voice.state` into the log. That event arrives *here*, where it is
 *    folded into `RuntimeState.voice` (stage 4) and forwarded to the browser
 *    (stage 5).
 *  - **Cognition** is driven by stimuli. Nothing in `server/cognition/` subscribes
 *    to this object; the one place an event causes new work is `LoopManager`'s
 *    event triggers, and those subscribe to `EventBus` directly. The log is the
 *    contract, not this object.
 *
 * Which leaves one subscriber shape in production: `SseSubscriber`, through
 * `server/http/routes/presence.ts`. Everything else that needs to know what
 * happened reads `domain_event`.
 *
 * ## Coalescing drops frames, and that is the design
 *
 * A subscriber that stops draining has its queue collapsed by `coalesceKey` — the
 * newest message under a key replaces the one waiting there. Ten `task.scheduled`
 * events inside one window are delivered as one frame and nine are dropped, on
 * purpose, and it costs nothing because the SSE route follows every event frame
 * with a full state snapshot read at send time (see `presence.ts`, "The stream is a
 * state feed, not an event log"). The state is what a client trusts and it is
 * re-sent whole; the frames are a log it shows, and a reconnecting client is
 * replayed the ones it missed out of `domain_event` via `Last-Event-ID`.
 *
 * That also bounds the queue by the number of distinct keys rather than by the
 * number of events, which is what makes a slow client cheap instead of a leak.
 */

import type { EventBus } from '../events/event-bus.js';
import type { PersistedDomainEvent } from '../events/types.js';
import type { BroadcastMessage, RuntimeState, Subscriber } from './types.js';

/**
 * How long a burst is allowed to collapse before it is written out.
 *
 * 50ms is Part XXII.2's number. It is the whole backpressure mechanism: within one
 * window, later messages replace earlier ones under the same key instead of
 * queueing behind them.
 */
const DEFAULT_COALESCE_WINDOW_MS = 50;

export interface RealtimeFlowOptions {
  /** Overrides {@link DEFAULT_COALESCE_WINDOW_MS}. Zero drains on a microtask. */
  coalesceWindowMs?: number;
  /**
   * Refreshes the *domain* fields of `RuntimeState` after an event.
   *
   * Without this, `applyToState` sets `version` and `lastMutation` and nothing else
   * — so `memory`, `tasks`, `loops`, `presence`, `cognitive` and `environment` keep
   * whatever the initial state was constructed with, forever, while the version
   * number keeps climbing and telling a subscriber it is up to date. A UI bound to
   * `getSnapshot()` would show six zeroes after a thousand memories were written.
   *
   * A hook rather than a repository dependency because this is a fan-out component:
   * it must stay usable with a hand-written state and no database, which is how the
   * tests drive it. The implementation is `RuntimeStateProjector.project` in
   * `server/http/state.ts`.
   */
  project?: ((previous: RuntimeState, event: PersistedDomainEvent) => RuntimeState) | undefined;
  /**
   * Where a subscriber's own failure goes. Defaults to `console.error`.
   *
   * Deliberately *not* wired to `server/app.ts`'s reporter, which publishes
   * `error.raised` into the event bus: this class subscribes to that bus, so a
   * subscriber whose `send` rejects would have its failure broadcast back to
   * itself, reject again, and publish again — one event per turn of a loop with
   * nothing to stop it. A fan-out cannot report through the thing it fans out.
   */
  report?: ((what: string, error: unknown) => void) | undefined;
}

/** One connected subscriber and the queue waiting for it. */
interface Fanout {
  readonly sub: Subscriber;
  /** `coalesceKey` → the newest message under it. Insertion-ordered. */
  readonly queue: Map<string, BroadcastMessage>;
  /** A drain is running. It re-checks the queue before it finishes. */
  draining: boolean;
  /** A drain is armed and has not looked at the queue yet. */
  scheduled: boolean;
  timer: NodeJS.Timeout | undefined;
}

export class RealtimeFlow {
  private readonly eventBus: EventBus;
  private readonly coalesceWindowMs: number;
  private readonly project:
    | ((previous: RuntimeState, event: PersistedDomainEvent) => RuntimeState)
    | undefined;
  private readonly report: (what: string, error: unknown) => void;

  private readonly fanouts = new Map<string, Fanout>();
  private currentState: RuntimeState;
  private unfollow: (() => void) | undefined;

  constructor(eventBus: EventBus, initialState: RuntimeState, options: RealtimeFlowOptions = {}) {
    this.eventBus = eventBus;
    this.currentState = initialState;
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.project = options.project;
    this.report =
      options.report ??
      ((what, error) => {
        console.error(`${what}:`, error);
      });
  }

  /** Begins following the log. Calling it twice is a no-op, not a second stream. */
  start(): void {
    if (this.unfollow !== undefined) return;
    this.unfollow = this.eventBus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  /**
   * Stops following the log and cancels every armed drain.
   *
   * Subscribers are left registered: this class did not open their sockets and
   * closing them is the owner's business. `presence.ts` unsubscribes on `close`.
   */
  stop(): void {
    this.unfollow?.();
    this.unfollow = undefined;
    for (const fanout of this.fanouts.values()) {
      this.disarm(fanout);
    }
  }

  /**
   * The state as of the last event applied.
   *
   * Returned by reference and never mutated in place — every update above replaces
   * the object — so a caller that holds one holds a stable snapshot.
   */
  getSnapshot(): RuntimeState {
    return this.currentState;
  }

  /** Registers a subscriber. A second call with the same id is ignored. */
  subscribe(subscriber: Subscriber): void {
    if (this.fanouts.has(subscriber.id)) return;
    this.fanouts.set(subscriber.id, {
      sub: subscriber,
      queue: new Map(),
      draining: false,
      scheduled: false,
      timer: undefined,
    });
  }

  /**
   * Removes a subscriber and drops whatever was queued for it.
   *
   * A drain already armed on a microtask cannot be cancelled, so `drain` checks the
   * registry rather than trusting the timer to have been cleared.
   */
  unsubscribe(subscriberId: string): void {
    const fanout = this.fanouts.get(subscriberId);
    if (fanout === undefined) return;
    this.disarm(fanout);
    this.fanouts.delete(subscriberId);
  }

  /**
   * One committed event: stage 4, then the UI edge of stage 5.
   *
   * Synchronous, and the bus awaits it under a deadline — so the state is advanced
   * before `deliver` returns and a publisher that awaits `publish` can read its own
   * write back out of `getSnapshot()`. Writing to the sockets is what happens later.
   */
  private handleEvent(event: PersistedDomainEvent): void {
    this.applyToState(event);
    this.broadcast({
      seq: event.seq,
      type: event.type,
      payload: event.payload,
      timestamp: Date.now(),
      // Events of one type touch one part of `RuntimeState`, so the newest of them
      // supersedes the rest — which is what makes the collapse above lossless in
      // the only sense a state feed cares about.
      coalesceKey: event.type,
    });
  }

  private applyToState(event: PersistedDomainEvent): void {
    const previous = this.currentState;

    // `version` is a high-water mark in the durable log, not a count of deliveries:
    // `seq` is `domain_event`'s `INTEGER PRIMARY KEY`, and this says every event at
    // or below it has been applied.
    //
    // `Math.max` rather than assignment, because delivery order is not seq order.
    // `EventBus.publish` inserts and dispatches inside one synchronous run, so two
    // publishes cannot interleave — but stage 12 writes a whole cycle's events in a
    // single transaction and then `await`s `deliver` once per event, and each of
    // those awaits is a chance for an independent publisher (an SSE connect, the
    // autonomic loop, a weather sweep) to insert *and* deliver a later event first.
    // Assigning would then walk the version backwards, and two readers take it as
    // monotonic: the book (VI.5 — clients detect missed updates by it) and
    // `replayMissed`, which uses it as the upper bound of a reconnect replay and
    // would tell a client four events behind that it was already current.
    const version = Math.max(previous.version, event.seq);

    // The same race, one field along. `lastMutation` means "the newest change", and
    // a late delivery of an older event is not that — XVI.2's rule for the channel,
    // never a stale field after a newer one, applied to the field this class owns.
    const lastMutation =
      event.seq >= previous.version
        ? { eventId: event.id, type: event.type, timestamp: event.timestamp }
        : previous.lastMutation;

    const stamped: RuntimeState = { ...previous, version, lastMutation };

    // The projection runs *after* version and lastMutation are set, so it sees a
    // state already stamped with the event it is projecting and cannot be the thing
    // that forgets to advance the version. A throwing projector is not caught: it
    // would mean the authoritative read behind it failed, and broadcasting a state
    // that silently kept stale counts is the dishonesty this hook exists to remove.
    this.currentState = this.project ? this.project(stamped, event) : stamped;
  }

  /**
   * Queues one message for every subscriber and makes sure a drain is coming.
   *
   * Public because the message does not have to be a domain event: the voice and
   * presence layers can put a frame on the same channel without inventing a row in
   * `domain_event` for it.
   */
  broadcast(message: BroadcastMessage): void {
    const key = coalesceKeyFor(message);
    for (const fanout of this.fanouts.values()) {
      // `Map.set` on a key that exists keeps its original position, so a coalesced
      // message holds the place of the first of its kind: order is by when that part
      // of the state first went stale, not by when the newest word about it arrived.
      fanout.queue.set(key, message);
      this.scheduleDrain(fanout);
    }
  }

  /**
   * Arms one drain, or leaves the one already coming to do the work.
   *
   * The two guards are the whole of the mutual exclusion. A drain that is running
   * re-checks the queue before it returns, and a drain that is armed has not looked
   * yet — in both cases this message is already covered, and arming a second one
   * would put two loops on one queue: they would not duplicate a message, but they
   * would interleave their awaits and write two clients' worth of frames in an order
   * neither of them chose.
   */
  private scheduleDrain(fanout: Fanout): void {
    if (fanout.draining || fanout.scheduled) return;
    fanout.scheduled = true;
    if (this.coalesceWindowMs > 0) {
      fanout.timer = setTimeout(() => {
        fanout.timer = undefined;
        void this.drain(fanout);
      }, this.coalesceWindowMs);
      return;
    }
    // No window still means "not this instant": a synchronous burst has to be
    // allowed to collapse, and calling straight through would send the first
    // message before the second was queued.
    queueMicrotask(() => {
      void this.drain(fanout);
    });
  }

  /**
   * Writes the queue out, oldest key first, one message at a time.
   *
   * Awaiting each `send` is the point rather than a cost: `SseSubscriber.send`
   * resolves when the socket has accepted the bytes, so a client on a slow link
   * stops draining and its queue collapses instead of growing. Sending
   * concurrently would turn the coalescing window into an unbounded buffer.
   */
  private async drain(fanout: Fanout): Promise<void> {
    fanout.scheduled = false;
    // Unsubscribed while this was armed. Its timer is cleared on the way out, but a
    // queued microtask cannot be, so this is what stops a frame going to a client
    // that has gone — and it is checked by identity, because a subscriber may have
    // re-registered under the same id since.
    if (this.fanouts.get(fanout.sub.id) !== fanout) return;

    fanout.draining = true;
    try {
      // Oldest key first, re-read after every send: a message queued while an await
      // was outstanding is picked up by this loop rather than by a second drain.
      for (let next = firstEntry(fanout.queue); next !== undefined; next = firstEntry(fanout.queue)) {
        const [key, message] = next;
        fanout.queue.delete(key);
        await fanout.sub.send(message);
      }
    } catch (error) {
      // A subscriber whose `send` rejects is broken: `SseSubscriber` resolves even
      // when the write fails and marks itself closed, which is how a vanished
      // browser is meant to be reported. The message that was in flight is gone —
      // it left the queue before the write — and the ones behind it stay and keep
      // coalescing, with the next `broadcast` arming the next attempt. So a
      // subscriber that recovers catches up, and one that never does costs one
      // pending message per key rather than a growing backlog.
      this.report(`realtime fan-out to ${fanout.sub.id}`, error);
    } finally {
      fanout.draining = false;
    }
  }

  /** Cancels an armed drain. The microtask path has nothing to cancel. */
  private disarm(fanout: Fanout): void {
    if (fanout.timer !== undefined) {
      clearTimeout(fanout.timer);
      fanout.timer = undefined;
    }
    fanout.scheduled = false;
  }
}

/**
 * The key a message coalesces under.
 *
 * A producer sets `coalesceKey` to say "this supersedes the last one like it".
 * Without one the message coalesces with nothing: a key built from its own `seq` is
 * unique by construction, and a message nobody said was superseded must not be.
 */
function coalesceKeyFor(message: BroadcastMessage): string {
  return message.coalesceKey ?? `seq:${message.seq}`;
}

/** The entry that has been waiting longest, or `undefined` when the queue is empty. */
function firstEntry(
  queue: Map<string, BroadcastMessage>,
): readonly [string, BroadcastMessage] | undefined {
  for (const entry of queue) return entry;
  return undefined;
}
