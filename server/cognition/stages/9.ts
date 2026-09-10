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
 *  2. **Unverified-claim suppression.** If an action could not be confirmed by
 *     stage 8, no success language survives (Part XI.3 — the user is never told
 *     an action succeeded unless VERIFY passed). What replaces it depends on
 *     whether the call was ever dispatched: see `unconfirmedNotice`.
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
import { describeOutcome } from '@server/tools/outcomes.js';
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

/**
 * The three dimensions of her register, as stage 9 needs them.
 *
 * Declared here rather than imported from `server/personality` on purpose, and this
 * is not a shadow copy of `ToneProfile`: it is the *subset* stage 9 depends on.
 * `ToneProfile` also carries a display name and the list of sources that produced
 * it, which are facts about the personality subsystem and none of a stage's
 * business. Structural typing means `PersonalityService.profileFor()` satisfies this
 * with no adapter, so there is one producer and no conversion to drift.
 */
export interface ResponseTone {
  /** 0 terse · 1 plain · 2 expansive. */
  verbosity: 0 | 1 | 2;
  /** 0 casual · 1 plain · 2 formal. */
  formality: 0 | 1 | 2;
  /** 0 flat · 1 plain · 2 warm. */
  warmth: 0 | 1 | 2;
}

export interface RespondOptions {
  llm?: ResponseFaculty | undefined;
  audit?: AuditCollector | undefined;
  /**
   * B08.s2 pre-TTS grounding frame. When present, completion language over an
   * empty `verifiedOutcomeIds` is suppressed to an in-progress acknowledgement
   * before other disclosure checks — so unverified "ho gaya" never reaches TTS.
   */
  frame?: import('@server/conversation/frame.js').ResponseFrame | null | undefined;
  /**
   * Her register for one caller, resolved at call time.
   *
   * Shapes only the *application-authored* lines below — the ones this file
   * hard-codes. It never touches an LLM draft (the faculty gets the same tone
   * through its own system instruction) and it never touches the proactive seed,
   * which is her own observation and not ours to reword.
   *
   * A function of identity rather than a value because a runtime is built per
   * request but the personality state is shared and expires: a profile captured at
   * construction would be a mood frozen at boot.
   */
  tone?: ((identityId: string) => ResponseTone) | undefined;
}

const PLAIN_TONE: ResponseTone = { verbosity: 1, formality: 1, warmth: 1 };

export const REDACTION = '[redacted]';

const UNVERIFIED_NOTICE =
  'I started on that, but I could not confirm it actually went through — so I am not going to tell you it did.';

/**
 * Nothing was called, so nothing can have half-happened.
 *
 * `UNVERIFIED_NOTICE` above was answering this case too, and it is the more alarming
 * of the two sentences: it sends him to check on a change that was never begun. Stage
 * 7 refuses before dispatch for five reasons — no clearance, no `toolId`, no
 * authenticated identity, an authorization denial at the boundary, no executor — and
 * a sixth arrives from the executor itself as `NotAttemptedError`, which is how a
 * refusal inside the action pipeline (a revoked caller, a tool the caller may not
 * reach, an input its schema rejected) crosses a seam that can only reject.
 * `ActionResult.attempted` is what tells all six apart from a call that ran and threw.
 *
 * It does not name the reason. Three of the four are her own configuration or her own
 * authorization verdict, which are the inside of the machine; the fourth is that he is
 * not cleared, and stage 6 has already recorded that where an audit can read it. What
 * he needs from this sentence is that it did not happen and that saying it again will
 * not change that.
 */
const NOT_ATTEMPTED_NOTICE =
  'I did not do that — it is not something I can carry out right now, so nothing has changed on your side.';

/**
 * Which of the two notices above answers this turn.
 *
 * `NOT_ATTEMPTED_NOTICE` exactly when nothing was dispatched — every result was a
 * refusal. One tool that did go out is enough to make `UNVERIFIED_NOTICE` the honest
 * sentence, because something out there may be half-changed, so the quantifier is
 * `every` and not `some`.
 *
 * A function, shared by the disclosure policy and the deterministic draft, because it
 * was not — and that is how the lie survived the fix that was meant to end it.
 * `deterministicDraft` read `attempted`; `applyDisclosurePolicy` did not, and
 * hardcoded `UNVERIFIED_NOTICE`. The deterministic draft only runs when no drafting
 * faculty is wired, and in production one always is — so the branch that knew the
 * difference was the unreachable one, and every refusal was answered with "I started
 * on that" by the only path a caller ever reaches. Two copies of a rule is one copy
 * too many when only one of them is on the live path.
 *
 * `results.length > 0` because `every` over `[]` is vacuously true and an empty list
 * is not a refusal. Stage 7 returns one result per `execute_tool` decision, so this
 * guards a case nobody has seen rather than one that happens.
 */
