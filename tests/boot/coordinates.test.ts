/**
 * `parseCoordinate` (`server/config/env.ts`).
 *
 * This file exists because of a boot failure, not a hypothetical. The owner
 * filled in `.env`, pasted his home from Google Maps' own "copy coordinates"
 * button — which hands you `25°58'31.7"N` — and she refused to start:
 *
 *     ConfigError: LOCATION_LATITUDE: expected a number, received "25°58'31.7"N"
 *
 * A location is *optional* in this application. Turning the one notation people
 * actually paste into a fatal error, for a variable she is happy to run without,
 * was the wrong trade by a wide margin.
 *
 * So the grammar widened, and a widened grammar is exactly the kind of thing that
 * quietly accepts nonsense. Every form the docstring promises is pinned here, and
 * so is every refusal — each of those asserted on the *message*, because a
 * coordinate that is rejected without saying what to write instead just moves the
 * dead end one step later.
 */

import { describe, it, expect } from 'vitest';
import { parseCoordinate, loadConfig, ConfigError } from '@server/config/env.js';

/** Unwraps a parse that is expected to succeed, failing loudly if it did not. */
function degrees(text: string, axis: 'latitude' | 'longitude'): number {
  const parsed = parseCoordinate(text, axis);
  if (!parsed.ok) expect.unreachable(`expected "${text}" to parse: ${parsed.problem}`);
  return parsed.degrees;
}

/** Unwraps a parse that is expected to fail, returning the operator-facing message. */
function problem(text: string, axis: 'latitude' | 'longitude'): string {
  const parsed = parseCoordinate(text, axis);
  if (parsed.ok) expect.unreachable(`expected "${text}" to be refused, got ${parsed.degrees}`);
  return parsed.problem;
}

