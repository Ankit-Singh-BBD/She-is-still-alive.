/**
 * P24 — Advanced Modules Opt-in (M16)
 * Tests for AdvancedModuleRegistry, AdvancedModuleCognitiveHook, and the
 * per-module opt-in / isolation contract.
 *
 * Per Build Book Part XX & Part XXVI.3.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AdvancedModuleRegistry,
  createDefaultAdvancedModuleRegistry,
  createDefaultAdvancedModules,
  createEnabledAdvancedModuleRegistry,
  createEmotionReadingModule,
  createRelationshipContextModule,
  createLongHorizonReflectionModule,
  createDreamConsolidationModule,
  DEFAULT_ADVANCED_FLAGS,
  type AdvancedModule,
  type AdvancedModuleFlagMap,
  type AdvancedModuleId,
} from '@server/advanced/index.js';
import {
  AdvancedModuleCognitiveHook,
  createDefaultAdvancedCognitiveHook,
  createAdvancedCognitiveHook,
} from '@server/advanced/cognitive-hook.js';
import type { CycleRecord } from '@server/cognition/types.js';

// ── Helpers ──

function makeCycle(opts: { stageCount?: number; identityId?: string; conversationId?: string } = {}): CycleRecord {
  const stageCount = opts.stageCount ?? 12;
  const stages = Array.from({ length: stageCount }, (_, i) => ({
    stage: (i + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
    stageName: `STAGE_${i + 1}`,
    startedAt: 1000,
    completedAt: 2000,
    inputJson: JSON.stringify({ hello: 'world', index: i + 1 }),
    outputJson: JSON.stringify({ ok: true, index: i + 1 }),
  }));
  return {
    id: 'cycle-test',
    identityId: opts.identityId ?? 'identity-1',
    conversationId: opts.conversationId ?? 'conv-1',
    status: 'completed',
    startedAt: 1000,
    completedAt: 2000,
    stages,
  };
}

function makeThrowingModule(id: AdvancedModuleId, flag: keyof AdvancedModuleFlagMap, hooks: readonly (1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12)[]): AdvancedModule {
  return {
    id,
    flag,
    hooks,
    async run(): Promise<Record<string, unknown>> {
      throw new Error(`module ${id} exploded`);
    },
  };
}

function makeRecordingModule(
  id: AdvancedModuleId,
  flag: keyof AdvancedModuleFlagMap,
  hooks: readonly (1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12)[],
): { module: AdvancedModule; calls: Array<{ input: unknown; stage: number; identityId: string; cycleId: string }> } {
  const calls: Array<{ input: unknown; stage: number; identityId: string; cycleId: string }> = [];
  const module: AdvancedModule = {
    id,
    flag,
    hooks,
    async run(input, stage, ctx) {
      calls.push({ input, stage, identityId: ctx.identityId, cycleId: ctx.cycleId });
      return { recorded: true, stage, kind: typeof input };
    },
  };
  return { module, calls };
}

// ── Tests ──

describe('P24 AdvancedModuleRegistry (Part XX, M16)', () => {
  describe('Construction and identification', () => {
    it('creates a default registry with all four P24 modules', () => {
      const registry = createDefaultAdvancedModuleRegistry();
      expect(registry.count()).toBe(4);
      expect(registry.ids().sort()).toEqual(
        ['dream-consolidation', 'emotion-reading', 'long-horizon-reflection', 'relationship-context'].sort(),
      );
    });

    it('createDefaultAdvancedModules returns a fresh array each call', () => {
      const a = createDefaultAdvancedModules();
      const b = createDefaultAdvancedModules();
      expect(a).not.toBe(b);
      expect(a.length).toBe(4);
      expect(b.length).toBe(4);
    });

    it('rejects duplicate module ids at construction time', () => {
      expect(
        () =>
          new AdvancedModuleRegistry([
            createEmotionReadingModule(),
            createEmotionReadingModule(),
          ]),
      ).toThrow(/Duplicate advanced module id/);
    });

    it('get() returns a registered module by id', () => {
      const registry = createDefaultAdvancedModuleRegistry();
      const m = registry.get('emotion-reading');
      expect(m).toBeDefined();
      expect(m?.id).toBe('emotion-reading');
      expect(m?.flag).toBe('enableEmotionReading');
    });

    it('get() returns undefined for an unknown id', () => {
      const registry = createDefaultAdvancedModuleRegistry();
      // @ts-expect-error — testing defensive behavior
      expect(registry.get('not-a-real-module')).toBeUndefined();
    });
  });

  describe('Flag-driven enablement', () => {
    it('default flags disable every module', () => {
      const registry = createDefaultAdvancedModuleRegistry();
      const enabled = registry.enabledIds(DEFAULT_ADVANCED_FLAGS);
      expect(enabled).toEqual([]);
    });

    it('enables only modules whose flag is on', () => {
      const registry = createDefaultAdvancedModuleRegistry();
      const flags: AdvancedModuleFlagMap = {
        ...DEFAULT_ADVANCED_FLAGS,
        enableEmotionReading: true,
        enableLongHorizonReflection: true,
      };
      const enabled = registry.enabledIds(flags);
      expect(enabled.sort()).toEqual(['emotion-reading', 'long-horizon-reflection'].sort());
    });

    it('createEnabledAdvancedModuleRegistry returns resolved flags and registry', () => {
      const { registry, flags } = createEnabledAdvancedModuleRegistry({
        enableDreamConsolidation: true,
      });
      expect(flags.enableDreamConsolidation).toBe(true);
      expect(flags.enableEmotionReading).toBe(false);
      expect(registry.count()).toBe(4);
    });
  });

  describe('Stage-filtered hook execution', () => {
    it('runs only modules whose hooks include the requested stage', async () => {
      const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2, 4]);
      const registry = new AdvancedModuleRegistry([module]);
      const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };

      await registry.run({ kind: 'in' }, 2, ctx('cycle-1', 'identity-1'), flags);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.stage).toBe(2);

      await registry.run({ kind: 'in' }, 4, ctx('cycle-1', 'identity-1'), flags);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.stage).toBe(4);

      // Stage 5 is not in hooks
      await registry.run({ kind: 'in' }, 5, ctx('cycle-1', 'identity-1'), flags);
      expect(calls).toHaveLength(2);
    });

    it('skips modules whose flag is off, even if hooks include the stage', async () => {
      const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2]);
      const registry = new AdvancedModuleRegistry([module]);
      const flags = DEFAULT_ADVANCED_FLAGS;
      await registry.run({ kind: 'in' }, 2, ctx('cycle-1', 'identity-1'), flags);
      expect(calls).toHaveLength(0);
    });

    it('passes cycle identity and identityId to the module context', async () => {
      const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2]);
      const registry = new AdvancedModuleRegistry([module]);
      const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };
      await registry.run(
        { input: 'x' },
        2,
        { identityId: 'ident-X', conversationId: 'conv-X', cycleId: 'cyc-X', stageNumber: 2 },
        flags,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.identityId).toBe('ident-X');
      expect(calls[0]!.cycleId).toBe('cyc-X');
    });

    it('returns successful results with the originating module id and stage', async () => {
      const { module } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2]);
      const registry = new AdvancedModuleRegistry([module]);
      const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };
      const { results, errors } = await registry.run({ in: 1 }, 2, ctx('cyc-1', 'ident-1'), flags);
      expect(errors).toEqual([]);
      expect(results).toHaveLength(1);
      expect(results[0]!.moduleId).toBe('emotion-reading');
      expect(results[0]!.stage).toBe(2);
      expect(results[0]!.data['recorded']).toBe(true);
    });
  });

  describe('Failure isolation (Part XX.2 — a thrown module cannot crash the runtime)', () => {
    it('catches a throwing module and reports it as an error, not a thrown exception', async () => {
      const throwing = makeThrowingModule('emotion-reading', 'enableEmotionReading', [2]);
      const registry = new AdvancedModuleRegistry([throwing]);
      const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };
      const { results, errors } = await registry.run(
        { in: 1 },
        2,
        ctx('cyc-1', 'ident-1'),
        flags,
      );
      expect(results).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.moduleId).toBe('emotion-reading');
      expect(errors[0]!.message).toContain('exploded');
    });

    it('continues to invoke sibling modules after one throws', async () => {
      const { module: ok } = makeRecordingModule('relationship-context', 'enableRelationshipContext', [4]);
      const throwing = makeThrowingModule('emotion-reading', 'enableEmotionReading', [4]);
      const registry = new AdvancedModuleRegistry([throwing, ok]);
      const flags: AdvancedModuleFlagMap = {
        ...DEFAULT_ADVANCED_FLAGS,
        enableEmotionReading: true,
        enableRelationshipContext: true,
      };
      const { results, errors } = await registry.run({ in: 1 }, 4, ctx('cyc-1', 'ident-1'), flags);
      expect(results).toHaveLength(1);
      expect(results[0]!.moduleId).toBe('relationship-context');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.moduleId).toBe('emotion-reading');
    });

    it('never propagates a thrown module error', async () => {
      const throwing = makeThrowingModule('emotion-reading', 'enableEmotionReading', [2]);
      const registry = new AdvancedModuleRegistry([throwing]);
      const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };
      await expect(
        registry.run({ in: 1 }, 2, ctx('cyc-1', 'ident-1'), flags),
      ).resolves.toBeDefined();
    });
  });

  describe('Default module wiring sanity', () => {
    it('emotion-reading hooks stages 2 (IDENTIFY) and 4 (UNDERSTAND)', () => {
      const m = createEmotionReadingModule();
      expect([...m.hooks].sort()).toEqual([2, 4]);
      expect(m.flag).toBe('enableEmotionReading');
    });

    it('relationship-context hooks stage 4 (UNDERSTAND)', () => {
      const m = createRelationshipContextModule();
      expect(m.hooks).toEqual([4]);
      expect(m.flag).toBe('enableRelationshipContext');
    });

    it('long-horizon-reflection hooks stage 11 (UPDATE)', () => {
      const m = createLongHorizonReflectionModule();
      expect(m.hooks).toEqual([11]);
      expect(m.flag).toBe('enableLongHorizonReflection');
    });

    it('dream-consolidation hooks stages 10 and 12 (LEARN + PERSIST)', () => {
      const m = createDreamConsolidationModule();
      expect([...m.hooks].sort()).toEqual([10, 12]);
      expect(m.flag).toBe('enableDreamConsolidation');
    });
  });
});

describe('P24 AdvancedModuleCognitiveHook (Part XX.2 — wire into cycles)', () => {
  it('returns an empty extension when registry is undefined (MVP path)', async () => {
    const hook = createDefaultAdvancedCognitiveHook();
    const cycle = makeCycle();
    const ext = await hook.afterCycle(cycle, {
      source: 'text',
      payload: 'hello',
      receivedAt: 1000,
      identityId: 'ident-1',
    });
    expect(ext.notes).toEqual([]);
    expect(ext.successCount).toBe(0);
    expect(ext.errorCount).toBe(0);
  });

  it('returns an empty extension when all flags are off', async () => {
    const registry = createDefaultAdvancedModuleRegistry();
    const hook = new AdvancedModuleCognitiveHook({ registry, flags: DEFAULT_ADVANCED_FLAGS });
    const cycle = makeCycle();
    const ext = await hook.afterCycle(cycle, {
      source: 'text',
      payload: 'hello',
      receivedAt: 1000,
      identityId: 'ident-1',
    });
    expect(ext.notes).toEqual([]);
    expect(ext.successCount).toBe(0);
    expect(ext.errorCount).toBe(0);
  });

  it('invokes enabled modules at every stage they hook into', async () => {
    const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2, 4]);
    const registry = new AdvancedModuleRegistry([module]);
    const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };
    const hook = createAdvancedCognitiveHook({ registry, flags });

    const ext = await hook.afterCycle(
      makeCycle({ stageCount: 6 }),
      { source: 'text', payload: 'hi', receivedAt: 1, identityId: 'ident-A' },
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.stage).sort()).toEqual([2, 4]);
    expect(ext.successCount).toBe(2);
    expect(ext.errorCount).toBe(0);
  });

  it('isolates a throwing module so the cycle remains green', async () => {
    const throwing = makeThrowingModule('emotion-reading', 'enableEmotionReading', [2]);
    const { module: ok, calls: okCalls } = makeRecordingModule(
      'relationship-context',
      'enableRelationshipContext',
      [4],
    );
    const registry = new AdvancedModuleRegistry([throwing, ok]);
    const flags: AdvancedModuleFlagMap = {
      ...DEFAULT_ADVANCED_FLAGS,
      enableEmotionReading: true,
      enableRelationshipContext: true,
    };
    const hook = createAdvancedCognitiveHook({ registry, flags });

    const ext = await hook.afterCycle(
      makeCycle({ stageCount: 6 }),
      { source: 'text', payload: 'hi', receivedAt: 1, identityId: 'ident-A' },
    );

    expect(okCalls).toHaveLength(1);
    expect(ext.successCount).toBe(1);
    expect(ext.errorCount).toBe(1);
    expect(ext.notes).toHaveLength(2);
  });

  it('counts success and error totals correctly across stages', async () => {
    const { module: a, calls: aCalls } = makeRecordingModule(
      'emotion-reading',
      'enableEmotionReading',
      [2, 4],
    );
    const throwing = makeThrowingModule('relationship-context', 'enableRelationshipContext', [4]);
    const registry = new AdvancedModuleRegistry([a, throwing]);
    const flags: AdvancedModuleFlagMap = {
      ...DEFAULT_ADVANCED_FLAGS,
      enableEmotionReading: true,
      enableRelationshipContext: true,
    };
    const hook = createAdvancedCognitiveHook({ registry, flags });

    const ext = await hook.afterCycle(
      makeCycle({ stageCount: 6 }),
      { source: 'text', payload: 'hi', receivedAt: 1, identityId: 'ident-A' },
    );

    expect(aCalls).toHaveLength(2);
    expect(ext.successCount).toBe(2);
    expect(ext.errorCount).toBe(1);
  });

  it('preserves the cycle record shape (does not mutate CycleRecord)', async () => {
    const { module } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2]);
    const registry = new AdvancedModuleRegistry([module]);
    const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };
    const hook = createAdvancedCognitiveHook({ registry, flags });

    const cycle = makeCycle({ stageCount: 3 });
    const before = JSON.parse(JSON.stringify(cycle));
    await hook.afterCycle(cycle, {
      source: 'text',
      payload: 'hi',
      receivedAt: 1,
      identityId: 'ident-A',
    });
    const after = JSON.parse(JSON.stringify(cycle));
    expect(after).toEqual(before);
  });
});

describe('P24 Feature flag integration (Part XX.2 — "All modules disable cleanly")', () => {
  it('disabling every module leaves a working MVP (zero-op extension)', async () => {
    const registry = createDefaultAdvancedModuleRegistry();
    const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS };
    const hook = createAdvancedCognitiveHook({ registry, flags });

    const cycle = makeCycle();
    const ext = await hook.afterCycle(cycle, {
      source: 'text',
      payload: 'hi',
      receivedAt: 1,
      identityId: 'ident-A',
    });

    // MVP path: no advanced module touches anything.
    expect(ext.notes).toEqual([]);
    expect(ext.successCount).toBe(0);
    expect(ext.errorCount).toBe(0);
  });

  it('enabling a single flag activates only that module', async () => {
    const registry = createDefaultAdvancedModuleRegistry();
    const { module, calls: erCalls } = makeRecordingModule(
      'emotion-reading',
      'enableEmotionReading',
      [2, 4],
    );
    // override the registered module with our recording one
    const overridden = new AdvancedModuleRegistry([
      module,
      createRelationshipContextModule(),
      createLongHorizonReflectionModule(),
      createDreamConsolidationModule(),
    ]);
    const flags: AdvancedModuleFlagMap = {
      ...DEFAULT_ADVANCED_FLAGS,
      enableEmotionReading: true,
    };
    const hook = createAdvancedCognitiveHook({ registry: overridden, flags });

    const ext = await hook.afterCycle(
      makeCycle({ stageCount: 12 }),
      { source: 'text', payload: 'hi', receivedAt: 1, identityId: 'ident-A' },
    );

    expect(erCalls).toHaveLength(2);
    expect(ext.successCount).toBe(2);
    expect(ext.errorCount).toBe(0);
    // The other three modules' flags are off, so they do not run.
    void registry;
  });

  it('toggling flags between calls does not leak state across cycles', async () => {
    const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2]);
    const registry = new AdvancedModuleRegistry([module]);

    const offHook = createAdvancedCognitiveHook({ registry, flags: DEFAULT_ADVANCED_FLAGS });
    await offHook.afterCycle(
      makeCycle({ stageCount: 3 }),
      { source: 'text', payload: 'a', receivedAt: 1, identityId: 'ident-A' },
    );

    const onHook = createAdvancedCognitiveHook({
      registry,
      flags: { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true },
    });
    await onHook.afterCycle(
      makeCycle({ stageCount: 3 }),
      { source: 'text', payload: 'b', receivedAt: 2, identityId: 'ident-A' },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ hello: 'world' });
  });
});

describe('P24 Smoke (Part XX.3 — verification)', () => {
  it('default modules run as a no-op without crashing across the 12-stage cycle', async () => {
    const registry = createDefaultAdvancedModuleRegistry();
    const flags: AdvancedModuleFlagMap = {
      ...DEFAULT_ADVANCED_FLAGS,
      enableEmotionReading: true,
      enableRelationshipContext: true,
      enableLongHorizonReflection: true,
      enableDreamConsolidation: true,
    };
    const hook = createAdvancedCognitiveHook({ registry, flags });

    const ext = await hook.afterCycle(
      makeCycle({ stageCount: 12 }),
      { source: 'text', payload: 'hello', receivedAt: 100, identityId: 'ident-A' },
    );

    // Stages hooked: 2,4 (emotion) + 4 (relationship) + 11 (long-horizon) + 10,12 (dream) = 6
    expect(ext.successCount).toBe(6);
    expect(ext.errorCount).toBe(0);
  });
});

// ── Tiny ctx helper ──

function ctx(cycleId: string, identityId: string) {
  return { identityId, conversationId: 'conv-1', cycleId, stageNumber: 2 as 1 | 2 };
}
