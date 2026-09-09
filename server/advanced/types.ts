/**
 * The advanced-module contract, split out from `./index.ts`.
 *
 * The four modules were one-line placeholders when they lived in `index.ts`, so
 * one file held everything. Real implementations are not one-liners — reading
 * affect, ranking relationships, and folding duplicate memories have nothing in
 * common with each other — so each now has its own file, and this one holds the
 * contract they share. `./index.ts` re-exports every name that was public before,
 * so nothing that imported from there has to change.
 *
 * ## What a module may and may not do
 *
 * A module is a **faculty, not an authority** — the same rule the Build Book sets
 * for the LLM (Part X: propose, then the application validates and authorizes),
 * applied to code that ships in this repository. Concretely:
 *
 *  - It receives the stage's input and returns a plain object. Its return value is
 *    recorded and may inform a later stage; it can never *replace* a stage's
 *    output or veto a decision.
 *  - It may write to state it owns — a persona override, a memory row — because
 *    that state has its own validation on the way in.
 *  - It may not throw usefully. `AdvancedModuleRegistry.run` catches, so a throw
 *    is survivable, but a module that relies on being caught reports nothing on
 *    the day it matters. Every module here degrades to a described no-result
 *    instead, and says which case it hit.
 *  - It may be missing its dependencies entirely. All four factories are callable
 *    with no arguments, because `createDefaultAdvancedModules()` is part of the
 *    public surface and a module with no collaborators must still be constructible
 *    and still run. With nothing wired a module computes what it can and reports
 *    `applied: false`, which is a true statement rather than a silent success.
 */

import type { StageNumber } from '@server/cognition/types.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type { PersonalityService } from '@server/personality/service.js';
import type { QuietHoursConfig } from '@server/proactive/types.js';

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

/**
 * All off.
 *
 * Kept as the default because Part XXVI.3 calls these opt-in and
 * `tests/boot/config.test.ts` holds the boot config to it. Turning them on is a
 * deployment decision made in `.env`, not a code change — see
 * `server/config/env.ts`.
 */
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
  /** Per-stage contribution. Throwing is never propagated, and never relied on. */
  run(
    input: unknown,
    stage: StageNumber,
    context: AdvancedModuleContext,
  ): Promise<Record<string, unknown>>;
}

/**
 * What the modules need from the rest of the application, all optional.
 *
 * Optional because the no-argument factories must keep working, and because the
 * honest behaviour of a module whose collaborator is absent is to say so. Named
 * collaborators rather than narrow structural interfaces: a shadow interface for
 * `MemoryRepository` would be a second copy of its signature, free to drift from
 * the real one without anything noticing.
 */
export interface AdvancedModuleDeps {
  /** Where a tone signal goes. Absent: modules compute the reading and stop. */
  personality?: PersonalityService | undefined;
  /** Where a summary is written and a duplicate is folded. */
  memory?: MemoryRepository | undefined;
  /**
   * Where a module announces a change the rest of the application must see.
   *
   * Only dream consolidation needs it, and only because it runs after the cycle's
   * own terminal event: nothing else would ever recount her memory. A module still
   * *reports* through its return value — the bus is for the effect, never for the
   * report.
   */
  eventBus?: EventBus | undefined;
  /** The window dream-consolidation is allowed to run in. */
  quietHours?: QuietHoursConfig | undefined;
  /** Injectable clock, so a test can move time without waiting. */
  now?: (() => number) | undefined;
}

/**
 * A module's own report on what it did.
 *
 * Every module returns at least these two fields. `applied` is the one that
 * matters: it separates "ran and changed something" from "ran and could not",
 * which a bare `{}` return conflates — and conflating them is how four
 * placeholders passed for four working modules.
 */
export interface AdvancedModuleReport extends Record<string, unknown> {
  applied: boolean;
  reason?: string;
}

/** What the modules contributed at one stage, and what failed there. */
export interface AdvancedCycleNote {
  stage: StageNumber;
  results: AdvancedModuleResult[];
  errors: Array<{ moduleId: string; message: string }>;
}

/**
 * Everything the modules did during one cycle.
 *
 * This is deliberately *not* part of `CycleRecord`. A cycle record is what she
 * thought; this is what her opt-in faculties observed while she thought it, and
 * with every flag off it is `EMPTY_ADVANCED_EXTENSION` — which is the honest
 * report for a cycle in which no module ran, rather than an absence the caller
 * has to interpret.
 */
export interface AdvancedCognitiveExtension {
  /** Only the stages where something happened. A stage no module hooked is absent. */
  notes: AdvancedCycleNote[];
  /** Module invocations that returned. */
  successCount: number;
  /** Module invocations that threw and were caught. A cycle survives all of them. */
  errorCount: number;
}

export const EMPTY_ADVANCED_EXTENSION: AdvancedCognitiveExtension = Object.freeze({
  notes: [],
  successCount: 0,
  errorCount: 0,
});
