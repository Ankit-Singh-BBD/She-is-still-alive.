/** P07 cognitive scaffold types — 12 stage contracts. */

import type { IdentityKind, PermissionSet } from '@server/identity/types.js';
import type { AuthzAction, AuthzResource } from '@server/authz/types.js';
import type { ScopedMemoryItem } from '@server/memory/types.js';
import type { ConversationTurn } from '@server/conversations/messages.js';

// ── Common ──
export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface StageTrace {
  stage: StageNumber;
  stageName: string;
  startedAt: number;
  completedAt?: number | undefined;
  inputJson: string;
  outputJson?: string | undefined;
  error?: string | undefined;
}

/**
 * `degraded` means the cycle ran to completion but at least one stage threw and
 * was replaced by its documented fallback. It exists so a cycle can never report
 * clean success over a stage that actually failed — see Part II, "action is
 * proven, not claimed". `failed` is reserved for a cycle that could not produce
 * a response at all.
 */
export type CycleStatus = 'running' | 'completed' | 'degraded' | 'interrupted' | 'failed';

export interface CycleRecord {
  id: string;
  identityId: string;
  conversationId: string;
  status: CycleStatus;
  startedAt: number;
  completedAt?: number | undefined;
  stages: StageTrace[];
  /**
   * What stage 6 proposed, before the application's authorization gate saw it.
   *
   * On an authorized cycle this equals `authorizedDecision.proposal`. On a refused
   * one it is the proposal that was refused — which is the only case where the
   * field carries information the rest of the record does not already hold, and
   * the case it used to get wrong: it was assigned the post-gate proposal, so a
   * denied tool call was persisted as a `clarify` she never proposed.
   */
  proposedDecision?: DecisionProposal | undefined;
  /**
   * The four stage outputs the cycle carries, each typed as the stage that wrote it.
   *
   * All four used to be `unknown` with a trailing comment naming the real type —
   * `authorizedDecision?: unknown; // AuthorizedDecision after stage 6 validation` —
   * and every one of those types is declared below in this same file. So the comment
   * was the type, written where the compiler could not read it, and the cost was paid
   * by every reader: `server/http/routes/conversation.ts` and
   * `server/voice/live/session.ts` each carried an identical thirteen-line
   * `asResponse(value: unknown)` that re-checked `typeof candidate.text === 'string'`
   * on a value `CognitiveRuntime` had built three call frames earlier, and seven test
   * sites cast it back by hand — `(cycle.response as { text: string }).text` — each
   * one free to name a field that does not exist.
   *
   * A record that crosses a serialization boundary genuinely is `unknown` when it comes
   * back, and that case has its own narrow type with its own guards:
   * `CycleRecord` in `server/learning/types.js`, rebuilt from a `cycle_record` row by
   * the consolidation sweep, where `authorizedDecision` is `unknown` because it is a
   * JSON column. This record never leaves the process it was built in.
   */
  authorizedDecision?: AuthorizedDecision | undefined;
  response?: AuthorizedResponse | undefined;
  actionResults?: ActionResult[] | undefined;
  learningDelta?: AuthorizedLearningDelta | undefined;
  error?: string | undefined;
}

// ── Stage 1: PERCEIVE ──
export interface RawStimulus {
  source: 'text' | 'audio' | 'system' | 'proactive';
  payload: unknown;
  receivedAt: number;
  identityId: string;
  conversationId?: string | undefined;
  sessionId?: string | undefined;
}

// ── Stage 2: IDENTIFY ──
export interface IdentifiedStimulus extends RawStimulus {
  identityKind: IdentityKind;
  callerPermissions: PermissionSet;
  inputType: 'user_message' | 'system_event' | 'proactive_trigger' | 'interrupt';
  attachedContext?: string | undefined;
}

// ── Stage 3: RECALL ──
export interface RecalledContext {
  stimulus: IdentifiedStimulus;
  episodic: ScopedMemoryItem[];
  semantic: ScopedMemoryItem[];
  preferences: ScopedMemoryItem[];
  habits: ScopedMemoryItem[];
  relationships: ScopedMemoryItem[];
  learnedPatterns: ScopedMemoryItem[];
  /**
   * The turns of this conversation before the current one, oldest first.
   *
   * Optional, and the two empty cases are deliberately distinguishable:
   * `undefined` means no transcript was loaded at all (no reader was wired, or
   * the stimulus named no conversation), while `[]` means one was loaded and
   * this is genuinely the first thing said. A prompt that cannot tell those
   * apart would claim she is starting fresh when in fact nobody looked.
   */
  recentTurns?: readonly ConversationTurn[] | undefined;
  retrievedAt: number;
}

