import {
  type PersonalityEngine as IPersonalityEngine,
  type PersonalityRegistry,
  type PersonalityFlagMap,
  DEFAULT_PERSONALITY_FLAGS,
  type EffectivePersona,
} from './types.js';

export class PersonalityEngine implements IPersonalityEngine {
  constructor(public readonly registry: PersonalityRegistry) {}

  getVerbosityHint(identityId: string, flags: PersonalityFlagMap = DEFAULT_PERSONALITY_FLAGS): string {
    const effective = this.registry.getEffectivePersonaWithFlags(identityId, flags);
    switch (effective.verbosity) {
      case 0:
        return 'Be concise, direct, and terse. Avoid unnecessary elaboration or filler.';
      case 2:
        return 'Be expansive, detailed, and thorough. Provide rich context and background.';
      case 1:
      default:
        return 'Maintain balanced verbosity suitable for conversational flow.';
    }
  }

  getFormalityHint(identityId: string, flags: PersonalityFlagMap = DEFAULT_PERSONALITY_FLAGS): string {
    const effective = this.registry.getEffectivePersonaWithFlags(identityId, flags);
    switch (effective.formality) {
      case 0:
        return 'Adopt a casual, relaxed, and conversational tone.';
      case 2:
        return 'Adopt a formal, precise, and professional demeanor.';
      case 1:
      default:
        return 'Maintain a warm yet respectful and natural tone.';
    }
  }

  getWarmthHint(identityId: string, flags: PersonalityFlagMap = DEFAULT_PERSONALITY_FLAGS): string {
    const effective = this.registry.getEffectivePersonaWithFlags(identityId, flags);
    switch (effective.warmth) {
      case 0:
        return 'Maintain objective, calm, and slightly detached composure.';
      case 2:
        return 'Be deeply empathetic, caring, attentive, and warmly expressive.';
      case 1:
      default:
        return 'Express friendly, considerate, and supportive presence.';
    }
  }

  getModulationPrompt(identityId: string, flags: PersonalityFlagMap = DEFAULT_PERSONALITY_FLAGS): string {
    const effective: EffectivePersona = this.registry.getEffectivePersonaWithFlags(identityId, flags);

    if (!flags.enablePersonalityModulation) {
      return '';
    }

    const sections: string[] = [];

    sections.push(`[Personality Tone Profile: ${effective.name}]`);
    if (flags.enableVerbosityControl) {
      sections.push(`- Verbosity: ${this.getVerbosityHint(identityId, flags)}`);
    }
    if (flags.enableFormalityControl) {
      sections.push(`- Formality: ${this.getFormalityHint(identityId, flags)}`);
    }
    if (flags.enableWarmthControl) {
      sections.push(`- Warmth: ${this.getWarmthHint(identityId, flags)}`);
    }

    if (effective.systemPromptSuffix) {
      sections.push(`- Style Note: ${effective.systemPromptSuffix}`);
    }

    if (effective.styleMarkers) {
      const markers = Object.entries(effective.styleMarkers)
        .map(([k, v]) => `${k} -> ${v}`)
        .join(', ');
      sections.push(`- Lexicon/Markers: ${markers}`);
    }

    return sections.join('\n');
  }
}
