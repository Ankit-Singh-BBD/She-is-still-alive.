/**
 * Stage 5: REASON
 * LLM faculty proposes a reasoning trace: the chain of conclusions that
 * justifies the candidate action.  The application validates the structural
 * shape of the trace; it does not evaluate the *correctness* of the
 * reasoning (that is the LLM's job, by design — Part VII.2).
 *
 * P08 real implementation: when no LLM faculty is wired, the stage emits
 * a single-step trace that follows the proposal from Stage 4 and
 * recomputes a recommendedApproach.  When an LLM faculty is wired, its
 * proposal is normalized into the expected envelope.
 */

import type {
  RecalledContext,
  UnderstandingProposal,
  ReasoningTraceProposal,
} from '../types.js';

export interface LlmFaculty {
  proposeReasoning(input: {
    stimulus: RecalledContext['stimulus'];
    recalled: RecalledContext;
    understanding: UnderstandingProposal;
  }): Promise<ReasoningTraceProposal>;
}

export interface ReasonOptions {
  llm?: LlmFaculty;
}

export async function reason(
  recalled: RecalledContext,
  understanding: UnderstandingProposal,
  opts: ReasonOptions = {},
): Promise<ReasoningTraceProposal> {
  let proposal: ReasoningTraceProposal;
  if (opts.llm) {
    proposal = await opts.llm.proposeReasoning({
      stimulus: recalled.stimulus,
      recalled,
      understanding,
    });
  } else {
    proposal = heuristicReasoning(understanding, recalled);
  }
  return validateAndNormalize(proposal);
}

function heuristicReasoning(
  understanding: UnderstandingProposal,
  recalled: RecalledContext,
): ReasoningTraceProposal {
  const baseApproach =
    understanding.intent === 'clarify'
      ? 'clarify'
      : understanding.intent === 'execute'
        ? 'execute'
        : understanding.intent === 'learn'
          ? 'learn'
          : 'respond';

  return {
    steps: [
      {
        description: `Caller intent: ${understanding.intent} (confidence ${understanding.confidence})`,
        conclusion: baseApproach,
        confidence: understanding.confidence,
      },
      {
        description: `Recalled ${recalled.episodic.length} episodic, ${recalled.semantic.length} semantic, ${recalled.preferences.length} preference, ${recalled.habits.length} habit, ${recalled.relationships.length} relationship, ${recalled.learnedPatterns.length} learned_pattern items.`,
        conclusion: 'context_loaded',
        confidence: 1,
      },
    ],
    optionsConsidered: ['respond', 'clarify', 'execute', 'learn'],
    recommendedApproach: baseApproach,
  };
}

function validateAndNormalize(p: ReasoningTraceProposal): ReasoningTraceProposal {
  const steps = Array.isArray(p?.steps)
    ? p.steps
        .filter(
          (s) =>
            s &&
            typeof s.description === 'string' &&
            typeof s.conclusion === 'string' &&
            typeof s.confidence === 'number',
        )
        .map((s) => ({
          description: s.description,
          conclusion: s.conclusion,
          confidence: clamp01(s.confidence),
        }))
    : [];
  const optionsConsidered = Array.isArray(p?.optionsConsidered)
    ? p.optionsConsidered.filter((o) => typeof o === 'string')
    : [];
  const recommendedApproach =
    typeof p?.recommendedApproach === 'string' && p.recommendedApproach.length > 0
      ? p.recommendedApproach
      : 'respond';

  if (steps.length === 0) {
    return {
      steps: [
        {
          description: 'Empty reasoning trace; defaulting to respond.',
          conclusion: 'respond',
          confidence: 0,
        },
      ],
      optionsConsidered: ['respond'],
      recommendedApproach: 'respond',
    };
  }

  return { steps, optionsConsidered, recommendedApproach };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
