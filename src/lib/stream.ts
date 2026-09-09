/**
 * Her pulse, over one long-lived HTTP response.
 *
 * ## The state frame is the only thing that carries state
 *
 * `GET /api/stream` writes two kinds of frame: a named domain event (`id:` plus
 * `event: cycle.completed`, say) and, immediately after each one, a full
 * `event: state` frame read from the flow at send time. The route's own header
 * explains why the second one is authoritative: `RealtimeFlow` *coalesces* by
 * event type, so the frames a client receives can never be a complete log — a
 * client that tried to maintain `RuntimeState` by applying events to it would
 * drift, and nothing would tell it.
 *
 * So `onState` is the whole of the state contract. Nothing here reconstructs,
 * merges, or patches a `RuntimeState`; every field the interface reads comes from
 * a frame the server built.
 *
 * ## Why the event frames are read anyway
 *
 * For their *names*, and for nothing else. Some things the interface has to do are
 * triggered by a fact having changed rather than by a field's value — the
 * transcript has to be re-read after a cycle commits a turn, including a cycle
 * this client never asked for.
 *
 * The state frame cannot carry that trigger, and this file used to assume it
 * could. `lastMutation` looks like it names the event the frame follows, and it
 * does not: the adapter sends `flow.getSnapshot()` read *at send time*, so a burst
 * of events leaves every trailing state frame naming the newest one. Measured on a
 * live run — a proactive cycle emitted `cycle.started`, `cycle.decided`,
 * `cycle.responded`, `cycle.completed`, `proactive.delivered`, and every state
 * frame in the burst reported `lastMutation.type = 'proactive.delivered'`.
 * `cycle.completed` never appeared in one. Reading it off the state frame was not
 * a race that usually works; it was a thing that cannot work.
 *
 * The event frame's own name is not coalesced away — it is the frame. So the four
 * terminal cycle events are subscribed by name and reported as a bare signal, with
 * no payload: after one of these, rows exist that were not there before, and the
 * only honest thing a client can do with that is go and read them.
 *
 * Not reading *every* event frame still does not break replay. `EventSource`
 * records the `id:` of every frame it parses, listener or not, and echoes the last
 * one as `Last-Event-ID` when it reconnects — which is exactly the cursor
 * `replayMissed` honours.
 *
 * ## Reconnection is the browser's job, and only mostly
 *
 * The server opens every stream with `retry: 2000`, so a dropped connection is
 * retried by `EventSource` on its own with the right backoff and the right
 * cursor. There is one case it must *not* retry, and does not: a non-200 status
 * or a wrong content type fails the connection permanently, leaving
 * `readyState === CLOSED`. That is how `503 not_available` — realtime switched
 * off, or no owner enrolled — arrives here, and the difference between "closed"
 * and "connecting" is the only reason this file inspects `readyState` at all.
 */

import type { RuntimeState } from './api.js';

/** Server-sent-event name for the full-state frame. Mirrors `STATE_EVENT`. */
const STATE_EVENT = 'state';

/**
 * Stage 12's terminal event, one per cycle, by SSE frame name.
 *
 * All four commit: `degraded` answered with a stage broken on the way,
 * `interrupted` was abandoned for a newer stimulus, `failed` did not answer at
 * all. Every one of them still ran the transaction that writes turns, so every one
 * can leave a line on screen — a set holding only `cycle.completed` would drop her
 * reply on a cycle that merely limped.
 *
 * The events are delivered *after* that transaction commits, so a frame naming one
 * of these is a promise the rows are already readable.
 */
const CYCLE_COMMITTED_EVENTS: readonly string[] = [
  'cycle.completed',
  'cycle.degraded',
  'cycle.interrupted',
  'cycle.failed',
];

export type StreamStatus =
  /** Opening, or reconnecting after a drop. Frames may still be stale. */
  | 'connecting'
  /** A frame has arrived and the connection is open. */
  | 'live'
  /** Closed by us. */
  | 'closed'
  /**
   * The server refused, or the browser has no `EventSource`. Not retried: a
   * refusal is an answer, and hammering it would not change it.
   */
  | 'unavailable';

export interface StreamHandlers {
  onState: (state: RuntimeState) => void;
  onStatus: (status: StreamStatus) => void;
  /**
   * A cycle just committed. Carries the event's name and no data.
   *
   * Deliberately not the parsed payload: anything a client believes about what
   * changed belongs in the state frame or in a fresh read, and a second source of
   * truth on this wire is the thing the header above is about. The name is passed
   * only because "which of the four" is worth having in a log.
   */
  onCycleCommitted?: ((type: string) => void) | undefined;
}

export interface StreamHandle {
  close: () => void;
}

/**
 * Subscribes to `/api/stream`. Returns a handle whose `close()` is idempotent.
 *
 * The cookie rides because the request is same-origin; `withCredentials` is for
 * cross-origin streams and would be a lie here.
 */
export function openPresenceStream(handlers: StreamHandlers): StreamHandle {
  // jsdom has no EventSource. Reported rather than thrown, for the same reason
  // the renderer reports a missing WebGL context: a test that mounts the shell
  // should see the honest degraded path, not a crash.
  if (typeof EventSource === 'undefined') {
    handlers.onStatus('unavailable');
    return { close: () => {} };
  }

  const source = new EventSource('/api/stream');
  let closed = false;

  handlers.onStatus('connecting');

  source.addEventListener(STATE_EVENT, (event: MessageEvent<string>) => {
    let state: RuntimeState;
    try {
      state = JSON.parse(event.data) as RuntimeState;
    } catch {
      // A malformed frame is a bug on the wire, not a reason to tear down a
      // working stream. The next state frame is authoritative anyway.
      return;
    }
    handlers.onStatus('live');
    handlers.onState(state);
  });

  // Named one at a time because `EventSource` has no wildcard: a listener is per
  // event name, and there is no frame these four could arrive under other than
  // their own. The body ignores `event.data` entirely — see `onCycleCommitted`.
  for (const name of CYCLE_COMMITTED_EVENTS) {
    source.addEventListener(name, () => {
      handlers.onCycleCommitted?.(name);
    });
  }

  source.addEventListener('error', () => {
    if (closed) return;
    if (source.readyState === EventSource.CLOSED) {
      // Permanent: a non-200 (the 503 when realtime is off) or a content type
      // the parser refused. `EventSource` will not retry, so neither do we.
      handlers.onStatus('unavailable');
      return;
    }
    handlers.onStatus('connecting');
  });

  return {
    close: () => {
      if (closed) return;
      closed = true;
      source.close();
      handlers.onStatus('closed');
    },
  };
}
