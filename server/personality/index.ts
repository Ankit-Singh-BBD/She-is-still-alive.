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

import { PersonalityRegistry } from './registry.js';
import { PersonalityEngine } from './engine.js';

/**
 * Convenience factory to create a fully wired personality engine.
 */
export function createPersonalityEngine(): PersonalityEngine {
  const registry = new PersonalityRegistry();
  // Ensure the default owner identity exists as an example
  registry.setPersona({
    identityId: 'default-owner',
    name: 'Owner Baseline',
    verbosity: 1,
    formality: 1,
    warmth: 2,
  });
  return new PersonalityEngine(registry);
}
