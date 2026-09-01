/**
 * Stage 3: RECALL
 * Application responsibility: Apply the Knowledge Retrieval Policy and load a
 * caller-scoped working context (episodic, semantic, preferences, habits,
 * relationships, learned patterns).
 *
 * The LLM never performs retrieval and never sees raw memory rows: this stage
 * hands downstream stages only the projected, policy-filtered ScopedMemoryItems
 * (Build Book Part X.3).
 */

import type { MemoryRetrieval } from '@server/memory/retrieval.js';
import type {
  MemoryDomain,
  RetrievalRequest,
  ScopedMemoryItem,
} from '@server/memory/types.js';
import { DEFAULT_RETRIEVAL_WEIGHTS } from '@server/memory/types.js';
import type { IdentifiedStimulus, RecalledContext } from '../types.js';

const ALL_DOMAINS: readonly MemoryDomain[] = [
  'episodic',
  'semantic',
  'preference',
  'habit',
  'relationship',
  'learned_pattern',
];

export const RECALL_LIMIT = 20;

export async function recall(
  stimulus: IdentifiedStimulus,
  memoryRetrieval?: MemoryRetrieval,
): Promise<RecalledContext> {
  const ctx: RecalledContext = {
    stimulus,
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    retrievedAt: Date.now(),
  };

  // Without a retrieval service the cycle proceeds on an empty working
  // context rather than failing — a cold start is not an error.
  if (!memoryRetrieval) {
    return ctx;
  }

  const request: RetrievalRequest = {
    callerId: stimulus.identityId,
    callerKind: stimulus.identityKind,
    query: queryTextFor(stimulus.payload),
    domains: [...ALL_DOMAINS],
    limit: RECALL_LIMIT,
    recencyWeight: DEFAULT_RETRIEVAL_WEIGHTS.recency,
    importanceWeight: DEFAULT_RETRIEVAL_WEIGHTS.importance,
    similarityWeight: DEFAULT_RETRIEVAL_WEIGHTS.similarity,
    excludeSoftDeleted: true,
  };

  const result = await memoryRetrieval.retrieve(request);
  for (const item of result.items) {
    bucketFor(ctx, item.domain).push(item);
  }

  return ctx;
}

function bucketFor(ctx: RecalledContext, domain: MemoryDomain): ScopedMemoryItem[] {
  switch (domain) {
    case 'episodic':
      return ctx.episodic;
    case 'semantic':
      return ctx.semantic;
    case 'preference':
      return ctx.preferences;
    case 'habit':
      return ctx.habits;
    case 'relationship':
      return ctx.relationships;
    case 'learned_pattern':
      return ctx.learnedPatterns;
  }
}

/**
 * Builds the retrieval query from the stimulus payload. Text payloads are used
 * verbatim; anything else is serialized so structured stimuli still retrieve
 * deterministically instead of silently matching nothing.
 */
function queryTextFor(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'text' in payload) {
    const text = (payload as { text: unknown }).text;
    if (typeof text === 'string') return text;
  }
  try {
    return JSON.stringify(payload ?? {});
  } catch {
    return '';
  }
}
