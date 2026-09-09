/**
 * Stage 3: RECALL
 * Application responsibility: Apply the Knowledge Retrieval Policy and load a
 * caller-scoped working context (episodic, semantic, preferences, habits,
 * relationships, learned patterns) — and the recent turns of the conversation
 * this stimulus belongs to.
 *
 * The LLM never performs retrieval and never sees raw memory rows: this stage
 * hands downstream stages only the projected, policy-filtered ScopedMemoryItems
 * (Build Book Part X.3).
 *
 * The transcript is loaded here rather than anywhere else because this is the
 * stage whose job is "what do I know that bears on this", and the previous turn
 * is the most immediate thing there is. Without it a cycle could recall a fact
 * from last month and not the sentence it was answering, so "and the other one?"
 * had nothing to refer to.
 */

import type { TranscriptReader } from '@server/conversations/messages.js';
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

/**
 * How many previous turns are loaded.
 *
 * Ten is roughly five exchanges, which is what the UNDERSTAND stage's input
 * budget (1024 tokens, shared with the stimulus and the working context) will
 * carry once each line is bounded. Loading more and rendering less would put
 * her one silent truncation away from losing the turn that mattered.
 */
export const RECENT_TURNS_LIMIT = 10;

export async function recall(
  stimulus: IdentifiedStimulus,
  memoryRetrieval?: MemoryRetrieval,
  transcript?: TranscriptReader,
): Promise<RecalledContext> {
  const recentTurns =
    transcript && stimulus.conversationId !== undefined && stimulus.conversationId !== ''
      ? transcript.recentForCaller(
          stimulus.conversationId,
          stimulus.identityId,
          RECENT_TURNS_LIMIT,
        )
      : undefined;

  const ctx: RecalledContext = {
    stimulus,
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    // Left absent, not empty, when nothing was loaded: `[]` is the claim that
    // this is the first turn, and that is not what "no reader was wired" means.
    ...(recentTurns ? { recentTurns } : {}),
    retrievedAt: Date.now(),
  };

  // Without a retrieval service the cycle proceeds on an empty working
  // context rather than failing — a cold start is not an error. Any transcript
  // that was loaded above still stands: the two sources are independent, and
  // having no memory store is no reason to forget the last sentence.
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
