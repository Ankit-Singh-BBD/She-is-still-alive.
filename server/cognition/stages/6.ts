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
 *
 * With no faculty there are two deterministic sources, in order: an
 * `IntentRecognizer` (`server/cognition/intent/`) reads the words for a tool it can
 * name and arguments it can actually justify, and if it finds none the reasoning
 * trace's shape decides. Both go through the same gate as a model's proposal, which
 * is the whole point of the arrangement — the application authorizes, and nothing
 * that proposes is trusted, whether it is a model or a regex.
 */

import { check } from '@server/authz/index.js';
import type { AuthzAction, AuthzCaller, AuthzResource } from '@server/authz/types.js';
import type { IntentRecognizer } from '../intent/index.js';
import type {
  DecisionProposal,
  AuthorizedDecision,
  ClearanceOutcome,
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
  /**
   * Who is asking, as of this cycle. Composed by `effectiveCaller`, which is why this
   * is the three fields `check()` reads and not a whole `Identity` — see that
   * function's note for what the wider type was letting through.
   */
  identity?: AuthzCaller | undefined;
  /**
   * The deterministic reader used when no faculty is wired.
   *
   * It stands exactly where `llm` stands and gets no more trust: whatever it
   * proposes goes through `validateProposal` and the authorization gate below,
   * so a tool it names is still refused if the caller may not run it.
   */
  intent?: IntentRecognizer | undefined;
  /**
   * What clearance a tool declares. Without it this stage hardcoded `'safe'` — the
   * *weaker* of the two requirements — so a caller holding `mayTriggerActions: 'safe'`
   * cleared the DECIDE gate for an `'all'` tool and was refused two stages later by
   * `check()` calls with identical inputs. The refusal was real; the trace attributed
   * it to the wrong stage, which is the thing that makes a defect hard to find.
   *
   * Stage 7 grew the same option for the same reason. `undefined` for an unknown tool
   * falls back to `'safe'`, so a tool the registry has never heard of is still
   * proposed and then refused by name at dispatch rather than silently downgraded
   * here.
   */
  clearanceFor?: ((toolId: string) => 'safe' | 'all' | undefined) | undefined;
}

const ALLOWED_ACTIONS: readonly DecisionProposal['action'][] = [
  'respond',
  'execute_tool',
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
    : (opts.intent?.propose(stimulus) ?? heuristicProposal(reasoning));

  // Application validation: is the proposal well-formed and recognized?
  const validated = validateProposal(proposal);

  // Application authorization. Producing language for the caller needs no
  // elevated clearance — what may actually be *said* is gated by the Knowledge
  // Disclosure Policy in stage 9. Everything else must clear the authz matrix.
  const required = mapToAuthz(validated, opts.clearanceFor);
  if (!required) {
    return granted(validated, { kind: 'not_required' });
  }

  if (!opts.identity) {
    // No authenticated identity means no clearance can be established. This is
    // `unavailable` and not `denied`: the policy was never consulted, so nothing
    // here says anything about what this caller may do.
    return refused(validated, {
      kind: 'unavailable',
      reason: 'No authenticated identity to authorize against',
      action: required.action,
    });
  }

  const decision = check(opts.identity, required.action, required.resource);

  if (!decision.allowed) {
    return refused(validated, {
      kind: 'denied',
      action: required.action,
      resource: required.resource,
      reason: decision.reason ?? 'Denied by authorization policy',
    });
  }

  return granted(validated, {
    kind: 'granted',
    action: required.action,
    resource: required.resource,
  });
}

/**
 * The authorized outcome: the validated proposal is what gets carried out, and
 * there is no refused proposal to keep.
 */
function granted(
  proposal: DecisionProposal,
  clearance: Extract<ClearanceOutcome, { kind: 'not_required' | 'granted' }>,
): AuthorizedDecision {
  return { proposal, authorized: true, clearance };
}

/**
 * The refused outcome: the fallback is carried out, the proposal that was refused
 * is kept verbatim, and the reason is the clearance's own rather than a second
 * copy that could disagree with it.
 *
 * Written as one constructor on purpose. `authorized`, `reason`, `clearance` and
 * `refusedProposal` describe a single event four ways, and the defect this
 * replaces was exactly those parts being assembled by hand at each return site.
 */
function refused(
  proposal: DecisionProposal,
  clearance: Extract<ClearanceOutcome, { kind: 'denied' | 'unavailable' }>,
): AuthorizedDecision {
  return {
    proposal: safeFallback(clearance.reason),
    authorized: false,
    reason: clearance.reason,
    clearance,
    refusedProposal: proposal,
  };
}

/**
 * Deterministic proposal derived from the reasoning trace alone, used when no LLM
 * faculty is wired *and* the words named nothing an `IntentRecognizer` could read.
 * This is the documented P08 rollback behaviour: stages 4-6 degrade to a default
 * decision rather than failing the cycle.
 *
 * `'execute'` is the one approach this path cannot honour, and it says so rather
 * than pretending otherwise. Choosing a tool means choosing its *arguments* —
 * which memory to recall, what time to schedule for — and a reasoning trace does
 * not carry them; it reports the shape of an answer, not its content.
 *
 * That used to be the end of the argument, and it was too strong. It ruled out the
 * whole of tool use without a model, which left seven registered tools unreachable
 * for anyone running without a key — so "kal 7 baje yaad dilana" was answered with
 * a greeting. A time and an imperative verb are readable by rule, and
 * `server/cognition/intent/` now reads them, ahead of this function. What remains
 * true is the sentence below: by the time a cycle is *here*, the words have already
 * been looked at and found to name no tool, so there is nothing to choose from.
 *
 * It used to return `action: 'execute_tool'` with no `toolId`, which
 * `validateProposal` then rewrote to `clarify` with the rationale "Tool execution
 * proposed without a toolId". That rationale is durable: it goes into
 * `CycleRecord`, and it described a model misbehaving when there was no model in
 * the cycle at all. The decision is the same; the reason on the record is now the
 * true one.
 */

function heuristicProposal(reasoning: ReasoningTraceProposal): DecisionProposal {
  switch (reasoning.recommendedApproach) {
    case 'execute':
      return {
        action: 'clarify',
        rationale:
          'Tool execution was the right shape of answer, but choosing a tool and its arguments needs the language faculty, and none is wired',
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
  }

  // A `learn` decision carries no payload. What to remember is stage 10's question,
  // asked of the model with the whole finished cycle in hand and answered in typed
  // candidates that carry a domain, a confidence, a sensitivity and a provenance —
  // everything the Scoped Learning Policy needs to decide what may be stored. This
  // proposal used to carry a `learningItems: unknown[]` alongside it, which the wire
  // schema never asked the model for and no stage ever read, so it was `[]` on every
  // path through this function.

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
  clearanceFor?: (toolId: string) => 'safe' | 'all' | undefined,
): { action: AuthzAction; resource?: AuthzResource } | null {
  switch (proposal.action) {
    case 'execute_tool':
      return {
        action: 'tool:execute',
        resource: {
          type: 'tool',
          toolId: proposal.toolId,
          // The clearance the tool really declares, not an assumed `safe`.
          clearanceRequired: (proposal.toolId ? clearanceFor?.(proposal.toolId) : undefined) ?? 'safe',
        },
      };
    case 'learn':
      return {
        action: 'knowledge:enroll',
        resource: { type: 'memory', sensitivity: 'medium' },
      };
    case 'respond':
    case 'clarify':
    case 'noop':
    default:
      return null;
  }
}
