import {
  type Persona,
  type PersonaOverride,
  type EffectivePersona,
  type PersonalityFlagMap,
  type PersonalityRegistry as IPersonalityRegistry,
  DEFAULT_PERSONALITY_FLAGS,
  computeEffectiveDimension,
} from './types.js';

export class PersonalityRegistry implements IPersonalityRegistry {
  private readonly personas: Map<string, Persona> = new Map();
  private readonly overrides: Map<string, PersonaOverride[]> = new Map();

  constructor(initialPersonas?: Persona[]) {
    if (initialPersonas) {
      for (const p of initialPersonas) {
        this.setPersona(p);
      }
    }
  }

  getPersona(identityId: string): Persona | undefined {
    return this.personas.get(identityId);
  }

  setPersona(persona: Persona): void {
    if (!persona.identityId) {
      throw new Error('Persona must have a valid identityId');
    }
    this.personas.set(persona.identityId, { ...persona });
  }

  deletePersona(identityId: string): boolean {
    this.overrides.delete(identityId);
    return this.personas.delete(identityId);
  }

  getAllPersonas(): Persona[] {
    return Array.from(this.personas.values()).map((p) => ({ ...p }));
  }

  addOverride(override: PersonaOverride): void {
    if (!override.identityId) {
      throw new Error('Override must specify an identityId');
    }
    const current = this.overrides.get(override.identityId) ?? [];
    const filtered = current.filter((o) => o.source !== override.source);
    filtered.push({ ...override });
    this.overrides.set(override.identityId, filtered);
  }

  removeOverride(identityId: string, source: PersonaOverride['source']): boolean {
    const current = this.overrides.get(identityId);
    if (!current) return false;
    const initialLen = current.length;
    const filtered = current.filter((o) => o.source !== source);
    if (filtered.length === initialLen) return false;
    if (filtered.length === 0) {
      this.overrides.delete(identityId);
    } else {
      this.overrides.set(identityId, filtered);
    }
    return true;
  }

  clearOverrides(identityId: string): void {
    this.overrides.delete(identityId);
  }

  getEffectivePersona(identityId: string): EffectivePersona {
    return this.getEffectivePersonaWithFlags(identityId, {
      enablePersonalityModulation: true,
      enablePersonaOverride: true,
      enableVerbosityControl: true,
      enableFormalityControl: true,
      enableWarmthControl: true,
    });
  }

  getEffectivePersonaWithFlags(
    identityId: string,
    flags: PersonalityFlagMap = DEFAULT_PERSONALITY_FLAGS,
  ): EffectivePersona {
    const fallback: EffectivePersona = {
      identityId,
      name: 'Default Neutral',
      verbosity: 1,
      formality: 1,
      warmth: 1,
      appliedOverrides: [],
    };

    if (!flags.enablePersonalityModulation) {
      return fallback;
    }

    const base = this.personas.get(identityId) ?? {
      identityId,
      name: 'Default',
      verbosity: 1,
      formality: 1,
      warmth: 1,
    };

    let effectiveVerbosity = base.verbosity;
    let effectiveFormality = base.formality;
    let effectiveWarmth = base.warmth;
    let systemPromptSuffix = base.systemPromptSuffix;
    const styleMarkers = { ...(base.styleMarkers ?? {}) };

    const activeOverrides: PersonaOverride[] = [];
    const now = Date.now();

    if (flags.enablePersonaOverride) {
      const overrides = this.overrides.get(identityId) ?? [];
      for (const override of overrides) {
        if (override.expiresAt !== undefined && override.expiresAt <= now) {
          continue;
        }

        activeOverrides.push(override);

        if (flags.enableVerbosityControl && override.verbosityDelta !== undefined) {
          effectiveVerbosity = computeEffectiveDimension(
            effectiveVerbosity,
            override.verbosityDelta,
            0,
            2,
          ) as 0 | 1 | 2;
        }

        if (flags.enableFormalityControl && override.formalityDelta !== undefined) {
          effectiveFormality = computeEffectiveDimension(
            effectiveFormality,
            override.formalityDelta,
            0,
            2,
          ) as 0 | 1 | 2;
        }

        if (flags.enableWarmthControl && override.warmthDelta !== undefined) {
          effectiveWarmth = computeEffectiveDimension(
            effectiveWarmth,
            override.warmthDelta,
            0,
            2,
          ) as 0 | 1 | 2;
        }

        if (override.systemPromptAddition) {
          systemPromptSuffix = systemPromptSuffix
            ? `${systemPromptSuffix} ${override.systemPromptAddition}`
            : override.systemPromptAddition;
        }
      }
    }

    if (activeOverrides.length !== (this.overrides.get(identityId)?.length ?? 0)) {
      if (activeOverrides.length === 0) {
        this.overrides.delete(identityId);
      } else {
        this.overrides.set(identityId, activeOverrides);
      }
    }

    const result: import('./types.js').EffectivePersona = {
      identityId,
      name: base.name,
      verbosity: flags.enableVerbosityControl ? effectiveVerbosity : base.verbosity,
      formality: flags.enableFormalityControl ? effectiveFormality : base.formality,
      warmth: flags.enableWarmthControl ? effectiveWarmth : base.warmth,
      appliedOverrides: activeOverrides,
    };

    if (systemPromptSuffix !== undefined) {
      result.systemPromptSuffix = systemPromptSuffix;
    }
    if (Object.keys(styleMarkers).length > 0) {
      result.styleMarkers = styleMarkers;
    }

    return result;
  }
}
