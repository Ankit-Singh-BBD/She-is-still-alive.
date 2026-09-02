/**
 * Advanced Intelligence Modules (Phase P24 / Milestone M16)
 *
 * Build Book Part XX & Part XXVI.3 Phase P24:
 *   Each is a CognitiveModule that hooks into one or more of the 12 cognitive
 *   stages. They are opt-in modules with explicit feature flags and isolation —
 *   a failure in one cannot crash the runtime.
 *
 * Modules declare:
 *   - id            stable module identifier
 *   - flag          feature flag key that controls enable/disable
 *   - hooks         list of stage numbers this module participates in
 *   - run(input, stage, context)  per-stage contribution (pure; may be async)
 *
 * The AdvancedModuleRegistry:
 *   - holds the registered modules
 *   - resolves enabled modules from a flag map
 *   - invokes only the hook that matches the current stage number
 *   - isolates failures: a throwing module is recorded as a WarningAction and
 *     does not propagate the error
 */

import type { StageNumber } from '@server/cognition/types.js';

export type AdvancedModuleId =
  | 'emotion-reading'
  | 'relationship-context'
  | 'long-horizon-reflection'
  | 'dream-consolidation';

export type AdvancedModuleFlag =
  | 'enableEmotionReading'
  | 'enableRelationshipContext'
  | 'enableLongHorizonReflection'
  | 'enableDreamConsolidation';

export interface AdvancedModuleFlagMap {
  enableEmotionReading: boolean;
  enableRelationshipContext: boolean;
  enableLongHorizonReflection: boolean;
  enableDreamConsolidation: boolean;
}

export const DEFAULT_ADVANCED_FLAGS: Readonly<AdvancedModuleFlagMap> = {
  enableEmotionReading: false,
  enableRelationshipContext: false,
  enableLongHorizonReflection: false,
  enableDreamConsolidation: false,
};

export interface AdvancedModuleContext {
  identityId: string;
  conversationId: string;
  cycleId: string;
  /** Current stage number — set by the caller so modules can branch. */
  stageNumber: StageNumber;
}

export interface AdvancedModuleResult {
  /** Stable module id that produced this result. */
  moduleId: AdvancedModuleId;
  /** Stage number that produced this result (echo of the input stage). */
  stage: StageNumber;
  /** Payload contributed by the module. Shape is opaque to the registry. */
  data: Record<string, unknown>;
  /** Optional diagnostic note. */
  note?: string;
}

export interface AdvancedModule {
  readonly id: AdvancedModuleId;
  readonly flag: AdvancedModuleFlag;
  /** Stage numbers this module participates in. Only those stages invoke `run`. */
  readonly hooks: readonly StageNumber[];
  /** Pure per-stage contribution. Throwing is never propagated. */
  run(input: unknown, stage: StageNumber, context: AdvancedModuleContext): Promise<Record<string, unknown>>;
}

/**
 * Isolated invocation of the advanced modules enabled by `flags`.
 *
 * - Offline: if a module's flag is false, the module is skipped entirely.
 * - Isolated: a module that throws is swallowed and reported as an `errors`
 *   entry; it cannot abort the cycle.
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
    return [...this.modules.values()]
      .filter((m) => flags[m.flag])
      .map((m) => m.id);
  }

  /**
   * Invoke all enabled modules that hook the given `stage`.
   *
   * Returns `{ results, errors }` where `results` are the successful module
   * outputs and `errors` are isolated failures (string ids + throw message).
   *
   * Never throws for module-level errors — callers must not branch on
   * `errors` to block the outer stage; advanced modules are advisory.
   */
  async run(
    input: unknown,
    stage: StageNumber,
    context: AdvancedModuleContext,
    flags: AdvancedModuleFlagMap,
  ): Promise<{ results: AdvancedModuleResult[]; errors: Array<{ moduleId: AdvancedModuleId; message: string }> }> {
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

// ── Default no-op implementations for the four P24 modules ──
//
// Each module's `run` is deliberately trivial — just an echo with metadata.
// Real inference/retrieval logic plugs in by replacing the module instance
// while preserving the same interface, flag, and isolation contract.

export function createEmotionReadingModule(): AdvancedModule {
  return {
    id: 'emotion-reading',
    flag: 'enableEmotionReading',
    hooks: [2, 4], // enriches IDENTIFY and UNDERSTAND
    async run(input: unknown, _stage: StageNumber, _ctx: AdvancedModuleContext) {
      // Placeholder — real impl classifies affect from voice/text features.
      return { hint: 'emotion-reading:no-op', inputKind: typeof input };
    },
  };
}

export function createRelationshipContextModule(): AdvancedModule {
  return {
    id: 'relationship-context',
    flag: 'enableRelationshipContext',
    hooks: [4], // contributes to UNDERSTAND (Part XX.1)
    async run(input: unknown, _stage: StageNumber, _ctx: AdvancedModuleContext) {
      // Placeholder — real impl recalls who matters to whom for this identity.
      return { hint: 'relationship-context:no-op', inputKind: typeof input };
    },
  };
}

export function createLongHorizonReflectionModule(): AdvancedModule {
  return {
    id: 'long-horizon-reflection',
    flag: 'enableLongHorizonReflection',
    hooks: [11], // summarizes/consolidates during UPDATE
    async run(input: unknown, _stage: StageNumber, _ctx: AdvancedModuleContext) {
      // Placeholder — real impl produces scheduled daily/weekly summaries.
      return { hint: 'long-horizon-reflection:no-op', inputKind: typeof input };
    },
  };
}

export function createDreamConsolidationModule(): AdvancedModule {
  return {
    id: 'dream-consolidation',
    flag: 'enableDreamConsolidation',
    hooks: [10, 12], // offline consolidation in LEARN + PERSIST window
    async run(input: unknown, _stage: StageNumber, _ctx: AdvancedModuleContext) {
      // Placeholder — real impl runs during quiet hours.
      return { hint: 'dream-consolidation:no-op', inputKind: typeof input };
    },
  };
}

export function createDefaultAdvancedModules(): AdvancedModule[] {
  return [
    createEmotionReadingModule(),
    createRelationshipContextModule(),
    createLongHorizonReflectionModule(),
    createDreamConsolidationModule(),
  ];
}

export function createDefaultAdvancedModuleRegistry(): AdvancedModuleRegistry {
  return new AdvancedModuleRegistry(createDefaultAdvancedModules());
}

export function createEnabledAdvancedModuleRegistry(
  flags: Partial<AdvancedModuleFlagMap> = {},
): { registry: AdvancedModuleRegistry; flags: AdvancedModuleFlagMap } {
  const registry = createDefaultAdvancedModuleRegistry();
  const resolved: AdvancedModuleFlagMap = { ...DEFAULT_ADVANCED_FLAGS, ...flags };
  return { registry, flags: resolved };
}
