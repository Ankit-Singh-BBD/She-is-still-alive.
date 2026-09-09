/**
 * The personality subsystem's public surface.
 *
 * ## What was removed from here, and why
 *
 * This file used to export a `createPersonalityEngine()` convenience factory whose
 * body seeded a persona for the literal identity id `'default-owner'`:
 *
 *     registry.setPersona({ identityId: 'default-owner', name: 'Owner Baseline', … });
 *
 * Nothing called it — `grep` across `server/` and `tests/` found no reference. It
 * was a hand-written character sheet for an identity that does not exist in any
 * database this application creates, sitting in the public surface waiting for
 * someone to wire it, and wiring it would have been the one thing the design
 * forbids: "kisi tarah ke predefined prompt ya persona pe nahi chalti sab kuch
 * actual logic se build hai".
 *
 * A baseline is still needed — she cannot open a conversation from nowhere — but it
 * comes from `PersonalityService.ensureBaseline`, which reads the *real* identity's
 * kind. That is derived from a fact rather than authored, and it is keyed to an
 * identity that actually exists.
 */

export type {
  PersonalityFlag,
  PersonalityFlagMap,
  Persona,
  PersonaOverride,
  EffectivePersona,
} from './types.js';

export {
  DEFAULT_PERSONALITY_FLAGS,
  getDefaultPersonaForKind,
  clampPersonaValue,
  computeEffectiveDimension,
} from './types.js';

export { PersonalityRegistry } from './registry.js';
export { PersonalityEngine } from './engine.js';

/**
 * The one consumer of the engine, and the one thing outside this directory should
 * hold. See `./service.ts` for why a persona is computed rather than written down.
 */
export {
  PersonalityService,
  NEUTRAL_TONE,
  AFFECT_TTL_MS,
  FAMILIARITY_TTL_MS,
  TIME_OF_DAY_TTL_MS,
  timeOfDayDeltas,
  type PersonalityServiceOptions,
  type ToneProfile,
} from './service.js';
