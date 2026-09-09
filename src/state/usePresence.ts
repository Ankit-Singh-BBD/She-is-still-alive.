/**
 * What is true right now, held for as long as the room is open.
 *
 * ## Snapshot first, then the stream
 *
 * `GET /api/state` is read before `GET /api/stream` is opened, for one reason: the
 * first state frame does not arrive until something happens, and on a quiet
 * instance that could be minutes. Without the snapshot the interface would sit at
 * her fallback palette in an empty room while the server knew exactly what the sky
 * was doing.
 *
 * The reverse order would be worse than useless: the stream's own first frame is a
 * snapshot too, so a client that opened the stream first and then read `/api/state`
 * could overwrite live state with an older read.
 *
 * ## When the stream is not opened at all
 *
 * `GET /api/state` answers `live: false` when there is no `RealtimeFlow` — the
 * flag is off, or no owner is enrolled. The route documents that the state is
 * still real in that case (the projector reads the same tables) but that nothing
 * is counting events for it, so `version` is `0`. Opening a stream then is a
 * request we already know answers 503, so it is not made; the status goes straight
 * to `unavailable` and the field visibly stops claiming to be live.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiFailure, api, type RuntimeState } from '../lib/api.js';
import { openPresenceStream, type StreamStatus } from '../lib/stream.js';

export interface PresenceReading {
  /** The last state the server reported. `undefined` until the first read lands. */
  state: RuntimeState | undefined;
  status: StreamStatus;
}

export interface PresenceOptions {
  /** True while we are in the room. Opening a stream at the door would 401. */
  active: boolean;
  /** Called when the server says this session is no longer good. */
  onExpire: () => void;
}

export function usePresence({ active, onExpire }: PresenceOptions): PresenceReading {
  const [state, setState] = useState<RuntimeState | undefined>(undefined);
  const [status, setStatus] = useState<StreamStatus>('connecting');

  // Held in a ref so a fresh callback identity from the parent cannot tear down a
  // working stream and reopen it.
  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;

  useEffect(() => {
    if (!active) {
      setState(undefined);
      setStatus('closed');
      return;
    }

    let live = true;
    let handle: { close: () => void } | undefined;

    void (async () => {
      let flowExists = false;
      try {
        const reply = await api.state();
        if (!live) return;
        setState(reply.state);
        flowExists = reply.live;
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiFailure && error.isAuth) {
          expireRef.current();
          return;
        }
        // A failed snapshot is survivable: the stream's own first frame is a
        // snapshot too. Leave the status alone and let the stream report.
      }
      if (!live) return;

      if (!flowExists) {
        setStatus('unavailable');
        return;
      }

      handle = openPresenceStream({
        onState: (next) => {
          if (live) setState(next);
        },
        onStatus: (next) => {
          if (live) setStatus(next);
        },
      });
    })();

    return () => {
      live = false;
      handle?.close();
    };
  }, [active]);

  return { state, status };
}
