/**
 * Colour, in the two forms the presence layer needs it.
 *
 * `derivedPalette` arrives as three `#rrggbb` strings, chosen server-side from
 * the hour and the sky (`server/environment/palette.ts` — the one file in that
 * directory allowed to guess, and only about colour). The DOM wants them as CSS
 * custom properties; the shader wants them as floats. Both conversions live here
 * so there is one definition of "her colours right now" rather than two that can
 * disagree by a rounding step.
 *
 * ## Ink is derived, not chosen
 *
 * All four base palettes are dark by design — the primary sits between 7% and
 * 20% lightness — so a light ink would be the obvious hard-coded answer. It is
 * still derived from the primary's luminance, because a hard-coded light ink is a
 * bet that the palette table never changes, and the cost of losing that bet is
 * unreadable text. Three lines of arithmetic buys the guarantee.
 */

import type { PaletteSpec } from '@server/realtime/types.js';

/** Red, green, blue — sRGB, 0..1. What a `vec3` uniform wants. */
export type Rgb = readonly [number, number, number];

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * `#rrggbb` (or `#rgb`) to sRGB floats. Falls back to mid-grey on anything else
 * rather than throwing: a palette is decoration, and a malformed one must not be
 * able to blank the screen.
 */
export function hexToRgb(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? `${raw[0]!}${raw[0]!}${raw[1]!}${raw[1]!}${raw[2]!}${raw[2]!}`
      : raw.length === 6
        ? raw
        : '808080';
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [0.5, 0.5, 0.5];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** `rgb` back to `#rrggbb`, for the CSS fallback that cannot take floats. */
export function rgbToHex([r, g, b]: Rgb): string {
  const byte = (channel: number): string =>
    Math.round(clamp01(channel) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/** Linear interpolation between two colours, in sRGB. Good enough for chrome. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const k = clamp01(t);
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** WCAG relative luminance. Used only to decide which way ink should go. */
export function luminance([r, g, b]: Rgb): number {
  const channel = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** `rgba()` from a colour and an alpha, for the properties that need transparency. */
export function rgba([r, g, b]: Rgb, alpha: number): string {
  const byte = (channel: number): number => Math.round(clamp01(channel) * 255);
  return `rgba(${byte(r)}, ${byte(g)}, ${byte(b)}, ${clamp01(alpha).toFixed(3)})`;
}

/**
 * The full set of custom properties the stylesheet reads.
 *
 * Returned as a plain record rather than written directly so it can be asserted
 * in a test without a DOM, and applied in one pass by `applyPalette`.
 */
export function paletteVars(palette: PaletteSpec): Record<string, string> {
  const primary = hexToRgb(palette.primary);
  const secondary = hexToRgb(palette.secondary);
  const accent = hexToRgb(palette.accent);

  // Which way is "away from the ground". Dark palettes get light ink.
  const dark = luminance(primary) < 0.28;
  const ink: Rgb = dark ? [0.94, 0.95, 0.97] : [0.06, 0.07, 0.09];

  return {
    '--primary': rgbToHex(primary),
    '--secondary': rgbToHex(secondary),
    '--accent': rgbToHex(accent),

    // The ground behind everything, and the two tones that lift off it. Mixed
    // toward the secondary rather than toward grey so surfaces stay in her key.
    '--ground': rgbToHex(mix(primary, [0, 0, 0], dark ? 0.55 : 0)),
    '--surface': rgba(mix(secondary, ink, 0.06), dark ? 0.06 : 0.5),
    '--surface-strong': rgba(mix(secondary, ink, 0.1), dark ? 0.11 : 0.66),

    '--ink': rgba(ink, 0.96),
    '--ink-soft': rgba(ink, 0.72),
    '--ink-dim': rgba(ink, 0.46),
    '--ink-faint': rgba(ink, 0.26),

    '--accent-soft': rgba(accent, 0.44),
    '--accent-faint': rgba(accent, 0.16),
    '--glow': rgba(accent, 0.3),
    '--hairline': rgba(ink, dark ? 0.09 : 0.14),
  };
}

/**
 * Writes the palette onto an element's inline style.
 *
 * On `document.documentElement` by default, because the transition that makes a
 * sunset arrive as a slow warming rather than a jump is declared on `:root` in
 * the stylesheet — and a custom property only animates where it is set.
 */
export function applyPalette(palette: PaletteSpec, target?: HTMLElement | null): void {
  const element = target ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (element === null) return;
  for (const [name, value] of Object.entries(paletteVars(palette))) {
    element.style.setProperty(name, value);
  }
}
