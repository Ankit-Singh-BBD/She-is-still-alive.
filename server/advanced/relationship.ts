/**
 * Relationship context — hooks stage 4 (UNDERSTAND).
 *
 * Two questions, both answered from what stage 3 already loaded and neither of
 * them by touching the database again.
 *
 * ## 1. Which relationships are salient right now
 *
 * `RecalledContext.relationships` arrives ranked by the retrieval layer's generic
 * weights (recency, importance, similarity) and already filtered by scope. What it
 * is not is ranked *for this sentence*. Someone named in the message he just typed
 * is the most salient person in the room regardless of when the row was last
 * touched, and generic recency ranking will bury them under whoever came up
 * yesterday.
 *
 * So this re-ranks with one extra term the retrieval layer cannot have: whether the
 * name occurs in the current utterance.
 *
 * ## 2. How well she actually knows the person she is talking to
 *
 * Not a stored trait — a count. Every item stage 3 loaded that is scoped to the
 * caller is evidence she knows something about them; the transcript length is
 * evidence this conversation is already underway. A guest three messages in is a
 * stranger no matter what a config file says, and the person she lives with is
 * familiar without anyone having declared it.
 *
 * That number becomes formality and warmth deltas, which is the module's actual
 * effect. It is the honest version of the thing a persona file fakes: she is less
 * formal with him because she demonstrably knows him, and the evidence is
 * countable.
 *
 * ## Why no re-fetch, stated plainly
 *
 * Stage 3 is the only stage allowed to load memory, and everything it loaded has
 * already been scoped and clearance-filtered for this caller. A module that ran its
 * own query would be reading around that filter — and it would be doing so at stage
 * 4, where the result feeds a prompt. Reading only what RECALL produced is not a
 * performance choice; it is how identity isolation survives contact with this file.
 */

import type { ScopedMemoryItem } from '@server/memory/types.js';
import type { StageNumber } from '@server/cognition/types.js';

import type {
  AdvancedModule,
  AdvancedModuleContext,
  AdvancedModuleDeps,
  AdvancedModuleReport,
} from './types.js';

/** How many salient relationships to report. Beyond a handful nobody is salient. */
const TOP_N = 3;

/** Items scoped to the caller that count as "she knows this person well". */
const FAMILIAR_AT_ITEMS = 12;

/** Above this she drops the formal register; below the floor she keeps it. */
const FAMILIAR_THRESHOLD = 0.6;
const STRANGER_THRESHOLD = 0.15;

export function createRelationshipContextModule(
  deps: AdvancedModuleDeps = {},
): AdvancedModule {
  return {
    id: 'relationship-context',
    flag: 'enableRelationshipContext',
    hooks: [4],
    async run(
      input: unknown,
      _stage: StageNumber,
      ctx: AdvancedModuleContext,
    ): Promise<AdvancedModuleReport> {
      const recalled = asRecalled(input);
      if (recalled === undefined) {
        // Not a failure. Stage 4's input is typed `unknown` and the registry
        // replays arbitrary JSON through `afterCycle`; a shape this module cannot
        // read is a case to name, not to throw over.
        return { applied: false, reason: 'input was not a recalled context', salient: [] };
      }

      const utterance = utteranceOf(recalled).toLowerCase();
      const salient = rank(recalled.relationships, utterance).slice(0, TOP_N);
      const familiarity = familiarityWith(ctx.identityId, recalled);
      const delta = toneFor(familiarity);

      const applied = deps.personality !== undefined;
      if (applied) deps.personality?.noteFamiliarity(ctx.identityId, delta);

      return {
        applied,
        ...(applied ? {} : { reason: 'no personality service wired' }),
        familiarity: round(familiarity),
        delta,
        salient: salient.map((entry) => ({
          name: entry.name,
          relation: entry.relation,
          mentionedNow: entry.mentionedNow,
          score: round(entry.score),
        })),
      };
    },
  };
}

interface RankedRelationship {
  name: string;
  relation: string | undefined;
  mentionedNow: boolean;
  score: number;
}