// ── Stage 4: UNDERSTAND ──
export interface UnderstandingProposal {
  intent: string;
  confidence: number;
  disambiguationNeeded: boolean;
  clarifyingQuestions: string[];
  entities: Record<string, unknown>;
}

// ── Stage 5: REASON ──
export interface ReasoningTraceProposal {
  steps: Array<{
    description: string;
    conclusion: string;
    confidence: number;
  }>;
  optionsConsidered: string[];
  recommendedApproach: string;
}

// ── Stage 6: DECIDE ──
/**
 * The five things a cycle can decide to do.
 *
 * There were six, and the sixth carried two fields that nothing read.
 * `schedule_task` carried a `taskSpec`: stage 7 executes `execute_tool` and nothing
 * else, so the action produced no results, and stage 9 answered it with "I have put
 * that on the list to take care of" — a promise nothing kept. Worse, the
 * unverified-claim gate could not catch it, because that gate requires at least one
 * action result and this action produced none. Scheduling something for later is
 * `execute_tool` with `reminder.schedule`, which has verified postconditions, a
 * durable row, and a delivery path that speaks it.
 *
 * `learn` kept its place but lost its `learningItems: unknown[]`, which was `[]` on
 * every path: the decision wire schema never asked the model for it, and stage 10
 * asks the real question — with the finished cycle in hand, in typed candidates that
 * carry the domain, confidence, sensitivity and provenance the Scoped Learning Policy
 * runs on.
 */
export interface DecisionProposal {
  action: 'respond' | 'execute_tool' | 'learn' | 'noop' | 'clarify';
  toolId?: string | undefined;
  toolInput?: unknown | undefined;
  rationale: string;
}

/**
 * What the authorization gate in stage 6 actually did.
 *
 * This replaced a `clearanceChecked: boolean` that was set to `true` on all four
 * of `decide`'s return paths — including the one where `mapToAuthz` returned null
 * and `check()` was therefore never called, which is every cycle that produces
 * language, and the one where there was no identity to check against. A flag that
 * is always true carries no information, and this one asserted a check had
 * happened where none had.
 *
 * The union makes the four outcomes distinguishable, and makes "checked" a claim
 * that cannot be made without naming the action and resource that were checked.
 */
export type ClearanceOutcome =
  /**
   * The proposal needs no elevated clearance, so nothing was checked. Producing
   * language for the caller lands here; what may actually be *said* is gated by
   * the Knowledge Disclosure Policy in stage 9 instead.
   */
  | { readonly kind: 'not_required' }
  /** `check()` ran against an authenticated identity and allowed it. */
  | {
      readonly kind: 'granted';
      readonly action: AuthzAction;
      readonly resource?: AuthzResource | undefined;
    }
  /** `check()` ran and refused it. */
  | {
      readonly kind: 'denied';
      readonly action: AuthzAction;
      readonly resource?: AuthzResource | undefined;
      readonly reason: string;
    }
  /**
   * The gate could not be consulted at all — there was no authenticated identity
   * to check against, or the stage threw before reaching it. Deliberately distinct
   * from `denied`: no policy decided anything here, so nothing about the caller's
   * permissions may be inferred from it.
   */
  | {
      readonly kind: 'unavailable';
      readonly reason: string;
      readonly action?: AuthzAction | undefined;
    };

export interface AuthorizedDecision {
  /**
   * What the application will actually carry out. On a refusal this is the safe
   * fallback and *not* what was proposed — the proposal itself is kept verbatim
   * in `refusedProposal`.
   */
  proposal: DecisionProposal;
  authorized: boolean;
  reason?: string | undefined;
  /**
   * The evidence behind `authorized`. Both are built by the same constructor in
   * stage 6 so the flag and its evidence cannot drift apart.
   */
  clearance: ClearanceOutcome;
  /**
   * The proposal the application refused, kept as proposed.
   *
   * Present exactly when `authorized` is false and a proposal had been formed.
   * Before this field existed, `proposal` was overwritten by the `clarify`
   * fallback and the refused proposal was recorded nowhere at all — the single
   * trace of what she wanted to do and was not cleared to do was the one thing
   * the cycle discarded. An unprompted cycle that gets refused has to leave that
   * trace, or self-initiated behaviour is unauditable.
   */
  refusedProposal?: DecisionProposal | undefined;
}

