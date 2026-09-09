/**
 * Dream consolidation — hooks stage 10 (LEARN) and stage 12 (PERSIST).
 *
 * ## What was actually wrong, and why this module is the fix for it
 *
 * `LifecycleStatus` has read `'active' | 'consolidated' | 'archived' |
 * 'soft_deleted'` since P05. Nothing in the codebase has ever written
 * `'consolidated'`, and — the part that matters — nothing has ever *read* it
 * either: `listEpisodic` filtered on `soft_deleted` alone, so a row marked
 * consolidated would have gone on being retrieved exactly as before. Marking rows
 * would have been decoration.
 *
 * So this module comes with the other half. `listEpisodic` now excludes
 * `'consolidated'` from its default view, which gives the status its first real
 * meaning: *folded into something else, no longer retrieved on its own.* The status
 * and the behaviour arrived together, because a status the code does not honour is
 * the same class of lie as a cycle that reports `completed` after a stage threw.
 *
 * ## Exact duplicates only, and that is a deliberate ceiling
 *
 * The obvious version of this module clusters near-duplicates by similarity and
 * writes a merged summary. This one folds only recollections whose normalised text
 * is *identical*, and keeps the earliest.
 *
 * That restraint is the design, not a shortcut. A fuzzy match that fires wrongly
 * removes a real memory from retrieval — she would forget something she was told,
 * and nothing in the transcript would explain why. An exact match cannot lose
 * information: the surviving row carries the same words, so it *is* the summary and
 * needs no merge step and no link column to justify itself. Duplicate episodic rows
 * are real — the same fact arriving through two cycles writes it twice — so this
 * fixes something that genuinely happens, at the one confidence level where it
 * cannot cost her a memory.
 *
 * ## Why stage 10 detects and stage 12 applies
 *
 * Stage 10 is where the cycle proposes what it learned but has not yet written it.
 * Folding duplicates there would race the delta about to be persisted — the pass
 * could fold a row and then stage 12 could write it straight back. So stage 10 only
 * counts, and reports.
 *
 * Stage 12 is the commit, and the runtime runs this module's 12 hook *after* that
 * transaction has closed and after the trace flush (`server/cognition/runtime.ts`,
 * the `runModules(12, …)` call). That is the only moment when the cycle's own writes
 * are visible and nothing is still in flight, which is exactly when a consolidation
 * pass is safe.
 *
 * ## Why the fold publishes an event
 *
 * Folding is the one thing in this file that changes what she can retrieve, and it
 * happens after `cycle.completed` has already been published — so the memory counts
 * in `RuntimeState` were recomputed a moment *before* the rows disappeared from the
 * default view. During quiet hours the next cycle may be hours away, which is how
 * long the counts would have stayed wrong. `memory.consolidated` was already declared
 * and already routed to a memory recount in `server/http/state.ts`; it simply had no
 * publisher. Now the operation that earns it emits it.
 *
 * ## Quiet hours are load-bearing, so nothing happens at 2pm
 *
 * The window is the whole conceit: she tidies her memory when nobody is talking to
 * her. Outside it the module reports `applied: false` with the reason, every cycle,
 * all day. That is the module working — not the module missing.
 */

import type { StageNumber } from '@server/cognition/types.js';
import type { EpisodicMemory } from '@server/memory/types.js';

import type {
  AdvancedModule,
  AdvancedModuleContext,
  AdvancedModuleDeps,
  AdvancedModuleReport,
} from './types.js';

export interface DreamOptions {
  /** Rows one pass may fold, so a long-neglected database cannot stall a cycle. */
  maxFoldsPerPass?: number;
  /** Minimum gap between passes, per identity. */
  minIntervalMs?: number;
}

const DEFAULTS = {
  maxFoldsPerPass: 50,
  minIntervalMs: 30 * 60_000,
} as const;

/** 22:00–07:00 unless configured otherwise, matching the proactive default. */
const DEFAULT_QUIET_HOURS = { startHour: 22, endHour: 7 } as const;