/**
 * Salience = what retrieval thought, plus whether they were just named.
 *
 * The mention term dominates by design: being referred to in the current sentence
 * is a stronger signal than any amount of importance or recency, because it is the
 * only one that is about *now*.
 */
function rank(relationships: ScopedMemoryItem[], utterance: string): RankedRelationship[] {
  const ranked: RankedRelationship[] = [];

  for (const item of relationships) {
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name.length === 0) continue;

    const mentionedNow = utterance.length > 0 && mentions(utterance, name);
    const importance = clamp01((item.importance ?? 0.5) / 2 + 0.25);
    const confidence = clamp01(item.confidence);
    const score = (mentionedNow ? 1 : 0) + importance * 0.5 + confidence * 0.3;

    ranked.push({
      name,
      relation: typeof item.relation === 'string' ? item.relation : undefined,
      mentionedNow,
      score,
    });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Whole-word match, not `includes`.
 *
 * `includes` would find "Ana" inside "banana" and inside "Anand", and a false
 * mention promotes the wrong person to the top of the list — a mistake that is
 * visible to him in her wording, which is the worst place for it.
 */
function mentions(utterance: string, name: string): boolean {
  const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, 'u').test(utterance);
}

/**
 * Evidence that she knows this caller, from what RECALL already produced.
 *
 * Items scoped to someone else are excluded even though they were loaded: they are
 * things she knows about *other people*, and counting them here would make her
 * familiar with a stranger who happened to arrive on a busy day.
 */
function familiarityWith(identityId: string, recalled: RecalledLike): number {
  const owned = allItems(recalled).filter((item) => item.identityId === identityId);
  const fromMemory = Math.min(1, owned.length / FAMILIAR_AT_ITEMS);
  // A conversation already in progress is its own evidence, but a weak one — it
  // says they are mid-exchange, not that she knows them.
  const fromTranscript = Math.min(0.3, (recalled.recentTurns?.length ?? 0) / 20);
  return clamp01(fromMemory * 0.8 + fromTranscript);
}

/**
 * Familiarity to register.
 *
 * Deliberately three-valued with a dead band in the middle. A continuous mapping
 * would move her register on every cycle as the count drifted by one item, and
 * tone that changes for no reason he can perceive is exactly what reads as
 * unstable rather than alive.
 */
function toneFor(familiarity: number): { formalityDelta?: number; warmthDelta?: number } {
  if (familiarity >= FAMILIAR_THRESHOLD) return { formalityDelta: -1, warmthDelta: 1 };
  if (familiarity <= STRANGER_THRESHOLD) return { formalityDelta: 1 };
  return {};
}

interface RecalledLike {
  stimulus?: { payload?: unknown } | undefined;
  episodic: ScopedMemoryItem[];
  semantic: ScopedMemoryItem[];
  preferences: ScopedMemoryItem[];
  habits: ScopedMemoryItem[];
  relationships: ScopedMemoryItem[];
  learnedPatterns: ScopedMemoryItem[];
  recentTurns?: readonly unknown[] | undefined;
}

const DOMAIN_KEYS = [
  'episodic',
  'semantic',
  'preferences',
  'habits',
  'relationships',
  'learnedPatterns',
] as const;

/**
 * A `RecalledContext`, or `undefined` if the input is not one.
 *
 * Checks every domain array rather than a marker field, because the arrays are
 * what this module reads — a partial object that happened to carry `stimulus`
 * would pass a marker check and then index into `undefined`.
 */
function asRecalled(input: unknown): RecalledLike | undefined {
  if (input === null || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  for (const key of DOMAIN_KEYS) {
    if (!Array.isArray(record[key])) return undefined;
  }
  return input as RecalledLike;
}

function allItems(recalled: RecalledLike): ScopedMemoryItem[] {
  return DOMAIN_KEYS.flatMap((key) => recalled[key]);
}

function utteranceOf(recalled: RecalledLike): string {
  const payload = recalled.stimulus?.payload;
  if (typeof payload === 'string') return payload;
  if (payload !== null && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
