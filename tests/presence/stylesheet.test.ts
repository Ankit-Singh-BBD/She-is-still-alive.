/**
 * The stylesheet against the code that feeds it.
 *
 * Two facts about her colours cannot be imported at their point of use, so they are
 * written out by hand — a CSS at-rule cannot call a function, and neither can a
 * `<meta>` tag:
 *
 * - the fourteen colour `@property` `initial-value`s in `src/styles.css`
 * - `theme-color` in `index.html`
 *
 * Both are supposed to be her night palette with no weather applied, which is exactly
 * what `paletteVars(derivePalette('night', 'unknown'))` returns and exactly what
 * `mood.ts` hands the shader before the first read. Nothing in the browser complains
 * when they drift: an `initial-value` that disagrees is simply the colour the interface
 * holds until the first `RuntimeState` arrives, and a `theme-color` that disagrees is a
 * visible seam between the browser's chrome and the top of the field. Both were wrong
 * before this file existed.
 *
 * The block also registers one thing that is not a colour, and that one is asserted by
 * name in `NOT_A_COLOUR` rather than exempted — a registration nothing checks is a
 * registration that can quietly stop working.
 *
 * `src/styles.css` also names this file in a comment, which makes writing it the
 * difference between a claim the code honours and one it does not.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { derivePalette } from '@server/environment/palette.js';

import { paletteVars } from '../../src/lib/palette.js';

const CSS = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

const EXPECTED = paletteVars(derivePalette('night', 'unknown'));

/**
 * Custom properties written from JavaScript rather than declared in CSS.
 *
 * `var(--viewport)` has no declaration to find because `main.tsx` measures it from
 * `window.visualViewport` before first paint. Listing it here is what lets the
 * "every `var()` resolves" test below treat every *other* undeclared name as the
 * typo it is.
 */
const WRITTEN_FROM_JS = new Set(['--viewport']);

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * `#rrggbb` or `rgba(r, g, b, a)` to numbers.
 *
 * Compared as numbers and not as strings on purpose: `rgba()` in `palette.ts` formats
 * alpha with `toFixed(3)`, so the derived value is `rgba(39, 41, 57, 0.060)` while any
 * human writing the same colour into CSS writes `0.06`. Those are the same colour, and
 * a string comparison would fail on the zero.
 */
function parseColour(value: string): Colour {
  const text = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex !== null) {
    const n = Number.parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text);
  if (rgba !== null) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  throw new Error(`not a colour this test can parse: ${JSON.stringify(value)}`);
}

interface Registration {
  syntax: string;
  inherits: string;
  initial: string;
}

/** Every `@property` at-rule in the stylesheet, by name, in source order. */
function registrations(): Map<string, Registration> {
  const found = new Map<string, Registration>();
  const block = /@property\s+(--[\w-]+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = block.exec(CSS)) !== null) {
    const body = match[2]!;
    const field = (name: string): string => {
      const hit = new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(body);
      return hit === null ? '' : hit[1]!.trim();
    };
    found.set(match[1]!, {
      syntax: field('syntax'),
      inherits: field('inherits'),
      initial: field('initial-value'),
    });
  }
  return found;
}

/**
 * The registrations that are not palette colours, and what each one has to be.
 *
 * `--level` is the microphone's own loudness: written per animation frame by
 * `src/ui/Voice.tsx` and read inside a `calc()` by `.mic::after`. It is asserted here
 * rather than merely excused from the colour rules below, because both ways of getting
 * it wrong are silent. `inherits: false` would stop the number at the button and never
 * reach the pseudo-element that draws the ring; a syntax of anything but `<number>`
 * would make every per-frame write an invalid declaration, which CSS discards in favour
 * of the initial value. Either one looks exactly like a room where nobody is talking.
 */
const NOT_A_COLOUR: Record<string, Registration> = {
  '--level': { syntax: '<number>', inherits: 'true', initial: '0' },
};

/** The registrations that are supposed to be one of her palette colours. */
function colourRegistrations(): Map<string, Registration> {
  const found = registrations();
  for (const name of Object.keys(NOT_A_COLOUR)) found.delete(name);
  return found;
}

describe('the @property registrations in src/styles.css', () => {
  it('registers exactly the properties paletteVars writes, and no others', () => {
    // Both directions matter. A property written but not registered cannot transition,
    // which is the entire reason the block exists. A property registered but never
    // written is a colour the stylesheet can read that nothing will ever update. A
    // registration that is neither a palette colour nor named in `NOT_A_COLOUR` fails
    // here, which is what keeps the next non-colour from arriving unasserted.
    expect([...colourRegistrations().keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('declares every colour as an inheriting <color>', () => {
    for (const [name, registration] of colourRegistrations()) {
      // A value the declared syntax cannot parse is dropped silently and the property
      // falls back to its initial value — the room frozen at night. And `inherits:
      // false` would stop the palette at `<html>`, where nothing is painted.
      expect(registration.syntax.replace(/['"]/g, ''), name).toBe('<color>');
      expect(registration.inherits, name).toBe('true');
    }
  });

  it('declares every non-colour as the type its reader needs', () => {
    const found = registrations();
    for (const [name, wanted] of Object.entries(NOT_A_COLOUR)) {
      const registration = found.get(name);
      expect(registration, name).toBeDefined();
      expect(registration!.syntax.replace(/['"]/g, ''), name).toBe(wanted.syntax);
      expect(registration!.inherits, name).toBe(wanted.inherits);
      expect(registration!.initial, name).toBe(wanted.initial);
    }
  });

  it('gives every one her night palette as its initial value', () => {
    const found = registrations();
    for (const [name, expected] of Object.entries(EXPECTED)) {
      const registration = found.get(name);
      expect(registration, name).toBeDefined();
      const actual = parseColour(registration!.initial);
      const wanted = parseColour(expected);
      expect([actual.r, actual.g, actual.b], name).toEqual([wanted.r, wanted.g, wanted.b]);
      expect(actual.a, `${name} alpha`).toBeCloseTo(wanted.a, 3);
    }
  });
});

describe('index.html', () => {
  it('paints the browser chrome her ground colour', () => {
    const meta = /<meta\s+name="theme-color"\s+content="([^"]+)"\s*\/?>/.exec(HTML);
    expect(meta, 'no theme-color meta tag found').not.toBeNull();
    // `App.tsx` rewrites this attribute from `--ground` on every palette change, so
    // the static value here is only what the OS paints before the first read. Getting
    // it wrong is a visible band above the field for exactly as long as that takes.
    expect(parseColour(meta![1]!)).toEqual(parseColour(EXPECTED['--ground']!));
  });

  it('loads the entry point main.tsx actually lives at', () => {
    expect(HTML).toContain('src="/src/main.tsx"');
    expect(HTML).toContain('id="root"');
  });
});

describe('every var() in the stylesheet resolves', () => {
  it('reads no custom property that is neither declared nor written from JS', () => {
    // `var(--typo)` is not an error in CSS. The declaration it appears in is thrown
    // away at computed-value time and the element keeps whatever it inherited, so a
    // renamed property shows up as one shade that stopped following the hour.
    const declared = new Set<string>([...registrations().keys(), ...WRITTEN_FROM_JS]);
    for (const match of CSS.matchAll(/(--[\w-]+)\s*:/g)) declared.add(match[1]!);

    const used = new Set<string>();
    for (const match of CSS.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(match[1]!);

    expect([...used].filter((name) => !declared.has(name)).sort()).toEqual([]);
  });
});
