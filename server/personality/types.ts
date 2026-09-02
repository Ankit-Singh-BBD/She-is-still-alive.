/**
 * Personality & Modulation (Phase P25 / Milestone M16)
 *
 * Build Book Part XXVI.3 Phase P25:
 *   Per-identity persona with verbosity, formality, warmth modulation.
 *   Feature-flagged with override capabilities.
 *   Checkpoint: Two identities see two tones.
 *   Rollback: default persona.
 */

import type { IdentityKind } from '@server/identity/types.js';

export type PersonalityFlag =
  | 'enablePersonalityModulation'
  | 'enablePersonaOverride'
  | 'enableVerbosityControl'
  | 'enableFormalityControl'
  | 'enableWarmthControl';

export interface PersonalityFlagMap {
  enablePersonalityModulation: boolean;
  enablePersonaOverride: boolean;
  enableVerbosityControl: boolean;
  enableFormalityControl: boolean;
  enableWarmthControl: boolean;
}

export const DEFAULT_PERSONALITY_FLAGS: Readonly<PersonalityFlagMap> = {
  enablePersonalityModulation: false,
  enablePersonaOverride: false,
  enableVerbosityControl: false,
  enableFormalityControl: false,
  enableWarmthControl: false,
};

/**
 * Persona definition — stable per identity.
 * Defines the baseline tone for an identity.
 */
export interface Persona {
  /** Unique identity this persona belongs to. */
  identityId: string;
  /** Human-readable name for debugging. */
  name: string;
  /** Verbosity level: 0=terse, 1=normal, 2=verbose. */
  verbosity: 0 | 1 | 2;
  /** Formality level: 0=casual, 1=balanced, 2=formal. */
  formality: 0 | 1 | 2;
  /** Warmth level: 0=cool, 1=warm, 2=very warm. */
  warmth: 0 | 1 | 2;
  /** Optional system prompt suffix for LLM. */
  systemPromptSuffix?: string;
  /** Custom vocabulary/style markers. */
  styleMarkers?: Record<string, string>;
}

/**
 * Per-identity override — applied on top of the base persona.
 * Used for dynamic modulation (e.g., time of day, relationship context).
 */
export interface PersonaOverride {
  identityId: string;
  /** Optional verbosity delta (-2 to +2). */
  verbosityDelta?: number;
  /** Optional formality delta (-2 to +2). */
  formalityDelta?: number;
  /** Optional warmth delta (-2 to +2). */
  warmthDelta?: number;
  /** Optional temporary system prompt addition. */
  systemPromptAddition?: string;
  /** When this override expires (timestamp), or undefined for persistent. */
  expiresAt?: number;
  /** Source of the override for debugging. */
  source: 'relationship' | 'timeOfDay' | 'emotion' | 'manual' | 'advanced_module';
}

/**
 * Computed effective persona after applying overrides.
 */
export interface EffectivePersona {
  identityId: string;
  name: string;
  verbosity: 0 | 1 | 2;
  formality: 0 | 1 | 2;
  warmth: 0 | 1 | 2;
  systemPromptSuffix?: string;
  styleMarkers?: Record<string, string>;
  appliedOverrides: PersonaOverride[];
}

/**
 * Personality registry — manages personas and applies overrides.
 */
export interface PersonalityRegistry {
  /** Get the base persona for an identity. */
  getPersona(identityId: string): Persona | undefined;
  /** Set or update a persona for an identity. */
  setPersona(persona: Persona): void;
  /** Delete a persona. */
  deletePersona(identityId: string): boolean;
  /** Get all registered personas. */
  getAllPersonas(): Persona[];
  /** Add a temporary override. */
  addOverride(override: PersonaOverride): void;
  /** Remove an override by identity and source. */
  removeOverride(identityId: string, source: PersonaOverride['source']): boolean;
  /** Clear all overrides for an identity. */
  clearOverrides(identityId: string): void;
  /** Get effective persona after applying active overrides. */
  getEffectivePersona(identityId: string): EffectivePersona;
  /** Get effective persona with feature flag awareness. */
  getEffectivePersonaWithFlags(
    identityId: string,
    flags: PersonalityFlagMap,
  ): EffectivePersona;
}

/**
 * Personality engine — computes effective persona and generates modulation instructions.
 */
export interface PersonalityEngine {
  registry: PersonalityRegistry;
  /** Get modulation instructions for LLM prompting. */
  getModulationPrompt(identityId: string, flags: PersonalityFlagMap): string;
  /** Get terse response constraint hint. */
  getVerbosityHint(identityId: string, flags: PersonalityFlagMap): string;
  /** Get formality style hint. */
  getFormalityHint(identityId: string, flags: PersonalityFlagMap): string;
  /** Get warmth tone hint. */
  getWarmthHint(identityId: string, flags: PersonalityFlagMap): string;
}

/**
 * Default personas per identity kind.
 */
export function getDefaultPersonaForKind(kind: IdentityKind): Partial<Persona> {
  switch (kind) {
    case 'owner':
      return { verbosity: 1, formality: 1, warmth: 2 };
    case 'person':
      return { verbosity: 1, formality: 1, warmth: 1 };
    case 'guest':
      return { verbosity: 0, formality: 1, warmth: 1 };
    default:
      return { verbosity: 1, formality: 1, warmth: 1 };
  }
}

/**
 * Clamp a value to valid range for personality dimensions.
 */
export function clampPersonaValue(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Compute effective verbosity/formality/warmth from base + delta.
 */
export function computeEffectiveDimension(
  base: number,
  delta: number,
  min: number,
  max: number,
): number {
  return clampPersonaValue(base + delta, min, max);
}