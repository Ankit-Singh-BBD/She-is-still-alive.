/**
 * What she believes about where she is and what the sky is doing.
 *
 * ## The honesty rules, which are the whole design
 *
 * 1. **A failed refresh never overwrites a good reading.** If she saw clear sky
 *    twelve minutes ago and the network is now down, she still says clear sky
 *    and marks the reading stale. Replacing it with `'unknown'` would be a
 *    *loss* of true information dressed up as caution.
 * 2. **A first refresh that fails leaves her not knowing.** There is nothing to
 *    keep, so `condition` is `'unknown'` and `observedAt` is absent — the field
 *    means "when the sky was observed", and nothing was.
 * 3. **No location means no location.** Not `0, 0`. `snapshot().location` is
 *    absent, and `refresh()` does not call the provider at all, because there
 *    are no coordinates to ask about.
 * 4. **The palette is derived, never stored.** It is recomputed from the current
 *    time of day and condition on every snapshot, so it cannot go stale
 *    independently of the facts it is derived from.
 *
 * ## Concurrency
 *
 * `refresh()` is deduplicated: two callers arriving together share one in-flight
 * request rather than racing to write the cache. Without that, a page load with
 * three subscribers is three identical calls to a public API, and the last
 * response to land wins for no reason.
 */

import type { EventBus } from '@server/events/event-bus.js';
import type { EnvironmentState, GeoSnapshot, WeatherSnapshot } from '@server/realtime/types.js';

import { derivePalette } from './palette.js';
import { resolveTimeOfDay, type TimeOfDayBasis } from './time-of-day.js';
import { OpenMeteoProvider, type WeatherObservation, type WeatherProvider } from './weather.js';

/**
 * How long a reading is current.
 *
 * Open-Meteo reports `interval: 900` on its own `current` block — it recomputes
 * every fifteen minutes — so refreshing faster than that spends requests to
 * receive the same numbers back.
 */
export const WEATHER_TTL_MS = 15 * 60_000;

export interface EnvironmentServiceOptions {
  provider?: WeatherProvider | undefined;
  /** From `config.location`, when the operator has set it. */
  configuredLocation?: GeoSnapshot | undefined;
  eventBus?: EventBus | undefined;
  ttlMs?: number | undefined;
  /** Injectable so tests can stand at an instant instead of racing the clock. */
  now?: (() => number) | undefined;
}

export interface EnvironmentReport {
  state: EnvironmentState;
  /** Absent until something has been observed. */
  observedAt: number | undefined;
  /** True when the reading is older than the TTL, or when a refresh failed. */
  stale: boolean;
  /** Which tier answered for `timeOfDay`; only `'solar'` is grounded in the sun. */
  timeOfDayBasis: TimeOfDayBasis;
  /** Where the coordinates came from, so a caller can say how sure it is. */
  locationSource: 'client' | 'config' | 'none';
}

const UNKNOWN_WEATHER: WeatherSnapshot = { condition: 'unknown' };

export class EnvironmentService {
  private readonly provider: WeatherProvider;
  private readonly configuredLocation: GeoSnapshot | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** Reported by a browser that was granted geolocation. Beats config. */
  private clientLocation: GeoSnapshot | undefined;
  private observation: WeatherObservation | undefined;
  /** Which coordinates `observation` describes, so a move invalidates it. */
  private observedLocation: GeoSnapshot | undefined;
  private lastRefreshFailed = false;
  private inFlight: Promise<void> | undefined;

