/**
 * Stage 4: UNDERSTAND
 * LLM faculty proposes interpretation of intent and entities.
 * Application validates that the proposal matches the expected JSON schema
 * (a well-formed UnderstandingProposal) before it is admitted into the cycle.
 *
 * P08 real implementation: the proposal is produced by a deterministic
 * heuristic extractor over the RecalledContext when no LLM faculty is wired,
 * and by the supplied LLM Faculty otherwise.  Either way, the application
 * is the gatekeeper: malformed proposals are rejected with a fallback that
 * forces the cycle to ask for clarification (intent='clarify', confidence=0).
 */

import type {
  IdentifiedStimulus,
  RecalledContext,
  UnderstandingProposal,
} from '../types.js';

/**
 * Minimal LLM Faculty boundary used by stage 4.
 * Real wiring in a later phase will pass a Gemini-backed client.
 */
export interface LlmFaculty {
  proposeUnderstanding(input: {
    stimulus: IdentifiedStimulus;
    recalled: RecalledContext;
  }): Promise<UnderstandingProposal>;
}

export interface UnderstandOptions {
  llm?: LlmFaculty;
}

export async function understand(
  recalled: RecalledContext,
  opts: UnderstandOptions = {},
): Promise<UnderstandingProposal> {
  let proposal: UnderstandingProposal;
  if (opts.llm) {
    proposal = await opts.llm.proposeUnderstanding({
      stimulus: recalled.stimulus,
      recalled,
    });
  } else {
    proposal = heuristicProposal(recalled);
  }
  return validateAndNormalize(proposal);
}

/**
 * Deterministic fallback proposal so the cognitive cycle remains
 * executable when the LLM faculty is not yet wired.
 */
function heuristicProposal(recalled: RecalledContext): UnderstandingProposal {
  const stimulus = recalled.stimulus;
  const text = extractText(stimulus.payload);
  const trimmed = (text ?? '').trim();
  const hasQuestion = /\?$/.test(trimmed);
  const lowConfidence = trimmed.length === 0;

  const entities: Record<string, unknown> = {};
  if (text) {
    const tokens = text.match(/\b[A-Z][a-zA-Z]{2,}\b/g) ?? [];
    for (const t of tokens) entities[t] = { surface: t };
  }

  return {
    intent: hasQuestion ? 'clarify' : 'respond',
    confidence: lowConfidence ? 0 : 0.6,
    disambiguationNeeded: lowConfidence,
    clarifyingQuestions: lowConfidence ? ['Could you rephrase that?'] : [],
    entities,
  };
}

/**
 * Application-side gate: every admitted UnderstandingProposal must satisfy
 * the shape.  Anything malformed is reduced to a safe clarification
 * proposal so the cycle continues without leaking unvalidated content.
 */
function validateAndNormalize(p: UnderstandingProposal): UnderstandingProposal {
  const intent = typeof p?.intent === 'string' && p.intent.length > 0 ? p.intent : 'respond';
  const confidence =
    typeof p?.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1
      ? p.confidence
      : 0;
  const disambiguationNeeded = Boolean(p?.disambiguationNeeded);
  const clarifyingQuestions = Array.isArray(p?.clarifyingQuestions)
    ? p.clarifyingQuestions.filter((q) => typeof q === 'string')
    : [];
  const entities =
    p && typeof p.entities === 'object' && p.entities !== null
      ? (p.entities as Record<string, unknown>)
      : {};

  if (intent !== 'respond' && intent !== 'clarify' && intent !== 'execute' && intent !== 'learn' && intent !== 'noop') {
    return {
      intent: 'clarify',
      confidence: 0,
      disambiguationNeeded: true,
      clarifyingQuestions: [`Unsupported intent '${intent}' proposed`],
      entities: {},
    };
  }

  return {
    intent,
    confidence,
    disambiguationNeeded,
    clarifyingQuestions,
    entities,
  };
}

function extractText(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object' && 'text' in payload) {
    const t = (payload as { text: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return undefined;
}
