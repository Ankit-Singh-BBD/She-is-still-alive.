/**
 * Personality, as something computed rather than something written down.
 *
 * `PersonalityEngine` and `PersonalityRegistry` have existed since P25 and were
 * constructed in `server/app.ts` and read by nobody — a `new` with no consumer.
 * This file is the consumer, and it is deliberately the *only* one: everything
 * that wants to know how she should sound asks here, and everything that has
 * learned something about how she should sound writes here.
 *
 * ## The constraint that shaped it
 *
 * "kisi tarah ke predefined prompt ya persona pe nahi chalti sab kuch actual logic
 * se build hai" — she does not run on a persona file. That rules out the obvious
 * implementation, which is a hand-written paragraph of character notes shipped in
 * the repository and pasted into every prompt. Such a file would be a costume: it
 * would make her *sound* consistent while being connected to nothing that happens.
 *
 * So there is no authored persona anywhere in this codebase. A persona is
 * *derived*, in two steps:
 *
 *  1. **A baseline from what the identity is.** `getDefaultPersonaForKind` maps
 *     owner/person/guest to opening values. A guest is met a little more briefly
 *     and a little less familiarly than the person she lives with; that is not a
 *     personality trait, it is a fact about the relationship.
 *  2. **Deltas from what is measurably true right now.** Three signals, each
 *     owning its own override slot so they can never overwrite each other:
 *
 *       - `'emotion'`     — `readAffect` over what he actually just said.
 *       - `'relationship'`— how much she actually knows about this person.
 *       - `'timeOfDay'`   — the resolved time of day, from real sunrise/sunset.
 *
 * Every delta expires. That is the load-bearing detail: a mood that never decayed
 * would silently become a trait, and three cycles of frustration would leave her
 * permanently clipped even after the thing was fixed. `getEffectivePersonaWithFlags`
 * prunes expired overrides as it reads, so decay costs nothing and needs no sweep.
 *
 * ## Two consumers, one source
 *
 * With a language faculty wired, `instructionFor` goes into `systemInstruction`
 * and the model does the shaping. With no `GOOGLE_API_KEY`, stage 9 drafts
 * deterministically and reads `profileFor` instead. Both come from the same
 * effective persona, so tone does not appear and disappear with the key — it only
 * gets more fluent.
 */

import type { Identity } from '@server/identity/types.js';

import type { PersonalityEngine } from './engine.js';
import {
  DEFAULT_PERSONALITY_FLAGS,
  getDefaultPersonaForKind,
  type PersonaOverride,
  type PersonalityFlagMap,
} from './types.js';

/**
 * How long each signal's delta survives without being renewed.
 *
 * A mood is the shortest — twelve minutes is long enough to span a few turns of
 * the same conversation and short enough that walking away and coming back finds
 * her level again. Familiarity is slow-moving and recomputed every cycle anyway,
 * so its window only exists to stop a stale value outliving the process. Time of
 * day is bounded by how fast the sky can actually change.
 */
export const AFFECT_TTL_MS = 12 * 60_000;
export const FAMILIARITY_TTL_MS = 60 * 60_000;
export const TIME_OF_DAY_TTL_MS = 30 * 60_000;

/**
 * The numeric tone, for callers that shape text themselves.
 *
 * Stage 9's deterministic draft needs the dimensions, not the prose hints the
 * model gets — it is choosing between sentences it already has, not writing new
 * ones.
 */
export interface ToneProfile {
  name: string;
  verbosity: 0 | 1 | 2;
  formality: 0 | 1 | 2;
  warmth: 0 | 1 | 2;
  /** Which signals are currently shaping this, for stage traces. */
  sources: PersonaOverride['source'][];
}

/** Neutral: what a caller gets when modulation is off. */
export const NEUTRAL_TONE: ToneProfile = {
  name: 'Default Neutral',
  verbosity: 1,
  formality: 1,
  warmth: 1,
  sources: [],
};

/**
 * What the hour does to how she speaks.
 *
 * Four bands, and the deltas are the ones that survive being read aloud. Late at
 * night people say less and say it more softly; just after waking nobody wants a
 * paragraph; the end of the day is warmer without being briefer; the middle of the
 * day is the baseline, so `day` returns nothing at all and `noteTimeOfDay` *clears*
 * the slot rather than writing a zero — the same "positive evidence of neutral"
 * rule `noteAffect` follows.
 *
 * The band parameter is a local string union, structurally identical to
 * `TimeOfDay` in `server/realtime/types.ts`, deliberately not imported. Personality
 * has no business depending on the realtime projection's types to answer a question
 * about the hour, and the compiler still rejects a caller that passes anything else.
 */
export function timeOfDayDeltas(
  band: 'night' | 'sunrise' | 'day' | 'sunset',
): { verbosityDelta?: number; warmthDelta?: number } {
  switch (band) {
    case 'night':
      return { verbosityDelta: -1, warmthDelta: 1 };
    case 'sunrise':
      return { verbosityDelta: -1 };
    case 'sunset':
      return { warmthDelta: 1 };
    case 'day':
    default:
      return {};
  }
}