// ── Stage 7: ACT ──
export interface ActionResult {
  toolId: string;
  /**
   * Whether the call was dispatched to an executor at all.
   *
   * Three booleans in a row look like two too many, and they are not. `success`
   * means the call returned; `verified` means stage 8 re-read the world and found it
   * changed; this one means the call was *made*. Stage 7 refuses before dispatch for
   * four reasons — an unauthorized decision, a proposal with no `toolId`, no
   * authenticated identity, no executor wired — and every one of those used to arrive
   * at stage 9 as `success: false, verified: false`, indistinguishable from a tool
   * that ran and threw.
   *
   * The two need different sentences, and the difference is safety rather than
   * register. `attempted: true, verified: false` means *the world may have changed and
   * she cannot confirm it* — go and look. `attempted: false` means nothing was
   * touched, full stop. Collapsing them made her answer a switched-off capability with
   * "I started on that, but I could not confirm it actually went through", which is a
   * false claim about her own behaviour, and the more alarming of the two.
   */
  attempted: boolean;
  success: boolean;
  output?: unknown | undefined;
  error?: string | undefined;
  verified: boolean;
}

// ── Stage 8: VERIFY ──
/**
 * What a re-read of authoritative state concluded.
 *
 * There is no `preconditionsMet` beside `postconditionsMet`, and the asymmetry is
 * deliberate. Nothing in this codebase checks a tool's preconditions *before* acting,
 * so a field named for that pair would have been read as a claim no stage makes — and
 * the one it did compute was narrower than its name: every result named an identified
 * tool. That fact is already here, as the sentence stage 9 can show the caller
 * (`An action was attempted without an identified tool: …`), and it forces
 * `postconditionsMet` false by the same route as any other discrepancy.
 */
export interface VerificationReport {
  postconditionsMet: boolean;
  discrepancies: string[];
  /**
   * The action results after verification. `verified` is set here and nowhere
   * else: only a re-read of authoritative state may mark an action proven
   * (Build Book Part XI.3).
   */
  results: ActionResult[];
  recheckedAt: number;
}

// ── Stage 9: RESPOND ──
export interface AuthorizedResponse {
  text: string;
  voiceEnabled: boolean;
  disclosuresApplied: string[];
  redacted: boolean;
}

// ── Stage 10: LEARN ──
export interface AuthorizedLearningDelta {
  memories: Array<{
    domain: string;
    data: Record<string, unknown>;
    provenance: {
      sourceCycleId: string;
      sourceConversationId: string;
      sourceMessageIds: string[];
      extractedAt: number;
      extractor: 'rule' | 'llm';
      confidence: number;
      validatedBy: 'app_rule' | 'owner_confirmation' | 'auto_policy';
    };
    sensitivity: 'public' | 'person_shared' | 'owner_only' | 'system_internal';
    subjectKind: IdentityKind | 'system';
  }>;
  extractedAt: number;
}

// ── Stage 11: UPDATE ──
export interface UpdateResult {
  applied: number;
  skipped: number;
  errors: string[];
}

// ── Stage 12: PERSIST ──
export interface PersistResult {
  cycleRecordId: string;
  committedAt: number;
  eventsEmitted: number;
  /**
   * Transcript turns actually inserted. Reported rather than assumed: a cycle
   * whose stimulus carried no text writes one turn, and one with no authorized
   * response writes none, so a caller counting the conversation counts rows.
   */
  turnsWritten: number;
}

// ── Stage handler signature ──
export type StageHandler<I, O> = (input: I) => Promise<O>;

// ── Audit (Part X.4.3 / VII.1 stage 12) ──

/**
 * One auditable decision made during a cycle. Disclosure decisions are recorded
 * in stage 9; stage 12 (PERSIST) commits the collected entries to `audit_log`
 * together with the rest of the cycle artifacts in a single transaction.
 */
export interface AuditEntry {
  actorId: string;
  action: string;
  resource: string;
  decision: 'allowed' | 'redacted' | 'generalized' | 'blocked';
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  at: number;
}

export interface AuditCollector {
  record(entry: AuditEntry): void;
}

// ── Stage names ──
export const STAGE_NAMES: Record<StageNumber, string> = {
  1: 'PERCEIVE',
  2: 'IDENTIFY',
  3: 'RECALL',
  4: 'UNDERSTAND',
  5: 'REASON',
  6: 'DECIDE',
  7: 'ACT',
  8: 'VERIFY',
  9: 'RESPOND',
  10: 'LEARN',
  11: 'UPDATE',
  12: 'PERSIST',
};