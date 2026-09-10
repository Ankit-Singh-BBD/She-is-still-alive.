/**
 * Configuration layer (`server/config/env.ts`).
 *
 * These tests exist because configuration is the one part of the application
 * that is written by a human under time pressure, in a file with no type
 * checker, and read exactly once at boot. Everything here is a mistake an
 * operator can actually make.
 *
 * Two of them are load-bearing beyond mere validation:
 *
 *  - `GOOGLE_API_KEY=` (the form `.env.example` ships) must read as *absent*.
 *    Read literally it is the empty string, which would have the application
 *    report a working language faculty and then send unauthenticated requests.
 *
 *  - The model names are the ones this application was asked for. Pinning them
 *    means a later edit cannot quietly substitute a different model.
 *
 *  - `.env.example` is checked against the schema in both directions. It is the
 *    only place an operator learns what is configurable, so a variable missing
 *    from it is a variable that effectively does not exist.
 */

import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';
import {
  loadConfig,
  describeConfig,
  ConfigError,
  DECLARED_ENV_VARS,
  DEFAULT_REASONING_MODEL,
  DEFAULT_LIVE_MODEL,
} from '@server/config/env.js';

describe('Configuration (server/config/env.ts)', () => {
  describe('defaults', () => {
    it('produces a complete, usable configuration from an empty environment', () => {
      const config = loadConfig({});

      expect(config.env).toBe('development');
      expect(config.isProduction).toBe(false);
      expect(config.server.port).toBe(3000);
      expect(config.database.path).toBe('./data/madhurita.db');
      expect(config.logging.level).toBe('info');
      expect(config.proactivity.enabled).toBe(true);
      expect(config.proactivity.quietHoursStart).toBe(22);
      expect(config.proactivity.quietHoursEnd).toBe(7);
      expect(config.backup.enabled).toBe(false);
      expect(config.flags.cognition).toBe(true);
      // Every faculty on from an empty environment, the advanced four included — see
      // `tests/wiring/personality-advanced.test.ts` for why that default changed, and
      // for the switches that turn them off one at a time.
      expect(config.flags.advancedModules).toBe(true);
    });

    it('binds loopback by default rather than every interface', () => {
      // She is a personal, local-first assistant holding one person's memory.
      // A default of 0.0.0.0 would publish an unauthenticated-by-default HTTP
      // surface to every device on the network the moment someone runs
      // `npm start` on a café wifi. Opening up has to be a deliberate act.
      expect(loadConfig({}).server.host).toBe('127.0.0.1');
      expect(loadConfig({ HOST: '0.0.0.0' }).server.host).toBe('0.0.0.0');
    });

    it('uses the models this application was built around', () => {
      const config = loadConfig({});
      // Pinned ids, asserted literally rather than against the constants, so that
      // changing a default is a deliberate act with a test to update — the reason
      // this assertion earns its keep is that `gemini-2.5-flash-lite` stopped
      // answering (404, "no longer available to new users") while it was still
      // the default, and every thinking stage threw. Switch to gemma-4-31b-it:
      // higher free-tier tokens via the same Google GenAI transport, zero Mac RAM
      // (hosted, not local).
      expect(config.llm.reasoningModel).toBe('gemma-4-31b-it');
      expect(config.llm.liveModel).toBe('gemini-3.1-flash-live-preview');
      expect(DEFAULT_REASONING_MODEL).toBe('gemma-4-31b-it');
      expect(DEFAULT_LIVE_MODEL).toBe('gemini-3.1-flash-live-preview');
    });
  });

  describe('an absent language faculty is a supported way to run', () => {
    it('boots with no GOOGLE_API_KEY and says so', () => {
      const config = loadConfig({});
      expect(config.llm.enabled).toBe(false);
      expect(config.llm.apiKey).toBeUndefined();
    });

    it('treats GOOGLE_API_KEY= as absent, not as an empty credential', () => {
      // This is the exact line `.env.example` ships. An operator who has not
      // filled it in yet must get the deterministic fallbacks, not a faculty
      // that reports itself ready and then fails every request it makes.
      const config = loadConfig({ GOOGLE_API_KEY: '' });
      expect(config.llm.enabled).toBe(false);
      expect(config.llm.apiKey).toBeUndefined();
    });

    it('treats an all-whitespace credential as absent', () => {
      expect(loadConfig({ GOOGLE_API_KEY: '   ' }).llm.enabled).toBe(false);
    });

    it('reports enabled once a credential is present, and never alters it', () => {
      // A credential is copied verbatim. Trailing-comment stripping and case
      // folding are applied to numbers, booleans and enums — never to a secret,
      // where a '#' is simply part of the value.
      const config = loadConfig({ GOOGLE_API_KEY: 'AIza-not-a-real-key#1' });
      expect(config.llm.enabled).toBe(true);
      expect(config.llm.apiKey).toBe('AIza-not-a-real-key#1');
    });
  });

  describe('coercion', () => {
    it('accepts the usual spellings of a boolean', () => {
      for (const truthy of ['true', 'TRUE', '1', 'yes', 'on']) {
        expect(loadConfig({ BACKUP_ENABLED: truthy }).backup.enabled).toBe(true);
      }
      for (const falsy of ['false', 'FALSE', '0', 'no', 'off']) {
        expect(loadConfig({ PROACTIVITY_ENABLED: falsy }).proactivity.enabled).toBe(false);
      }
    });

    it('tolerates the inline comments .env.example documents its values with', () => {
      // `SESSION_MAX_AGE_MS=2592000000  # 30 days` is a line an operator can
      // reasonably end up with. Failing on it would report an arithmetic error
      // for what is actually a stray note.
      const config = loadConfig({
        SESSION_MAX_AGE_MS: '2592000000  # 30 days',
        LOG_LEVEL: 'debug  # debug | info | warn | error',
      });
      expect(config.session.maxAgeMs).toBe(2_592_000_000);
      expect(config.logging.level).toBe('debug');
    });
  });

  describe('rejection', () => {
    it('names the offending variable', () => {
      expect(() => loadConfig({ PORT: 'three thousand' })).toThrow(ConfigError);
      try {
        loadConfig({ PORT: 'three thousand' });
        expect.unreachable('expected a ConfigError');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).message).toContain('PORT');
        expect((e as ConfigError).message).toContain('three thousand');
      }
    });

    it('reports every problem at once, not just the first', () => {
      // An operator filling in a fresh .env should learn about all four
      // mistakes in one pass instead of rediscovering them one restart at a
      // time.
      try {
        loadConfig({
          PORT: '99999',
          QUIET_HOURS_START: '25',
          LOG_LEVEL: 'chatty',
          LLM_TEMPERATURE: 'warm',
        });
        expect.unreachable('expected a ConfigError');
      } catch (e) {
        const issues = (e as ConfigError).issues.join('\n');
        expect(issues).toContain('PORT');
        expect(issues).toContain('QUIET_HOURS_START');
        expect(issues).toContain('LOG_LEVEL');
        expect(issues).toContain('LLM_TEMPERATURE');
        expect((e as ConfigError).issues).toHaveLength(4);
      }
    });

    it('rejects a provider it has no client for', () => {
      // Only @google/genai is installed. Accepting 'anthropic' and failing at
      // the first request would be a configuration knob that lies about what it
      // does — the same class of bug as an event type that is never published.
      try {
        loadConfig({ LLM_PROVIDER: 'anthropic' });
        expect.unreachable('expected a ConfigError');
      } catch (e) {
        expect((e as ConfigError).message).toContain('LLM_PROVIDER');
        expect((e as ConfigError).message).toContain('google');
      }
    });
  });

  describe('location', () => {
    it('is absent by default rather than guessed', () => {
      // Inventing a location and then narrating the weather there would be a
      // confident fabrication — the thing this codebase is most careful not to
      // do.
      expect(loadConfig({}).location).toBeUndefined();
    });

    it('accepts a full coordinate', () => {
      const config = loadConfig({
        LOCATION_LATITUDE: '26.8467',
        LOCATION_LONGITUDE: '80.9462',
        LOCATION_LABEL: 'Lucknow',
      });
      expect(config.location).toEqual({
        latitude: 26.8467,
        longitude: 80.9462,
        label: 'Lucknow',
      });
    });

    it('refuses half a coordinate', () => {
      expect(() => loadConfig({ LOCATION_LATITUDE: '26.8467' })).toThrow(/set together/);
      expect(() => loadConfig({ LOCATION_LONGITUDE: '80.9462' })).toThrow(/set together/);
    });

    it('rejects a coordinate off the planet', () => {
      expect(() =>
        loadConfig({ LOCATION_LATITUDE: '91', LOCATION_LONGITUDE: '0' }),
      ).toThrow(/LOCATION_LATITUDE/);
    });
  });

  describe('describeConfig', () => {
    const secret = 'AIza-super-secret-value-0123456789';

    it('never prints a credential', () => {
      // Part II: API keys live in .env, never in the database, never in the UI,
      // and no secret is logged. A boot banner that echoed the key would put it
      // in every scrollback and log file that ever saw the process start.
      const summary = describeConfig(loadConfig({ GOOGLE_API_KEY: secret }));
      expect(summary).not.toContain(secret);
      expect(summary).not.toContain('AIza');
      expect(summary).toContain('present');
    });

    it('says plainly when the faculty is absent, and what that means', () => {
      const summary = describeConfig(loadConfig({}));
      expect(summary).toContain('absent');
      expect(summary).toMatch(/deterministic fallbacks/);
    });

    it('reports the things an operator actually needs to confirm', () => {
      const summary = describeConfig(loadConfig({ PORT: '4100', DATABASE_PATH: './x/y.db' }));
      expect(summary).toContain('4100');
      expect(summary).toContain('./x/y.db');
      expect(summary).toContain('gemma-4-31b-it');
      expect(summary).toContain('gemini-3.1-flash-live-preview');
    });

    /**
     * Proactivity has two switches and the banner used to read only one of them.
     *
     * `server/app.ts:960` starts the sweep on `flags.proactivity && proactivity.enabled`.
     * With `FLAG_PROACTIVITY=false` and the default `PROACTIVITY_ENABLED=true` the banner
     * printed "proactivity  enabled · quiet 22:00-07:00" and then listed `proactivity`
     * under `flags off` four lines below it — about a runtime in which she can never
     * speak first. Observed while running the e2e voice probe, which sets exactly that.
     */
    it('reports proactivity as it will actually behave, not as one of its two switches', () => {
      const both = describeConfig(loadConfig({}));
      expect(both).toMatch(/proactivity\s+enabled · quiet 22:00-07:00/);

      const flagOff = describeConfig(loadConfig({ FLAG_PROACTIVITY: 'false' }));
      expect(flagOff).toMatch(/proactivity\s+disabled by FLAG_PROACTIVITY/);
      expect(flagOff).not.toMatch(/proactivity\s+enabled/);

      // Named rather than a bare "disabled", because an operator looking at
      // `PROACTIVITY_ENABLED=true` in their own `.env` would hunt the wrong variable.
      const settingOff = describeConfig(loadConfig({ PROACTIVITY_ENABLED: 'false' }));
      expect(settingOff).toMatch(/proactivity\s+disabled by PROACTIVITY_ENABLED/);

      const neither = describeConfig(
        loadConfig({ FLAG_PROACTIVITY: 'false', PROACTIVITY_ENABLED: 'false' }),
      );
      expect(neither).toMatch(/proactivity\s+disabled \(FLAG_PROACTIVITY, PROACTIVITY_ENABLED\)/);
    });
  });

  describe('.env.example documents exactly what is read', () => {
    // Drift here is silent in both directions and neither direction is caught by
    // anything else. A variable the schema reads but the example omits is
    // undiscoverable — the operator would have to read `server/config/env.ts` to
    // find out it exists. A variable the example advertises but the schema does
    // not read is worse: it invites someone to set it and then ignores them.
    //
    // Both were real. `LLM_VOICE_NAME` and `LLM_VOICE_LANGUAGE` were read at boot
    // and documented nowhere until 2026-09-05.
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');

    /** Assignment lines only — `KEY=`, at the start of a line, comments ignored. */
    const documented = new Set(
      example
        .split('\n')
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    );

    it('is actually comparing two populated lists', () => {
      // Both sides of the comparison are derived — one from a Zod shape, one from
      // a regex over a text file — and either could silently yield nothing, which
      // would make the two tests below pass while checking no variables at all.
      expect(DECLARED_ENV_VARS.length).toBeGreaterThan(30);
      expect(documented.size).toBeGreaterThan(30);
    });

    it('documents every variable the schema declares', () => {
      const undocumented = DECLARED_ENV_VARS.filter((name) => !documented.has(name));
      expect(undocumented).toEqual([]);
    });

    it('advertises no variable the schema ignores', () => {
      const declared = new Set(DECLARED_ENV_VARS);
      const unread = [...documented].filter((name) => !declared.has(name));
      expect(unread).toEqual([]);
    });

    it('leaves the credential blank, so a fresh copy runs without one', () => {
      // The absent-faculty tests above depend on this exact line shipping empty.
      expect(example).toMatch(/^GOOGLE_API_KEY=\s*$/m);
    });
  });
});
