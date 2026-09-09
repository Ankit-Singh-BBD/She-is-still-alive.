/**
 * P05 Memory Domains - Knowledge Retrieval Policy
 *
 * Implements deterministic policy-gated retrieval (Build Book Part X.3).
 * Enforces Identity Isolation, Sensitivity Gating, Soft-Delete Exclusion,
 * and composite ranking.
 */

import type { Database } from '@server/persistence/db.js';
import { toRomanHinglish } from '@server/lang/index.js';
import { MemoryRepository } from './repository.js';
import type {
  Habit,
  MemoryDomain,
  MemoryItem,
  RetrievalRequest,
  RetrievalResult,
  ScopedMemoryItem,
} from './types.js';

export class MemoryRetrieval {
  private repo: MemoryRepository;

  constructor(repo?: MemoryRepository | Database) {
    if (repo instanceof MemoryRepository) {
      this.repo = repo;
    } else {
      this.repo = new MemoryRepository(repo);
    }
  }

  /**
   * Main retrieval method - enforces policy, gathers matching records,
   * scores them, and projects them to ScopedMemoryItem.
   */
  public async retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    const start = performance.now();

    // 1. Fetch raw items from all requested domains
    const allRawItems = this.fetchRawItems(req.domains, req.excludeSoftDeleted);

    // 2. Apply Knowledge Retrieval Policy filters (Identity Isolation & Sensitivity)
    const allowedItems = allRawItems.filter((item) => this.isAllowedByPolicy(req, item));

    // 3. Score & Rank items based on query similarity, recency, and importance
    const scoredItems = allowedItems.map((item) => this.scoreItem(req, item));

    // Sort descending by score
    scoredItems.sort((a, b) => b.score - a.score);

    // 4. Limit and project to ScopedMemoryItem
    const topItems = scoredItems.slice(0, req.limit);
    const resultItems = topItems.map((si) => this.projectItem(si.item, si.score));

    const took = performance.now() - start;

    return {
      items: resultItems,
      total: allowedItems.length,
      took,
      fromCache: false,
    };
  }

  /**
   * Fetch raw items across the requested domains.
   * Note: In a production DB, this would be pushing WHERE clauses to SQLite.
   * Since SQLite doesn't natively combine domains easily and the memory set is
   * bounded, we fetch per domain and filter in-memory for testing the policy rules.
   */
  private fetchRawItems(domains: MemoryDomain[], excludeSoftDeleted: boolean): MemoryItem[] {
    const items: MemoryItem[] = [];

    if (domains.includes('episodic')) {
      items.push(...this.repo.listEpisodic(undefined, !excludeSoftDeleted));
    }
    if (domains.includes('semantic')) {
      items.push(...this.repo.listSemantic(undefined, !excludeSoftDeleted));
    }
    if (domains.includes('preference')) {
      items.push(...this.repo.listPreferences(undefined, !excludeSoftDeleted));
    }
    if (domains.includes('habit')) {
      items.push(...this.repo.listHabits(undefined, !excludeSoftDeleted));
    }
    if (domains.includes('relationship')) {
      items.push(...this.repo.listRelationships(undefined, !excludeSoftDeleted));
    }
    if (domains.includes('learned_pattern')) {
      items.push(...this.repo.listLearnedPatterns(undefined, !excludeSoftDeleted));
    }

    return items;
  }

  /**
   * Knowledge Retrieval Policy (Layer 2) enforcement.
   * Deterministically returns true if caller is authorized to view this item.
   */
  private isAllowedByPolicy(req: RetrievalRequest, item: MemoryItem): boolean {
    const isOwnerUser = req.callerKind === 'owner';
    const isItemAboutCaller = item.identityId === req.callerId;

    // 1. Identity Isolation
    // Only the owner can read data outside their own identity.
    if (!isOwnerUser && !isItemAboutCaller) {
      return false;
    }

    // 2. Sensitivity Gating
    switch (item.sensitivity) {
      case 'system_internal':
        // Only owner can retrieve system internals via normal requests
        return isOwnerUser;

      case 'owner_only':
        // strictly only owner
        return isOwnerUser;

      case 'person_shared':
        // Owner or the person the item is about
        return isOwnerUser || isItemAboutCaller;

      case 'public':
        // Anyone whose Identity Isolation check passed
        return true;

      default:
        return false;
    }
  }

  /**
   * Compute retrieval score combining similarity, importance, and recency.
   */
  private scoreItem(
    req: RetrievalRequest,
    item: MemoryItem
  ): { item: MemoryItem; score: number } {
    let textToMatch = '';
    let itemRecencyMs = item.createdAt;
    let itemImportance = 0.5;

    // Extract text payload and domain-specific metadata
    if ('summary' in item) {
      textToMatch = item.summary + ' ' + (item.details ?? '');
      itemRecencyMs = item.occurredAt;
      itemImportance = item.importance;
    } else if ('predicate' in item) {
      textToMatch = item.subject + ' ' + item.predicate + ' ' + item.object;
    } else if ('value' in item) {
      textToMatch = item.key + ' ' + item.value;
      itemRecencyMs = item.statedAt;
    } else if ('frequency' in item) {
      textToMatch = item.pattern;
      itemRecencyMs = item.lastObserved;
    } else if ('relation' in item) {
      textToMatch = item.name + ' ' + item.relation + ' ' + (item.notes ?? '');
      itemImportance = item.importance;
    } else if ('evidenceCount' in item) {
      textToMatch = item.pattern;
    }

    // Normalized Recency (0..1) -> newer is closer to 1
    const ageMs = Date.now() - itemRecencyMs;
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const normalizedRecency = Math.max(0, 1 - ageMs / oneYearMs);

    // Basic Jaccard similarity fallback since we lack vector extension in testing
    const similarity = this.bagOfWordsSimilarity(req.query, textToMatch);

    const score =
      req.similarityWeight * similarity +
      req.importanceWeight * itemImportance +
      req.recencyWeight * normalizedRecency;

    return { item, score };
  }

  /**
   * Barebones token overlap for baseline ranking without an LLM/vector store.
   */
  private bagOfWordsSimilarity(query: string, text: string): number {
    if (!query || !text) return 0;

    const queryTokens = comparableTokens(query);
    const textTokens = comparableTokens(text);

    if (queryTokens.size === 0 || textTokens.size === 0) return 0;

    let intersection = 0;
    for (const t of queryTokens) {
      if (textTokens.has(t)) intersection++;
    }

    return intersection / queryTokens.size; // 0 to 1
  }

  /**
   * Projects a raw MemoryItem into a ScopedMemoryItem safe for exposure.
   */
  private projectItem(item: MemoryItem, score: number): ScopedMemoryItem {
    let domain: MemoryDomain;

    // Determine domain from unique properties
    if ('summary' in item) domain = 'episodic';
    else if ('predicate' in item) domain = 'semantic';
    else if ('value' in item) domain = 'preference';
    else if ('frequency' in item) domain = 'habit'; // must check frequency or lastObserved carefully, but 'pattern' + 'frequency' is habit
    else if ('relation' in item) domain = 'relationship';
    else if ('evidenceCount' in item) domain = 'learned_pattern';
    else domain = 'episodic'; // fallback shouldn't happen if types are sound

    const scoped: ScopedMemoryItem = {
      id: item.id,
      domain,
      identityId: item.identityId,
      subjectKind: item.subjectKind,
      sensitivity: item.sensitivity,
      confidence: item.confidence,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      similarityScore: score,
    };

    if ('summary' in item) {
      scoped.summary = item.summary;
      scoped.details = item.details;
      scoped.importance = item.importance;
      scoped.occurredAt = item.occurredAt;
    } else if ('predicate' in item) {
      scoped.subject = item.subject;
      scoped.predicate = item.predicate;
      scoped.object = item.object;
    } else if ('value' in item) {
      scoped.key = item.key;
      scoped.value = item.value;
      scoped.statedAt = item.statedAt;
    } else if ('frequency' in item || ('pattern' in item && 'lastObserved' in item)) {
      scoped.pattern = item.pattern;
      scoped.frequency = (item as Habit).frequency;
      scoped.lastObserved = (item as Habit).lastObserved;
    } else if ('relation' in item) {
      scoped.name = item.name;
      scoped.relation = item.relation;
      scoped.notes = item.notes;
      scoped.importance = item.importance;
    } else if ('evidenceCount' in item) {
      scoped.pattern = item.pattern;
      scoped.evidenceCount = item.evidenceCount;
    }

    return scoped;
  }
}

