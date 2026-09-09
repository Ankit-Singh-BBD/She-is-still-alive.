/**
 * The Scoped Learning Policy — Build Book Part XIII.4, in one place.
 *
 * | Information Subject | Application Policy Outcome |
 * |---|---|
 * | Small talk / idle context | Transient only, discarded after session. |
 * | Guest's own preferences | Saved as Guest-scoped `preference`. Completely isolated from Owner. |
 * | General behavioral patterns | May be saved as `learned_pattern` (e.g. "guests often ask X"). |
 * | Information about the Owner | Quarantine: Saved as `unverified_semantic` with Guest provenance. Owner confirmation required. |
 * | Sensitive/Private | Discarded unless explicitly authorized. |
 *
 * Regardless of identity:
 * - Transient emotional state is never learned as permanent memory.
 * - Unverified claims about third parties are discarded.
 * - Anything the owner later marks as wrong or soft-deletes is removed.
 *
 * ## Why this file is the only copy
 *
 * The table was implemented twice: here, for the out-of-band `LearningPipeline`, and as
 * `applyScopedLearningPolicy` inside cognition stage 10, for the in-cycle learner that
 * runs on every turn. Two implementations of one table is not redundancy — it is two
 * different policies wearing one name, and they disagreed in five measured places:
 *
 *  1. **Guest preference sensitivity.** Stage 10 said `person_shared`; this file said
 *     `public`. `public` is the single `Sensitivity` value that lets *any* caller past
 *     the identity-isolation rule in `MemoryRetrieval.isAllowedByPolicy`, so the copy
 *     whose header quotes "Completely isolated from Owner" was the copy that un-isolated
 *     it. `person_shared` wins.
 *  2. **What the quarantine is scoped as.** Split, and each half decided on its own axis:
 *     `subjectKind: 'owner'` (the claim *is* about him — stage 10's `'guest'` was wrong)
 *     with `sensitivity: 'owner_only'` (stage 10's `person_shared` let the guest read
 *     their own unconfirmed claim back out of her), and `validatedBy:
 *     'owner_confirmation'` (this file's writer hardcoded `'app_rule'` — a rule claiming
 *     it validated a row whose whole purpose is to be awaiting validation).
 *  3. **Guest `episodic` / `relationship` / `habit` / non-owner `semantic`.** This file
 *     discarded all four by name. The book's table forbids none of them, XIII.3 asks for
 *     relationships explicitly, and the wording it was implementing —
 *     `Domain X not allowed for non-owner` — appears nowhere in the book. Stage 10 wins.
 *  4. **Small talk.** Stage 10 detects it (below); this file had no detector and
 *     approximated one by discarding every guest `episodic`, which is why (3) looked
 *     defensible from inside it.
 *  5. **"Information about the Owner".** Stage 10 reads the sentence. This file compared
 *     `content['subject'] === 'owner'` — a literal string `extractor.ts` is deliberately
 *     written never to emit (it writes `subject: 'speaker'`, with a comment explaining
 *     that labelling a guest's self-report `'owner'` would file it in his memory). So the
 *     quarantine branch here could not fire, and every guest `semantic` fell through to
 *     the discard beneath it. That is the defect (3) and (4) were compensating for.
 *
 * Everything not in that list is behaviour-preserving for both callers: the owner and
 * person rows this file used to compute are reproduced by the defaults below.
 *
 * ## Order is part of the policy
 *
 * A discard has to dominate every scoping decision, because scoping a secret correctly
 * still keeps it. The credential test used to sit at step 5 of stage 10's copy, below
 * three branches that returned "allowed" — so a guest's own preference, or anything
 * phrased as a habit, carried a password into storage past a rule written to stop it.
 */

import { toRomanHinglish } from '@server/lang/index.js';
import type {
  MemoryDomain,
  Sensitivity,
  SourceKind,
  SubjectKind,
} from '@server/memory/types.js';
import type { IdentityKind } from '@server/identity/types.js';
import type { LearningCandidate, ScopedLearningDecision, GuestLearningPolicy } from './types.js';

/**
 * A candidate as the policy reads it: a domain, the words, and whatever scope the
 * extractor *proposed*.
 *
 * The three `declared*` fields are optional because the two callers arrive with
 * different amounts of information — a `RuleExtraction` from stage 10 carries a
 * sensitivity and subject kind, a `LearningCandidate` from the pipeline carries neither
 * — and because a proposal is all they ever are. Scope is the policy's to assign; see
 * the defaults in `scopeFor`.
 */
