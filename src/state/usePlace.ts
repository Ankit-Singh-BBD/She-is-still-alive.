/**
 * Telling her where she is, without ambushing anyone for it.
 *
 * ## Why the browser dialog is not fired on load
 *
 * A geolocation prompt in the first second of a session is the most jarring thing
 * a page can do, and location here buys exactly one thing: the sky in the room
 * matches the sky outside. So the permission state is *queried* on entering — which
 * prompts nobody — and the request itself is made only in two cases: permission
 * was already granted (so there is no dialog to show), or the person asked for it
 * by tapping the one quiet line the interface offers.
 *
 * A `denied` permission is never retried. Calling `getCurrentPosition` on a denied
 * origin does not re-prompt; it fails, which would turn a settled decision into a
 * silent error every time the page loaded.
 *
 * ## What is sent, and where
 *
 * Two numbers, to her own server on the same origin, which forwards them to
 * Open-Meteo to read the sky. `enableHighAccuracy` is off deliberately: a weather
 * lookup wants the city, not the street, and coarse positioning is both faster and
 * less than the browser would otherwise hand over.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../lib/api.js';

export type PlaceStatus =
  /** Not asked. The interface may offer to. */
  | 'unknown'
  /** A request is in flight, dialog included. */
  | 'asking'
  /** She has coordinates and has read the sky. */
  | 'shared'
  /** Declined, or the attempt failed. Not retried on its own. */
  | 'refused'
  /** No geolocation in this browser at all. */
  | 'unsupported';

export interface PlaceState {
  status: PlaceStatus;
  /** Triggers the browser dialog. Safe to call more than once. */
  ask: () => void;
}

const POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  timeout: 10_000,
  // A reading up to a quarter of an hour old is fine for weather and costs no
  // hardware wake-up.
  maximumAge: 900_000,
};

export function usePlace({ active }: { active: boolean }): PlaceState {
  const [status, setStatus] = useState<PlaceStatus>('unknown');
  const inFlight = useRef(false);

  const report = useCallback(() => {
    if (inFlight.current) return;
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setStatus('unsupported');
      return;
    }
    inFlight.current = true;
    setStatus('asking');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        void api
          .place({ lat: position.coords.latitude, lng: position.coords.longitude })
          .then(() => setStatus('shared'))
          // The coordinates are good; the round trip failed. Reported as refused
          // rather than shared, because nothing downstream knows where she is.
          .catch(() => setStatus('refused'))
          .finally(() => {
            inFlight.current = false;
          });
      },
      () => {
        inFlight.current = false;
        setStatus('refused');
      },
      POSITION_OPTIONS,
    );
  }, []);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || navigator.geolocation === undefined) {
      setStatus('unsupported');
      return;
    }
    let live = true;
    // `permissions` is absent in some Safari versions; there the state stays
    // `unknown` and the interface offers the line instead of guessing.
    if (navigator.permissions === undefined) return;
    void navigator.permissions
      .query({ name: 'geolocation' })
      .then((permission) => {
        if (!live) return;
        if (permission.state === 'granted') report();
        else if (permission.state === 'denied') setStatus('refused');
      })
      .catch(() => {
        // A browser that refuses to describe the permission is one we ask nothing
        // of until the person asks first.
      });
    return () => {
      live = false;
    };
  }, [active, report]);

  return { status, ask: report };
}
