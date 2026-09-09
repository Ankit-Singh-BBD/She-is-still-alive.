/**
 * Emotion reading — hooks stages 2 (IDENTIFY) and 4 (UNDERSTAND).
 *
 * ## Why two stages and not one
 *
 * The `hooks: [2, 4]` in the original placeholder was the right answer with no
 * implementation behind it, and the reason is worth writing down because it is
 * the only thing that makes the second hook more than a duplicate call.
 *
 * At **stage 2** all that exists is the utterance. That is enough to read a mood
 * and, more importantly, it is *early* — stage 2 runs before RECALL, UNDERSTAND,
 * REASON, DECIDE and RESPOND, so a tone signal written here is in force for the
 * rest of the cycle that produces the words. This is the hook that changes what he
 * hears.
 *
 * At **stage 4** stage 3 has since loaded the transcript, so for the first time in
 * the cycle there is an *arc* rather than a sentence. One sharp message is a blip;
 * three in a row is a state. Re-reading the same text here would be a wasted call,
 * but reading the last few turns answers a question stage 2 structurally cannot:
 * is this where the conversation already was?
 *
 * The distinction is not cosmetic. A single "yeh kaam nahi kar raha" is someone
 * reporting a fact, and clipping her replies for twelve minutes over it would be an
 * overreaction. The same sentence as the third of three is someone who has been
 * stuck for a while, and brevity is then the useful response.
 *
 * ## Where the effect lands
 *
 * Not in the return value. The return value is a report — it goes into the stage
 * trace so the wiring is inspectable, and that is all it is for. The effect is the
 * `PersonaOverride` written into the shared `PersonalityRegistry` through
 * `PersonalityService`, which stage 9 reads on its way out: through
 * `systemInstruction` when a language faculty is wired, through
 * `RespondOptions.tone` when none is. That is why this module is useful with no
 * `GOOGLE_API_KEY` — the reading is local, and so is the thing that consumes it.
 *
 * ## With no `PersonalityService`
 *
 * It still reads, and reports `applied: false` with the reason. A module that
 * returned nothing when it had nowhere to write would be indistinguishable from a
 * module that was never called.
 */

import type { StageNumber } from '@server/cognition/types.js';

import { personaDeltaFor, readAffect, type AffectReading } from './affect.js';
import type {
  AdvancedModule,
  AdvancedModuleContext,
  AdvancedModuleDeps,
  AdvancedModuleReport,
} from './types.js';

/** How many prior turns of his count as "where the conversation already was". */
const ARC_TURNS = 4;

/** Consecutive negative turns before a mood is treated as sustained. */
const SUSTAINED_THRESHOLD = 2;

export function createEmotionReadingModule(deps: AdvancedModuleDeps = {}): AdvancedModule {
  return {
    id: 'emotion-reading',
    flag: 'enableEmotionReading',
    hooks: [2, 4],
    async run(
      input: unknown,
      stage: StageNumber,
      ctx: AdvancedModuleContext,
    ): Promise<AdvancedModuleReport> {
      return stage === 4 ? readArc(input, ctx, deps) : readMoment(input, ctx, deps);
    },
  };
}

/**
 * Stage 2 — the utterance on its own.
 *
 * `readAffect` handles any input shape, so a stage that hands it something
 * unexpected produces a neutral reading rather than an exception. A neutral
 * reading still writes: `noteAffect` with no deltas *clears* the emotion slot,
 * which is how a mood ends.
 */
function readMoment(
  input: unknown,
  ctx: AdvancedModuleContext,
  deps: AdvancedModuleDeps,
): AdvancedModuleReport {
  const reading = readAffect(input);
  const delta = personaDeltaFor(reading);
  const applied = apply(ctx.identityId, delta, deps);

  return {
    applied,
    ...(applied ? {} : { reason: 'no personality service wired' }),
    scope: 'utterance',
    label: reading.label,
    valence: reading.valence,
    arousal: reading.arousal,
    confidence: reading.confidence,
    cues: reading.cues,
    delta,
  };
}

/**
 * Stage 4 — the same person, over the last few things they said.
 *
 * Only his turns are read. Including hers would fold her own wording back into a
 * reading of his mood, and since her wording is already shaped by the previous
 * reading, that is a loop: one warm reply would read as warmth, which would raise
 * warmth, which would read as more warmth.
 */
function readArc(
  input: unknown,
  ctx: AdvancedModuleContext,
  deps: AdvancedModuleDeps,
): AdvancedModuleReport {
  const current = readAffect(input);
  const priors = userTurnTexts(input).slice(-ARC_TURNS).map(readAffect);

  // Oldest first, so the run is counted from the most recent backwards.
  const arc = [...priors, current];
  const negativeRun = trailingNegativeRun(arc);
  const sustained = negativeRun >= SUSTAINED_THRESHOLD;

  // A sustained low mood earns brevity even when the latest message on its own
  // was not agitated enough to trigger it — that is the whole point of looking at
  // more than one turn. It never *removes* what the moment justified.
  const delta = personaDeltaFor(current);
  if (sustained) {
    delta.warmthDelta = 1;
    delta.verbosityDelta = -1;
  }

  const applied = apply(ctx.identityId, delta, deps);

  return {
    applied,
    ...(applied ? {} : { reason: 'no personality service wired' }),
    scope: 'arc',
    label: current.label,
    turnsConsidered: arc.length,
    negativeRun,
    sustained,
    delta,
  };
}

/**
 * Write the deltas, or report that there was nowhere to write them.
 *
 * An empty delta is still a write: it clears the slot. So `applied` reflects
 * whether the sink existed, not whether the deltas were non-empty — "nothing to
 * say about his mood" is a result, not a failure.
 */
function apply(
  identityId: string,
  delta: { warmthDelta?: number; verbosityDelta?: number },
  deps: AdvancedModuleDeps,
): boolean {
  if (deps.personality === undefined) return false;
  deps.personality.noteAffect(identityId, delta);
  return true;
}

/**
 * His turns out of a `RecalledContext`, oldest first.
 *
 * Defensive about the shape because this is reached from a stage input typed
 * `unknown`, and because `recentTurns` is legitimately `undefined` when no
 * transcript reader was wired — which must read as "no arc", not as an empty arc.
 */
function userTurnTexts(input: unknown): string[] {
  if (input === null || typeof input !== 'object') return [];
  const turns = (input as { recentTurns?: unknown }).recentTurns;
  if (!Array.isArray(turns)) return [];

  const texts: string[] = [];
  for (const turn of turns) {
    if (turn === null || typeof turn !== 'object') continue;
    const record = turn as { role?: unknown; text?: unknown };
    if (record.role !== 'user') continue;
    if (typeof record.text !== 'string' || record.text.trim() === '') continue;
    texts.push(record.text);
  }
  return texts;
}

/**
 * How many readings at the end of the arc are negative and actually confident.
 *
 * Confidence is part of the test on purpose: a run of turns that simply said
 * nothing emotional is not a run of low mood, and counting neutral turns toward it
 * would make almost any conversation look sustained.
 */
function trailingNegativeRun(arc: AffectReading[]): number {
  let run = 0;
  for (let i = arc.length - 1; i >= 0; i -= 1) {
    const reading = arc[i];
    if (reading === undefined) break;
    if (reading.valence > -0.2 || reading.confidence < 0.25) break;
    run += 1;
  }
  return run;
}