export interface ScopedLearningInput {
  domain: MemoryDomain;
  /** The domain payload. Read for its words only, never for its scope. */
  data: Record<string, unknown>;
  declaredSubjectKind?: SubjectKind | undefined;
  declaredSensitivity?: Sensitivity | undefined;
  declaredSourceKind?: SourceKind | undefined;
}

/** The caller, as the policy reads them. */
export interface ScopedLearningCaller {
  id: string;
  kind: IdentityKind;
}

/**
 * Decide what happens to one candidate.
 *
 * Returns a decision both writers can carry out without adding to it: an action, the
 * scope to write under, and the provenance claim that goes with it. Anything a writer
 * hardcodes instead of reading from here is a cell of the table that moved out of this
 * file, which is how there came to be two of them.
 */
export function decideScope(
  candidate: ScopedLearningInput,
  caller: ScopedLearningCaller,
  ownerName?: string | undefined,
): ScopedLearningDecision {
  const { domain, data } = candidate;

  // 1. A credential is not written down, whatever else the sentence also is.
  if (isSensitive(data)) return discarded('Sensitive content discarded');

  // 2. Small talk / idle context — transient only, discarded after the session.
  //    "Regardless of identity", so this is not scoped to guests.
  if (isSmallTalk(data)) return discarded('Small talk discarded');

  // 3. A non-owner's claim about the owner — quarantine.
  //
  //    Ahead of the guest-preference row deliberately: a guest saying "the owner likes
  //    X" is an unverified claim about him, not a statement of their own taste, and the
  //    row that reads `domain === 'preference'` cannot tell those apart.
  if (caller.kind !== 'owner' && isAboutOwner(data, ownerName, caller.id)) {
    return {
      action: 'quarantine',
      reason: `${caller.kind}-originated information about the owner requires owner confirmation`,
      // Under the speaker's own id — the book's "with Guest provenance" — while
      // `subjectKind` records who it is *about*. Those are two different questions and
      // the old copies each answered only one of them.
      identityId: caller.id,
      subjectKind: 'owner',
      // The load-bearing field. Nothing in the codebase reads `provenance.quarantined`
      // or `validatedBy`, so this value is the entire practical difference between "an
      // unverified claim" and "something she knows": `owner_only` is the one setting
      // under which `isAllowedByPolicy` refuses the guest their own row back.
      sensitivity: 'owner_only',
      sourceKind: 'conversation',
      // Kept out of ordinary recall until he confirms it, which is what the word means.
      // `listSemantic` excludes `archived` from the default view for the same reason it
      // excludes `consolidated`.
      lifecycleStatus: 'archived',
      validatedBy: 'owner_confirmation',
    };
  }

  // 4. A guest's own preferences — Guest-scoped, isolated from the owner.
  if (caller.kind === 'guest' && domain === 'preference') {
    return {
      action: 'persist',
      reason: "Guest's own preference, isolated under their identity",
      identityId: caller.id,
      subjectKind: 'guest',
      sensitivity: 'person_shared',
      sourceKind: 'conversation',
      lifecycleStatus: 'active',
      validatedBy: 'app_rule',
    };
  }

  // 5. A general behavioural pattern from any caller — "guests often ask X".
  if (domain === 'learned_pattern' || (domain === 'semantic' && isGeneralPattern(data))) {
    return {
      action: 'persist',
      reason: 'General behavioural pattern',
      ...scopeFor(candidate, caller),
      lifecycleStatus: 'active',
      validatedBy: 'auto_policy',
    };
  }

  // 6. Otherwise: the caller's own record, under the caller's own identity.
  return {
    action: 'persist',
    reason: `${domain} kept under the caller's own identity`,
    ...scopeFor(candidate, caller),
    lifecycleStatus: 'active',
    validatedBy: 'app_rule',
  };
}

/**
 * The scope a candidate is written under when no earlier row has claimed it.
 *
 * `identityId` is never the declared one. A candidate does not get to nominate whose
 * memory it joins — that is the isolation the whole table exists to enforce, and the
 * only honest answer is the caller who said it.
 *
 * The defaults are what this file used to compute for the owner and person rows, so
 * candidates that declare nothing (the pipeline's) land exactly where they did:
 * `relationship` is `owner_only` because a person's social graph is the most private
 * row in the schema, everything else is `person_shared`, and a `learned_pattern` is
 * `system`-sourced because the system inferred it rather than anyone stating it.
 */