function unconfirmedNotice(results: readonly ActionResult[]): string {
  return results.length > 0 && results.every((r) => !r.attempted)
    ? NOT_ATTEMPTED_NOTICE
    : UNVERIFIED_NOTICE;
}

const WITHHELD_NOTICE = 'There is something there I am not able to share with you.';

/**
 * Claim words the application refuses to let stand over an unverified action.
 *
 * English only, which is why there is a second pattern below it.
 */
const CLAIM_PATTERN =
  /\b(done|completed|complete|succeeded|success|successful|finished|all set|taken care of|i've|i have|already|turned (?:it )?(?:on|off)|sent|saved|scheduled|deleted)\b/i;

/**
 * The same claim, in the language she is actually spoken to in.
 *
 * She is answered in Hinglish as often as in English, in either script, and a gate
 * that only reads one of them is not a gate — "main laga diya" and "ho gaya" are the
 * plainest possible way to assert an outcome, and both sailed past `CLAIM_PATTERN`
 * untouched. The completion is carried by the light verb (`diya`/`di`, `gaya`/`gayi`)
 * rather than by the main verb, so these match on the pair.
 *
 * `\b` is not used around the Devanagari alternatives: JavaScript word boundaries are
 * defined on ASCII word characters, so `\b` next to a Devanagari letter matches in
 * places that have nothing to do with word edges. The phrases are distinctive enough
 * to stand without it.
 */
const CLAIM_PATTERN_HI = new RegExp(
  [
    // Latin-script Hinglish.
    '\\b(?:ho\\s*ga(?:ya|yi|ye)|hogaya|kar\\s*d(?:iya|iye|i)\\b|laga\\s*d(?:iya|i)\\b',
    '|bhej\\s*d(?:iya|i)\\b|daal\\s*d(?:iya|i)\\b|chalu\\s*kar\\s*d|band\\s*kar\\s*d|set\\s*kar\\s*d)',
    // Devanagari.
    '|हो\\s*गय[ाीे]|कर\\s*द(?:िया|ी)|लगा\\s*द(?:िया|ी)|भेज\\s*द(?:िया|ी)|डाल\\s*द(?:िया|ी)',
  ].join(''),
  'i',
);

/** Whether a draft asserts an outcome, in either language. */
function claimsAnOutcome(text: string): boolean {
  return CLAIM_PATTERN.test(text) || CLAIM_PATTERN_HI.test(text);
}

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
    : deterministicDraft(recalled, decision, results, verification, toneFor(recalled, opts));

  return applyDisclosurePolicy(draft, recalled, results, verification, opts.audit, opts.frame ?? null);
}

/**
 * The marker appended to `disclosuresApplied` when the line below was written
 * here rather than by the faculty that was supposed to write it.
 *
 * It reaches `message.metadata` and the persisted response, so "why does this turn
 * read tersely?" is answerable from the record months later without cross-checking
 * a stage trace.
 */
export const RESPOND_FALLBACK = 'respond_stage_fallback';

/**
 * Her answer when the drafting faculty threw.
 *
 * She used to say nothing at all. `respond` propagated the throw, the runtime
 * recorded the error and returned no response, `transcriptTurns` wrote no assistant
 * turn, and the caller displayed an empty reply — so the practical effect of one
 * failed HTTP call to Google was a person typing a sentence and watching her ignore
 * it. That was reasoned as honesty ("recording the fallback would be a claim the
 * traces contradict") but it is the wrong reading of the contract: her own seeded
 * self-knowledge says *the answer still arrives, and it arrives labelled*, and going
 * mute is neither.
 *
 * What honesty actually requires is that the three records agree, and they do:
 *
 *  - the stage trace still carries the faculty's error, so the cycle is `degraded`
 *    and not `completed` — this function is never reached without that;
 *  - the line is the deterministic draft, which states only what the application
 *    can stand behind, in her computed register rather than one canned sentence;
 *  - `disclosuresApplied` carries `RESPOND_FALLBACK`, so the turn says of itself
 *    that it came from here.
 *
 * The disclosure gate runs over it exactly as it runs over a faculty draft. That is
 * the whole point of the gate being a separate function: there is no path to the
 * caller, degraded or not, that skips it.
 */
