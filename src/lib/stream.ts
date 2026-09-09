/**
 * Her pulse, over one long-lived HTTP response.
 *
 * ## Why this listens for `state` and nothing else
 *
 * `GET /api/stream` writes two kinds of frame: a named domain event (`id:` plus
 * `event: cycle.stage.completed`, say) and, immediately after each one, a full
 * `event: state` frame read from the flow at send time. The route's own header
 * explains why: `RealtimeFlow` *coalesces* by event type, so the frames a client
 * receives can never be a complete log — a client that tried to maintain
 * `RuntimeState` by applying events to it would drift, and nothing would tell it.
 *
 * So the state frame is the whole contract, and this file subscribes to that one
 * name. Everything a presence layer wants from the event log is already inside
 * it: `lastMutation.type` names the event that caused this state, and
 * `cognitive.currentStage` names where in the twelve stages she is.
 *
 * Not reading the event frames does not break replay. `EventSource` records the
 * `id:` of every frame it parses, listener or not, and echoes the last one as
 * `Last-Event-ID` when it reconnects — which is exactly the cursor
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
