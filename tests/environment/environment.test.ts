/**
 * Where she is and what the sky is doing.
 *
 * These tests exist to pin the honesty rules, because every one of them is a
 * place where the easy implementation lies:
 *
 * - A provider that fails must not overwrite a good reading with `'unknown'`.
 * - A missing location must be *absent*, never `{ lat: 0, lng: 0 }`.
 * - `timeOfDay` must come from the sun where the owner is, not from the hour on
 *   the server's clock. One instant is checked against four zones for that.
 * - Open-Meteo's local wall-clock strings carry no zone marker, so a naive
 *   `Date.parse` puts sunrise hours away. The offset conversion is pinned
 *   against the real body shape, captured live.
 * - `'unknown'` weather must apply no colour modifier at all — she renders the
 *   hour she knows and says nothing about the sky she does not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';

import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { EventBus } from '@server/events/event-bus.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import type { GeoSnapshot, TimeOfDay } from '@server/realtime/types.js';
import {
  conditionForWmoCode,
  derivePalette,
  hourInZone,
  hslToHex,
  parseOpenMeteo,
  resolveTimeOfDay,
  unknownWeather,
  EnvironmentService,
  OpenMeteoProvider,
  TRANSITION_WINDOW_MS,
  WEATHER_TTL_MS,
  type WeatherCondition,
  type WeatherObservation,
  type WeatherProvider,
} from '@server/environment/index.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

/** 2026-09-04T12:45:00Z — which is 18:15 in Kolkata, where the live body was taken. */
const NOW = Date.UTC(2026, 8, 4, 12, 45, 0);
const IST_OFFSET = 19_800; // +05:30 in seconds

const DELHI: GeoSnapshot = { lat: 28.6139, lng: 77.209 };

/**
 * The real Open-Meteo response for Delhi, captured with `curl` while writing
 * this. Kept verbatim so a change in what the parser tolerates is a change to a
 * body that genuinely arrived, not to one that was invented to pass.
 */
const LIVE_BODY = {
  latitude: 28.625,
  longitude: 77.25,
  generationtime_ms: 0.0349,
  utc_offset_seconds: IST_OFFSET,
  timezone: 'Asia/Kolkata',
  timezone_abbreviation: 'GMT+5:30',
  elevation: 219,
  current_units: { time: 'iso8601', temperature_2m: '°C', weather_code: 'wmo code', is_day: '' },
  current: {
    time: '2026-09-04T18:15',
    interval: 900,
    temperature_2m: 28.6,
    weather_code: 3,
    is_day: 1,
  },
  daily_units: { time: 'iso8601', sunrise: 'iso8601', sunset: 'iso8601' },
  daily: { time: ['2026-09-04'], sunrise: ['2026-09-04T06:00'], sunset: ['2026-09-04T18:39'] },
};

/** 06:00 IST and 18:39 IST as epoch ms — what the parser must produce. */
const LIVE_SUNRISE = Date.UTC(2026, 8, 4, 6, 0) - IST_OFFSET * 1000;
const LIVE_SUNSET = Date.UTC(2026, 8, 4, 18, 39) - IST_OFFSET * 1000;

const observation = (over: Partial<WeatherObservation> = {}): WeatherObservation => ({
  condition: 'clear',
  temperature: 28.6,
  observedAt: NOW,
  sunrise: undefined,
  sunset: undefined,
  isDay: undefined,
  timeZone: undefined,
  ...over,
});

/** Hands back whatever `next` currently holds, and records every call. */
class FakeProvider implements WeatherProvider {
  readonly calls: GeoSnapshot[] = [];
  next: WeatherObservation;

  constructor(next: WeatherObservation = observation()) {
    this.next = next;
  }

  observe(location: GeoSnapshot): Promise<WeatherObservation> {
    this.calls.push({ ...location });
    return Promise.resolve(this.next);
  }
}

const ALL_TIMES: TimeOfDay[] = ['night', 'sunrise', 'day', 'sunset'];
const ALL_CONDITIONS: WeatherCondition[] = [
  'clear',
  'cloudy',
  'rainy',
  'stormy',
  'snow',
  'fog',
  'unknown',
];

