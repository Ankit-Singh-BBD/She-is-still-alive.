/**
 * `RuntimeState` → the handful of numbers the shader understands.
 *
 * The renderer knows nothing about cognition, weather or sessions; it takes a
 * `Mood` and draws it. This file is the only place the translation happens, which
 * is what keeps the visual layer from quietly inventing meaning — every value
 * below traces to something the server actually reported.
 *
 * ## `presence` is the honest one
 *
 * It is not a mood at all: it is how live the picture is. A stream that has gone
 * away leaves the last `RuntimeState` on screen forever, and a full-brightness orb
 * over a dead connection is the UI telling a comfortable lie. So a lost stream
 * dims and stills her, visibly, without a dialog. The room reports its own
 * staleness.
 */

import type { CognitiveStageName, RuntimeState } from '@server/realtime/types.js';

import { derivePalette } from '@server/environment/palette.js';

import { hexToRgb, type Rgb } from '../lib/palette.js';
import type { StreamStatus } from '../lib/stream.js';

export interface Mood {
  primary: Rgb;
  secondary: Rgb;
  accent: Rgb;
  /** 0 at night, 1 at midday. Lifts the horizon and thins the vignette. */
  dayness: number;
  /** 0 for a still clear sky, 1 for a storm. Drives the noise in the field. */
  turbulence: number;
  /** How hard she is working: 0 idle, up to 1 mid-cycle. */
  energy: number;
  /** How live the picture is: 1 streaming, 0.34 snapshot only, 0.1 gone. */
  presence: number;
}

/** The four hours, as brightness. `sunrise` and `sunset` are deliberately unequal. */
const DAYNESS: Record<RuntimeState['environment']['timeOfDay'], number> = {
  night: 0.0,
  // Sunrise is the colder, thinner light of the two; sunset holds more of the day.
  sunrise: 0.42,
  day: 1.0,
  sunset: 0.54,
};

/**
 * The seven conditions, as agitation.
 *
 * `'unknown'` is low but not zero. Zero would render the perfect stillness of a
 * clear night, which is a claim about the sky; a faint drift says only that
 * something is out there.
 */
const TURBULENCE: Record<RuntimeState['environment']['weather']['condition'], number> = {
  clear: 0.08,
  cloudy: 0.32,
  rainy: 0.58,
  stormy: 0.92,
  snow: 0.36,
  fog: 0.46,
  unknown: 0.18,
};

/**
 * Where in the twelve stages the work is heaviest.
 *
 * Shaped rather than linear because the cycle is not linear: `REASON` and
 * `RESPOND` are where the language faculty runs, `PERSIST` is a transaction that
 * is over before it is seen. The curve is what makes the orb's rise read as
 * thinking rather than as a progress bar.
 */
const STAGE_ENERGY: Record<CognitiveStageName, number> = {
  PERCEIVE: 0.34,
  IDENTIFY: 0.4,
  RECALL: 0.56,
  UNDERSTAND: 0.72,
  REASON: 1.0,
  DECIDE: 0.8,
  ACT: 0.86,
  VERIFY: 0.68,
  RESPOND: 0.94,
  LEARN: 0.5,
  UPDATE: 0.38,
  PERSIST: 0.22,
};

const PRESENCE: Record<StreamStatus, number> = {
  live: 1,
  connecting: 0.55,
  /** The snapshot from `GET /api/state` is real; nothing is keeping it fresh. */
  unavailable: 0.34,
  closed: 0.1,
};

export interface MoodInput {
  state: RuntimeState | undefined;
  status: StreamStatus;
  /** True between sending a turn and its reply. Local knowledge; the stream lags. */
  thinking: boolean;
}

/**
 * The palette she falls back to before the first read.
 *
 * Derived rather than written down. `derivePalette` is the server's own table, and it
 * is a pure function over two enums with no imports of its own — so calling it here
 * costs a few lines of bundled arithmetic and buys the guarantee that the frame before
 * the first read and the frame after it are the same colours. Three hand-copied hexes
 * were what stood here before, and all three had drifted a byte or two per channel.
 *
 * `'unknown'` and not `'clear'`, deliberately: `'unknown'` is the one condition that
 * applies no weather modifier at all. Before the first read she does not know the sky
 * any more than she knows the hour, so she renders night and says nothing about the
 * weather — a clear-sky boost would be a claim.
 *
 * Exported so the renderer can start its easing here instead of keeping a fourth copy,
 * and so a test can hold it against the stylesheet's `@property` initial values.
 */
const AWAITING_PALETTE = derivePalette('night', 'unknown');

export const AWAITING: Mood = {
  primary: hexToRgb(AWAITING_PALETTE.primary),
  secondary: hexToRgb(AWAITING_PALETTE.secondary),
  accent: hexToRgb(AWAITING_PALETTE.accent),
  dayness: DAYNESS.night,
  turbulence: TURBULENCE.unknown,
  energy: 0,
  /** Always overridden by `PRESENCE[status]` below; this is only the type's default. */
  presence: PRESENCE.unavailable,
};

export function moodFrom({ state, status, thinking }: MoodInput): Mood {
  if (state === undefined) return { ...AWAITING, presence: PRESENCE[status] };

  const { environment, cognitive } = state;
  return {
    primary: hexToRgb(environment.derivedPalette.primary),
    secondary: hexToRgb(environment.derivedPalette.secondary),
    accent: hexToRgb(environment.derivedPalette.accent),
    dayness: DAYNESS[environment.timeOfDay] ?? 0,
    turbulence: TURBULENCE[environment.weather.condition] ?? 0.18,
    // Only local knowledge can say a cycle is *in flight*: the stream reports the
    // stage a cycle reached, not that it is still going. Without the `thinking`
    // gate the orb would sit at `PERSIST`'s weight forever after the first turn.
    energy: thinking ? (STAGE_ENERGY[cognitive.currentStage] ?? 0.4) : 0,
    presence: PRESENCE[status],
  };
}
