/**
 * The colours she is wearing, derived from the sky.
 *
 * ## This file is the only place a guess is allowed
 *
 * Everything else in `server/environment/` refuses to invent: unobserved
 * weather is `'unknown'`, an unknown location is absent. But something has to be
 * on screen regardless, and "we do not know the weather" is not a colour. So the
 * derivation lives here, in one function, where it is visible and reviewable —
 * rather than being smuggled into `WeatherSnapshot` as a claim about the sky.
 *
 * The rule that keeps it honest: `'unknown'` weather applies **no** weather
 * modifier at all. She renders the time of day, which she does know, and says
 * nothing with colour about the condition, which she does not. A viewer never
 * sees storm-dark glass on a clear afternoon because a request timed out.
 *
 * ## Why HSL
 *
 * Weather is a *modifier*, not a palette: overcast desaturates and darkens
 * whatever the hour already was. Expressed as hex triplets that needs a
 * separate table for every hour × condition pair — twenty-eight of them, each
 * hand-tuned and each able to drift out of agreement with its neighbours. In
 * HSL it is one small delta per condition applied to four base palettes, which
 * is both shorter and impossible to make internally inconsistent.
 */

import type { PaletteSpec, TimeOfDay } from '@server/realtime/types.js';

import type { WeatherCondition } from './weather.js';

interface Hsl {
  /** Degrees, 0–360. */
  h: number;
  /** Percent, 0–100. */
  s: number;
  /** Percent, 0–100. */
  l: number;
}

interface HslPalette {
  primary: Hsl;
  secondary: Hsl;
  accent: Hsl;
}

/** How a condition bends the hour's palette. Absent fields mean "unchanged". */
interface WeatherModifier {
  /** Degrees to rotate the hue, signed. */
  hueShift?: number;
  /** Multiplied into saturation. Below 1 drains colour. */
  saturation?: number;
  /** Multiplied into lightness. Below 1 darkens. */
  lightness?: number;
  /** Added to accent saturation only, so the one bright thing survives fog. */
  accentSaturation?: number;
}

/**
 * Four hours of the day, deep and desaturated.
 *
 * Low saturation across the board is the "subtle, not UI-heavy" brief taken
 * literally: the primary is close to black at night and close to white at
 * midday, and the accent is the only element permitted to be vivid.
 */
const BASE: Record<TimeOfDay, HslPalette> = {
  night: {
    primary: { h: 240, s: 32, l: 7 },
    secondary: { h: 235, s: 26, l: 14 },
    accent: { h: 265, s: 62, l: 62 },
  },
  sunrise: {
    primary: { h: 22, s: 34, l: 16 },
    secondary: { h: 12, s: 42, l: 28 },
    accent: { h: 32, s: 78, l: 64 },
  },
  day: {
    primary: { h: 205, s: 24, l: 20 },
    secondary: { h: 200, s: 22, l: 34 },
    accent: { h: 190, s: 66, l: 60 },
  },
  sunset: {
    primary: { h: 288, s: 30, l: 13 },
    secondary: { h: 320, s: 34, l: 24 },
    accent: { h: 18, s: 76, l: 62 },
  },
};

/**
 * `'unknown'` is deliberately absent — see the honesty note above. Its absence
 * is what makes the "no modifier" path unreachable by accident: adding an entry
 * would be a visible edit to this table, not a typo somewhere else.
 */
const WEATHER: Partial<Record<WeatherCondition, WeatherModifier>> = {
  clear: { saturation: 1.08, lightness: 1.04 },
  cloudy: { saturation: 0.72, lightness: 0.94 },
  rainy: { hueShift: -12, saturation: 0.6, lightness: 0.84 },
  stormy: { hueShift: -20, saturation: 0.5, lightness: 0.7, accentSaturation: 8 },
  snow: { hueShift: 8, saturation: 0.44, lightness: 1.22 },
  fog: { saturation: 0.3, lightness: 1.1, accentSaturation: -10 },
};

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

function applyModifier(colour: Hsl, mod: WeatherModifier, isAccent: boolean): Hsl {
  const saturation = colour.s * (mod.saturation ?? 1) + (isAccent ? (mod.accentSaturation ?? 0) : 0);
  return {
    h: ((colour.h + (mod.hueShift ?? 0)) % 360 + 360) % 360,
    s: clamp(saturation, 0, 100),
    l: clamp(colour.l * (mod.lightness ?? 1), 0, 100),
  };
}

/** HSL to `#rrggbb`. The standard conversion, written out to avoid a dependency. */
export function hslToHex({ h, s, l }: Hsl): string {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const hue = (((h % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((hue % 2) - 1));

  const [r, g, b] =
    hue < 1 ? [chroma, second, 0]
    : hue < 2 ? [second, chroma, 0]
    : hue < 3 ? [0, chroma, second]
    : hue < 4 ? [0, second, chroma]
    : hue < 5 ? [second, 0, chroma]
    : [chroma, 0, second];

  const offset = light - chroma / 2;
  const byte = (channel: number): string =>
    Math.round(clamp((channel + offset) * 255, 0, 255))
      .toString(16)
      .padStart(2, '0');

  return `#${byte(r!)}${byte(g!)}${byte(b!)}`;
}

/**
 * The palette for an hour and a sky.
 *
 * Pure and total: every `TimeOfDay` × `WeatherCondition` pair has an answer, and
 * the same pair always gives the same one, so a snapshot test can pin it.
 */
export function derivePalette(timeOfDay: TimeOfDay, condition: WeatherCondition): PaletteSpec {
  const base = BASE[timeOfDay];
  const mod = WEATHER[condition];

  if (mod === undefined) {
    // `'unknown'`: render the hour, claim nothing about the weather.
    return {
      primary: hslToHex(base.primary),
      secondary: hslToHex(base.secondary),
      accent: hslToHex(base.accent),
    };
  }

  return {
    primary: hslToHex(applyModifier(base.primary, mod, false)),
    secondary: hslToHex(applyModifier(base.secondary, mod, false)),
    accent: hslToHex(applyModifier(base.accent, mod, true)),
  };
}
