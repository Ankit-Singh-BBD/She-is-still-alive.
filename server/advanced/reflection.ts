/**
 * Long-horizon reflection — hooks stage 11 (UPDATE).
 *
 * Stage 10 (LEARN) extracts what one exchange taught her. Nothing extracts what a
 * hundred exchanges taught her, and that gap is the difference between a system
 * with a memory and a system that notices. This module closes it: periodically, it
 * reads her recent episodic memories, finds what keeps coming back, and writes that
 * as a semantic fact — a durable row, not a note in a log.
 *
 * ## Why stage 11 and why rate-limited
 *
 * Stage 11 is where the cycle's learning is applied, so it is where a *slower* kind
 * of learning belongs. But it runs on every single cycle, and a reflection pass on
 * every turn would be both wasteful and wrong: a theme that recurs is a claim about
 * a span of time, and recomputing it every thirty seconds would produce the same
 * row over and over. So the module holds a per-identity watermark and does real
 * work at most once per interval. Between passes it returns `applied: false` with
 * the reason — a true report, and the thing that makes the rate limit visible
 * rather than a silent skip.
 *
 * ## The sensitivity rule is the part that must not be got wrong
 *
 * A summary derived from `owner_only` recollections is itself owner-only. Writing
 * the derived row at the default `person_shared` would launder private material
 * into a class that stage 9 is willing to disclose to a guest — a leak with no
 * bug anywhere near the disclosure gate, because the gate would be doing exactly
 * what it was told. So the written row takes the *most restrictive* sensitivity
 * among its sources, and the ordering is explicit below rather than implied by the
 * order of a union type.
 *
 * ## Themes, not topics
 *
 * The extraction is deliberately dull: term frequency across *distinct* memories,
 * stopwords removed, a floor on how many memories a term must appear in. Counting
 * occurrences instead of memories would let one long recollection that repeats a
 * word five times invent a theme by itself. There is no model call here for the
 * same reason as in `./affect.ts` — this runs inside a cycle, and her ability to
 * notice a pattern should not depend on a network.
 */

import type { StageNumber } from '@server/cognition/types.js';
import type { EpisodicMemory, Sensitivity } from '@server/memory/types.js';

import type {
  AdvancedModule,
  AdvancedModuleContext,
  AdvancedModuleDeps,
  AdvancedModuleReport,
} from './types.js';

export interface ReflectionOptions {
  /** Minimum gap between real passes, per identity. */
  minIntervalMs?: number;
  /** How many recent recollections a pass looks at. */
  windowSize?: number;
  /** Distinct memories a term must appear in before it is a theme. */
  minOccurrences?: number;
  /** How many themes one pass may record. */
  maxThemes?: number;
}

const DEFAULTS = {
  minIntervalMs: 6 * 60 * 60_000,
  windowSize: 40,
  minOccurrences: 3,
  maxThemes: 2,
} as const;

/** The predicate every reflection row shares, so they can be found as a set. */
export const REFLECTION_PREDICATE = 'recurs_in_conversation';

/**
 * Most restrictive first. Written out rather than derived from the `Sensitivity`
 * union's declaration order, because that order is not a contract and reordering
 * it while tidying a file must not quietly downgrade a memory.
 */
const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  system_internal: 3,
  owner_only: 2,
  person_shared: 1,
  public: 0,
};

export function createLongHorizonReflectionModule(
  deps: AdvancedModuleDeps = {},
  options: ReflectionOptions = {},
): AdvancedModule {
  const minIntervalMs = options.minIntervalMs ?? DEFAULTS.minIntervalMs;
  const windowSize = options.windowSize ?? DEFAULTS.windowSize;
  const minOccurrences = options.minOccurrences ?? DEFAULTS.minOccurrences;
  const maxThemes = options.maxThemes ?? DEFAULTS.maxThemes;
  const now = deps.now ?? Date.now;

  /** Per-identity watermark. In-memory: a missed pass after a restart is fine. */
  const lastPass = new Map<string, number>();

  return {
    id: 'long-horizon-reflection',
    flag: 'enableLongHorizonReflection',
    hooks: [11],
    async run(
      _input: unknown,
      _stage: StageNumber,
      ctx: AdvancedModuleContext,
    ): Promise<AdvancedModuleReport> {
      const memory = deps.memory;
      if (memory === undefined) {
        return { applied: false, reason: 'no memory repository wired', themes: [] };
      }

      const at = now();
      const previous = lastPass.get(ctx.identityId);
      if (previous !== undefined && at - previous < minIntervalMs) {
        return {
          applied: false,
          reason: 'within reflection interval',
          nextPassAt: previous + minIntervalMs,
          themes: [],
        };
      }
      // Claimed before the work, not after: a pass that throws halfway must not
      // leave the watermark open for the very next cycle to retry, or a broken
      // read becomes a reflection attempt on every turn.
      lastPass.set(ctx.identityId, at);

      // Sorted here rather than trusting `listEpisodic`'s ORDER BY: this module needs
      // the newest first, and that must not silently become "whatever order the
      // repository happens to return" if that query is ever changed.
      const recent = memory
        .listEpisodic(ctx.identityId)
        .sort((a, b) => b.occurredAt - a.occurredAt)
        .slice(0, windowSize);

      if (recent.length < minOccurrences) {
        return {
          applied: false,
          reason: `only ${recent.length} recollections to reflect on`,
          themes: [],
        };
      }

      const themes = findThemes(recent, minOccurrences).slice(0, maxThemes);
      if (themes.length === 0) {
        return { applied: false, reason: 'nothing recurred', considered: recent.length, themes: [] };
      }

      const known = new Set(
        memory
          .listSemantic(ctx.identityId)
          .filter((row) => row.predicate === REFLECTION_PREDICATE)
          .map((row) => row.subject.toLowerCase()),
      );

      const written: string[] = [];
      for (const theme of themes) {
        if (known.has(theme.term)) continue;
        memory.createSemantic({
          identityId: ctx.identityId,
          subject: theme.term,
          predicate: REFLECTION_PREDICATE,
          object: `across ${theme.memories} of the last ${recent.length} recollections`,
          sourceCycle: ctx.cycleId,
          sensitivity: theme.sensitivity,
          confidence: theme.confidence,
          sourceKind: 'observation',
          provenance: {
            sourceCycleId: ctx.cycleId,
            sourceConversationId: ctx.conversationId,
            sourceMessageIds: [],
            extractedAt: at,
            extractor: 'rule',
            confidence: theme.confidence,
            validatedBy: 'app_rule',
          },
        });
        written.push(theme.term);
      }

      return {
        applied: written.length > 0,
        ...(written.length > 0 ? {} : { reason: 'every theme was already recorded' }),
        considered: recent.length,
        themes: themes.map((t) => ({
          term: t.term,
          memories: t.memories,
          sensitivity: t.sensitivity,
        })),
        written,
      };
    },
  };
}