export function fallbackResponse(
  recalled: RecalledContext,
  decision: AuthorizedDecision,
  results: ActionResult[],
  verification: VerificationReport | undefined,
  opts: RespondOptions = {},
): AuthorizedResponse {
  const draft = deterministicDraft(
    recalled,
    decision,
    results,
    verification,
    toneFor(recalled, opts),
    true,
  );
  const authorized = applyDisclosurePolicy(
    draft,
    recalled,
    results,
    verification,
    opts.audit,
    opts.frame ?? null,
  );
  return {
    ...authorized,
    disclosuresApplied: [...authorized.disclosuresApplied, RESPOND_FALLBACK],
  };
}

/**
 * Her register for this caller, or the plain one.
 *
 * The provider is called inside a try because it reaches into live personality
 * state: a throw there would otherwise turn "she could not work out her mood" into
 * "she had nothing to say", and losing the answer over the tone of it is the wrong
 * trade every time.
 */
function toneFor(recalled: RecalledContext, opts: RespondOptions): ResponseTone {
  try {
    return opts.tone?.(recalled.stimulus.identityId) ?? PLAIN_TONE;
  } catch {
    return PLAIN_TONE;
  }
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
  frame?: import('@server/conversation/frame.js').ResponseFrame | null,
): AuthorizedResponse {
  const caller = recalled.stimulus;
  const at = Date.now();
  const policies = new Set<string>(['knowledge_disclosure_policy']);
  const original = typeof draft?.text === 'string' ? draft.text : '';
  let text = original;
  let redacted = false;

  // ── 0. B08.s2 pre-TTS grounding: completion over ungrounded frame → in-progress acknowledgement.
  // Runs before other checks so "ho gaya" over an accepted-but-unverified job never reaches TTS.
  // Sync check using this file's own CLAIM_PATTERN/CLAIM_PATTERN_HI — the bridge's
  // groundingViolation is the single logical authority, this repeats the predicate for
  // the sync pre-TTS gate without making applyDisclosurePolicy async.
  {
    const _FRAME = frame as unknown as { verifiedOutcomeIds?: unknown[]; acceptedJobIds?: unknown[]; activeWork?: unknown[] } | null;
    if (_FRAME !== null && _FRAME !== undefined) {
      const hasVerified = Array.isArray(_FRAME.verifiedOutcomeIds) && _FRAME.verifiedOutcomeIds.length > 0;
      if (!hasVerified && claimsAnOutcome(text)) {
        const hasAccepted =
          (Array.isArray(_FRAME.acceptedJobIds) && _FRAME.acceptedJobIds.length > 0) ||
          (Array.isArray(_FRAME.activeWork) && _FRAME.activeWork.length > 0);
        text = hasAccepted
          ? 'I have got that and am working on it — I will let you know when it is actually done.'
          : 'I hear you — I have not completed that yet, and I will tell you when it is.';
        redacted = true;
        policies.add('grounding_frame');
        audit?.record({
          actorId: caller.identityId,
          action: 'disclosure:suppress_ungrounded_completion',
          resource: 'response',
          decision: 'generalized',
          reason: 'ResponseFrame has no verifiedOutcomeIds for completion claim',
          at,
        });
      }
    }
  }

  // ── 2. Unverified-claim suppression ──
  //
  // What this reaches, exactly: a turn in which at least one action ran and was not
  // confirmed. It cannot reach a turn that ran no action at all, and that is not an
  // oversight — a claim on a zero-action turn is as likely to be her recounting
  // something true from an earlier turn ("I sent that yesterday") as it is to be an
  // invention, and no pattern separates the two. That case is held on the model side
  // instead, by the line `buildRespondPrompt` adds when there are no results, where
  // the grammar a regex cannot read is available. The deterministic drafts below
  // cannot reach it at all: none of the zero-action lines claims an outcome.
  const unverified = results.filter((r) => !r.verified);
  const actionUnconfirmed =
    results.length > 0 && (unverified.length > 0 || verification?.postconditionsMet === false);

  if (actionUnconfirmed && claimsAnOutcome(text)) {
    // Which notice, not a fixed one. This line read `UNVERIFIED_NOTICE` regardless,
    // which meant a model draft claiming success over a call that was refused at the
    // gate was replaced with "I started on that, but I could not confirm it actually
    // went through" — sending him to check on something that never began.
    text = unconfirmedNotice(results);
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
 * One application-authored line, written out at every register it needs.
 *
 * Variants rather than assembly. The obvious alternative — a plain sentence plus a
 * warm prefix and a formal substitution — produces English no human wrote and would
 * eventually emit something like "Certainly. Hey, noted!!". Four hand-written
 * sentences per line cost nothing at runtime and can each be read aloud once to
 * check they sound like a person.
 */
interface Phrasing {
  /** verbosity 0. Also the whole line when she is being brief, whatever else is set. */
  terse: string;
  /** verbosity 1. */
  plain: string;
  /** verbosity 2. */
  full: string;
  /** formality 2, when brevity is not already deciding. */
  formal?: string;
  /** warmth 2, when brevity and formality are not already deciding. */
  warm?: string;
}

/**
 * Pick the wording for one register.
 *
 * The precedence is deliberate. Brevity wins outright: a terse register asked for
 * fewer words, and "warm but terse" resolves to a warm sentence that is no longer
 * short — the dimension the caller actually set gets overruled. Formality then
 * outranks warmth, because formality constrains the *form* of a sentence while
 * warmth only colours it, and a formal line delivered warmly reads as familiarity
 * she was not granted. Missing variants fall back to the verbosity choice, so a
 * `Phrasing` only spells out the registers where the wording genuinely differs.
 */
function say(phrasing: Phrasing, tone: ResponseTone): string {
  if (tone.verbosity === 0) return phrasing.terse;
  const byLength = tone.verbosity === 2 ? phrasing.full : phrasing.plain;
  if (tone.formality === 2) return phrasing.formal ?? byLength;
  if (tone.warmth === 2) return phrasing.warm ?? byLength;
  return byLength;
}

/**
 * ## Every variant of an action line must stay catchable by `CLAIM_PATTERN`
 *
 * The lines below that assert something happened — `didThem` and `ACTED` today — contain
 * a word `CLAIM_PATTERN` matches, in *every* variant. That is a requirement, not a
 * coincidence. Unverified-claim suppression runs over the finished draft by matching
 * claim words, so a terse variant phrased around them ("All set.") would state an
 * unconfirmed outcome unchallenged while its plain sibling ("Done — I ran it…") was
 * correctly replaced. A gate whose reach depends on how chatty she happens to be is
 * not a gate. When adding a variant to a line that asserts an outcome, keep a claim
 * word in it. `Done` is the word every variant of both lines carries, and it is the
 * reason an outcome clause from a tool may be interpolated freely: the claim word is in
 * the frame, not in the part that varies.
 *
 * There was a `SCHEDULED` line here, answering a `schedule_task` decision with "I
 * have put that on the list to take care of." It was catchable and it was still a
 * lie: nothing read the decision's `taskSpec`, so no list existed, and because
 * suppression needs at least one action result to fire it could not catch a stage
 * that produced none. Both the action and the line are gone — scheduling is
 * `execute_tool` with `reminder.schedule`, which reaches `didThem` only after its
 * postconditions verify.
 */
const CLARIFY: Phrasing = {
  terse: 'Could you tell me a little more?',
  plain: 'I want to be sure I have you right — could you tell me a little more?',
  full: 'I want to be sure I have you right before I act on it — could you tell me a little more about what you need?',
  formal: 'So that I have this right — could you tell me a little more about what you need?',
  warm: 'I do not want to get this wrong — tell me a little more?',
};

const LEARN: Phrasing = {
  terse: 'Noted.',
  plain: 'Noted — I will hold on to that.',
  full: 'Noted — I will hold on to that, and I will bring it up when it matters.',
  formal: 'Understood. I will keep a record of that.',
  warm: 'Noted — I will keep that with me.',
};

/**
 * The one line with a value in it, so the bank is built per call rather than fixed.
 *
 * `what` is an outcome — "the reminder for “paani peena hai” is set for tomorrow at 7:00
 * am" — never a tool id. It used to be the id, joined with commas: *"Done — I ran
 * reminder.schedule and checked it."* Two things were wrong with that. It named a
 * mechanism the caller has no model of, and it made the sentence *sound* like a report
 * while carrying nothing he could check: a reminder set for the wrong hour, or holding a
 * mis-transcribed message, reads exactly like a right one. `describeOutcome` reads the
 * tool's own output, so the words he hears are the state that was written.
 *
 * `andChecked` is the generic tail, used when no tool in the batch could describe itself.
 * It claims only what stage 8 established.
 */
function didThem(what: string): Phrasing {
  return {
    terse: `Done — ${what}.`,
    plain: `Done — ${what}, and I checked it.`,
    full: `Done — ${what}, and I checked the result, so you can rely on it.`,
    formal: `Done. ${sentence(what)}, confirmed.`,
    warm: `Done — ${what}, and I checked it, so that is off your plate.`,
  };
}

const ACTED: Phrasing = {
  terse: 'Done.',
  plain: 'Done — I did that and checked it.',
  full: 'Done — I did that and checked the result afterwards, so you can rely on it.',
  formal: 'Done. I carried that out and confirmed the result.',
  warm: 'Done — I did that and checked it, so that is off your plate.',
};

/** A clause as the start of its own sentence, for the formal variant. */
function sentence(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/**
 * Several outcomes as one English list.
 *
 * Two verified actions in a turn is normal — a reminder set and a preference saved from
 * the same sentence — and "a, b" for two clauses reads like a fragment where "a and b"
 * reads like a person.
 */
function listOf(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  const last = clauses[clauses.length - 1] ?? '';
  return `${clauses.slice(0, -1).join(', ')} and ${last}`;
}


/**
 * Deterministic application draft, used when no LLM faculty is wired. It states
 * only what the application can stand behind — in her register rather than in one
 * fixed voice, because a fallback that always says the same seven sentences is how
 * a system sounds when nobody is home.
 *
 * Register changes the *wording*, never the *claim*: every variant of a line below
 * asserts exactly what its siblings assert. A warmer `execute_tool` line is still
 * only reachable when `verification.postconditionsMet` is true, and no amount of
 * expansiveness adds a fact the application has not verified.
 */
function deterministicDraft(
  recalled: RecalledContext,
  decision: AuthorizedDecision,
  results: ActionResult[],
  verification: VerificationReport | undefined,
  tone: ResponseTone,
  /**
   * True only on the `fallbackResponse` path — a faculty was wired and threw.
   * Reaches exactly one branch: the words-arrived line, which is the only one
   * whose honest content differs between "nothing was wired" and "it broke".
   */
  facultyFailed = false,
): ResponseDraft {
  switch (decision.proposal.action) {
    case 'noop':
      // Silence is a legitimate outcome; the cycle still completes. It stays
      // silence even when the faculty failed — nobody was waiting on an answer,
      // so there is nothing to apologise for.
      return { text: '', voicePreferred: false };
    case 'clarify':
      // A request to rephrase, sent because *her* drafting faculty broke, asks him
      // to fix a problem that is not his and cannot be fixed from his side.
      return { text: say(facultyFailed ? UNANSWERED : CLARIFY, tone) };
    case 'learn':
      return { text: say(facultyFailed ? UNANSWERED : LEARN, tone) };
    case 'execute_tool': {
      const verified = results.filter((r) => r.verified);
      if (verified.length > 0 && verification?.postconditionsMet) {
        // Reported even when the drafting faculty failed, and deliberately: the
        // tool ran and the world was read back afterwards, which the application
        // established on its own. Withholding that to talk about her own outage
        // would be the less useful truth.
        //
        // A tool that cannot describe its own outcome is dropped from the list rather
        // than named: `ACTED` says only that it happened, which is what stage 8 proved.
        const said = verified
          .map((r) => describeOutcome(r, { callerId: recalled.stimulus.identityId }))
          .filter((clause): clause is string => clause !== undefined);
        return { text: say(said.length > 0 ? didThem(listOf(said)) : ACTED, tone) };
      }
      // Nothing was confirmed. Whether the honest sentence is "it did not happen" or
      // "I could not confirm it" turns on whether anything was dispatched, which is
      // `unconfirmedNotice`'s one job — and the disclosure policy above asks it the
      // same question about a model-authored draft.
      return { text: unconfirmedNotice(results) };
    }
    case 'respond':
    default:
      return respondDraft(recalled, tone, facultyFailed);
  }
}

/**
 * The three openers, for the three things a first line can be answering.
 *
 * None of them claims anything, so unlike the action lines above they carry no
 * claim word and need none. What they must not do is *promise* — an opener that
 * said "I have been listening" would assert a behaviour that depends on whether
 * the autonomic loop is running, which is not something stage 9 can see.
 */
const GREETED: Phrasing = {
  terse: 'Hello.',
  plain: 'Hello — I am here.',
  full: 'Hello — I am here. What would you like to do?',
  formal: 'Hello. How can I help?',
  warm: 'Hello — good to hear you. I am here.',
};

/** Nothing was said at all: an opening, not an answer. */
const OPENING: Phrasing = {
  terse: 'I am here.',
  plain: 'Hello — I am here whenever you want to start.',
  full: 'Hello — I am here whenever you want to start, and there is no hurry.',
  formal: 'Hello. I am ready whenever you are.',
  warm: 'I am here whenever you want to start.',
};

/** Words arrived that were not a greeting, and no faculty is wired to answer them. */
const HEARD: Phrasing = {
  terse: 'I hear you.',
  plain: 'Hello — I hear you.',
  full: 'Hello — I hear you. Tell me what you need.',
  formal: 'Hello. I am listening.',
  warm: 'I hear you.',
};

/**
 * Words arrived, a faculty *was* wired to answer them, and it failed.
 *
 * A different situation from `HEARD` and it has to read like one. With no key she
 * has nothing to answer with and "I hear you" is the whole truth. With a key that
 * threw — a dead model id, an expired quota, a network that went away mid-cycle —
 * she tried, and saying only "I hear you" would quietly present a failure as her
 * ordinary manner. These lines say the thing she can stand behind: heard, tried,
 * could not, ask again.
 *
 * No claim word, like the other openers, so nothing here can trip the
 * unverified-claim suppression it does not need.
 */
const UNANSWERED: Phrasing = {
  terse: 'I heard you — I could not get an answer together just now.',
  plain: 'I heard you, but I could not put an answer together just now. Ask me again in a moment.',
  full:
    'I heard you, but I could not put an answer together just now — something on my side did ' +
    'not come back. Ask me again in a moment and I will try it properly.',
  formal: 'I received that, but I was unable to compose a reply. Please try again shortly.',
  warm: 'I heard you — I just could not find the words this time. Try me again in a moment.',
};

/**
 * The `respond` draft with no faculty wired.
 *
 * The proactive case is the one that matters here, and it was wrong. Nothing was
 * said to her: the payload holds what a sensor noticed, phrased by
 * `server/autonomic/noticing.ts` as something addressed to him precisely so this
 * path can say it. Sending it through `greetingAware` instead answered a
 * permanently failed reminder with 'Hello — I hear you.' — a greeting standing
 * exactly where the observation belonged, which is the one thing an utterance
 * nobody asked for must not be. She spoke, but she did not say anything.
 *
 * The words still pass the disclosure gate below, so an error string that names a
 * table or a path is redacted before he reads it.
 *
 * `tone` reaches the greeting and stops there. The seed is returned byte for byte:
 * it is her own observation, already in plain words, and rewording it in a warmer
 * or terser register would put our sentence where hers was. A register is how she
 * says a thing; it is not licence to say a different thing.
 */
function respondDraft(
  recalled: RecalledContext,
  tone: ResponseTone,
  facultyFailed: boolean,
): ResponseDraft {
  if (recalled.stimulus.inputType === 'proactive_trigger') {
    const noticed = extractText(recalled.stimulus.payload).trim();
    // A sensor that produced no words is a reason to stay quiet, not to say hello
    // — she started this, so there is nobody waiting on an answer from her.
    if (noticed.length === 0) return { text: '', voicePreferred: false };
    return { text: noticed };
  }
  return { text: greetingAware(recalled, tone, facultyFailed) };
}

function greetingAware(
  recalled: RecalledContext,
  tone: ResponseTone,
  facultyFailed: boolean,
): string {
  const text = extractText(recalled.stimulus.payload).toLowerCase();
  // A greeting and an empty stimulus need no faculty, so losing one changes
  // nothing about what she can honestly say to either.
  if (/\b(hi|hello|hey|namaste)\b/.test(text)) return say(GREETED, tone);
  if (text.length === 0) return say(OPENING, tone);
  return say(facultyFailed ? UNANSWERED : HEARD, tone);
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
 * Whether one item in working context may be spoken to this caller.
 *
 * Exported so the language faculty can decline to put non-disclosable memories
 * into a prompt in the first place. That matters because redaction below matches
 * *literal strings*: a model that was shown an owner-only fact and paraphrased
 * it would walk straight past the filter. Not showing it is the stronger
 * guarantee, and `applyDisclosurePolicy` remains the authority over whatever is
 * drafted — this is the same predicate rather than a second copy of it, so the
 * prompt filter and the output gate cannot drift apart.
 */
export function mayDiscloseToCaller(
  item: ScopedMemoryItem,
  caller: {
    identityId: string;
    identityKind: string;
    callerPermissions: { mayReadMemories: boolean };
  },
): boolean {
  return disclosability(item, caller.identityId, caller.identityKind, caller).disclosable;
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