describe('WMO codes collapsed onto the renderable conditions', () => {
  it('maps every code the visual layer knows how to draw', () => {
    expect(conditionForWmoCode(0)).toBe('clear');
    for (const code of [1, 2, 3]) expect(conditionForWmoCode(code)).toBe('cloudy');
    for (const code of [45, 48]) expect(conditionForWmoCode(code)).toBe('fog');
    for (const code of [95, 96, 99]) expect(conditionForWmoCode(code)).toBe('stormy');
    for (const code of [71, 73, 75, 77, 85, 86]) expect(conditionForWmoCode(code)).toBe('snow');
    for (const code of [51, 55, 61, 63, 65, 67, 80, 82]) {
      expect(conditionForWmoCode(code)).toBe('rainy');
    }
  });

  it('says it does not know rather than guessing, for a code nobody has seen', () => {
    // The honesty case: WMO 4677 has gaps and the table may grow. An unmapped
    // code must not fall through to 'clear' just because clear is first.
    for (const code of [4, 20, 44, 70, 90, 100, -1, Number.NaN]) {
      expect(conditionForWmoCode(code)).toBe('unknown');
    }
  });
});

describe('parseOpenMeteo', () => {
  it('reads the live body, converting local wall-clock through the offset', () => {
    const parsed = parseOpenMeteo(LIVE_BODY);

    expect(parsed.condition).toBe('cloudy'); // weather_code 3, overcast
    expect(parsed.temperature).toBe(28.6);
    expect(parsed.timeZone).toBe('Asia/Kolkata');
    expect(parsed.isDay).toBe(true);

    // The bug this pins: '2026-09-04T18:15' has no zone marker, so a naive
    // Date.parse reads it as the *server's* local time. It is 12:45Z.
    expect(parsed.observedAt).toBe(NOW);
    expect(parsed.sunrise).toBe(LIVE_SUNRISE);
    expect(parsed.sunset).toBe(LIVE_SUNSET);
    expect(new Date(parsed.sunrise!).toISOString()).toBe('2026-09-04T00:30:00.000Z');
  });

  it('does not shift a timestamp that already carries its own Z', () => {
    const parsed = parseOpenMeteo({
      utc_offset_seconds: 0,
      current: { time: '2026-09-04T12:45Z', weather_code: 0 },
    });
    expect(parsed.observedAt).toBe(NOW);
  });

  it('claims nothing for a body that is not an object', () => {
    for (const body of [null, undefined, 'clear', 42, []]) {
      expect(parseOpenMeteo(body).condition).toBe('unknown');
    }
  });

  it('claims nothing about the sky but still reads a temperature it was given', () => {
    const parsed = parseOpenMeteo({ current: { temperature_2m: 19.2 } });
    expect(parsed.condition).toBe('unknown');
    expect(parsed.temperature).toBe(19.2);
    expect(parsed.sunrise).toBeUndefined();
    expect(parsed.sunset).toBeUndefined();
    expect(parsed.isDay).toBeUndefined();
  });

  it('unknownWeather() carries no claim at all', () => {
    expect(unknownWeather(NOW)).toEqual({
      condition: 'unknown',
      temperature: undefined,
      observedAt: NOW,
      sunrise: undefined,
      sunset: undefined,
      isDay: undefined,
      timeZone: undefined,
    });
  });
});

describe('OpenMeteoProvider.observe', () => {
  it('asks for exactly the fields the parser reads, at four decimal places', async () => {
    let seen: string | undefined;
    const provider = new OpenMeteoProvider({
      fetchImpl: (input) => {
        seen = String(input);
        return Promise.resolve(new Response(JSON.stringify(LIVE_BODY), { status: 200 }));
      },
    });

    const result = await provider.observe(DELHI);
    expect(result.condition).toBe('cloudy');

    const url = new URL(seen!);
    expect(url.searchParams.get('latitude')).toBe('28.6139');
    expect(url.searchParams.get('longitude')).toBe('77.2090');
    expect(url.searchParams.get('current')).toBe('temperature_2m,weather_code,is_day');
    expect(url.searchParams.get('daily')).toBe('sunrise,sunset');
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('forecast_days')).toBe('1');
    // No key, so nothing secret can leak into a URL or a log line.
    expect(url.searchParams.has('apikey')).toBe(false);
  });

  it('resolves to not-knowing rather than rejecting, whatever went wrong', async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      () => Promise.resolve(new Response('nope', { status: 503 })),
      () => Promise.resolve(new Response('<html>not json</html>', { status: 200 })),
    ];

    for (const fetchImpl of failures) {
      const provider = new OpenMeteoProvider({ fetchImpl: fetchImpl as unknown as typeof fetch });
      // A rejection here would take a cognitive cycle down with it.
      const result = await provider.observe(DELHI);
      expect(result.condition).toBe('unknown');
      expect(result.temperature).toBeUndefined();
    }
  });
});

