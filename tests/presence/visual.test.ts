// @vitest-environment jsdom

/**
 * Colour and mood: the two pure layers under the field.
 *
 * Both are worth testing for one reason — every number in them is supposed to trace to
 * something the server reported, and the failure mode is a picture that looks fine while
 * saying something untrue (a full-brightness room over a dead stream, a clear sky she
 * never observed).
 */

import { describe, expect, it } from 'vitest';

import { derivePalette } from '@server/environment/palette.js';
import type { PaletteSpec, RuntimeState } from '@server/realtime/types.js';

import {
  applyPalette,
  hexToRgb,
  luminance,
  mix,
  paletteVars,
  rgbToHex,
} from '../../src/lib/palette.js';
import { AWAITING, moodFrom } from '../../src/visual/mood.js';

const NIGHT = derivePalette('night', 'unknown');
const DAY: PaletteSpec = { primary: '#e8eef4', secondary: '#f4f7fa', accent: '#3f7fbf' };

/** Only the two fields the mood reads. Cast because the rest of `RuntimeState` is not involved. */
function state(overrides: Record<string, unknown> = {}): RuntimeState {
  return {
    environment: {
      timeOfDay: 'night',
      weather: { condition: 'clear' },
      derivedPalette: NIGHT,
    },
    cognitive: {
      currentStage: 'RESPOND',
      cycleId: 'c',
      cycleStartedAt: 1,
      lastCompletedStage: 'RESPOND',
    },
    ...overrides,
  } as unknown as RuntimeState;
}

describe('hexToRgb', () => {
  it('reads six-digit hex as sRGB floats', () => {
    const [r, g, b] = hexToRgb('#0c0c17');
    expect(r).toBeCloseTo(12 / 255, 6);
    expect(g).toBeCloseTo(12 / 255, 6);
    expect(b).toBeCloseTo(23 / 255, 6);
  });

  it('expands the three-digit form', () => {
    expect(hexToRgb('#fff')).toEqual(hexToRgb('#ffffff'));
  });

  it('tolerates a missing hash and surrounding space', () => {
    expect(hexToRgb('  8f6ee0 ')).toEqual(hexToRgb('#8f6ee0'));
  });

  it('falls back to mid-grey rather than throwing on nonsense', () => {
    // A malformed palette is decoration going wrong. It must not be able to blank a screen.
    expect(rgbToHex(hexToRgb('not a colour'))).toBe('#808080');
    expect(rgbToHex(hexToRgb(''))).toBe('#808080');
  });

  it('round-trips through rgbToHex', () => {
    expect(rgbToHex(hexToRgb('#8f6ee0'))).toBe('#8f6ee0');
  });
});

describe('mix and luminance', () => {
  it('clamps the interpolation factor at both ends', () => {
    const black = hexToRgb('#000000');
    const white = hexToRgb('#ffffff');
    expect(rgbToHex(mix(black, white, -1))).toBe('#000000');
    expect(rgbToHex(mix(black, white, 2))).toBe('#ffffff');
  });

  it('orders dark below light', () => {
    expect(luminance(hexToRgb('#0c0c17'))).toBeLessThan(luminance(hexToRgb('#e8eef4')));
  });
});

describe('paletteVars', () => {
  it('emits exactly the fourteen properties the stylesheet registers', () => {
    expect(Object.keys(paletteVars(NIGHT)).sort()).toEqual([
      '--accent',
      '--accent-faint',
      '--accent-soft',
      '--glow',
      '--ground',
      '--hairline',
      '--ink',
      '--ink-dim',
      '--ink-faint',
      '--ink-soft',
      '--primary',
      '--secondary',
      '--surface',
      '--surface-strong',
    ]);
  });

  it('passes the three server-chosen colours through unchanged', () => {
    const vars = paletteVars(NIGHT);
    expect(vars['--primary']).toBe(NIGHT.primary);
    expect(vars['--secondary']).toBe(NIGHT.secondary);
    expect(vars['--accent']).toBe(NIGHT.accent);
  });

  it('emits every value in a form a registered <color> property can hold', () => {
    // A value `@property { syntax: '<color>' }` cannot parse is dropped silently, and
    // the property falls back to its initial value — a colour frozen at night.
    for (const [name, value] of Object.entries(paletteVars(NIGHT))) {
      expect(value, name).toMatch(/^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, [\d.]+\))$/);
    }
  });

  it('derives light ink over a dark palette and dark ink over a light one', () => {
    expect(paletteVars(NIGHT)['--ink']).toContain('240, 242, 247');
    expect(paletteVars(DAY)['--ink']).toContain('15, 18, 23');
  });

  it('sinks the ground below her own colour on a dark palette', () => {
    // The darkest point of the field has to be darker than she is, or the composition
    // reads inside-out: a vignette lighter than its subject.
    expect(luminance(hexToRgb(paletteVars(NIGHT)['--ground']!))).toBeLessThan(
      luminance(hexToRgb(NIGHT.primary)),
    );
  });

  it('keeps ink readable against the ground for all four hours', () => {
    for (const hour of ['night', 'sunrise', 'day', 'sunset'] as const) {
      const palette = derivePalette(hour, 'unknown');
      const vars = paletteVars(palette);
      const ground = luminance(hexToRgb(vars['--ground']!));
      // Ink is 0.94-ish white over every dark palette; the check is that the decision
      // went the right way, not that a particular contrast ratio was hit.
      const inkIsLight = vars['--ink']!.includes('240, 242, 247');
      expect(inkIsLight, hour).toBe(ground < 0.28);
    }
  });
});