describe('parseCoordinate', () => {
  describe('the notations a person actually has a coordinate in', () => {
    it('reads decimal degrees, the canonical form', () => {
      expect(degrees('25.9755', 'latitude')).toBe(25.9755);
      expect(degrees('79.4489', 'longitude')).toBe(79.4489);
      expect(degrees('0', 'latitude')).toBe(0);
      expect(degrees('+25.5', 'latitude')).toBe(25.5);
    });

    it('reads a hemisphere from a sign', () => {
      expect(degrees('-79.4489', 'longitude')).toBe(-79.4489);
      expect(degrees('-25.9755', 'latitude')).toBe(-25.9755);
    });

    it('reads a hemisphere from a letter, on either side of the number', () => {
      expect(degrees('25.9755 N', 'latitude')).toBe(25.9755);
      expect(degrees('25.9755 S', 'latitude')).toBe(-25.9755);
      expect(degrees('79.4489 E', 'longitude')).toBe(79.4489);
      expect(degrees('79.4489 W', 'longitude')).toBe(-79.4489);
      // Written before the number as often as after it, and lower case as often
      // as upper.
      expect(degrees('N25.9755', 'latitude')).toBe(25.9755);
      expect(degrees('s 25.9755', 'latitude')).toBe(-25.9755);
      expect(degrees('w79.4489', 'longitude')).toBe(-79.4489);
    });

    it('reads degrees-minutes-seconds however it was punctuated', () => {
      // All four of these are the same place, and all four are things a person
      // ends up with: Maps' own output, the same with spaces, the separators
      // dropped entirely, and the colon form some tools emit.
      const expected = 25.9754722;
      expect(degrees(`25°58'31.7"N`, 'latitude')).toBe(expected);
      expect(degrees(`25° 58' 31.7"`, 'latitude')).toBe(expected);
      expect(degrees('25 58 31.7 N', 'latitude')).toBe(expected);
      expect(degrees('25:58:31.7N', 'latitude')).toBe(expected);
      expect(degrees(`25°58′31.7″N`, 'latitude')).toBe(expected);
    });

    it('reads degrees and minutes with no seconds', () => {
      expect(degrees(`25°58'`, 'latitude')).toBe(25.9666667);
      expect(degrees('25 58', 'latitude')).toBe(25.9666667);
    });

    it('reads the exact pair sitting in the owner’s .env', () => {
      // Pasted from Maps and then trimmed of its closing quote, which is what
      // happens when the `"` looks like it might be a shell problem. This pair is
      // the reason the parser exists; if it ever stops reading it, she stops
      // knowing where she is.
      expect(degrees(`25°58'31.7`, 'latitude')).toBe(25.9754722);
      expect(degrees(`79°26'56.0`, 'longitude')).toBe(79.4488889);
    });

    it('accepts the poles and the antimeridian, and no further', () => {
      expect(degrees('90', 'latitude')).toBe(90);
      expect(degrees('-90', 'latitude')).toBe(-90);
      expect(degrees('180', 'longitude')).toBe(180);
      expect(degrees('180 W', 'longitude')).toBe(-180);
      // A latitude of 90 is a place; 90 for a longitude is also a place, which is
      // why the two limits cannot be one constant.
      expect(degrees('90', 'longitude')).toBe(90);
    });

    it('never yields negative zero', () => {
      // `-0` survives arithmetic, compares equal to `0`, and then serialises into
      // the weather request as `-0`. Object.is is the only assertion that can see
      // the difference, so it is the one used.
      expect(Object.is(degrees('0 S', 'latitude'), 0)).toBe(true);
      expect(Object.is(degrees('-0', 'longitude'), 0)).toBe(true);
      expect(Object.is(degrees('0 0 0 ', 'latitude'), 0)).toBe(true);
    });
  });

  describe('refusals, each of which has to say what to write instead', () => {
    it('catches both coordinates pasted into one variable', () => {
      // The other thing that happens when someone copies a location: Maps gives
      // you "25.9755, 79.4489" as a single string, and the obvious move is to
      // paste it into the first of the two variables.
      expect(problem('25.9755, 79.4489', 'latitude')).toContain('LOCATION_LONGITUDE');
      expect(problem('25.9755; 79.4489', 'latitude')).toContain('both coordinates');
      expect(problem('79.4489, 25.9755', 'longitude')).toContain('LOCATION_LATITUDE');
    });

    it('catches a hemisphere letter belonging to the other axis', () => {
      // The paste that is off by one variable: longitude into LOCATION_LATITUDE.
      // Read without this check, `E` is simply ignored and the number is accepted
      // as a latitude — a silently wrong place rather than an error.
      expect(problem(`79°26'56"E`, 'latitude')).toContain('longitude hemisphere');
      expect(problem(`79°26'56"E`, 'latitude')).toMatch(/N or S/);
      expect(problem('25.9755 N', 'longitude')).toMatch(/E or W/);
    });

    it('catches a letter that contradicts a minus sign', () => {
      expect(problem('-25.9755 N', 'latitude')).toContain('minus sign');
      expect(problem('-79.4489 W', 'longitude')).toContain('one or the other');
    });

    it('catches two hemisphere letters', () => {
      expect(problem('N 25.9755 S', 'latitude')).toContain('two hemisphere letters');
    });

    it('catches minutes or seconds at sixty', () => {
      expect(problem('25 60 0', 'latitude')).toMatch(/0 to 59/);
      expect(problem('25 30 60', 'latitude')).toMatch(/0 to 59/);
      // One tick below the limit is a real place and stays one.
      expect(parseCoordinate('25 59 59.9', 'latitude').ok).toBe(true);
    });

    it('catches two notations mixed into one value', () => {
      // 25.5 degrees and 30 minutes are two ways of saying the same kind of thing,
      // so a value carrying both cannot be read without guessing which was meant.
      expect(problem('25.5 30', 'latitude')).toContain('fractional degrees');
      expect(problem('25 30.5 10', 'latitude')).toContain('fractional minutes');
    });

    it('catches a coordinate that is off the planet', () => {
      expect(problem('91', 'latitude')).toMatch(/-90 to 90/);
      expect(problem('90 0 0.1', 'latitude')).toMatch(/-90 to 90/);
      expect(problem('181', 'longitude')).toMatch(/-180 to 180/);
      expect(problem('-181', 'longitude')).toMatch(/-180 to 180/);
    });

    it('catches more parts than a coordinate has', () => {
      expect(problem('25 30 10 5', 'latitude')).toContain('at most');
    });

    it('catches things that are not a coordinate at all', () => {
      for (const nonsense of ['', '   ', 'somewhere', 'N', '25.9.755', '--25', '25-58']) {
        expect(problem(nonsense, 'latitude')).toMatch(/latitude/);
      }
    });
  });

  describe('through loadConfig, which is the only way an operator meets it', () => {
    it('turns the owner’s pasted pair into the decimal degrees the weather call needs', () => {
      const config = loadConfig({
        LOCATION_LATITUDE: `25°58'31.7"N`,
        LOCATION_LONGITUDE: `79°26'56.0"E`,
        LOCATION_LABEL: `Ankit's Home`,
      });
      expect(config.location).toEqual({
        latitude: 25.9754722,
        longitude: 79.4488889,
        label: `Ankit's Home`,
      });
    });

    it('tolerates the inline comment a documented .env line carries', () => {
      const config = loadConfig({
        LOCATION_LATITUDE: '25.9755  # home',
        LOCATION_LONGITUDE: '79.4489  # home',
      });
      expect(config.location?.latitude).toBe(25.9755);
      expect(config.location?.longitude).toBe(79.4489);
    });

    it('names the variable and quotes the value it could not read', () => {
      try {
        loadConfig({ LOCATION_LATITUDE: 'my house', LOCATION_LONGITUDE: '79.4489' });
        expect.unreachable('expected a ConfigError');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).message).toContain('LOCATION_LATITUDE');
        expect((e as ConfigError).message).toContain('my house');
      }
    });

    it('reports both coordinates at once when both are wrong', () => {
      try {
        loadConfig({ LOCATION_LATITUDE: '91', LOCATION_LONGITUDE: '181' });
        expect.unreachable('expected a ConfigError');
      } catch (e) {
        expect((e as ConfigError).issues).toHaveLength(2);
      }
    });

    it('still refuses half a coordinate, however well written', () => {
      // A hemisphere and a notation this parser is happy with does not make one
      // number into a place.
      expect(() => loadConfig({ LOCATION_LATITUDE: `25°58'31.7"N` })).toThrow(/set together/);
      expect(() => loadConfig({ LOCATION_LONGITUDE: '79.4489' })).toThrow(/set together/);
    });

    it('leaves her without a location when the example file is copied unedited', () => {
      // `.env.example` ships all three of these blank, and blank has to keep
      // meaning absent — the alternative is a boot failure on an untouched copy.
      expect(
        loadConfig({ LOCATION_LATITUDE: '', LOCATION_LONGITUDE: '', LOCATION_LABEL: '' }).location,
      ).toBeUndefined();
    });
  });
});
