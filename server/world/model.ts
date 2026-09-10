/**
 * WorldModel — the one place the app knows what "out there" is.
 *
 * Not weather, not location, not calendar, not people — all of them, together,
 * with `unknown` where there is nothing to say. Each field is `unknown`/`null`
 * independently, so a missing calendar never blocks a greeting, a missing location
 * never blocks work, and a missing person is absent from `peopleContext`, not
 * invented with an empty string. Nothing is guessed; the palette derivation for
 * `unknown` weather deliberately applies *no* modifier, so the screen renders the
 * hour alone rather than a fabricated sky.
 *
 * Every field has its own TTL/probe; the aggregation below merely composes the
 * latest of each. `toResponseFrameContext()` is the only thing the Faculty
 * sees — bounded top-N people prose with provenance, never an unbounded import.
 */

import type { EnvironmentService, EnvironmentReport } from '@server/environment/index.js';
import type { EnvironmentState, TimeOfDay } from '@server/realtime/types.js';

export type Freshness = 'fresh' | 'stale' | 'unknown';

export interface WorldSnapshot {
  time: { timeOfDay: TimeOfDay; basis: string };
  weather: EnvironmentState['weather'] & { freshness: Freshness };
  location: EnvironmentState['location'];
  freshness: Record<'weather' | 'location' | 'time', Freshness>;
  palette: EnvironmentState['derivedPalette'];
  /** Borrowed from EnvironmentService.report so callers can say "from Delhi 8 min ago". */
  report: EnvironmentReport;
}

export interface WorldModelOptions {
  environment: EnvironmentService;
  people?: { toContext(max?: number): string[] } | undefined;
}

export class WorldModel {
  constructor(private readonly opts: WorldModelOptions) {}

  snapshot(): WorldSnapshot {
    const report = this.opts.environment.report();
    const freshness = freshnessForReport(report);
    return {
      time: { timeOfDay: report.state.timeOfDay, basis: report.timeOfDayBasis },
      weather: { ...report.state.weather, freshness: freshness.weather },
      location: report.state.location,
      freshness,
      palette: report.state.derivedPalette,
      report,
    };
  }

  /** Bounded, redacted people prose for ResponseFrame. Empty when no graph wired. */
  peopleContext(max = 6): string[] {
    return this.opts.people?.toContext(max) ?? [];
  }
}

function freshnessForReport(report: EnvironmentReport): Record<'weather' | 'location' | 'time', Freshness> {
  const weather: Freshness =
    report.observedAt === undefined
      ? 'unknown'
      : report.stale
        ? 'stale'
        : 'fresh';
  const location: Freshness = report.locationSource === 'none' ? 'unknown' : 'fresh';
  const time: Freshness = report.timeOfDayBasis === 'local_hour' ? 'stale' : 'fresh';
  return { weather, location, time };
}