/**
 * Comparable words out of a line of text, for the overlap score above.
 *
 * Three things beyond lowercasing, all of them about the language she is actually
 * spoken to in:
 *
 *  - `\p{L}` rather than `\w`. `\w` is `[A-Za-z0-9_]` and nothing else, so a line
 *    written in Devanagari tokenized to the empty set and every similarity
 *    involving it came back 0 — from the empty-set guard, not from any judgement
 *    about the words.
 *  - One script, via `toRomanHinglish`. Tokenizing Devanagari correctly is not
 *    enough on its own: a Roman query and a Devanagari memory then produce two
 *    valid token sets that overlap in nothing. The ear already folds what it hears
 *    (`server/voice/live/session.ts`), but a turn *typed* in Devanagari reaches the
 *    store without passing the ear, and a memory written from one of those would be
 *    unreachable from every query she is ever spoken. Applied to both sides here, so
 *    the store may hold either script and the comparison stops caring.
 *  - Vowel length is folded away, because Roman Hinglish has no settled spelling
 *    for it. The same word is typed "theek" and "thik", "aaj" and "aj", "hoon" and
 *    "hun", "yaad" and "yad", and a memory written one way would never match a
 *    stimulus written the other. `ee`→`i`, `oo`→`u`, then any repeated letter
 *    collapsed — applied to both sides, so the fold can only ever join two
 *    spellings of one word, never separate them. It is also what absorbs the
 *    transliterator's deliberate choice of the short form: `ठीक` becomes "thik"
 *    and the owner types "theek".
 *
 * It costs some precision in English: "book" and "buk" fold together, as do "all"
 * and "al". This is one weighted term in a ranking sum next to importance and
 * recency, not a filter, and a near-miss that ranks slightly high is a far smaller
 * failure than a whole script that could not be seen.
 */
function comparableTokens(text: string): Set<string> {
  const words = toRomanHinglish(text).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return new Set(words.map(foldVowelLength));
}

function foldVowelLength(word: string): string {
  return word.replace(/ee/g, 'i').replace(/oo/g, 'u').replace(/(.)\1+/g, '$1');
}
