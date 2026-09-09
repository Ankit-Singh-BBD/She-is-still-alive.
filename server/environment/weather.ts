/**
 * What the sky is doing, from Open-Meteo.
 *
 * Chosen because it needs no API key and no client library: one `fetch` of one
 * documented URL, so weather costs this application zero dependencies and zero
 * secrets. The provider is behind an interface anyway, because a network call is
 * the one part of `EnvironmentService` that has to be replaceable in a test.
 *
 * ## Honesty
 *
 * There is no "probably clear". A failed request, a timeout, a body that does
 * not parse, or a WMO code nobody has seen before all produce the same thing:
 * `'unknown'`. The caller keeps its previous reading and marks it stale rather
 * than promoting a guess, because "it looks like rain" said on no evidence is
 * exactly the kind of confident fabrication the whole system is built to avoid.
 *
 * ## Time
 *
 * Open-Meteo reports local wall-clock strings with no zone marker plus a
 * separate `utc_offset_seconds`. Parsed naively, `Date.parse` reads them as the
 * *server's* local time and sunrise lands hours from where the sun is. Every
 * timestamp here is therefore converted through `localToEpoch`, which is the
 * same class of bug as `sqliteTimeToMillis` guards in the conversation store.
 */

import type { GeoSnapshot, WeatherSnapshot } from '@server/realtime/types.js';

/** The six conditions the visual layer knows how to render, plus not-knowing. */
export type WeatherCondition = WeatherSnapshot['condition'];

export interface WeatherObservation {
  condition: WeatherCondition;
  /** Degrees Celsius. Absent when the provider did not report it. */
  temperature: number | undefined;
  /** When the provider says the reading was taken, epoch ms. */
  observedAt: number;
  /** Local sunrise for these coordinates, epoch ms, when reported. */
  sunrise: number | undefined;
  /** Local sunset for these coordinates, epoch ms, when reported. */
  sunset: number | undefined;
  /** The provider's own daylight flag — the fallback when there is no sunrise. */
  isDay: boolean | undefined;
  /** The IANA zone the coordinates sit in, when reported. */
  timeZone: string | undefined;
}

export interface WeatherProvider {
  /** Resolves to `'unknown'` rather than rejecting; see the honesty note. */
  observe(location: GeoSnapshot): Promise<WeatherObservation>;
}

/**
 * WMO 4677 present-weather codes, collapsed onto the six conditions the visual
 * layer renders.
 *
 * The collapsing is lossy on purpose: 'light drizzle' and 'heavy freezing rain'
 * are both water falling out of the sky, and an orb has no vocabulary for the
 * difference. Code 1 ("mainly clear") is grouped with cloudy rather than clear
 * because the palette should not swing to open sky on partial cover.
 */
export function conditionForWmoCode(code: number): WeatherCondition {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2 || code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code === 95 || code === 96 || code === 99) return 'stormy';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rainy';
  return 'unknown';
}

/** Local wall-clock string plus the zone's offset, as epoch ms. */
function localToEpoch(local: string, utcOffsetSeconds: number): number | undefined {
  const parsed = Date.parse(local.includes('Z') ? local : `${local}Z`);
  if (Number.isNaN(parsed)) return undefined;
  return parsed - utcOffsetSeconds * 1000;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

/** A reading that claims nothing, for every path that could not observe. */
export function unknownWeather(at = Date.now()): WeatherObservation {
  return {
    condition: 'unknown',
    temperature: undefined,
    observedAt: at,
    sunrise: undefined,
    sunset: undefined,
    isDay: undefined,
    timeZone: undefined,
  };
}

export interface OpenMeteoOptions {
  /** Overridable so a test can point at a local fixture server. */
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
  /** Injectable purely so tests need no network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const DEFAULT_TIMEOUT_MS = 8_000;

export class OpenMeteoProvider implements WeatherProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenMeteoOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async observe(location: GeoSnapshot): Promise<WeatherObservation> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('latitude', location.lat.toFixed(4));
    url.searchParams.set('longitude', location.lng.toFixed(4));
    url.searchParams.set('current', 'temperature_2m,weather_code,is_day');
    url.searchParams.set('daily', 'sunrise,sunset');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '1');

    let body: unknown;
    try {
      const response = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return unknownWeather();
      body = await response.json();
    } catch {
      // Offline, DNS, timeout, or a body that is not JSON. All the same answer:
      // we do not know what the sky is doing.
      return unknownWeather();
    }

    return parseOpenMeteo(body);
  }
}

/**
 * Exported for the tests, which is also the honest way to describe it: this is
 * the whole of what the application believes about a provider response, and it
 * defends against every field being absent because a public API is not a
 * contract this repository controls.
 */
export function parseOpenMeteo(body: unknown): WeatherObservation {
  if (typeof body !== 'object' || body === null) return unknownWeather();
  const root = body as Record<string, unknown>;

  const offset = numberOrUndefined(root['utc_offset_seconds']) ?? 0;
  const current = (
    typeof root['current'] === 'object' && root['current'] !== null ? root['current'] : {}
  ) as Record<string, unknown>;
  const daily = (
    typeof root['daily'] === 'object' && root['daily'] !== null ? root['daily'] : {}
  ) as Record<string, unknown>;

  const code = numberOrUndefined(current['weather_code']);
  const time = typeof current['time'] === 'string' ? current['time'] : undefined;
  const isDayFlag = numberOrUndefined(current['is_day']);
  const sunriseLocal = firstString(daily['sunrise']);
  const sunsetLocal = firstString(daily['sunset']);

  return {
    condition: code === undefined ? 'unknown' : conditionForWmoCode(code),
    temperature: numberOrUndefined(current['temperature_2m']),
    observedAt: (time === undefined ? undefined : localToEpoch(time, offset)) ?? Date.now(),
    sunrise: sunriseLocal === undefined ? undefined : localToEpoch(sunriseLocal, offset),
    sunset: sunsetLocal === undefined ? undefined : localToEpoch(sunsetLocal, offset),
    isDay: isDayFlag === undefined ? undefined : isDayFlag === 1,
    timeZone: typeof root['timezone'] === 'string' ? root['timezone'] : undefined,
  };
}