describe('resolveTimeOfDay', () => {
  describe('tier 1 — the actual sun', () => {
    const solar = { sunrise: LIVE_SUNRISE, sunset: LIVE_SUNSET, timeZone: 'Asia/Kolkata' };

    it('is sunset 24 minutes before the sun goes down in Delhi', () => {
      expect(resolveTimeOfDay(solar, NOW)).toEqual({ timeOfDay: 'sunset', basis: 'solar' });
    });

    it('holds the transition to the edge of the window and not past it', () => {
      expect(resolveTimeOfDay(solar, LIVE_SUNRISE).timeOfDay).toBe('sunrise');
      expect(resolveTimeOfDay(solar, LIVE_SUNRISE + TRANSITION_WINDOW_MS).timeOfDay).toBe('sunrise');
      expect(resolveTimeOfDay(solar, LIVE_SUNRISE - TRANSITION_WINDOW_MS).timeOfDay).toBe('sunrise');
      expect(resolveTimeOfDay(solar, LIVE_SUNRISE + TRANSITION_WINDOW_MS + 1).timeOfDay).toBe('day');
      expect(resolveTimeOfDay(solar, LIVE_SUNRISE - TRANSITION_WINDOW_MS - 1).timeOfDay).toBe(
        'night',
      );
      expect(resolveTimeOfDay(solar, LIVE_SUNSET).timeOfDay).toBe('sunset');
      expect(resolveTimeOfDay(solar, LIVE_SUNSET + TRANSITION_WINDOW_MS + 1).timeOfDay).toBe(
        'night',
      );
    });

    it('is day in the middle and night on either side of it', () => {
      const noon = (LIVE_SUNRISE + LIVE_SUNSET) / 2;
      expect(resolveTimeOfDay(solar, noon).timeOfDay).toBe('day');
      expect(resolveTimeOfDay(solar, LIVE_SUNRISE - 6 * 3_600_000).timeOfDay).toBe('night');
      expect(resolveTimeOfDay(solar, LIVE_SUNSET + 4 * 3_600_000).timeOfDay).toBe('night');
    });
  });

  describe("tier 2 — the provider's daylight flag", () => {
    it('collapses to day or night, and says that is what it did', () => {
      expect(resolveTimeOfDay({ isDay: true }, NOW)).toEqual({
        timeOfDay: 'day',
        basis: 'daylight_flag',
      });
      expect(resolveTimeOfDay({ isDay: false }, NOW)).toEqual({
        timeOfDay: 'night',
        basis: 'daylight_flag',
      });
    });

    it('is only reached when there are no solar times', () => {
      // isDay says night, the sun says otherwise. The sun wins.
      const noon = (LIVE_SUNRISE + LIVE_SUNSET) / 2;
      const reading = resolveTimeOfDay(
        { sunrise: LIVE_SUNRISE, sunset: LIVE_SUNSET, isDay: false },
        noon,
      );
      expect(reading).toEqual({ timeOfDay: 'day', basis: 'solar' });
    });
  });

  describe("tier 3 — the hour where she is, not where the server is", () => {
    it('gives four different answers for one instant in four zones', () => {
      // This is the whole reason the tier exists. `new Date().getHours()` cannot
      // produce this table: it would return the same answer four times.
      const at = NOW; // 12:45Z
      expect(resolveTimeOfDay({ timeZone: 'Asia/Kolkata' }, at)).toEqual({
        timeOfDay: 'sunset', // 18:15
        basis: 'local_hour',
      });
      expect(resolveTimeOfDay({ timeZone: 'America/Los_Angeles' }, at).timeOfDay).toBe('sunrise'); // 05:45
      expect(resolveTimeOfDay({ timeZone: 'UTC' }, at).timeOfDay).toBe('day'); // 12:45
      expect(resolveTimeOfDay({ timeZone: 'Pacific/Auckland' }, at).timeOfDay).toBe('night'); // 00:45
    });

    it('falls back to the only other clock when the zone is unusable', () => {
      // Intl throws on a bogus zone. Throwing here would take out a snapshot.
      expect(() => resolveTimeOfDay({ timeZone: 'Not/AZone' }, NOW)).not.toThrow();
      expect(hourInZone(NOW, 'Not/AZone')).toBe(new Date(NOW).getHours());
      expect(hourInZone(NOW, undefined)).toBe(new Date(NOW).getHours());
    });

    it('reports an hour in range for every zone it is given', () => {
      for (const zone of ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Pacific/Midway']) {
        const hour = hourInZone(NOW, zone);
        expect(hour).toBeGreaterThanOrEqual(0);
        expect(hour).toBeLessThanOrEqual(23);
      }
    });
  });

  it('has an answer with no evidence at all', () => {
    const reading = resolveTimeOfDay({}, NOW);
    expect(ALL_TIMES).toContain(reading.timeOfDay);
    expect(reading.basis).toBe('local_hour');
  });
});

