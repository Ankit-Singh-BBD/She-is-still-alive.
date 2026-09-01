/**
 * Stage 9: RESPOND
 *
 * The LLM drafts user-facing language; the **Application** applies the
 * Knowledge Disclosure Policy before a single character escapes to the caller
 * (Build Book Part VII.1 stage 9, Part X.4). The gate is mandatory and cannot
 * be bypassed — the model never applies it to itself.
 *
 * The policy is deterministic and does three things:
 *
 *  1. **Identity isolation and sensitivity gating.** Every item that stage 3
 *     loaded into the working context is re-evaluated *independently* against
 *     the caller's clearance. Presence in working context is not permission to
 *     speak; if a non-disclosable fact appears in the draft it is redacted.
 *  2. **Unverified-claim suppression.** If an action was attempted and stage 8
 *     could not confirm it, no success language survives (Part XI.3 — the user
 *     is never told an action succeeded unless VERIFY passed).
 *  3. **System-internal redaction.** Table names, SQL, and internal paths never
 *     surface.
 *
 * Every disclosure decision is recorded for the audit log (Part X.4.3). Stage 9
 * hands the entries to a collector; stage 12 (PERSIST) commits them with the
 * rest of the cycle artifacts in one transaction (Part VII.1 stage 12).
 *
 * P09 rollback contract: with no LLM faculty wired, the application drafts the
 * text deterministically and the same gate runs over it.
 */

import type { ScopedMemoryItem } from '@server/memory/types.js';
import type {
  ActionResult,
  AuditCollector,
  AuthorizedDecision,
  AuthorizedResponse,
  RecalledContext,
  VerificationReport,
} from '../types.js';

export interface ResponseDraft {
  text: string;
  /** The faculty may ask for silence in voice; permission still decides. */
  voicePreferred?: boolean | undefined;
}

export interface ResponseFaculty {
  draftResponse(input: {
    recalled: RecalledContext;
    decision: AuthorizedDecision;
    results: ActionResult[];
    verification: VerificationReport | undefined;
  }): Promise<ResponseDraft>;
}

export interface RespondOptions {
  llm?: ResponseFaculty | undefined;
  audit?: AuditCollector | undefined;
}

export const REDACTION = '[redacted]';

const UNVERIFIED_NOTICE =
  'I started on that, but I could not confirm it actually went through — so I am not going to tell you it did.';

const WITHHELD_NOTICE = 'There is something there I am not able to share with you.';