describe('applyPalette', () => {
  it('writes onto the element it is given', () => {
    const element = document.createElement('div');
    applyPalette(NIGHT, element);
    expect(element.style.getPropertyValue('--accent')).toBe(NIGHT.accent);
    expect(element.style.getPropertyValue('--ink')).toContain('240, 242, 247');
  });

  it('does nothing rather than throwing when there is no element', () => {
    expect(() => applyPalette(NIGHT, null)).not.toThrow();
  });
});

describe('moodFrom', () => {
  it('falls back to the night palette with no weather applied', () => {
    const mood = moodFrom({ state: undefined, status: 'connecting', thinking: false });
    expect(mood.primary).toEqual(AWAITING.primary);
    // `'unknown'` applies no weather modifier, so the fallback claims nothing about the sky.
    expect(rgbToHex(mood.primary)).toBe(derivePalette('night', 'unknown').primary);
  });

  it('still reports the stream honestly while it has no state', () => {
    expect(moodFrom({ state: undefined, status: 'closed', thinking: false }).presence).toBe(
      moodFrom({ state: state(), status: 'closed', thinking: false }).presence,
    );
  });

  it('drains presence as the stream goes away', () => {
    const presence = (status: 'live' | 'connecting' | 'unavailable' | 'closed'): number =>
      moodFrom({ state: state(), status, thinking: false }).presence;
    expect(presence('live')).toBe(1);
    expect(presence('live')).toBeGreaterThan(presence('connecting'));
    expect(presence('connecting')).toBeGreaterThan(presence('unavailable'));
    expect(presence('unavailable')).toBeGreaterThan(presence('closed'));
  });

  it('only shows energy while a cycle is actually in flight', () => {
    const working = state({
      cognitive: {
        currentStage: 'REASON',
        cycleId: 'c',
        cycleStartedAt: 1,
        lastCompletedStage: 'RECALL',
      },
    });
    // Same state, both times. The difference is local knowledge that a turn is out.
    expect(moodFrom({ state: working, status: 'live', thinking: false }).energy).toBe(0);
    expect(moodFrom({ state: working, status: 'live', thinking: true }).energy).toBeGreaterThan(0);
  });

  it('does not fall to zero energy on a stage name it does not know', () => {
    const odd = state({
      cognitive: {
        currentStage: 'SOMETHING_NEW',
        cycleId: 'c',
        cycleStartedAt: 1,
        lastCompletedStage: 'RECALL',
      },
    });
    expect(moodFrom({ state: odd, status: 'live', thinking: true }).energy).toBeGreaterThan(0);
  });

  it('reads dayness from the hour', () => {
    const night = moodFrom({ state: state(), status: 'live', thinking: false });
    const day = moodFrom({
      state: state({
        environment: { timeOfDay: 'day', weather: { condition: 'clear' }, derivedPalette: DAY },
      }),
      status: 'live',
      thinking: false,
    });
    expect(night.dayness).toBe(0);
    expect(day.dayness).toBeGreaterThan(night.dayness);
  });

  it('reads turbulence from the sky, and keeps unknown between clear and a storm', () => {
    const turbulence = (condition: string): number =>
      moodFrom({
        state: state({
          environment: { timeOfDay: 'night', weather: { condition }, derivedPalette: NIGHT },
        }),
        status: 'live',
        thinking: false,
      }).turbulence;
    expect(turbulence('clear')).toBeLessThan(turbulence('unknown'));
    expect(turbulence('unknown')).toBeLessThan(turbulence('stormy'));
    // Not zero: perfect stillness is the picture of a clear night, which is a claim.
    expect(turbulence('unknown')).toBeGreaterThan(0);
  });
});