describe('the derived palette', () => {
  /**
   * Hex back to the two quantities the weather modifiers actually move.
   *
   * Perceived luminance is the wrong ruler here and the first version of this
   * test used it: the sRGB weights put blue at 0.0722, so draining saturation
   * from the deep-blue night palette *raises* perceived luminance even as HSL
   * lightness falls. Measuring L and chroma directly is hue-independent, and it
   * is what `WEATHER`'s `lightness`/`saturation` multipliers claim to do.
   */
  const hslOf = (hex: string): { lightness: number; chroma: number } => {
    const n = Number.parseInt(hex.slice(1), 16);
    const [r, g, b] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    const max = Math.max(r!, g!, b!);
    const min = Math.min(r!, g!, b!);
    return { lightness: (max + min) / 2, chroma: max - min };
  };

  it('converts HSL to hex at the corners', () => {
    expect(hslToHex({ h: 0, s: 0, l: 0 })).toBe('#000000');
    expect(hslToHex({ h: 0, s: 0, l: 100 })).toBe('#ffffff');
    expect(hslToHex({ h: 0, s: 100, l: 50 })).toBe('#ff0000');
    expect(hslToHex({ h: 120, s: 100, l: 50 })).toBe('#00ff00');
    expect(hslToHex({ h: 240, s: 100, l: 50 })).toBe('#0000ff');
    expect(hslToHex({ h: 60, s: 100, l: 50 })).toBe('#ffff00');
    // Out of range in, still a colour out.
    expect(hslToHex({ h: 725, s: 150, l: -20 })).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('is total and pure over every hour and every sky', () => {
    for (const time of ALL_TIMES) {
      for (const condition of ALL_CONDITIONS) {
        const palette = derivePalette(time, condition);
        expect(palette.primary).toMatch(/^#[0-9a-f]{6}$/);
        expect(palette.secondary).toMatch(/^#[0-9a-f]{6}$/);
        expect(palette.accent).toMatch(/^#[0-9a-f]{6}$/);
        expect(derivePalette(time, condition)).toEqual(palette);
      }
    }
  });

  it('applies no weather modifier at all when the sky was not observed', () => {
    // The rule: an unobserved sky must not be rendered as any particular sky.
    // If 'unknown' ever gains a modifier row, these all break.
    for (const time of ALL_TIMES) {
      const unknown = derivePalette(time, 'unknown');
      for (const condition of ALL_CONDITIONS) {
        if (condition === 'unknown') continue;
        expect(derivePalette(time, condition)).not.toEqual(unknown);
      }
    }
  });

  it('darkens and drains colour as the weather closes in, at every hour', () => {
    for (const time of ALL_TIMES) {
      const clear = hslOf(derivePalette(time, 'clear').primary);
      for (const condition of ['cloudy', 'rainy', 'stormy'] as const) {
        const worse = hslOf(derivePalette(time, condition).primary);
        expect(worse.lightness).toBeLessThan(clear.lightness);
        expect(worse.chroma).toBeLessThan(clear.chroma);
      }
    }
  });

  it('lifts rather than darkens for the bright greys — snow and fog', () => {
    for (const time of ALL_TIMES) {
      const clear = hslOf(derivePalette(time, 'clear').primary);
      for (const condition of ['snow', 'fog'] as const) {
        const lifted = hslOf(derivePalette(time, condition).primary);
        expect(lifted.lightness).toBeGreaterThan(clear.lightness);
        expect(lifted.chroma).toBeLessThan(clear.chroma);
      }
    }
  });

  it('keeps the accent from disappearing in fog, which is where contrast dies', () => {
    for (const time of ALL_TIMES) {
      const accent = hslOf(derivePalette(time, 'fog').accent);
      const primary = hslOf(derivePalette(time, 'fog').primary);
      // One vivid element is the whole visual language; fog must not flatten it
      // into the background.
      expect(Math.abs(accent.lightness - primary.lightness)).toBeGreaterThan(0.1);
    }
  });

  it('keeps every hour visually distinct, so the time of day reads at a glance', () => {
    const primaries = ALL_TIMES.map((time) => derivePalette(time, 'clear').primary);
    expect(new Set(primaries).size).toBe(ALL_TIMES.length);
  });
});

describe('EnvironmentService', () => {
  let db: Database;
  let bus: EventBus;
  let clock: number;

  const now = (): number => clock;

  const changedEvents = (): { timeOfDay: string; condition: string }[] =>
    (
      db.raw
        .prepare(`SELECT payload_json FROM domain_event WHERE type = 'environment.changed' ORDER BY timestamp ASC, rowid ASC`)
        .all() as { payload_json: string }[]
    ).map((row) => JSON.parse(row.payload_json));

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    bus = new EventBus(db);
    clock = NOW;
  });

  afterEach(() => {
    db.close();
  });

  describe('when nobody has said where she is', () => {
    it('does not ask the provider, and does not pretend to be at 0, 0', async () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, now });

      const report = await service.refresh();

      expect(provider.calls).toHaveLength(0);
      expect(report.locationSource).toBe('none');
      expect(report.state.weather.condition).toBe('unknown');
      expect(report.observedAt).toBeUndefined();
      expect(report.stale).toBe(true);
      // Null island is a real place in the Gulf of Guinea. Absent is the honest shape.
      expect(report.state.location).toBeUndefined();
      expect('location' in report.state).toBe(false);
      expect(changedEvents()).toHaveLength(0);
    });

    it('still renders an hour, because something has to be on screen', async () => {
      const service = new EnvironmentService({ provider: new FakeProvider(), now });
      const state = service.snapshot();
      expect(ALL_TIMES).toContain(state.timeOfDay);
      expect(state.derivedPalette).toEqual(derivePalette(state.timeOfDay, 'unknown'));
    });
  });

  describe('where the coordinates come from', () => {
    it('uses the configured location when there is no client', async () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });

      const report = await service.refresh();

      expect(report.locationSource).toBe('config');
      expect(provider.calls).toEqual([DELHI]);
      expect(report.state.location).toEqual(DELHI);
    });

    it('lets a client that actually knows override the operator', async () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      const mumbai: GeoSnapshot = { lat: 19.076, lng: 72.8777 };

      expect(service.setClientLocation(mumbai)).toBe(true);
      const report = await service.refresh();

      expect(report.locationSource).toBe('client');
      expect(provider.calls).toEqual([mumbai]);
    });

    it('refuses a coordinate that is not a place, instead of clamping it to one', async () => {
      const service = new EnvironmentService({
        provider: new FakeProvider(),
        configuredLocation: DELHI,
        now,
      });

      for (const bad of [
        { lat: 91, lng: 0 },
        { lat: -91, lng: 0 },
        { lat: 0, lng: 181 },
        { lat: Number.NaN, lng: 0 },
        { lat: 0, lng: Number.POSITIVE_INFINITY },
      ]) {
        // Clamping 91 to 90 would move her somewhere she is not and then
        // narrate the weather there.
        expect(service.setClientLocation(bad)).toBe(false);
      }
      expect(service.location()).toEqual(DELHI);
      expect(service.locationSource()).toBe('config');
    });

    it('throws away a reading taken somewhere else when she moves', async () => {
      const provider = new FakeProvider(observation({ condition: 'rainy' }));
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      await service.refresh();
      expect(provider.calls).toHaveLength(1);

      provider.next = observation({ condition: 'clear' });
      service.setClientLocation({ lat: 19.076, lng: 72.8777 });
      const report = await service.refresh();

      expect(provider.calls).toHaveLength(2);
      expect(report.state.weather.condition).toBe('clear');
    });

    it('does not invalidate a good reading for GPS jitter of a few metres', async () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, now });
      service.setClientLocation(DELHI);
      await service.refresh();

      service.setClientLocation({ lat: DELHI.lat + 0.001, lng: DELHI.lng - 0.001 });
      await service.refresh();

      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('how often she looks up', () => {
    it('reuses a reading inside the fifteen minutes the provider recomputes on', async () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });

      await service.refresh();
      clock = NOW + WEATHER_TTL_MS - 1;
      await service.refresh();

      expect(provider.calls).toHaveLength(1);
      expect(service.report().stale).toBe(false);
    });

    it('looks again once the reading has aged out, and admits it was stale', async () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });

      await service.refresh();
      clock = NOW + WEATHER_TTL_MS;
      expect(service.report().stale).toBe(true);

      provider.next = observation({ condition: 'rainy', observedAt: clock });
      const report = await service.refresh();

      expect(provider.calls).toHaveLength(2);
      expect(report.state.weather.condition).toBe('rainy');
      expect(report.stale).toBe(false);
    });

    it('force skips the age check but never invents a request without coordinates', async () => {
      const withPlace = new FakeProvider();
      const service = new EnvironmentService({
        provider: withPlace,
        configuredLocation: DELHI,
        now,
      });
      await service.refresh();
      await service.refresh(true);
      expect(withPlace.calls).toHaveLength(2);

      const nowhere = new FakeProvider();
      await new EnvironmentService({ provider: nowhere, now }).refresh(true);
      expect(nowhere.calls).toHaveLength(0);
    });

    it('two callers arriving together share one request', async () => {
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const provider: WeatherProvider = {
        async observe() {
          calls += 1;
          await blocked;
          return observation();
        },
      };
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });

      const both = Promise.all([service.refresh(), service.refresh()]);
      release();
      await both;

      // Three subscribers on a page load must not be three calls to a public API.
      expect(calls).toBe(1);
    });
  });

  describe('when the network goes away', () => {
    it('keeps the sky she actually saw and marks it stale, rather than forgetting it', async () => {
      const provider = new FakeProvider(observation({ condition: 'clear', temperature: 31.2 }));
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      await service.refresh();

      clock = NOW + WEATHER_TTL_MS;
      provider.next = unknownWeather(clock);
      const report = await service.refresh();

      // Overwriting with 'unknown' would *lose* true information in the name of
      // caution. She saw clear sky; she still says clear sky, and says it is old.
      expect(report.state.weather.condition).toBe('clear');
      expect(report.state.weather.temperature).toBe(31.2);
      expect(report.observedAt).toBe(NOW);
      expect(report.stale).toBe(true);
    });

    it('publishes nothing when a failed refresh changed nothing she believes', async () => {
      const provider = new FakeProvider(observation({ condition: 'clear' }));
      const service = new EnvironmentService({
        provider,
        configuredLocation: DELHI,
        eventBus: bus,
        now,
      });
      await service.refresh();
      const afterFirst = changedEvents().length;

      clock = NOW + WEATHER_TTL_MS;
      provider.next = unknownWeather(clock);
      await service.refresh();

      expect(changedEvents()).toHaveLength(afterFirst);
    });

    it('does not know, when the very first look fails', async () => {
      const provider = new FakeProvider(unknownWeather(NOW));
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });

      const report = await service.refresh();

      expect(report.state.weather.condition).toBe('unknown');
      expect(report.stale).toBe(true);
      // There is nothing to keep, so there is nothing to date.
      expect(report.state.weather.temperature).toBeUndefined();
    });

    it('recovers on the next successful look', async () => {
      const provider = new FakeProvider(unknownWeather(NOW));
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      await service.refresh();

      clock = NOW + WEATHER_TTL_MS;
      provider.next = observation({ condition: 'stormy', observedAt: clock });
      const report = await service.refresh();

      expect(report.state.weather.condition).toBe('stormy');
      expect(report.stale).toBe(false);
    });
  });

  describe('what she tells the rest of the application', () => {
    it("publishes environment.changed durably, which nothing in the repo did before", async () => {
      const provider = new FakeProvider(
        observation({ condition: 'rainy', temperature: 24.1, timeZone: 'Asia/Kolkata' }),
      );
      const service = new EnvironmentService({
        provider,
        configuredLocation: DELHI,
        eventBus: bus,
        now,
      });

      await service.refresh();

      const events = changedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        condition: 'rainy',
        temperature: 24.1,
        observedAt: NOW,
        location: DELHI,
      });
      expect(ALL_TIMES).toContain(events[0]!.timeOfDay);
    });

    it('stays quiet when the sky is the same as last time', async () => {
      const provider = new FakeProvider(observation({ condition: 'cloudy' }));
      const service = new EnvironmentService({
        provider,
        configuredLocation: DELHI,
        eventBus: bus,
        now,
      });

      await service.refresh();
      provider.next = observation({ condition: 'cloudy', observedAt: NOW + WEATHER_TTL_MS });
      clock = NOW + WEATHER_TTL_MS;
      await service.refresh();

      // A subscriber should not repaint because a timestamp moved.
      expect(changedEvents()).toHaveLength(1);
    });

    it('speaks up when the temperature moves, because she may narrate it', async () => {
      const provider = new FakeProvider(observation({ condition: 'clear', temperature: 20 }));
      const service = new EnvironmentService({
        provider,
        configuredLocation: DELHI,
        eventBus: bus,
        now,
      });
      await service.refresh();

      clock = NOW + WEATHER_TTL_MS;
      provider.next = observation({ condition: 'clear', temperature: 27.5, observedAt: clock });
      await service.refresh();

      expect(changedEvents()).toHaveLength(2);
      expect(changedEvents()[1]).toMatchObject({ temperature: 27.5 });
    });

    it('works with no event bus wired at all', async () => {
      const service = new EnvironmentService({
        provider: new FakeProvider(),
        configuredLocation: DELHI,
        now,
      });
      await expect(service.refresh()).resolves.toMatchObject({ stale: false });
    });
  });

  describe('the snapshot', () => {
    it('advances the time of day with the clock even though no new weather arrived', async () => {
      const provider = new FakeProvider(
        observation({ condition: 'clear', sunrise: LIVE_SUNRISE, sunset: LIVE_SUNSET }),
      );
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      await service.refresh();

      clock = (LIVE_SUNRISE + LIVE_SUNSET) / 2;
      expect(service.snapshot().timeOfDay).toBe('day');
      clock = LIVE_SUNSET + 4 * 3_600_000;
      expect(service.snapshot().timeOfDay).toBe('night');

      // One observation, three different hours. The provider was asked once.
      expect(provider.calls).toHaveLength(1);
    });

    it('derives the palette from the current facts rather than storing it', async () => {
      const provider = new FakeProvider(
        observation({ condition: 'stormy', sunrise: LIVE_SUNRISE, sunset: LIVE_SUNSET }),
      );
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      await service.refresh();

      clock = (LIVE_SUNRISE + LIVE_SUNSET) / 2;
      const day = service.snapshot();
      clock = LIVE_SUNSET + 4 * 3_600_000;
      const night = service.snapshot();

      expect(day.derivedPalette).toEqual(derivePalette('day', 'stormy'));
      expect(night.derivedPalette).toEqual(derivePalette('night', 'stormy'));
      expect(day.derivedPalette).not.toEqual(night.derivedPalette);
    });

    it('is synchronous and cheap, so a late subscriber needs no network call', () => {
      const provider = new FakeProvider();
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });

      const state = service.snapshot();

      expect(provider.calls).toHaveLength(0);
      expect(state.weather.condition).toBe('unknown');
      expect(state.location).toEqual(DELHI);
    });

    it('reports which tier answered, so a caller knows what it may say out loud', async () => {
      const provider = new FakeProvider(
        observation({ sunrise: LIVE_SUNRISE, sunset: LIVE_SUNSET }),
      );
      const service = new EnvironmentService({ provider, configuredLocation: DELHI, now });
      expect(service.report().timeOfDayBasis).toBe('local_hour');

      await service.refresh();
      expect(service.report().timeOfDayBasis).toBe('solar');
    });
  });
});

