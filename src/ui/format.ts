/**
 * Words for machine states.
 *
 * Kept out of the components because these are decisions about honesty, not about
 * layout, and they are easier to argue with in one place. Two rules run through
 * all of them:
 *
 * 1. **Never round a "do not know" into a value.** `'unknown'` weather says
 *    "she cannot see the sky", not "clear". An absent temperature is omitted, not
 *    shown as 0°.
 * 2. **Never soften a degraded cycle.** `degraded` gets its own sentence naming
 *    the stages that fell back, because that is the distinction the whole cycle
 *    contract exists to preserve.
 */

import type { CognitiveStageName, EnvironmentState } from '@server/realtime/types.js';

import type { ChatReply } from '../lib/api.js';

/** What she is doing, for the line under the composer. Present tense, lower case. */
const DOING: Record<CognitiveStageName, string> = {
  PERCEIVE: 'taking it in',
  IDENTIFY: 'working out who is speaking',
  RECALL: 'remembering',
  UNDERSTAND: 'understanding',
  REASON: 'thinking it through',
  DECIDE: 'deciding',
  ACT: 'doing something about it',
  VERIFY: 'checking it actually happened',
  RESPOND: 'finding the words',
  LEARN: 'keeping what matters',
  UPDATE: 'settling it in',
  PERSIST: 'writing it down',
};

export function doingWords(stage: CognitiveStageName): string {
  return DOING[stage] ?? 'thinking';
}

/**
 * The same words, for a stage name that arrived over the wire.
 *
 * `ChatReply.fellBackAt` is `readonly string[]` and not `CognitiveStageName[]`,
 * because `StageTrace.stageName` on the server is a plain `string` — so an
 * unrecognised name is a real possibility and is passed through untranslated
 * rather than guessed at or dropped.
 *
 * These have to be words and not the raw names because the raw names read as
 * English mid-sentence: "one stage fell back — reason" says the reason is coming
 * next, which is the opposite of what happened. "fell back — thinking it through"
 * cannot be misread, and it is the same vocabulary the live line uses.
 */
export function stageWords(name: string): string {
  return DOING[name as CognitiveStageName] ?? name;
}

/** The four hours, as she would say them. */
const HOURS: Record<EnvironmentState['timeOfDay'], string> = {
  night: 'night',
  sunrise: 'first light',
  day: 'daylight',
  sunset: 'last light',
};

/** The seven conditions. `'unknown'` is a sentence about her, not about the sky. */
const SKY: Record<EnvironmentState['weather']['condition'], string> = {
  clear: 'clear',
  cloudy: 'clouded',
  rainy: 'rain',
  stormy: 'storm',
  snow: 'snow',
  fog: 'fog',
  unknown: 'no view of the sky',
};

/**
 * "night · clear · 21°" — the parts that are actually known, joined.
 *
 * The location is reported as its absence rather than its coordinates: latitude
 * and longitude are not something a person reads, and "she does not know where
 * she is" is the only part of it that changes what you would do.
 */
export function environmentWords(environment: EnvironmentState): string[] {
  const parts = [HOURS[environment.timeOfDay] ?? 'unknown hour', SKY[environment.weather.condition]];
  const temperature = environment.weather.temperature;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    parts.push(`${Math.round(temperature)}°`);
  }
  if (environment.location === undefined) parts.push('nowhere in particular');
  return parts;
}

/**
 * How the last cycle went, when that is worth a sentence — and `undefined` when it
 * is not. A clean cycle says nothing; silence is the report.
 */
export function cycleWords(reply: ChatReply | undefined): string | undefined {
  if (reply === undefined) return undefined;
  if (reply.status === 'degraded') {
    const stages = [...new Set(reply.fellBackAt)];
    // `degraded` is set by the runtime when a stage threw, and `fellBackAt` is built
    // from the traces that carry an error, so the two should never disagree. If they
    // do, the verdict is still the honest half — say that, rather than "0 stages".
    if (stages.length === 0) return 'she answered, but not cleanly — no stage was named';
    const named = stages.map(stageWords).join(', ');
    return `she answered, but ${stages.length === 1 ? 'one stage' : `${stages.length} stages`} fell back — ${named}`;
  }
  if (reply.status === 'failed') return 'that cycle failed to close';
  if (reply.redacted) {
    return `she held something back — ${reply.disclosures.join(', ') || 'no reason given'}`;
  }
  return undefined;
}

/**
 * "1 confirmed, 2 unconfirmed" — never counts an action as proven off `success` alone.
 *
 * The buckets are made disjoint by construction rather than by subtraction:
 * `proven` requires `success` as well as `verified`, so a call that failed cannot land
 * in two buckets and leave another negative. `ActionPipeline` does keep that invariant
 * — stage 5 only runs when the call returned — but the client is reading independent
 * booleans off the wire and is not the component that can assume a relationship between
 * them.
 *
 * `attempted` splits what used to be one failure bucket. "1 failed" was also what this
 * said about a tool call that was never dispatched — no clearance, or `FLAG_ACTIONS`
 * off — and "failed" reads as a malfunction, which sends someone to debug a setting.
 * "not run" is the other half, and it is the honest half: nothing was touched.
 */
export function actionWords(reply: ChatReply | undefined): string | undefined {
  if (reply === undefined || reply.actions.length === 0) return undefined;
  const notRun = reply.actions.filter((action) => !action.attempted).length;
  const failed = reply.actions.filter((action) => action.attempted && !action.success).length;
  const proven = reply.actions.filter((action) => action.success && action.verified).length;
  const unproven = reply.actions.length - proven - failed - notRun;
  const parts: string[] = [];
  if (proven > 0) parts.push(`${proven} confirmed`);
  if (unproven > 0) parts.push(`${unproven} unconfirmed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (notRun > 0) parts.push(`${notRun} not run`);
  return parts.join(', ');
}

/** A clock time for a turn. Locale-aware, and never a date — the room is today. */
export function clock(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
