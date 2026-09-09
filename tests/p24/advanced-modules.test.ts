/**
 * P24 — Advanced Modules Opt-in (M16)
 *
 * Two halves, and the split is deliberate.
 *
 * The first half tests `AdvancedModuleRegistry` on its own — construction, flag
 * enablement, stage filtering, failure isolation. What can go wrong there is
 * dispatch logic, and dispatch logic is far easier to pin down without twelve
 * stages and a database in the way.
 *
 * The second half used to test `AdvancedModuleCognitiveHook`, which ran the same
 * registry over an already-*finished* `CycleRecord`. That class is deleted, and its
 * ten tests are not ported: they asserted that a mechanism nothing called did what
 * it claimed. A module that reads affect at stage 2 exists so stage 9 can answer in
 * the register it found, and a pass beginning after stage 12 has committed cannot
 * inform any stage of the cycle it is reading — so every write it made landed a turn
 * late. What replaces them drives a real `CognitiveRuntime` over a real migrated
 * database, because that is the only path there is now.
 *
 * Per Build Book Part XX & Part XXVI.3.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
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
  type AdvancedCognitiveExtension,
  type AdvancedModule,
  type AdvancedModuleFlagMap,
  type AdvancedModuleId,
} from '@server/advanced/index.js';
import type { CycleRecord, RawStimulus } from '@server/cognition/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

// ── Helpers ──

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

const IDENTITY = 'ident-A';
const CONVERSATION = 'conv-A';

/**
 * One full twelve-stage cycle over a fresh migrated database, and the module
 * reports it produced.
 *
 * A bare `CognitiveRuntime` with no LLM wired is exactly right here: every stage
 * still runs and still hands its input to the modules, and what this file is about
 * is *when a module is invoked*, not what it decides. `onCycle` is the only place
 * the extension is observable — it is on `CycleOutcome`, deliberately not on
 * `CycleRecord` — so a test cannot reach it any other way.
 */
async function cycleWith(
  advanced: { registry: AdvancedModuleRegistry; flags: AdvancedModuleFlagMap } | undefined,
  text = 'hello',
): Promise<{ ext: AdvancedCognitiveExtension; record: CycleRecord }> {
  const db = new Database({ path: ':memory:' });
  runMigrations(db, migrationsDir);
  db.raw
    .prepare(
      `INSERT INTO identity (id, kind, display_name, status) VALUES (?, 'guest', 'Guest', 'active')`,
    )
    .run(IDENTITY);
  db.raw
    .prepare(`INSERT INTO conversation (id, identity_id) VALUES (?, ?)`)
    .run(CONVERSATION, IDENTITY);

  let ext: AdvancedCognitiveExtension | undefined;
  const runtime = new CognitiveRuntime({
    db,
    ...(advanced ? { advanced } : {}),
    onCycle: (_record, extras) => {
      ext = extras.advanced;
    },
  });

  const stimulus: RawStimulus = {
    source: 'text',
    payload: { text },
    receivedAt: 1_700_000_000_000,
    identityId: IDENTITY,
    conversationId: CONVERSATION,
  };
  const record = await runtime.runCycle(stimulus);

  // Not ceremony: without this, a runtime that never notified would be
  // indistinguishable from one whose modules all declined.
  expect(ext).toBeDefined();
  return { ext: ext!, record };
}