function scopeFor(
  candidate: ScopedLearningInput,
  caller: ScopedLearningCaller,
): Pick<ScopedLearningDecision, 'identityId' | 'subjectKind' | 'sensitivity' | 'sourceKind'> {
  return {
    identityId: caller.id,
    subjectKind: candidate.declaredSubjectKind ?? caller.kind,
    sensitivity:
      candidate.declaredSensitivity ??
      (candidate.domain === 'relationship' ? 'owner_only' : 'person_shared'),
    sourceKind:
      candidate.declaredSourceKind ??
      (candidate.domain === 'learned_pattern' ? 'system' : 'conversation'),
  };
}

/**
 * A discard carries no scope, because there is nowhere it is being written.
 *
 * The fields are filled with the system's own values rather than left off so that a
 * writer which forgets to check `action` first writes something inert instead of
 * something scoped to a real person.
 *
 * Exported because the pipeline discards on thresholds before the policy is consulted,
 * and a second hand-built discard literal is how the two copies started.
 */
export function discarded(reason: string): ScopedLearningDecision {
  return {
    action: 'discard',
    reason,
    identityId: '',
    subjectKind: 'system',
    sensitivity: 'system_internal',
    sourceKind: 'system',
    lifecycleStatus: 'soft_deleted',
    validatedBy: 'auto_policy',
  };
}

/**
 * The `GuestLearningPolicy` seam, over the one table.
 *
 * `LearningPipeline` takes a policy as a constructor parameter so a test can substitute
 * one. That seam is worth keeping; a second *implementation* of the book behind it is
 * not, so this class is an adapter and holds no rules of its own.
 */
export class DefaultGuestLearningPolicy implements GuestLearningPolicy {
  evaluate(
    candidate: LearningCandidate,
    callerId: string,
    callerKind: IdentityKind,
    ownerName?: string,
  ): ScopedLearningDecision {
    return decideScope(
      {
        domain: candidate.domain,
        data: asData(candidate.content),
      },
      { id: callerId, kind: callerKind },
      ownerName,
    );
  }
}

/**
 * `LearningCandidate.content` is `unknown`, and a policy that reads `unknown` by casting
 * it is a policy that throws on the first candidate built by hand or returned by a model
 * having a bad day.
 */
function asData(content: unknown): Record<string, unknown> {
  return typeof content === 'object' && content !== null && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : {};
}

/**
 * Whether a candidate is nothing but a greeting.
 *
 * ## Why the boundaries matter more than the list
 *
 * This was `smallTalkPatterns.some(p => text.includes(p))`, and `'hi'` is one of the
 * patterns. `nahi` contains `hi`. So the moment the rule floor started reading
 * Hinglish, every stated dislike — `{ key: 'dhaniya', value: 'pasand nahi' }`, the
 * single most important kind of thing to get right about a person — was discarded
 * here as a greeting, silently, at the last step before it would have been stored.
 * So did every candidate holding `bhi`, `abhi`, `sahi`, `yahi`, `chahiye`, and a
 * relationship with a man called Rohit, because `rohit` contains `hi` too.
 *
 * Two more things this reads that the substring version did not:
 *
 *  - **Only the string values.** The text was `Object.values(data).join(' ')`, which
 *    includes `statedAt` — thirteen digits of Unix time, whose only effect was to
 *    push short content past the length test below and so to save it by accident.
 *  - **What is left after the greeting.** A length cap is the wrong proxy for "this
 *    is only small talk": "hey i just got promoted" is 23 characters and is not small
 *    talk. So the greeting is removed and what remains is what decides.
 */
export function isSmallTalk(data: Record<string, unknown>): boolean {
  const text = Object.values(data)
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  const stripped = text.replace(GREETINGS, ' ');
  if (stripped === text) return false;

  const remaining = stripped.trim().replace(/\s+/g, ' ');
  return remaining === '' || remaining.split(' ').length < 3;
}

/**
 * The greetings, in both languages, as whole words.
 *
 * Hinglish is here because the filter's whole purpose is to drop an opening, and
 * "namaste" and "kaisi ho" are the openings she will actually be given.
 */
const GREETINGS =
  /\b(?:hello|hi|hey|how\s+are\s+you|good\s+(?:morning|afternoon|evening|night)|nice\s+weather|thanks|thank\s+you|bye|goodbye|see\s+you|namaste|namaskar|kaise\s+ho|kaisi\s+ho|kya\s+haa?l|shukriya|dhanyavad|alvida|phir\s+milenge|shubh\s+ratri|suprabhat)\b/gi;

