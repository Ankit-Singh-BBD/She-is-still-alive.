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
    return `she answered, but ${stages.length === 1 ? 'one stage' : `${stages.length} stages`} fell back — ${stages.join(', ').toLowerCase()}`;
  }
  if (reply.status === 'failed') return 'that cycle failed to close';
  if (reply.redacted) {
    return `she held something back — ${reply.disclosures.join(', ') || 'no reason given'}`;
  }
  return undefined;
}

/** "3 done, 1 unproven" — never counts an action as proven off `success` alone. */
export function actionWords(reply: ChatReply | undefined): string | undefined {
  if (reply === undefined || reply.actions.length === 0) return undefined;
  const proven = reply.actions.filter((action) => action.verified).length;
  const failed = reply.actions.filter((action) => !action.success).length;
  const unproven = reply.actions.length - proven - failed;
  const parts: string[] = [];
  if (proven > 0) parts.push(`${proven} confirmed`);
  if (unproven > 0) parts.push(`${unproven} unconfirmed`);
  if (failed > 0) parts.push(`${failed} failed`);
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