export interface PersonalityServiceOptions {
  engine: PersonalityEngine;
  flags?: PersonalityFlagMap | undefined;
  /** Injectable clock, so a test can watch an override expire. */
  now?: (() => number) | undefined;
}

export class PersonalityService {
  private readonly engine: PersonalityEngine;
  private readonly flags: PersonalityFlagMap;
  private readonly now: () => number;
  /** Identities already given a baseline, so seeding is idempotent and cheap. */
  private readonly seeded = new Set<string>();

  constructor(options: PersonalityServiceOptions) {
    this.engine = options.engine;
    this.flags = options.flags ?? { ...DEFAULT_PERSONALITY_FLAGS };
    this.now = options.now ?? Date.now;
  }

  /** Whether anything here does anything. False means every read is neutral. */
  get enabled(): boolean {
    return this.flags.enablePersonalityModulation;
  }

  /**
   * Give this identity a baseline if it does not have one.
   *
   * Called from `runtimeFor`, which already holds the full `Identity` — so the
   * baseline comes from the identity's own kind rather than from a table of names
   * someone maintained by hand. Existing personas are left alone: an override
   * written earlier in the same session must not be reset by a later cycle.
   */
  ensureBaseline(identity: Identity): void {
    if (this.seeded.has(identity.id)) return;
    this.seeded.add(identity.id);
    if (this.engine.registry.getPersona(identity.id) !== undefined) return;

    const defaults = getDefaultPersonaForKind(identity.kind);
    this.engine.registry.setPersona({
      identityId: identity.id,
      name: `${identity.displayName} (${identity.kind})`,
      verbosity: (defaults.verbosity ?? 1) as 0 | 1 | 2,
      formality: (defaults.formality ?? 1) as 0 | 1 | 2,
      warmth: (defaults.warmth ?? 1) as 0 | 1 | 2,
    });
  }

  /**
   * Record what the emotion-reading module read, or clear the slot.
   *
   * Passing no deltas *removes* the override rather than writing an empty one.
   * That matters: a neutral reading is positive evidence that the previous mood
   * has passed, and leaving the old delta in place until its TTL ran out would
   * keep her warm at someone who has plainly moved on.
   */
  noteAffect(identityId: string, delta: { warmthDelta?: number; verbosityDelta?: number }): void {
    this.write(identityId, 'emotion', delta, AFFECT_TTL_MS);
  }

  /** Record how familiar this person is, from the relationship-context module. */
  noteFamiliarity(
    identityId: string,
    delta: { formalityDelta?: number; warmthDelta?: number },
  ): void {
    this.write(identityId, 'relationship', delta, FAMILIARITY_TTL_MS);
  }

  /** Record what the hour is doing to her, from the environment service. */
  noteTimeOfDay(identityId: string, delta: { verbosityDelta?: number; warmthDelta?: number }): void {
    this.write(identityId, 'timeOfDay', delta, TIME_OF_DAY_TTL_MS);
  }

  /** The instruction block for a model's `systemInstruction`. `''` when off. */
  instructionFor(identityId: string): string {
    if (!this.enabled) return '';
    return this.engine.getModulationPrompt(identityId, this.flags);
  }

  /** The numeric tone, for stage 9's deterministic draft. */
  profileFor(identityId: string): ToneProfile {
    if (!this.enabled) return { ...NEUTRAL_TONE };
    const effective = this.engine.registry.getEffectivePersonaWithFlags(identityId, this.flags);
    return {
      name: effective.name,
      verbosity: effective.verbosity,
      formality: effective.formality,
      warmth: effective.warmth,
      sources: effective.appliedOverrides.map((o) => o.source),
    };
  }

  // ── Internals ──

  /**
   * One override slot, written or cleared.
   *
   * `addOverride` already replaces by source, so writing is idempotent per signal
   * and three signals can never fight over one slot. `exactOptionalPropertyTypes`
   * is why the deltas are copied in conditionally rather than spread.
   */
  private write(
    identityId: string,
    source: PersonaOverride['source'],
    delta: { warmthDelta?: number; verbosityDelta?: number; formalityDelta?: number },
    ttlMs: number,
  ): void {
    if (!this.enabled || !this.flags.enablePersonaOverride) return;

    const meaningful =
      delta.warmthDelta !== undefined ||
      delta.verbosityDelta !== undefined ||
      delta.formalityDelta !== undefined;

    if (!meaningful) {
      this.engine.registry.removeOverride(identityId, source);
      return;
    }

    const override: PersonaOverride = { identityId, source, expiresAt: this.now() + ttlMs };
    if (delta.warmthDelta !== undefined) override.warmthDelta = delta.warmthDelta;
    if (delta.verbosityDelta !== undefined) override.verbosityDelta = delta.verbosityDelta;
    if (delta.formalityDelta !== undefined) override.formalityDelta = delta.formalityDelta;
    this.engine.registry.addOverride(override);
  }
}