interface Theme {
  term: string;
  /** Distinct memories the term appeared in — not total occurrences. */
  memories: number;
  sensitivity: Sensitivity;
  confidence: number;
}

/**
 * Terms appearing in at least `minOccurrences` distinct recollections.
 *
 * Each term carries the strictest sensitivity of the memories it came from, so the
 * caller cannot write it at a looser class by accident.
 */
function findThemes(memories: EpisodicMemory[], minOccurrences: number): Theme[] {
  const counts = new Map<string, { memories: number; sensitivity: Sensitivity }>();

  for (const memory of memories) {
    const text = `${memory.summary} ${memory.details ?? ''}`;
    // A Set per memory is what makes this "distinct memories" rather than "total
    // mentions" — the single most important line in the function.
    for (const term of new Set(contentTerms(text))) {
      const entry = counts.get(term) ?? { memories: 0, sensitivity: 'public' as Sensitivity };
      entry.memories += 1;
      entry.sensitivity = stricter(entry.sensitivity, memory.sensitivity);
      counts.set(term, entry);
    }
  }

  const themes: Theme[] = [];
  for (const [term, entry] of counts) {
    if (entry.memories < minOccurrences) continue;
    themes.push({
      term,
      memories: entry.memories,
      sensitivity: entry.sensitivity,
      // Recurrence is evidence, and more of it is more evidence — capped, because
      // a term in every recollection is often just a habit of phrasing.
      confidence: Math.min(0.9, 0.4 + entry.memories * 0.1),
    });
  }

  return themes.sort((a, b) => b.memories - a.memories || a.term.localeCompare(b.term));
}

function stricter(a: Sensitivity, b: Sensitivity): Sensitivity {
  return SENSITIVITY_RANK[b] > SENSITIVITY_RANK[a] ? b : a;
}

/**
 * Words worth counting.
 *
 * Short tokens and stopwords go, in English and Hinglish both — without the
 * Hinglish half, "hai", "kya" and "nahi" would be the three great themes of her
 * inner life. Numbers go too: a date that appears in three recollections is not a
 * subject she keeps returning to.
 */
function contentTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((term) => term.length >= 4 && !STOPWORDS.has(term) && !/^\d+$/.test(term));
}

const STOPWORDS = new Set([
  // English
  'about', 'after', 'again', 'also', 'been', 'before', 'being', 'both', 'came',
  'come', 'could', 'does', 'doing', 'done', 'down', 'each', 'even', 'ever',
  'from', 'gave', 'give', 'going', 'gone', 'have', 'here', 'into', 'just',
  'know', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must',
  'need', 'only', 'other', 'over', 'said', 'same', 'says', 'shall', 'should',
  'some', 'such', 'take', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'things', 'this', 'those', 'time', 'told', 'took',
  'very', 'want', 'went', 'were', 'what', 'when', 'where', 'which', 'while',
  'will', 'with', 'would', 'your',
  // Hinglish
  'aaya', 'abhi', 'agar', 'apna', 'apne', 'baat', 'bahut', 'bola', 'bohot',
  'chij', 'chiz', 'diya', 'gaya', 'haan', 'hain', 'jaise', 'kaha', 'karke',
  'karna', 'karta', 'karte', 'kiya', 'koii', 'kuch', 'lekin', 'liye', 'mera',
  'mere', 'nahi', 'nahin', 'raha', 'rahi', 'sath', 'tera', 'tere', 'thaa',
  'tumhara', 'uska', 'uske', 'wala', 'wale', 'yaha', 'yahan', 'yeh',
]);
