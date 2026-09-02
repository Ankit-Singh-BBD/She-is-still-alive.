/**
 * AdvancedModuleCognitiveHook — wires `AdvancedModuleRegistry` into a
 * cognitive cycle without modifying the 12-stage pipeline.
 *
 * Build Book Part XX.2: "Each is a CognitiveModule that hooks into one or
 * more of the 12 stages. They are opt-in modules, with explicit feature
 * flags and isolation so a failure in one cannot crash the runtime."
 *
 * Strategy:
 *   - We do not mutate `CognitiveRuntime` or its stages.
 *   - The runtime returns a `CycleRecord` whose `stages[]` array already
 *     contains one trace per stage; we layer advanced-module invocations
 *     into a per-stage hook interface that callers can run alongside
 *     `runtime.runCycle()`.
 *   - The hook is purely additive: a missing registry, a disabled flag, or
 *     an empty hook list all result in a zero-op response that does not
 *     change the cycle's outputs.
 *
 * Callers that want a "rich" cycle call:
 *
 *   const runtime = new CognitiveRuntime(opts);
 *   const hook = new AdvancedModuleCognitiveHook({ registry, flags });
 *   const cycle = await runtime.runCycle(stimulus);
 *   const enriched = await hook.afterCycle(cycle, stimulus);
 *   // `enriched.advanced.notes` holds per-stage module contributions
 */

import type { CycleRecord, RawStimulus, StageNumber } from '@server/cognition/types.js';
import {
  AdvancedModuleRegistry,
  DEFAULT_ADVANCED_FLAGS,
  type AdvancedModuleFlagMap,
  type AdvancedModuleResult,
} from './index.js';

export interface AdvancedModuleCognitiveHookOptions {
  registry?: AdvancedModuleRegistry | undefined;
  flags?: AdvancedModuleFlagMap | undefined;
}

export interface AdvancedCycleNote {
  stage: StageNumber;
  results: AdvancedModuleResult[];
  errors: Array<{ moduleId: string; message: string }>;
}

export interface AdvancedCognitiveExtension {
  /** Per-stage advanced module contributions. Empty array per stage if no module hooked it. */
  notes: AdvancedCycleNote[];
  /** Total successful module invocations. */
  successCount: number;
  /** Total isolated failures (modules that threw but were caught). */
  errorCount: number;
}

const EMPTY_EXTENSION: AdvancedCognitiveExtension = {
  notes: [],
  successCount: 0,
  errorCount: 0,
};

export class AdvancedModuleCognitiveHook {
  private readonly registry: AdvancedModuleRegistry | undefined;
  private readonly flags: AdvancedModuleFlagMap;

  constructor(opts: AdvancedModuleCognitiveHookOptions = {}) {
    this.registry = opts.registry;
    this.flags = opts.flags ?? DEFAULT_ADVANCED_FLAGS;
  }

  /**
   * Run all enabled advanced modules across the 12 stages for one cycle.
   * Returns an extension object describing per-stage contributions; the
   * `CycleRecord` itself is not modified.
   */
  async afterCycle(
    cycle: CycleRecord,
    stimulus: RawStimulus,
  ): Promise<AdvancedCognitiveExtension> {
    if (!this.registry) return EMPTY_EXTENSION;
    if (Object.values(this.flags).every((v) => v === false)) return EMPTY_EXTENSION;

    const notes: AdvancedCycleNote[] = [];
    let successCount = 0;
    let errorCount = 0;

    const stageInputs: Map<StageNumber, unknown> = new Map();
    for (const trace of cycle.stages) {
      // We don't replay inputs; the cycle carries the JSON of the previous
      // stage's input. Modules receive that as the `input` for the next stage.
      try {
        stageInputs.set(trace.stage, trace.inputJson !== undefined ? JSON.parse(trace.inputJson) : null);
      } catch {
        stageInputs.set(trace.stage, trace.inputJson);
      }
    }

    for (const trace of cycle.stages) {
      const input = stageInputs.get(trace.stage);
      const { results, errors } = await this.registry.run(
        input,
        trace.stage,
        {
          identityId: cycle.identityId,
          conversationId: cycle.conversationId,
          cycleId: cycle.id,
          stageNumber: trace.stage,
        },
        this.flags,
      );
      successCount += results.length;
      errorCount += errors.length;
      if (results.length > 0 || errors.length > 0) {
        notes.push({
          stage: trace.stage,
          results,
          errors,
        });
      }
    }

    return { notes, successCount, errorCount };
  }
}

/**
 * Convenience constructor that wires a fresh registry + default flags off.
 */
export function createDefaultAdvancedCognitiveHook(): AdvancedModuleCognitiveHook {
  // Lazy import to keep cycles between modules unidirectional.
  // The hook itself owns no module logic — it just orchestrates whatever
  // registry the caller injects.
  return new AdvancedModuleCognitiveHook({
    registry: undefined,
    flags: { ...DEFAULT_ADVANCED_FLAGS },
  });
}

export function createAdvancedCognitiveHook(opts: {
  registry: AdvancedModuleRegistry;
  flags: AdvancedModuleFlagMap;
}): AdvancedModuleCognitiveHook {
  return new AdvancedModuleCognitiveHook(opts);
}