export function isAboutOwner(
  data: Record<string, unknown>,
  ownerName: string | undefined,
  callerId: string,
): boolean {
  // Stage 10's rules set this when the sentence names him as its subject — "the owner
  // likes X". An explicit signal from the code that parsed the sentence beats any
  // re-reading of it, so it is checked first and it is final.
  if (data['aboutOwner'] === true) return true;

  // A claim the candidate itself says is about the speaker is not a claim about the
  // owner, whatever names the sentence happens to contain.
  //
  // Without this, a guest called Ankit introducing himself to an owner called Ankit —
  // "mera naam Ankit hai" — was quarantined as an unverified claim about the owner,
  // because the only test was whether the owner's name appears anywhere in the text.
  // `extractor.ts` writes `subject: 'speaker'` for exactly this reason and says so in a
  // comment; stage 10's self-fact rule writes the caller's own id. Reading either is
  // strictly better evidence than a word match, and it costs the quarantine nothing:
  // "Ankit ko chai pasand hai" carries no self-subject and still quarantines.
  if (isAboutSpeaker(data['subject'], callerId) || isAboutSpeaker(data['target'], callerId)) {
    return false;
  }

  const text = saidValues(data);
  return OWNER_ROLE.test(text) || (ownerName !== undefined && named(ownerName).test(text));
}

const SELF_SUBJECTS = new Set(['speaker', 'self', 'me', 'i']);

function isAboutSpeaker(subject: unknown, callerId: string): boolean {
  if (typeof subject !== 'string') return false;
  return subject === callerId || SELF_SUBJECTS.has(subject.trim().toLowerCase());
}

/**
 * The role word, as a word.
 *
 * `text.includes('owner')` also fired on "landowner" and "the car owner called" — and
 * `includes('madhurita')` fired on every sentence a guest said *to* her, which is not a
 * claim about him at all. She is not the owner; that line asserted she was.
 */
const OWNER_ROLE = /\bowner\b/;

/**
 * A pattern matching a person by the name they are enrolled under.
 *
 * This replaces `text.includes('ankit')` — a literal name in the quarantine policy, which
 * meant the policy was correct for exactly one installation and, for every other, either
 * never quarantined a guest's claims or quarantined them for saying an unrelated word.
 *
 * Three things the literal did not do. The name is **escaped**, because a display name is
 * whatever he typed at enrollment and "Ankit (bhai)" is a syntax error in a regex, not a
 * name. It is matched **as a word**, so an owner called "Om" is not found inside "shalom".
 * And both the name and the text are **folded to Roman**, so "अंकित" in a Devanagari
 * sentence matches the same person as "Ankit".
 *
 * The first token is matched as well as the whole name: a guest says "Ankit ko chai
 * pasand hai", not "Ankit Kumar Singh ko chai pasand hai".
 */
function named(displayName: string): RegExp {
  const full = toRomanHinglish(displayName).toLowerCase().trim();
  const first = full.split(/\s+/)[0] ?? '';
  const forms = full === first || first.length < 3 ? [full] : [full, first];
  return new RegExp(`\\b(?:${forms.map(escapeRegExp).join('|')})\\b`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isGeneralPattern(data: Record<string, unknown>): boolean {
  return PATTERN_WORDS.test(saidValues(data));
}

const PATTERN_WORDS =
  /\b(?:often|usually|always|never|tends\s+to|pattern|habit|roz|hamesha|kabhi\s+nahi|aksar)\b/;

export function isSensitive(data: Record<string, unknown>): boolean {
  return SENSITIVE_WORDS.test(saidValues(data));
}

/**
 * What must not be written down, whatever else it also is.
 *
 * Whole words, for the reason the greeting list is whole words: `includes('pin')` matched
 * "spinach". And the Indian ones are here because they are the secrets he will actually
 * say out loud — an OTP read off a phone is the realistic way a credential reaches her.
 */
const SENSITIVE_WORDS =
  /\b(?:password|passcode|secret|ssn|credit\s+card|cvv|otp|pin|private|confidential|aadhaar|aadhar|paasvard)\b/;

/**
 * The string values of a candidate, folded to one vocabulary.
 *
 * Two defects this removes from four call sites that each built this by hand. The text
 * was `Object.values(data).join(' ')`, which includes `statedAt` and `occurredAt` —
 * thirteen digits of Unix time whose only effect was to lengthen the text and so change
 * the outcome of a length test by accident. And it was not folded, so a Devanagari
 * episodic `summary` — the one field kept verbatim on purpose — was invisible to every
 * policy above, which read Roman.
 */
function saidValues(data: Record<string, unknown>): string {
  return toRomanHinglish(
    Object.values(data)
      .filter((value): value is string => typeof value === 'string')
      .join(' '),
  ).toLowerCase();
}
