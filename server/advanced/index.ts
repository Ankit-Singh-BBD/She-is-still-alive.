/**
 * Advanced Intelligence Modules (Build Book Part XX / Part XXVI.3 Phase P24).
 *
 * Four faculties that hook the 12-stage cycle: emotion reading, relationship
 * context, long-horizon reflection, dream consolidation. Each is opt-in behind its
 * own flag and isolated, so a failure in one cannot crash a cycle.
 *
 * ## What changed here, and why the file got smaller
 *
 * This file used to hold the contract, the registry, *and* four factories whose
 * bodies were one line each:
 *
 *     return { hint: 'emotion-reading:no-op', inputKind: typeof input };
 *
 * Four flags, four hook lists, four entries in the trace — and nothing behind any
 * of them. That is a worse failure than missing code, because the wiring reported
 * success: `successCount: 6` on a cycle where six modules had done nothing at all.
 *
 * So the four factories now live in their own files with real implementations, the
 * shared contract lives in `./types.js`, and this file keeps the registry and the
 * re-exports. Every name that was importable from here before still is —
 * `tests/p24/advanced-modules.test.ts` imports twelve of them and needed no edit.
 *
 * ## Why the factories take dependencies now
 *
 * A module that reads affect has to write the tone somewhere; a module that folds
 * duplicates has to reach the memory repository. Those arrive as an
 * `AdvancedModuleDeps` bag rather than through the registry, because the registry's
 * job is dispatch and isolation and it should not have to know what any module
 * wants.
 *
 * Every parameter is optional at every level, so `createDefaultAdvancedModules()`
 * with no arguments keeps working exactly as it did — it builds four real modules
 * that compute what they can and report `applied: false` for the rest. That path is
 * public surface and is what the P24 tests exercise; the wired path is what
 * `server/app.ts` builds.
 */

import type { StageNumber } from '@server/cognition/types.js';

import { createDreamConsolidationModule } from './dream.js';
import { createEmotionReadingModule } from './emotion.js';
import { createLongHorizonReflectionModule } from './reflection.js';
import { createRelationshipContextModule } from './relationship.js';
import {
  DEFAULT_ADVANCED_FLAGS,
  type AdvancedModule,
  type AdvancedModuleContext,
  type AdvancedModuleDeps,
  type AdvancedModuleFlagMap,
  type AdvancedModuleId,
  type AdvancedModuleResult,
} from './types.js';

export {
  createDreamConsolidationModule,
  createEmotionReadingModule,
  createLongHorizonReflectionModule,
  createRelationshipContextModule,
};
export type { DreamOptions } from './dream.js';
export type { ReflectionOptions } from './reflection.js';
export { REFLECTION_PREDICATE } from './reflection.js';
export {
  MIN_ACTIONABLE_CONFIDENCE,
  personaDeltaFor,
  readAffect,
  type AffectLabel,
  type AffectReading,
} from './affect.js';
export {
  DEFAULT_ADVANCED_FLAGS,
  EMPTY_ADVANCED_EXTENSION,
  type AdvancedCognitiveExtension,
  type AdvancedCycleNote,
  type AdvancedModule,
  type AdvancedModuleContext,
  type AdvancedModuleDeps,
  type AdvancedModuleFlag,
  type AdvancedModuleFlagMap,
  type AdvancedModuleId,
  type AdvancedModuleReport,
  type AdvancedModuleResult,
} from './types.js';

/**
 * Isolated invocation of the advanced modules enabled by `flags`.
 *
 * - Off: a module whose flag is false is never constructed into a call.
 * - Isolated: a module that throws is recorded in `errors` and cannot abort the
 *   cycle. Modules are advisory, so callers must *not* branch on `errors` to
 *   block the surrounding stage.
 * - Stage-filtered: only modules whose `hooks` include `stage` are invoked.
 */
export class AdvancedModuleRegistry {
  private readonly modules: ReadonlyMap<AdvancedModuleId, AdvancedModule>;

  constructor(modules: AdvancedModule[]) {
    const map = new Map<AdvancedModuleId, AdvancedModule>();
    for (const m of modules) {
      if (map.has(m.id)) {
        throw new Error(`Duplicate advanced module id: ${m.id}`);
      }
      map.set(m.id, m);
    }
    this.modules = map;
  }

  ids(): AdvancedModuleId[] {
    return [...this.modules.keys()];
  }

  count(): number {
    return this.modules.size;
  }

  get(id: AdvancedModuleId): AdvancedModule | undefined {
    return this.modules.get(id);
  }

  enabledIds(flags: AdvancedModuleFlagMap): AdvancedModuleId[] {
    return [...this.modules.values()].filter((m) => flags[m.flag]).map((m) => m.id);
  }

  /** True when at least one enabled module hooks `stage` — lets a caller skip the call. */
  hooksStage(stage: StageNumber, flags: AdvancedModuleFlagMap): boolean {
    for (const module of this.modules.values()) {
      if (flags[module.flag] && module.hooks.includes(stage)) return true;
    }
    return false;
  }

  /**
   * Invoke every enabled module that hooks `stage`.
   *
   * Returns the successful outputs and the isolated failures. Never throws for a
   * module-level error.
   */
  async run(
    input: unknown,
    stage: StageNumber,
    context: AdvancedModuleContext,
    flags: AdvancedModuleFlagMap,
  ): Promise<{
    results: AdvancedModuleResult[];
    errors: Array<{ moduleId: AdvancedModuleId; message: string }>;
  }> {
    const results: AdvancedModuleResult[] = [];
    const errors: Array<{ moduleId: AdvancedModuleId; message: string }> = [];

    for (const module of this.modules.values()) {
      if (!flags[module.flag]) continue;
      if (!module.hooks.includes(stage)) continue;

      try {
        const data = await module.run(input, stage, context);
        results.push({ moduleId: module.id, stage, data });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ moduleId: module.id, message });
      }
    }

    return { results, errors };
  }
}

/**
 * The four modules, in stage order of their first hook.
 *
 * Callable with no arguments on purpose — see the header. With no deps each module
 * still runs and still reports; it simply reports that it had nowhere to write.
 */
export function createDefaultAdvancedModules(deps: AdvancedModuleDeps = {}): AdvancedModule[] {
  return [
    createEmotionReadingModule(deps),
    createRelationshipContextModule(deps),
    createLongHorizonReflectionModule(deps),
    createDreamConsolidationModule(deps),
  ];
}

export function createDefaultAdvancedModuleRegistry(
  deps: AdvancedModuleDeps = {},
): AdvancedModuleRegistry {
  return new AdvancedModuleRegistry(createDefaultAdvancedModules(deps));
}

export function createEnabledAdvancedModuleRegistry(
  flags: Partial<AdvancedModuleFlagMap> = {},
  deps: AdvancedModuleDeps = {},
): { registry: AdvancedModuleRegistry; flags: AdvancedModuleFlagMap } {
  const registry = createDefaultAdvancedModuleRegistry(deps);
  const resolved: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, ...flags };
  return { registry, flags: resolved };
}
