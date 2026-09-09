/**
 * Which of the four times of day it is, where she is.
 *
 * ## Why this is not `new Date().getHours()`
 *
 * The obvious implementation reads the *server's* clock and calls 06:00 sunrise
 * everywhere on earth. Two things break. The server may not be in the same zone
 * as the owner, so "good morning" arrives at midnight. And 06:00 is not sunrise
 * in Delhi in December or in Reykjavík in June — the sun is the event, the hour
 * is only a proxy for it.
 *
 * So there are three tiers, and each one is used only when the tier above it has
 * no evidence:
 *
 * 1. **Real sunrise and sunset** for these coordinates, from the provider. A
 *    window either side of each event is when the light is actually changing.
 * 2. **The provider's `is_day` flag**, when it reported daylight but no times.
 *    That collapses to `'day'` or `'night'` — it cannot see the transitions.
 * 3. **Hour of day in the location's own zone**, via `Intl`, which is the last
 *    resort and the only tier that is a guess. It is still better than the
 *    server's zone, and it never pretends the transition windows are precise.
 *
 * The tier used is returned alongside the answer, because a caller that wants
 * to say "the sun set twenty minutes ago" may only do so on tier 1.
 */

import type { TimeOfDay } from '@server/realtime/types.js';

/**
 * How long the light takes to change, either side of the event.
 *
 * Civil twilight runs roughly 20–30 minutes at mid latitudes; 40 gives the
 * palette a window wide enough to be worth crossfading through without holding
 * `'sunrise'` so long that it stops being true.
 */
export const TRANSITION_WINDOW_MS = 40 * 60_000;

export type TimeOfDayBasis = 'solar' | 'daylight_flag' | 'local_hour';

/**
 * The four facts about the sun this needs, all of them optional.
 *
 * A `WeatherObservation` satisfies it, and so does `{}` — which is the shape a
 * caller has before anything has been observed, and the case that selects the
 * last-resort tier.
 */
export interface SolarTimes {
  /** Epoch ms. */
  sunrise?: number | undefined;
  /** Epoch ms. */
  sunset?: number | undefined;
  isDay?: boolean | undefined;
  /** IANA zone name. */
  timeZone?: string | undefined;
}

export interface TimeOfDayReading {
  timeOfDay: TimeOfDay;
  /** Which tier answered. Only `'solar'` is grounded in the actual sun. */
  basis: TimeOfDayBasis;
}

/** Hour bands for the last-resort tier. Deliberately coarse — it is a guess. */
function timeOfDayForHour(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 7) return 'sunrise';
  if (hour >= 7 && hour < 17) return 'day';
  if (hour >= 17 && hour < 19) return 'sunset';
  return 'night';
}

/**
 * The hour in an IANA zone, or in the server's zone when none is known.
 *
 * `Intl` ships with Node, so this costs no dependency. An unknown or malformed
 * zone makes `DateTimeFormat` throw, and the honest fallback for "we cannot
 * resolve that zone" is the only other clock available.
 */
export function hourInZone(at: number, timeZone: string | undefined): number {
  if (timeZone === undefined) return new Date(at).getHours();
  try {
    const formatted = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).format(new Date(at));
    const parsed = Number.parseInt(formatted, 10);
    // `hour12: false` yields 0–23 in Node, but '24' has been observed in some
    // ICU builds for midnight, so it is normalised rather than trusted.
    if (Number.isNaN(parsed)) return new Date(at).getHours();
    return parsed % 24;
  } catch {
    return new Date(at).getHours();
  }
}

/**
 * Resolve the time of day from whatever the observation actually contains.
 *
 * `at` is injectable so a test can stand at a chosen instant instead of racing
 * the wall clock — the same reason every other clock-reading function here
 * takes one.
 */
export function resolveTimeOfDay(
  observation: SolarTimes,
  at: number = Date.now(),
): TimeOfDayReading {
  const { sunrise, sunset } = observation;

  if (sunrise !== undefined && sunset !== undefined) {
    if (Math.abs(at - sunrise) <= TRANSITION_WINDOW_MS) {
      return { timeOfDay: 'sunrise', basis: 'solar' };
    }
    if (Math.abs(at - sunset) <= TRANSITION_WINDOW_MS) {
      return { timeOfDay: 'sunset', basis: 'solar' };
    }
    // Outside both windows the sun is either up or down. Note that this is
    // correct across a day boundary too: before the reported sunrise it is
    // still last night, and the answer is the same either way.
    return { timeOfDay: at > sunrise && at < sunset ? 'day' : 'night', basis: 'solar' };
  }

  if (observation.isDay !== undefined) {
    return { timeOfDay: observation.isDay ? 'day' : 'night', basis: 'daylight_flag' };
  }

  return {
    timeOfDay: timeOfDayForHour(hourInZone(at, observation.timeZone)),
    basis: 'local_hour',
  };
}