/** Claim words the application refuses to let stand over an unverified action. */
const CLAIM_PATTERN =
  /\b(done|completed|complete|succeeded|success|successful|finished|all set|taken care of|i've|i have|already|turned (?:it )?(?:on|off)|sent|saved|scheduled|deleted)\b/i;

/** System internals that must never reach a caller. */
const INTERNAL_PATTERNS: RegExp[] = [
  /\b(cycle_record|stage_trace|domain_event|audit_log|action_result|episodic_memory|semantic_memory|learned_pattern)\b/gi,
  /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[a-z_][\w.]*/gi,
  /\bserver\/[\w/.-]+/gi,
  /\bsqlite\b/gi,
];

export async function respond(
  recalled: RecalledContext,
  decision: AuthorizedDecision,
  results: ActionResult[],
  verification: VerificationReport | undefined,
  opts: RespondOptions = {},
): Promise<AuthorizedResponse> {
  const draft = opts.llm
    ? await opts.llm.draftResponse({ recalled, decision, results, verification })
    : deterministicDraft(recalled, decision, results, verification);

  return applyDisclosurePolicy(draft, recalled, results, verification, opts.audit);
}

/**
 * The Knowledge Disclosure Policy. Runs over *any* draft — application-authored
 * or LLM-authored — and is the only thing that produces caller-visible output.
 */
function applyDisclosurePolicy(
  draft: ResponseDraft,
  recalled: RecalledContext,
  results: ActionResult[],
  verification: VerificationReport | undefined,
  audit: AuditCollector | undefined,
): AuthorizedResponse {
  const caller = recalled.stimulus;
  const at = Date.now();
  const policies = new Set<string>(['knowledge_disclosure_policy']);
  const original = typeof draft?.text === 'string' ? draft.text : '';
  let text = original;
  let redacted = false;

  // ── 2. Unverified-claim suppression ──
  const unverified = results.filter((r) => !r.verified);
  const actionUnconfirmed =
    results.length > 0 && (unverified.length > 0 || verification?.postconditionsMet === false);

  if (actionUnconfirmed && CLAIM_PATTERN.test(text)) {
    text = UNVERIFIED_NOTICE;
    redacted = true;
    policies.add('unverified_claim_suppression');
    audit?.record({
      actorId: caller.identityId,
      action: 'disclosure:suppress_unverified_claim',
      resource: 'response',
      decision: 'generalized',
      reason:
        verification?.discrepancies[0] ??
        unverified[0]?.error ??
        'Action was not verified against authoritative state',
      metadata: { toolIds: unverified.map((r) => r.toolId) },
      at,
    });
  }

  // ── 1. Identity isolation and sensitivity gating ──
  let evaluated = 0;
  let withheld = 0;

  for (const item of allContextItems(recalled)) {
    evaluated += 1;
    const verdict = disclosability(item, caller.identityId, caller.identityKind, caller);
    if (verdict.disclosable) continue;
    withheld += 1;

    let hit = false;
    for (const secret of secretsOf(item)) {
      if (!containsSecret(text, secret)) continue;
      text = redactSecret(text, secret);
      hit = true;
    }

    if (hit) {
      redacted = true;
      policies.add(verdict.policy);
      audit?.record({
        actorId: caller.identityId,
        action: 'disclosure:redact',
        resource: `memory:${item.domain}:${item.id}`,
        decision: 'redacted',
        reason: verdict.reason,
        metadata: { sensitivity: item.sensitivity, subjectId: item.identityId },
        at,
      });
    }
  }

  // ── 3. System-internal redaction ──
  for (const pattern of INTERNAL_PATTERNS) {
    if (!pattern.test(text)) {
      pattern.lastIndex = 0;
      continue;
    }
    pattern.lastIndex = 0;
    text = text.replace(pattern, REDACTION);
    redacted = true;
    policies.add('system_internal_redaction');
  }

  if (policies.has('system_internal_redaction')) {
    audit?.record({
      actorId: caller.identityId,
      action: 'disclosure:redact',
      resource: 'response',
      decision: 'redacted',
      reason: 'Draft referenced system internals',
      at,
    });
  }

  // A draft that redaction hollowed out becomes an honest refusal rather than a
  // string of holes.
  if (original.trim().length > 0 && stripRedactions(text).length === 0) {
    text = WITHHELD_NOTICE;
  }

  const voiceEnabled = caller.callerPermissions.mayBeHeardInVoice && (draft?.voicePreferred ?? true);

  audit?.record({
    actorId: caller.identityId,
    action: 'disclosure:evaluate',
    resource: 'response',
    decision: redacted ? 'redacted' : 'allowed',
    metadata: { itemsEvaluated: evaluated, itemsWithheld: withheld, policies: [...policies] },
    at,
  });

  return {
    text: text.trim(),
    voiceEnabled,
    disclosuresApplied: [...policies],
    redacted,
  };
}

/**
 * Deterministic application draft, used when no LLM faculty is wired. It states
 * only what the application can stand behind.
 */
function deterministicDraft(
  recalled: RecalledContext,
  decision: AuthorizedDecision,
  results: ActionResult[],
  verification: VerificationReport | undefined,
): ResponseDraft {
  switch (decision.proposal.action) {
    case 'noop':
      // Silence is a legitimate outcome; the cycle still completes.
      return { text: '', voicePreferred: false };
    case 'clarify':
      return { text: 'I want to be sure I have you right — could you tell me a little more?' };
    case 'learn':
      return { text: 'Noted — I will hold on to that.' };
    case 'schedule_task':
      return { text: 'I have put that on the list to take care of.' };
    case 'execute_tool': {
      const verified = results.filter((r) => r.verified);
      if (verified.length > 0 && verification?.postconditionsMet) {
        return { text: `Done — I ran ${verified.map((r) => r.toolId).join(', ')} and checked it.` };
      }
      return { text: UNVERIFIED_NOTICE };
    }
    case 'respond':
    default:
      return { text: greetingAware(recalled) };
  }
}

function greetingAware(recalled: RecalledContext): string {
  const text = extractText(recalled.stimulus.payload).toLowerCase();
  if (/\b(hi|hello|hey|namaste)\b/.test(text)) return 'Hello — I am here.';
  if (text.length === 0) return 'Hello — I am here whenever you want to start.';
  return 'Hello — I hear you.';
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const t = (payload as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}

function allContextItems(recalled: RecalledContext): ScopedMemoryItem[] {
  return [
    ...recalled.episodic,
    ...recalled.semantic,
    ...recalled.preferences,
    ...recalled.habits,
    ...recalled.relationships,
    ...recalled.learnedPatterns,
  ];
}

interface DisclosureVerdict {
  disclosable: boolean;
  policy: string;
  reason: string;
}

/**
 * Deterministic per-item disclosure decision. Independent of retrieval: an item
 * that should never have been loaded is still not speakable.
 */
function disclosability(
  item: ScopedMemoryItem,
  callerId: string,
  callerKind: string,
  caller: { callerPermissions: { mayReadMemories: boolean } },
): DisclosureVerdict {
  if (item.sensitivity === 'system_internal') {
    return {
      disclosable: false,
      policy: 'system_internal_redaction',
      reason: 'System-internal knowledge is never disclosed to a caller',
    };
  }

  if (!caller.callerPermissions.mayReadMemories && item.sensitivity !== 'public') {
    return {
      disclosable: false,
      policy: 'sensitivity_gating',
      reason: 'Caller may not read stored memories',
    };
  }

  const ownedByCaller = item.identityId === callerId;

  if (item.sensitivity === 'owner_only') {
    if (callerKind === 'owner' && ownedByCaller) {
      return { disclosable: true, policy: 'sensitivity_gating', reason: 'Owner-only, caller is owner' };
    }
    return {
      disclosable: false,
      policy: ownedByCaller ? 'sensitivity_gating' : 'identity_isolation',
      reason: 'Owner-only knowledge is not disclosable to this caller',
    };
  }

  if (!ownedByCaller && item.sensitivity !== 'public') {
    return {
      disclosable: false,
      policy: 'identity_isolation',
      reason: "Knowledge belongs to another identity's scope",
    };
  }

  return { disclosable: true, policy: 'sensitivity_gating', reason: 'Within caller clearance' };
}

/** The literal strings that would constitute disclosure of this item. */
function secretsOf(item: ScopedMemoryItem): string[] {
  const candidates = [
    item.summary,
    item.details,
    item.subject,
    item.object,
    item.value,
    item.pattern,
    item.name,
    item.notes,
    item.relation,
  ];
  // Very short fragments are matched by coincidence, not by disclosure.
  return candidates.filter((s): s is string => typeof s === 'string' && s.trim().length >= 4);
}

function containsSecret(text: string, secret: string): boolean {
  return text.toLowerCase().includes(secret.trim().toLowerCase());
}

function redactSecret(text: string, secret: string): string {
  return text.replace(new RegExp(escapeRegExp(secret.trim()), 'gi'), REDACTION);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripRedactions(text: string): string {
  return text.split(REDACTION).join('').replace(/[\s.,;:!?—-]+/g, '');
}