describe('the app, actually looking at the sky', () => {
  let db: Database;
  let app: MadhuritaApp | undefined;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
  });

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    db.close();
    closeDatabase();
  });

  const build = (env: Record<string, string>, provider?: WeatherProvider): MadhuritaApp =>
    createApp({
      config: loadConfig(env),
      db,
      installGlobalDatabase: false,
      ...(provider ? { weatherProvider: provider } : {}),
    });

  it('says on the boot report that it does not know where she is', async () => {
    const provider = new FakeProvider();
    app = build({}, provider);

    const report = await app.start();

    // A timer that can never do anything must not be announced as started.
    expect(report.started.some((line) => line.includes('environment'))).toBe(false);
    expect(report.absent.some((line) => line.startsWith('location —'))).toBe(true);
    expect(provider.calls).toHaveLength(0);
    expect(app.environment.locationSource()).toBe('none');
    expect(app.environment.snapshot().location).toBeUndefined();
  });

  it('looks up at boot when the operator said where she is, and publishes what it saw', async () => {
    const provider = new FakeProvider(observation({ condition: 'rainy', temperature: 24.1 }));
    app = build(
      { LOCATION_LATITUDE: '28.6139', LOCATION_LONGITUDE: '77.2090', LOCATION_LABEL: 'Delhi' },
      provider,
    );

    const report = await app.start();
    // The boot refresh is deliberately not awaited inside start(), so join it
    // here — refresh() shares one in-flight request rather than making a second.
    await app.environment.refresh();

    expect(report.started.some((line) => line.includes('environment (config location'))).toBe(true);
    expect(provider.calls).toEqual([DELHI]);
    expect(app.environment.snapshot().weather).toMatchObject({
      condition: 'rainy',
      temperature: 24.1,
    });

    // 'environment.changed' was a declared DomainEventType that nothing in the
    // repository ever published. This is the first emitter.
    const rows = db.raw
      .prepare(`SELECT payload_json FROM domain_event WHERE type = 'environment.changed'`)
      .all() as { payload_json: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
      condition: 'rainy',
      temperature: 24.1,
      location: DELHI,
    });
  });

  it('lets a client override the operator at runtime', async () => {
    const provider = new FakeProvider();
    app = build({ LOCATION_LATITUDE: '28.6139', LOCATION_LONGITUDE: '77.2090' }, provider);
    await app.start();
    await app.environment.refresh();

    expect(app.environment.setClientLocation({ lat: 19.076, lng: 72.8777 })).toBe(true);
    await app.environment.refresh();

    expect(app.environment.locationSource()).toBe('client');
    expect(provider.calls[1]).toEqual({ lat: 19.076, lng: 72.8777 });
  });

  it('rearms the sweep while running and drops it on stop()', async () => {
    // The only two behaviours worth measuring about the timer, measured rather
    // than asserted: it comes back on its own, and it does not survive shutdown.
    // Every other timer is off so nothing else is advancing under fake time.
    const provider = new FakeProvider();
    app = build(
      {
        LOCATION_LATITUDE: '28.6139',
        LOCATION_LONGITUDE: '77.2090',
        FLAG_TASKS: 'false',
        FLAG_PROACTIVITY: 'false',
      },
      provider,
    );

    vi.useFakeTimers();
    try {
      await app.start();
      await app.environment.refresh();
      expect(provider.calls).toHaveLength(1);

      // The TTL has passed, so the rearmed sweep finds the reading expired.
      await vi.advanceTimersByTimeAsync(WEATHER_TTL_MS + 1);
      expect(provider.calls).toHaveLength(2);

      const before = provider.calls.length;
      await app.stop();
      app = undefined;
      await vi.advanceTimersByTimeAsync(WEATHER_TTL_MS * 3);

      // A surviving timer would keep calling a public API after shutdown.
      expect(provider.calls).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