describe('P24 advanced modules inside a real cycle (Part XX.2 — wire into cycles)', () => {
  it('reports an empty extension when no registry is wired', async () => {
    const { ext, record } = await cycleWith(undefined);

    expect(ext.notes).toEqual([]);
    expect(ext.successCount).toBe(0);
    expect(ext.errorCount).toBe(0);
    // The MVP path: she thinks a whole cycle through with no faculties attached.
    expect(record.status).toBe('completed');
  });

  it('reports an empty extension when every flag is off', async () => {
    const registry = createDefaultAdvancedModuleRegistry();
    const { ext, record } = await cycleWith({ registry, flags: DEFAULT_ADVANCED_FLAGS });

    expect(ext.notes).toEqual([]);
    expect(ext.successCount).toBe(0);
    expect(ext.errorCount).toBe(0);
    expect(record.status).toBe('completed');
  });

  it('invokes a module at every stage it hooks, inside the cycle it is reading', async () => {
    const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2, 4]);
    const registry = new AdvancedModuleRegistry([module]);
    const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };

    const { ext, record } = await cycleWith({ registry, flags });

    expect(calls.map((c) => c.stage)).toEqual([2, 4]);
    expect(ext.successCount).toBe(2);
    expect(ext.errorCount).toBe(0);
    // The point of the whole in-cycle path, and the one thing the deleted
    // after-the-cycle mechanism could not do: the context a module is handed names
    // the cycle *currently running*, so a stage that has not happened yet can still
    // act on what the module found.
    expect(calls.every((c) => c.cycleId === record.id)).toBe(true);
    expect(calls.every((c) => c.identityId === IDENTITY)).toBe(true);
    expect(ext.notes.map((n) => n.stage)).toEqual([2, 4]);
  });

  it('isolates a throwing module and still finishes the cycle', async () => {
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

    const { ext, record } = await cycleWith({ registry, flags });

    expect(okCalls).toHaveLength(1);
    expect(ext.successCount).toBe(1);
    expect(ext.errorCount).toBe(1);
    expect(ext.notes).toHaveLength(2);
    // 'degraded' is what a *stage* failing looks like. A module failing must not
    // reach the status at all: these are advisory faculties, and one of them
    // exploding cannot be allowed to change what the cycle reports about itself.
    expect(record.status).toBe('completed');
    expect(record.error).toBeUndefined();
  });

  it('aggregates success and error totals across stages', async () => {
    const { module: reader, calls } = makeRecordingModule(
      'emotion-reading',
      'enableEmotionReading',
      [2, 4],
    );
    const throwing = makeThrowingModule('relationship-context', 'enableRelationshipContext', [4]);
    const registry = new AdvancedModuleRegistry([reader, throwing]);
    const flags: AdvancedModuleFlagMap = {
      ...DEFAULT_ADVANCED_FLAGS,
      enableEmotionReading: true,
      enableRelationshipContext: true,
    };

    const { ext } = await cycleWith({ registry, flags });

    expect(calls).toHaveLength(2);
    expect(ext.successCount).toBe(2);
    expect(ext.errorCount).toBe(1);
  });

  it('records what a module returned without letting it change the cycle', async () => {
    // A module that tries to be the answer. `AdvancedModuleDeps` calls this out as
    // the contract: a faculty, not an authority.
    const hijack: AdvancedModule = {
      id: 'emotion-reading',
      flag: 'enableEmotionReading',
      hooks: [9],
      async run(): Promise<Record<string, unknown>> {
        return { text: 'HIJACKED', decision: { kind: 'refuse' } };
      },
    };
    const registry = new AdvancedModuleRegistry([hijack]);
    const flags: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true };

    const { ext, record } = await cycleWith({ registry, flags });

    // Recorded: its report is exactly where a report goes.
    expect(JSON.stringify(ext)).toContain('HIJACKED');
    // Not obeyed: nothing it returned reached the response, the decision, or a trace.
    expect(JSON.stringify(record)).not.toContain('HIJACKED');
    expect(record.status).toBe('completed');
  });

  it('invokes the four real modules exactly six times across one cycle', async () => {
    const registry = createDefaultAdvancedModuleRegistry();
    const flags: AdvancedModuleFlagMap = {
      enableEmotionReading: true,
      enableRelationshipContext: true,
      enableLongHorizonReflection: true,
      enableDreamConsolidation: true,
    };

    const { ext, record } = await cycleWith({ registry, flags });

    // 2, 4 (emotion) + 4 (relationship) + 10, 12 (dream) + 11 (long-horizon).
    expect(ext.successCount).toBe(6);
    expect(ext.errorCount).toBe(0);
    expect(
      ext.notes.flatMap((n) => n.results.map((r) => `${r.stage}:${r.moduleId}`)),
    ).toEqual([
      '2:emotion-reading',
      '4:emotion-reading',
      '4:relationship-context',
      '10:dream-consolidation',
      '11:long-horizon-reflection',
      '12:dream-consolidation',
    ]);
    // Stage 12's pass runs after the commit, so a cycle it folded rows during is
    // still a cycle that completed.
    expect(record.status).toBe('completed');
  });
});

describe('P24 Feature flag integration (Part XX.2 — "All modules disable cleanly")', () => {
  it('enabling a single flag activates only that module', async () => {
    const { module, calls: erCalls } = makeRecordingModule(
      'emotion-reading',
      'enableEmotionReading',
      [2, 4],
    );
    // The recording module stands in for the real emotion reader; the other three
    // are the real ones, with their flags off.
    const registry = new AdvancedModuleRegistry([
      module,
      createRelationshipContextModule(),
      createLongHorizonReflectionModule(),
      createDreamConsolidationModule(),
    ]);
    const flags: AdvancedModuleFlagMap = {
      ...DEFAULT_ADVANCED_FLAGS,
      enableEmotionReading: true,
    };

    const { ext } = await cycleWith({ registry, flags });

    expect(erCalls.map((c) => c.stage)).toEqual([2, 4]);
    expect(ext.successCount).toBe(2);
    expect(ext.errorCount).toBe(0);
    // Every note came from the one enabled module. A flag that is off is not a
    // module that ran and returned nothing.
    expect(ext.notes.flatMap((n) => n.results.map((r) => r.moduleId))).toEqual([
      'emotion-reading',
      'emotion-reading',
    ]);
  });

  it('does not carry a flag decision from one cycle into the next', async () => {
    const { module, calls } = makeRecordingModule('emotion-reading', 'enableEmotionReading', [2]);
    const registry = new AdvancedModuleRegistry([module]);

    await cycleWith({ registry, flags: DEFAULT_ADVANCED_FLAGS }, 'first');
    expect(calls).toHaveLength(0);

    await cycleWith(
      { registry, flags: { ...DEFAULT_ADVANCED_FLAGS, enableEmotionReading: true } },
      'second',
    );
    expect(calls).toHaveLength(1);
  });
});

// ── Tiny ctx helper ──

function ctx(cycleId: string, identityId: string) {
  return { identityId, conversationId: 'conv-1', cycleId, stageNumber: 2 as 1 | 2 };
}
