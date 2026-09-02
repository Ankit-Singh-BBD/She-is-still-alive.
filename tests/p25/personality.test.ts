import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersonalityRegistry } from '@server/personality/registry.js';
import { PersonalityEngine } from '@server/personality/engine.js';
import { DEFAULT_PERSONALITY_FLAGS, type PersonalityFlagMap, type Persona } from '@server/personality/types.js';

function allEnabled(): PersonalityFlagMap {
  return {
    enablePersonalityModulation: true,
    enablePersonaOverride: true,
    enableVerbosityControl: true,
    enableFormalityControl: true,
    enableWarmthControl: true,
  };
}

function cold(): PersonalityFlagMap {
  return { ...DEFAULT_PERSONALITY_FLAGS };
}

describe('P25 Personality & Modulation', () => {
  describe('getEffectivePersonaWithFlags — rollback / feature gate', () => {
    it('returns default neutral persona when enablePersonalityModulation is off', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'Identity A', verbosity: 0, formality: 2, warmth: 2 });
      const eff = reg.getEffectivePersonaWithFlags('A', cold());
      expect(eff.name).toBe('Default Neutral');
      expect(eff.verbosity).toBe(1);
      expect(eff.appliedOverrides).toEqual([]);
    });

    it('applies baseline persona when enabled', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'Identity A', verbosity: 0, formality: 2, warmth: 0 });
      const eff = reg.getEffectivePersonaWithFlags('A', allEnabled());
      expect(eff.verbosity).toBe(0);
      expect(eff.formality).toBe(2);
      expect(eff.warmth).toBe(0);
      expect(eff.name).toBe('Identity A');
    });
  });

  describe('Two identities see two tones (checkpoint)', () => {
    it('distinct personas produce distinct effective tones', () => {
      const reg = new PersonalityRegistry();
      const engine = new PersonalityEngine(reg);
      const flags = allEnabled();

      reg.setPersona({
        identityId: 'alice',
        name: 'Alice',
        verbosity: 2,
        formality: 0,
        warmth: 2,
        systemPromptSuffix: 'You adore long, breezy metaphors.',
      });
      reg.setPersona({
        identityId: 'bob',
        name: 'Bob',
        verbosity: 0,
        formality: 2,
        warmth: 0,
        systemPromptSuffix: 'You reply in clipped, precise sentences.',
      });

      const a = reg.getEffectivePersonaWithFlags('alice', flags);
      const b = reg.getEffectivePersonaWithFlags('bob', flags);
      expect([a.verbosity, a.formality, a.warmth]).not.toEqual([b.verbosity, b.formality, b.warmth]);

      const promptA = engine.getModulationPrompt('alice', flags);
      const promptB = engine.getModulationPrompt('bob', flags);
      expect(promptA).not.toBe(promptB);
      expect(promptB).toContain('concise');
      expect(promptA).toContain('expansive');
    });
  });

  describe('Override behavior', () => {
    it('adds an override and reflects it in the effective persona', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'A', verbosity: 1, formality: 1, warmth: 1 });
      reg.addOverride({
        identityId: 'A',
        verbosityDelta: 1,
        warmthDelta: 1,
        source: 'manual',
      });
      const eff = reg.getEffectivePersonaWithFlags('A', allEnabled());
      expect(eff.verbosity).toBe(2);
      expect(eff.warmth).toBe(2);
      expect(eff.appliedOverrides).toHaveLength(1);
    });

    it('removes an override by source', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'A', verbosity: 1, formality: 1, warmth: 1 });
      reg.addOverride({ identityId: 'A', verbosityDelta: 1, source: 'manual' });
      const removed = reg.removeOverride('A', 'manual');
      expect(removed).toBe(true);
      const eff = reg.getEffectivePersonaWithFlags('A', allEnabled());
      expect(eff.appliedOverrides).toHaveLength(0);
    });

    it('expired overrides are ignored', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'A', verbosity: 1, formality: 1, warmth: 1 });
      reg.addOverride({
        identityId: 'A',
        verbosityDelta: 1,
        source: 'manual',
        expiresAt: Date.now() - 1000,
      });
      const eff = reg.getEffectivePersonaWithFlags('A', allEnabled());
      expect(eff.verbosity).toBe(1);
      expect(eff.appliedOverrides).toHaveLength(0);
    });

    it('enablePersonaOverride off ignores all overrides', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'A', verbosity: 1, formality: 1, warmth: 1 });
      reg.addOverride({ identityId: 'A', verbosityDelta: 1, source: 'manual' });
      const flags: PersonalityFlagMap = { ...allEnabled(), enablePersonaOverride: false };
      const eff = reg.getEffectivePersonaWithFlags('A', flags);
      expect(eff.verbosity).toBe(1);
      expect(eff.appliedOverrides).toHaveLength(0);
    });

    it('per-dimension controls gate verbosity/formality/warmth independently', () => {
      const reg = new PersonalityRegistry();
      reg.setPersona({ identityId: 'A', name: 'A', verbosity: 1, formality: 1, warmth: 1 });
      reg.addOverride({ identityId: 'A', verbosityDelta: 1, warmthDelta: 1, source: 'manual' });
      const flags: PersonalityFlagMap = { ...allEnabled(), enableVerbosityControl: false };
      const eff = reg.getEffectivePersonaWithFlags('A', flags);
      expect(eff.verbosity).toBe(1); // not modulated
      expect(eff.warmth).toBe(2);    // modulated
    });
  });
});