export function createDreamConsolidationModule(
  deps: AdvancedModuleDeps = {},
  options: DreamOptions = {},
): AdvancedModule {
  const maxFolds = options.maxFoldsPerPass ?? DEFAULTS.maxFoldsPerPass;
  const minIntervalMs = options.minIntervalMs ?? DEFAULTS.minIntervalMs;
  const now = deps.now ?? Date.now;
  const quietHours = deps.quietHours ?? DEFAULT_QUIET_HOURS;

  const lastPass = new Map<string, number>();

  return {
    id: 'dream-consolidation',
    flag: 'enableDreamConsolidation',
    hooks: [10, 12],
    async run(
      _input: unknown,
      stage: StageNumber,
      ctx: AdvancedModuleContext,
    ): Promise<AdvancedModuleReport> {
      const memory = deps.memory;
      if (memory === undefined) {
        return { applied: false, reason: 'no memory repository wired', folded: 0 };
      }

      const at = now();
      const asleep = isWithinQuietHours(hourOf(at), quietHours);

      const groups = duplicateGroups(memory.listEpisodic(ctx.identityId));
      const foldable = groups.reduce((sum, group) => sum + group.length - 1, 0);

      // Stage 10: look, do not touch. See the header — stage 10's own delta has
      // not been written yet, and folding now could fold a row stage 12 is about
      // to write back.
      if (stage === 10) {
        return {
          applied: false,
          reason: asleep ? 'detection pass only at stage 10' : 'outside the quiet window',
          asleep,
          duplicateGroups: groups.length,
          foldable,
        };
      }

      if (!asleep) {
        return { applied: false, reason: 'outside the quiet window', asleep, folded: 0, foldable };
      }

      const previous = lastPass.get(ctx.identityId);
      if (previous !== undefined && at - previous < minIntervalMs) {
        return {
          applied: false,
          reason: 'within consolidation interval',
          nextPassAt: previous + minIntervalMs,
          folded: 0,
          foldable,
        };
      }
      lastPass.set(ctx.identityId, at);

      let folded = 0;
      const foldedIds: string[] = [];
      for (const group of groups) {
        // `group[0]` is the survivor: `duplicateGroups` sorts oldest first, and the
        // earliest recollection is the one whose provenance points at the cycle
        // that actually learned the thing.
        //
        // Two recollections written inside the same millisecond share an
        // `occurredAt`, which is the common case rather than the exotic one — one
        // cycle extracting the same fact twice does exactly that. The sort then
        // falls through to the id, and that is only a recency signal because
        // `server/persistence/ids.ts` mints monotonic ids; the package's plain
        // `ulid()` re-rolls its random field and sorted those pairs arbitrarily, so
        // this loop used to keep a coin-flip survivor and the sentence above was
        // true about half the time.
        for (const duplicate of group.slice(1)) {
          if (folded >= maxFolds) break;
          if (!memory.markEpisodicConsolidated(duplicate.id)) continue;
          foldedIds.push(duplicate.id);
          folded += 1;
        }
        if (folded >= maxFolds) break;
      }

      // Only when something actually moved. An event published on a pass that
      // folded nothing would be a mutation notice for a database that did not
      // change — which is what every consumer of this event would then act on.
      if (folded > 0 && deps.eventBus !== undefined) {
        await deps.eventBus.publish({
          type: 'memory.consolidated',
          payload: { folded, foldedIds: foldedIds.slice(0, 20), duplicateGroups: groups.length },
          identityId: ctx.identityId,
          cycleId: ctx.cycleId,
          timestamp: at,
        });
      }

      return {
        applied: folded > 0,
        ...(folded > 0 ? {} : { reason: 'nothing was duplicated' }),
        asleep,
        duplicateGroups: groups.length,
        foldable,
        folded,
        foldedIds: foldedIds.slice(0, 20),
      };
    },
  };
}

/**
 * Groups of identical recollections, each group oldest first, singletons dropped.
 *
 * Identity is the normalised summary *and* details together. Summary alone would
 * fold two recollections that opened the same way and then said different things —
 * the exact information loss this module refuses to risk.
 */
function duplicateGroups(memories: EpisodicMemory[]): EpisodicMemory[][] {
  const byKey = new Map<string, EpisodicMemory[]>();

  for (const memory of memories) {
    const key = normalise(`${memory.summary} ${memory.details ?? ''}`);
    // An empty recollection has no text to be a duplicate *of*, so it is skipped
    // rather than grouped — otherwise every blank-summary row would fold into one.
    if (key.length === 0) continue;
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [memory]);
    else group.push(memory);
  }

  return [...byKey.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id)));
}

/**
 * Whitespace and case only.
 *
 * Punctuation is left alone on purpose: "call the bank" and "call the bank?" are
 * not reliably the same recollection, and this module's whole safety argument rests
 * on the match being exact rather than clever.
 */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Local hour. Same wrap-around rule as `ProactiveDecisionTree`, including
 * `start === end` meaning "no quiet hours at all" — which is how the test
 * environment turns the window off.
 */
function isWithinQuietHours(hour: number, config: { startHour: number; endHour: number }): boolean {
  const { startHour, endHour } = config;
  if (startHour === endHour) return false;
  if (startHour > endHour) return hour >= startHour || hour < endHour;
  return hour >= startHour && hour < endHour;
}

function hourOf(at: number): number {
  return new Date(at).getHours();
}
