/**
 * Stage 6: DECIDE
 * LLM faculty proposes a DecisionProposal (what action to take, which tool,
 * etc.). The Application *validates* the proposal for well-formedness and
 * *authorizes* it against the caller's permissions via `server/authz`. If the
 * proposal is invalid or unauthorized, the application rejects it and forces a
 * safe fallback (clarify) — the LLM cannot unilaterally execute tools or
 * bypass permissions (Build Book Part VII.2).
 *
 * P08 real implementation: a deterministic default proposal is emitted when no
 * LLM faculty is wired; when wired, the LLM's proposal is still passed through
 * the same application validation + authorization gate.
 */

import type { Identity } from '@server/identity/types.js';
import { check } from '@server/authz/index.js';
import type { AuthzAction, AuthzResource } from '@server/authz/types.js';
import type {
  DecisionProposal,
  AuthorizedDecision,
  ReasoningTraceProposal,
  IdentifiedStimulus,
} from '../types.js';

export interface LlmFaculty {
  proposeDecision(input: {
    stimulus: IdentifiedStimulus;
    reasoning: ReasoningTraceProposal;
  }): Promise<DecisionProposal>;
}

export interface DecideOptions {
  llm?: LlmFaculty | undefined;
  identity?: Identity | undefined;
}

const ALLOWED_ACTIONS: readonly DecisionProposal['action'][] = [
  'respond',
  'execute_tool',
  'schedule_task',
  'learn',
  'noop',
  'clarify',
];

export async function decide(
  reasoning: ReasoningTraceProposal,
  stimulus: IdentifiedStimulus,
  opts: DecideOptions = {},
): Promise<AuthorizedDecision> {
  const proposal = opts.llm
    ? await opts.llm.proposeDecision({ stimulus, reasoning })
    : heuristicProposal(reasoning);

  // Application validation: is the proposal well-formed and recognized?
  const validated = validateProposal(proposal);

  // Application authorization. Producing language for the caller needs no
  // elevated clearance — what may actually be *said* is gated by the Knowledge
  // Disclosure Policy in stage 9. Everything else must clear the authz matrix.
  const required = mapToAuthz(validated);
  if (!required) {
    return {
      proposal: validated,
      authorized: true,
      clearanceChecked: true,
    };
  }

  if (!opts.identity) {
    // No authenticated identity means no clearance can be established.
    const reason = 'No authenticated identity to authorize against';
    return {
      proposal: safeFallback(reason),
      authorized: false,
      reason,
      clearanceChecked: true,
    };
  }

  const decision = check(opts.identity, required.action, required.resource);

  if (!decision.allowed) {
    const reason = decision.reason ?? 'Denied by authorization policy';
    return {
      proposal: safeFallback(reason),
      authorized: false,
      reason,
      clearanceChecked: true,
    };
  }

  return {
    proposal: validated,
    authorized: true,
    clearanceChecked: true,
  };
}

/**
 * Deterministic proposal derived from the reasoning trace, used when no LLM
 * faculty is wired. This is the documented P08 rollback behaviour: stages 4-6
 * degrade to a default decision rather than failing the cycle.
 */
function heuristicProposal(reasoning: ReasoningTraceProposal): DecisionProposal {
  switch (reasoning.recommendedApproach) {
    case 'execute':
      return {
        action: 'execute_tool',
        rationale: 'Reasoning trace recommended tool execution',
      };
    case 'learn':
      return { action: 'learn', rationale: 'Reasoning trace recommended learning' };
    case 'clarify':
      return { action: 'clarify', rationale: 'Reasoning trace recommended clarification' };
    case 'noop':
      return { action: 'noop', rationale: 'Reasoning trace recommended no action' };
    default:
      return { action: 'respond', rationale: 'Reasoning trace recommended a response' };
  }
}

/**
 * Reduces any proposal to a well-formed DecisionProposal. Fields that do not
 * belong to the chosen action are dropped so an unauthorized tool call cannot
 * ride along on a 'respond' decision.
 */
function validateProposal(p: DecisionProposal): DecisionProposal {
  const action = ALLOWED_ACTIONS.includes(p?.action) ? p.action : 'respond';
  const rationale =
    typeof p?.rationale === 'string' && p.rationale.length > 0
      ? p.rationale
      : 'No rationale supplied';

  const validated: DecisionProposal = { action, rationale };

  if (action === 'execute_tool') {
    if (typeof p?.toolId === 'string' && p.toolId.length > 0) {
      validated.toolId = p.toolId;
      validated.toolInput = p.toolInput;
    } else {
      // A tool call with no tool is not a recognized proposal.
      return { action: 'clarify', rationale: 'Tool execution proposed without a toolId' };
    }
  } else if (action === 'schedule_task') {
    validated.taskSpec = p?.taskSpec;
  } else if (action === 'learn') {
    validated.learningItems = Array.isArray(p?.learningItems) ? p.learningItems : [];
  }

  return validated;
}

function safeFallback(reason: string): DecisionProposal {
  return { action: 'clarify', rationale: `Rejected by application: ${reason}` };
}

/**
 * Maps a validated proposal to the authorization it requires.
 * Returns null when the proposal needs no elevated clearance.
 */
function mapToAuthz(
  proposal: DecisionProposal,
): { action: AuthzAction; resource?: AuthzResource } | null {
  switch (proposal.action) {
    case 'execute_tool':
      return {
        action: 'tool:execute',
        resource: { type: 'tool', toolId: proposal.toolId, clearanceRequired: 'safe' },
      };
    case 'learn':
      return {
        action: 'knowledge:enroll',
        resource: { type: 'memory', sensitivity: 'medium' },
      };
    case 'schedule_task':
      return { action: 'action:trigger', resource: { type: 'task' } };
    case 'respond':
    case 'clarify':
    case 'noop':
    default:
      return null;
  }
}