  constructor(options: EnvironmentServiceOptions = {}) {
    this.provider = options.provider ?? new OpenMeteoProvider();
    this.configuredLocation = options.configuredLocation;
    this.eventBus = options.eventBus;
    this.ttlMs = options.ttlMs ?? WEATHER_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Client-reported first, then whatever the operator configured, then nothing. */
  location(): GeoSnapshot | undefined {
    return this.clientLocation ?? this.configuredLocation;
  }

  locationSource(): EnvironmentReport['locationSource'] {
    if (this.clientLocation !== undefined) return 'client';
    if (this.configuredLocation !== undefined) return 'config';
    return 'none';
  }

  /**
   * Accept coordinates a client reported.
   *
   * Rejects anything outside the valid ranges rather than clamping it, because a
   * clamped coordinate is a different place and she would then narrate weather
   * for somewhere nobody is. Returns whether it was accepted.
   */
  setClientLocation(location: GeoSnapshot): boolean {
    const valid =
      Number.isFinite(location.lat) &&
      Number.isFinite(location.lng) &&
      location.lat >= -90 &&
      location.lat <= 90 &&
      location.lng >= -180 &&
      location.lng <= 180;
    if (!valid) return false;

    const previous = this.location();
    this.clientLocation = { lat: location.lat, lng: location.lng };
    // A reading taken 400 km away describes a different sky.
    if (previous === undefined || !sameCoarsePlace(previous, this.clientLocation)) {
      this.observation = undefined;
      this.observedLocation = undefined;
      this.lastRefreshFailed = false;
    }
    return true;
  }

  /** True when there is nothing cached, it has aged out, or the place changed. */
  private isExpired(): boolean {
    if (this.observation === undefined || this.observedLocation === undefined) return true;
    const here = this.location();
    if (here === undefined || !sameCoarsePlace(here, this.observedLocation)) return true;
    return this.now() - this.observation.observedAt >= this.ttlMs;
  }

  /**
   * Observe the sky if the cached reading has aged out.
   *
   * `force` skips only the TTL check, not the no-location check — there is no
   * request to make without coordinates.
   */
  async refresh(force = false): Promise<EnvironmentReport> {
    const here = this.location();
    if (here === undefined) return this.report();
    if (!force && !this.isExpired()) return this.report();

    // Second caller through the door joins the first one's request.
    this.inFlight ??= this.observeInto(here).finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
    return this.report();
  }

  private async observeInto(here: GeoSnapshot): Promise<void> {
    const before = this.snapshot();
    const observation = await this.provider.observe(here);

    if (observation.condition === 'unknown' && this.observation !== undefined) {
      // Rule 1: keep the good reading, admit it is stale. Nothing is published,
      // because nothing she believes has changed.
      this.lastRefreshFailed = true;
      return;
    }

    this.observation = observation;
    this.observedLocation = { lat: here.lat, lng: here.lng };
    this.lastRefreshFailed = observation.condition === 'unknown';

    const after = this.snapshot();
    if (this.eventBus !== undefined && changed(before, after)) {
      await this.eventBus.publish({
        type: 'environment.changed',
        payload: {
          timeOfDay: after.timeOfDay,
          condition: after.weather.condition,
          temperature: after.weather.temperature,
          observedAt: after.weather.observedAt,
          location: after.location,
        },
        timestamp: this.now(),
      });
    }
  }

  /**
   * What she currently believes, with the palette recomputed from it.
   *
   * Cheap and synchronous on purpose: a subscriber joining mid-session gets the
   * current state without triggering a network call, and `timeOfDay` advances
   * with the clock even when no new weather has arrived.
   */
  snapshot(): EnvironmentState {
    const at = this.now();
    const observation = this.observation;
    const { timeOfDay } = resolveTimeOfDay(observation ?? {}, at);
    const weather: WeatherSnapshot =
      observation === undefined
        ? UNKNOWN_WEATHER
        : {
            condition: observation.condition,
            ...(observation.temperature === undefined
              ? {}
              : { temperature: observation.temperature }),
            observedAt: observation.observedAt,
          };
    const here = this.location();

    return {
      timeOfDay,
      weather,
      ...(here === undefined ? {} : { location: here }),
      derivedPalette: derivePalette(timeOfDay, weather.condition),
    };
  }

  /** The snapshot plus how much to trust it. */
  report(): EnvironmentReport {
    const at = this.now();
    const state = this.snapshot();
    const observedAt = this.observation?.observedAt;
    return {
      state,
      observedAt,
      stale:
        this.lastRefreshFailed ||
        observedAt === undefined ||
        at - observedAt >= this.ttlMs,
      timeOfDayBasis: resolveTimeOfDay(this.observation ?? {}, at).basis,
      locationSource: this.locationSource(),
    };
  }
}

/**
 * Whether two coordinates are close enough to share a sky.
 *
 * Two decimal places is about 1.1 km at the equator. Below that the weather is
 * identical and re-requesting is waste; above it, GPS jitter would keep
 * invalidating a perfectly good reading.
 */
function sameCoarsePlace(a: GeoSnapshot, b: GeoSnapshot): boolean {
  return Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01;
}

/** Only the facts are compared — the palette is derived from them. */
function changed(before: EnvironmentState, after: EnvironmentState): boolean {
  return (
    before.timeOfDay !== after.timeOfDay ||
    before.weather.condition !== after.weather.condition ||
    before.weather.temperature !== after.weather.temperature ||
    before.location?.lat !== after.location?.lat ||
    before.location?.lng !== after.location?.lng
  );
}
