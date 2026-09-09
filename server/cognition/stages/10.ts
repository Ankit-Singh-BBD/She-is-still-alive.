/**
 * Stage 10: LEARN
 *
 * The LLM proposes candidate memories (preferences, habits, patterns, relationships,
 * semantic facts, episodic moments); the **Application applies the Scoped Learning
 * Policy** to decide what may be stored, with what scope, sensitivity, and provenance
 * (Build Book Part VII.1 stage 10, Part XIII).
 *
 * The policy enforces:
 *   1. **Multi-domain validation** - each candidate must match a known domain schema.
 *   2. **Scoped Guest Learning Policy** (Part XIII.4) - guest-originated info about
 *      the Owner is quarantined; guest's own preferences are isolated; small talk
 *      is transient.
 *   3. **Deduplication** - identical or near-identical memories are merged or skipped.
 *   4. **Provenance attachment** - every stored item carries a durable evidence chain.
 *   5. **Confidence threshold** - low-confidence extractions are dropped.
 *   6. **Importance scoring** - only items above threshold persist.
 *
 * P10 rollback contract: with no LLM faculty wired, the application extracts
 * deterministic preferences (e.g., explicit "I prefer X" statements) and applies
 * the same policy; all other domains are skipped.
 *
 * ## Authorization, and why it was missing
 *
 * The policy below decides *where* a candidate lands. It never decided *whether the
 * caller may write there*, and nothing downstream did either: stage 11 UPDATE takes the
 * delta this stage returns and writes it.
 *
 * `mayEnrollNewKnowledge` had exactly one enforcement site — `check()` reached from
 * stage 6, for a proposal whose `action` is `'learn'`. Follow that action and it changes
 * one thing: the sentence stage 9 falls back to (`stages/9.ts:581`). No write is
 * attached to it. Stage 10 runs on every cycle regardless of what stage 6 decided, so
 * the permission gated the phrasing of a reply while the memory it names was written
 * without being asked about. `mayMutatePreferences` had no enforcement site at all.
 *
 * Both are asked now, per candidate, after scoping — see `actionFor` and the `check()`
 * call in `learn`. This is also the only reason the values in `DEFAULT_PERMISSIONS`
 * mean anything; the note there records which of them had to change to stop
 * contradicting XIII.4 once they started being honoured.
 */

import { ulid } from '@server/persistence/ids.js';
import { toRomanHinglish } from '@server/lang/index.js';
import { check } from '@server/authz/index.js';
import { decideScope } from '@server/learning/policy.js';
import type { AuthzAction, AuthzCaller } from '@server/authz/types.js';
import type { Database } from '@server/persistence/db.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type {
  MemoryProvenance,
  MemoryDomain,
  Sensitivity,
  SubjectKind,
  SourceKind,
} from '@server/memory/types.js';
import { readStatedPreference } from '../intent/index.js';
import type {
  AuthorizedDecision,
  RecalledContext,
  AuthorizedResponse,
  VerificationReport,
  AuthorizedLearningDelta,
} from '../types.js';

export interface LearningFaculty {
  proposeExtractions(input: {
    recalled: RecalledContext;
    decision: AuthorizedDecision;
    response: AuthorizedResponse;
    actionResults: { toolId: string; success: boolean; verified: boolean }[];
    verification: VerificationReport | undefined;
  }): Promise<Array<{
    domain: MemoryDomain;
    data: Record<string, unknown>;
    confidence: number; // 0..1
    importance: number; // 0..1
    sensitivity: Sensitivity;
    subjectKind: SubjectKind;
  }>>;
}

export interface LearnOptions {
  llm?: LearningFaculty | undefined;
  memoryRepo?: MemoryRepository | undefined;
  db?: Database | undefined;
  /** Minimum confidence for any extraction to be accepted. Default 0.6 */
  minConfidence?: number;
  /** Minimum importance for any extraction to be accepted. Default 0.3 */
  minImportance?: number;
  cycleId?: string | undefined;
  /**
   * The name the owner is enrolled under, for the guest quarantine.
   *
   * A guest's claim *about him* is quarantined, and the only way a sentence says who it
   * is about is by naming him. Read fresh each cycle by the runtime, because he can
   * rename himself and a name captured at construction would then be someone else's.
   * Absent, the quarantine still catches the role word and the rules' own flag.
   */
  ownerName?: string | undefined;
}

/**
 * Deterministic extraction rules used when no LLM faculty is wired, or as a
 * baseline that the LLM proposals are scored against.
 */
interface RuleExtraction {
  domain: MemoryDomain;
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  subjectKind: SubjectKind;
  sourceKind: SourceKind;
}

/**
 * Stage 10 entry point.
 */
export async function learn(
  recalled: RecalledContext,
  decision: AuthorizedDecision,
  response: AuthorizedResponse,
  actionResults: { toolId: string; success: boolean; verified: boolean }[],
  verification: VerificationReport | undefined,
  opts: LearnOptions = {},
): Promise<AuthorizedLearningDelta> {
  const minConfidence = opts.minConfidence ?? 0.6;
  const minImportance = opts.minImportance ?? 0.3;
  const cycleId = opts.cycleId ?? ulid();
  const conversationId = recalled.stimulus.conversationId ?? 'unknown';
  const sourceMessageIds = extractMessageIds(recalled);

  // 1. Collect candidates from rule-based extraction (always runs)
  const ruleCandidates = extractByRules(recalled, decision, response, actionResults, verification);

  // 2. Collect candidates from LLM faculty (if wired)
  let llmCandidates: RuleExtraction[] = [];
  if (opts.llm) {
    const proposed = await opts.llm.proposeExtractions({ recalled, decision, response, actionResults, verification });
    llmCandidates = proposed.map(c => ({
      ...c,
      sourceKind: 'conversation' as SourceKind,
    }));
  }

  // 3. Merge, threshold, and deduplicate candidates
  //
  // Both thresholds are applied here, to both sources. They used to be applied inside
  // the branch above, to the model's proposals only — so `minConfidence` and
  // `minImportance`, documented as the minimum "for any extraction to be accepted",
  // governed half the extractions, and the rule pass (the *only* pass on the owner's
  // actual configuration, which has no model wired) was subject to neither. That made
  // `RuleExtraction.importance` a field every rule call site set and nothing read:
  // seven call sites choosing a number that changed nothing.
  //
  // Note this is the candidate's own score, not the stored column: `episodic` and
  // `relationship` carry an `importance` column of their own, written from
  // `candidate.data`, and no other domain table has one.
  const allCandidates = [...ruleCandidates, ...llmCandidates].filter(
    c => c.confidence >= minConfidence && c.importance >= minImportance,
  );
  const deduped = deduplicateCandidates(allCandidates, opts.memoryRepo, recalled.stimulus.identityId);

  // 4. Apply Scoped Learning Policy (Part XIII.4) and validate domains
  const authorized: AuthorizedLearningDelta['memories'] = [];
  const callerId = recalled.stimulus.identityId;
  const callerKind = recalled.stimulus.identityKind;

  /**
   * The caller as `authz` reads them — the three fields it looks at, taken from the
   * stimulus stage 2 resolved this cycle.
   *
   * Built here rather than accepted as an option, and that is the point. An
   * `identity?: Identity` on `LearnOptions` would make enforcement depend on wiring:
   * every test and every caller that forgot it would skip the check, which is how
   * `mayEnrollNewKnowledge` came to have one call site gating a *sentence* while the
   * writes it names went through ungated. `callerPermissions` is required on
   * `IdentifiedStimulus`, so there is never a cycle where the answer is unavailable and
   * never a way to turn the question off.
   */
  const caller: AuthzCaller = {
    id: callerId,
    kind: callerKind,
    permissions: recalled.stimulus.callerPermissions,
  };

  for (const candidate of deduped) {
    const scope = decideScope(
      {
        domain: candidate.domain,
        data: candidate.data,
        declaredSubjectKind: candidate.subjectKind,
        declaredSensitivity: candidate.sensitivity,
        declaredSourceKind: candidate.sourceKind,
      },
      { id: callerId, kind: callerKind },
      opts.ownerName,
    );
    if (scope.action === 'discard') continue;

    // Build Book V.4: the write passes through `check()`, against the scope the policy
    // just assigned rather than the one the candidate asked for. Order matters — the
    // policy decides *where* this lands, and only then can authorization ask whether
    // this caller may write there.
    const authz = check(caller, actionFor(candidate.domain), {
      type: 'memory',
      ownerId: scope.identityId,
      domain: candidate.domain,
    });
    if (!authz.allowed) continue;

    // Build full memory item with provenance
    const provenance: MemoryProvenance = {
      sourceCycleId: cycleId,
      sourceConversationId: conversationId,
      sourceMessageIds,
      extractedAt: Date.now(),
      extractor: candidate.sourceKind === 'conversation' && opts.llm ? 'llm' : 'rule',
      confidence: candidate.confidence,
      validatedBy: scope.validatedBy,
    };

    authorized.push({
      domain: candidate.domain,
      data: {
        ...candidate.data,
        identityId: scope.identityId,
        subjectKind: scope.subjectKind,
        sensitivity: scope.sensitivity,
        confidence: candidate.confidence,
        sourceKind: scope.sourceKind,
        provenance,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // The policy's, not a constant. This was hardcoded `'active'`, which meant a
        // quarantined claim about the owner — the one thing XIII.4 says must wait for his
        // confirmation — was written on the in-cycle path as an ordinary live memory.
        lifecycleStatus: scope.lifecycleStatus,
      },
      provenance,
      sensitivity: scope.sensitivity,
      subjectKind: scope.subjectKind,
    });
  }

  return { memories: authorized, extractedAt: Date.now() };
}

/**
 * Rule-based deterministic extraction (P10 rollback: no LLM faculty).
 *
 * `learn` calls this on every cycle, faculty or no faculty, so it is the floor under
 * her learning rather than a fallback for a degraded mode. Which is why it mattered
 * that every rule in it read English over an unfolded sentence: the person she is
 * built for says "mujhe dhaniya pasand nahi hai", and for him the floor was flat.
 * Not a missed nicety — the LLM half is optional and this half is not, so with no
 * faculty wired she learned nothing at all from him, in either script.
 *
 * The text is therefore folded to Roman here, exactly as the recogniser folds at
 * `propose`, and every pattern below reads the fold's spellings beside the
 * hand-typed ones. They differ, and the difference is measured rather than guessed:
 * `बहन` folds to `bahan`, `मम्मी` to `mammi`, `बीवी` to `bivi`, `काम` to `kam`,
 * `चाहिए` to `chahie`, `पहली बार` to `pahli bar`, `पढ़ता` to `parhta`, `फेवरेट` to
 * `phevret`. `माँ` folds to `man`, which is also the word for "mind" in "mera man
 * nahi hai" — so that one is deliberately *not* in the relation list below. A
 * relationship invented out of an idiom is worse than a relationship not noticed.
 *
 * ## Why the stance is read by `readStatedPreference` and not by a list here
 *
 * The list that used to be here declared `positive: true | false` on each pattern
 * and then destructured only `{ pattern, keyValue }`. The flag was never read. So
 * "i don't like coriander" captured "like coriander" and stored
 * `{ key: 'like_coriander', value: 'like coriander' }` — the negation dropped on the
 * floor and the dislike recorded as its own opposite, the same defect
 * `recognizer.ts` documents for `napasand`, at the other end of the same cycle.
 *
 * It also keyed on a slug of the *value*, while `preference.set` keys on the thing.
 * One `preference` table, unique on `(identity_id, key)`, with two conventions
 * writing into it: `DedupeEngine` matched neither, so a reversal never overwrote the
 * stance it reversed — it landed beside it as a second, contradicting row. Both ends
 * now read one function, so a stance means one thing whichever end notices it.
 */
function extractByRules(
  recalled: RecalledContext,
  _decision: AuthorizedDecision,
  _response: AuthorizedResponse,
  _actionResults: { toolId: string; success: boolean; verified: boolean }[],
  _verification: VerificationReport | undefined,
): RuleExtraction[] {
  const extractions: RuleExtraction[] = [];
  const said = extractText(recalled.stimulus.payload);
  const folded = toRomanHinglish(said).toLowerCase();
  const identityId = recalled.stimulus.identityId;

  // A correction is a mark *on* the sentence, not part of what the sentence says, so the
  // opening marker comes off before any rule reads it. Left on, it is read as content:
  // "nahi mujhe chai pasand nahi hai" — no comma, which is how it is usually typed —
  // keyed the stance on "nahi mujhe chai", because the key is whatever precedes the
  // stance word.
  //
  // The marker has to open a sentence. Unanchored, `\bno` matched the "no" in "i said no
  // yesterday" and stored "yesterday" as a correction, and `nahi` unanchored is worse —
  // it sits mid-sentence in every negated stance she can be told ("mujhe chai pasand
  // nahi hai"), which would have made a correction out of "hai". Only the marker that
  // opens the whole utterance is stripped; one that opens a later sentence still counts
  // as a correction but is left in place, because cutting to it would throw away the
  // clause before it, which may be the fact she is about to need.
  const corrects = CORRECTION_ANYWHERE.test(folded);
  const text = folded.replace(CORRECTION_OPENING, '');

  const preference = (data: Record<string, unknown>, confidence: number, importance: number): void => {
    extractions.push({
      domain: 'preference',
      data: { ...data, statedAt: Date.now() },
      confidence,
      importance,
      sensitivity: 'person_shared',
      subjectKind: 'person',
      sourceKind: 'conversation',
    });
  };

  // A stated liking, either direction, either script, keyed on the thing.
  const stance = readStatedPreference(text);
  if (stance && stance.key !== '') preference(stance, 0.8, 0.6);

  // Someone speaking about the owner rather than about themselves. Only the explicit
  // word `owner` is read: "unko chai pasand hai" is a third person, not necessarily
  // him, and `aboutOwner` is what sends a row into the guest quarantine — a wrong
  // subject there quarantines the wrong claim.
  const aboutOwner = /\b(?:the\s+)?owner\s+(?:prefers|likes|loves|enjoys)\s+([^,.;!?]+)/i.exec(text);
  if (aboutOwner?.[1]) preference({ key: phrase(aboutOwner[1]), value: 'likes', aboutOwner: true }, 0.8, 0.6);

  // An explicit thing-and-choice: "my favourite food is biryani", "mera phevret
  // khana biryani hai". The Hindi shape puts the copula last, so the choice is the
  // word before it and the thing is everything between the marker and the choice.
  const chosen =
    /\bmy\s+(?:favou?rite|preferred)\s+([^,.;!?]+?)\s+is\s+([^,.;!?]+)/i.exec(text) ??
    /\bme(?:ra|ri|re)\s+(?:favou?rite|phevret|pasandida)\s+([^,.;!?]+?)\s+([^\s,.;!?]+)\s+h(?:ai|ain)\b/i.exec(text);
  if (chosen?.[1] && chosen[2]) preference({ key: phrase(chosen[1]), value: phrase(chosen[2]) }, 0.85, 0.7);

  // A want is a need at a moment rather than a standing liking, so it is keyed on the
  // thing wanted and valued as the wanting.
  //
  // Both forms are read narrowly, because both are also how an instruction is phrased.
  // "i want you to remind me at 7" is a request, not a preference for the string "you
  // to remind me at 7". And `chahiye` is equally "should" — "mujhe jana chahiye" is "I
  // should go" — which is why the Hindi form alone refuses an infinitive ending. That
  // costs the real "mujhe khana chahiye" too, and it is the trade this file makes
  // everywhere else: a memory not taken can be said again, an invented one cannot be
  // unsaid. The English form needs no such rule, and must not borrow it — "i need a
  // new phone" ends in `-ne`.
  const wantedEnglish = /\bi\s+(?:want|need)\s+([^,.;!?]+)/i.exec(text);
  const wantedHindi = wantedEnglish ? null : /(?:mujhe|muje|mereko)\s+([^,.;!?]+?)\s+chahi?[ye]e?\b/i.exec(text);
  const thing = phrase((wantedEnglish ?? wantedHindi)?.[1] ?? '');
  const words = thing === '' ? [] : thing.split(' ');
  const instruction =
    words.length === 0 ||
    words.length > 5 ||
    /^(?:you|u|tum|aap|ki|that|to)$/i.test(words[0] ?? '') ||
    (wantedHindi !== null && /(?:na|ni|ne)$/i.test(words[words.length - 1] ?? ''));
  if (!instruction) preference({ key: thing, value: 'wants' }, 0.8, 0.6);

  // A person in his life — "my brother Rohit", "mera bhai rohit".
  //
  // The name is whatever word follows the relation, and most of what follows a
  // relation word is not a name. "my friend said that…" stored a friend called
  // "said"; "mera bhai dilli men rahta hai" names no one at all and would have stored
  // a brother called "dilli". Two guards, both narrow on purpose: a name is not one of
  // the words in `FILLERS`, and a name is not followed by a *locative* postposition —
  // "dilli **men**", "delhi **se**" is a place being located and the sentence simply
  // does not say who. The genitives are deliberately not in that list, because `ka`,
  // `ke`, `ki` and `ko` follow real names constantly: "meri behan anita ke saath".
  const NOT_A_NAME = String.raw`(\w+)\b(?!\s+(?:me|men|mein|se|par|pe|tak)\b)`;
  const relationship =
    new RegExp(
      String.raw`\bmy\s+(spouse|partner|husband|wife|child|son|daughter|parent|mother|father|friend|colleague)\s+${NOT_A_NAME}`,
      'i',
    ).exec(text) ??
    new RegExp(String.raw`\bme(?:ra|ri|re)\s+(${Object.keys(RELATIONS).join('|')})\s+${NOT_A_NAME}`, 'i').exec(text);
  const named = relationship?.[2] === undefined ? undefined : phrase(relationship[2]);
  if (relationship?.[1] && named !== undefined && named.length > 2 && !isFiller(named)) {
    extractions.push({
      domain: 'relationship',
      data: {
        ownerId: identityId,
        name: named,
        relation: RELATIONS[relationship[1].toLowerCase()] ?? relationship[1].trim(),
        notes: '',
        importance: 0.7,
      },
      confidence: 0.75,
      importance: 0.7,
      sensitivity: 'owner_only',
      subjectKind: 'person',
      sourceKind: 'conversation',
    });
  }

  // A fact he states about himself — "I work at X", "main dilli men rahta hun".
  //
  // The predicate is the verb he used. All four English verbs used to collapse into
  // `is`, so "i work at infosys" was stored as the fact that he *is* Infosys, and
  // a recall reading that back would say it.
  //
  // There is no bare `main <X> hun` here on purpose. It is the commonest sentence in
  // the language and almost never a durable fact — "main theek hun", "main ghar pe
  // hun", "main aa raha hun" — and `semantic` is the domain she reasons *from*. The
  // three shapes below each name their own predicate, so each one is a fact or it
  // does not match.
  const self =
    /\bi\s+(am|work\s+at|live\s+in|study)\s+([^,.;!?]+)/i.exec(text) ??
    /\bmain\s+([^,.;!?]+?)\s+me(?:in|n)?\s+(kaa?m\s+kart[ai])\s+hu[nm]?\b/i.exec(text) ??
    /\bmain\s+([^,.;!?]+?)\s+me(?:in|n)?\s+(r[ae]h?t[ai])\s+hu[nm]?\b/i.exec(text) ??
    /\bmain\s+([^,.;!?]+?)\s+(pa?[rd]h?t[ai])\s+hu[nm]?\b/i.exec(text);
  if (self) {
    // The English form says the verb first and the object second; the Hindi forms put
    // the object first, because that is the order the language uses.
    const english = /^i\b/i.test(self[0]);
    const verb = (english ? self[1] : self[2])?.toLowerCase() ?? '';
    const object = phrase((english ? self[2] : self[1]) ?? '', 2000);
    if (object !== '') {
      extractions.push({
        domain: 'semantic',
        data: { subject: identityId, predicate: predicateFor(verb), object, sourceCycle: undefined },
        confidence: 0.7,
        importance: 0.5,
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'conversation',
      });
    }
  }

  // Something that happened, marked as an event by the words around it. Each marker
  // needs the first person beside it for the same reason the English list has "today
  // i" and not "today": "kal 7 baje yaad dilana" is a reminder being set, not a
  // memory of a day. The summary keeps the sentence as it was said, unfolded.
  const episodicMarkers = [
    'first time', 'today i', 'just ', 'recently ', 'yesterday ',
    'pahli bar', 'pehli baar', 'aaj main', 'aj main', 'abhi abhi', 'abhi main', 'kal main',
  ];
  for (const marker of episodicMarkers) {
    if (text.includes(marker)) {
      extractions.push({
        domain: 'episodic',
        data: {
          summary: said.slice(0, 200),
          details: '',
          occurredAt: Date.now(),
          importance: 0.5,
        },
        confidence: 0.6,
        importance: 0.5,
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'conversation',
      });
      break; // Only one episodic per cycle from rules
    }
  }

  // And now what the correction was worth.
  //
  // Everything after the marker has already been read by the rules above, so when one of
  // them caught something a correction is not a memory of its own — it is a reason to be
  // surer of what was caught. `confidence` is the field that means that, it is the one
  // column every one of these tables has, and it reaches storage twice (the row and its
  // provenance). A `wasCorrection: true` flag beside it would be read by nothing, which
  // is how `positive: true|false` came to store a dislike as a liking in the pattern list
  // this rule pass replaced. `importance` would be no better: `preference` and
  // `semantic_memory` have no such column, so raising it there changes nothing at all.
  //
  // When nothing above matched, the sentence itself is kept, and kept as an episode: "he
  // told me I had this wrong" happened at a time, and `episodic` is append-only, so the
  // next correction sits beside this one instead of overwriting it. It used to be stored
  // as a `preference` under the literal key `correction` — one slot, unique per identity,
  // holding the latest correction he ever made and reciting it back to him as a taste.
  if (corrects) {
    if (extractions.length > 0) {
      for (const extraction of extractions) extraction.confidence = Math.min(1, extraction.confidence + 0.1);
    } else {
      const corrected = phrase(text, 2000);
      if (corrected.length > 1 && !isFiller(corrected)) {
        extractions.push({
          domain: 'episodic',
          data: { summary: said.slice(0, 200), details: '', occurredAt: Date.now(), importance: 0.7 },
          confidence: 0.9,
          importance: 0.7,
          sensitivity: 'person_shared',
          subjectKind: 'person',
          sourceKind: 'conversation',
        });
      }
    }
  }

  return extractions;
}

/**
 * The words that open a correction, and the interjection that may precede them.
 *
 * `arre` is not itself one of them. It is surprise, not disagreement — "arre main bhool
 * gaya" corrects nothing — but it does come in front of the real marker constantly, so
 * it is allowed there and nowhere else.
 *
 * `CORRECTION_ANYWHERE` requires a non-space after the marker so a bare "nahi." is not a
 * correction of anything; `CORRECTION_OPENING` is the same marker pinned to the start of
 * the utterance, and is the only one that is cut away.
 */
const CORRECTION_WORDS = String.raw`(?:no|actually|that'?s\s+wrong|you'?re\s+wrong|correction|nah(?:i|in)|galat)`;
const INTERJECTION = String.raw`(?:arre|are|abe|oh)?[,\s]*`;
const CORRECTION_ANYWHERE = new RegExp(
  String.raw`(?:^|[.!?]\s+)${INTERJECTION}${CORRECTION_WORDS}\b[,:]?\s+\S`,
  'i',
);
const CORRECTION_OPENING = new RegExp(String.raw`^${INTERJECTION}${CORRECTION_WORDS}\b[,:]?\s+`, 'i');

/**
 * A phrase as it will be stored: no wrapping space, no double space, capped.
 *
 * The cap is the `preference.set` schema's own limit for a key, so a key this file
 * writes and a key the tool writes can be the same key.
 */
function phrase(text: string, max = 120): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : clean.slice(0, max).trim();
}

/** The relations she can be told about, in both spellings, mapped to one name each. */
const RELATIONS: Record<string, string> = {
  bhai: 'brother', bhaiya: 'brother',
  behan: 'sister', bahan: 'sister', didi: 'sister',
  papa: 'father', pita: 'father', pitaji: 'father',
  mummy: 'mother', mammi: 'mother', maa: 'mother', mata: 'mother',
  patni: 'wife', biwi: 'wife', bivi: 'wife',
  pati: 'husband',
  beta: 'son', beti: 'daughter',
  dost: 'friend', saheli: 'friend',
  bhabhi: 'sister-in-law', jija: 'brother-in-law',
};

/**
 * Words that are not a name and not a correction, however well they fit the slot.
 *
 * Every one of these has been the whole content of a memory: a friend called "said",
 * a correction reading "yaar". A rule that captures the next word will capture
 * whatever is there, so the guard belongs beside the rule. It is a list, so it is not
 * complete — which is why the rules it guards are written to fail closed rather than
 * to lean on it.
 */
const FILLERS = new Set([
  'hai', 'hain', 'tha', 'thi', 'the', 'ne', 'ko', 'se', 'ka', 'ki', 'ke', 'me', 'men', 'mein',
  'bhi', 'aur', 'or', 'to', 'toh', 'na', 'nahi', 'nahin', 'bahut', 'kuch', 'wo', 'woh', 'ye', 'yeh',
  'yaar', 'bhai', 'arre', 'ok', 'okay', 'thik', 'theek', 'acha', 'achha',
  'aaj', 'aj', 'kal', 'abhi', 'phir', 'hamesha', 'roz', 'kabhi',
  'rahta', 'rehta', 'rahti', 'rehti', 'karta', 'karti', 'kaam', 'kam', 'padhta', 'parhta',
  'bola', 'boli', 'kehta', 'kehti', 'kaha', 'aaya', 'aayi', 'gaya', 'gayi',
  'is', 'was', 'said', 'says', 'told', 'lives', 'works', 'studies', 'went', 'came',
  'and', 'the', 'a', 'an', 'very', 'that', 'this', 'it',
]);

function isFiller(text: string): boolean {
  return text
    .toLowerCase()
    .split(' ')
    .every((word) => FILLERS.has(word));
}

/** The verb he used, as the predicate a recall will read back. */
function predicateFor(verb: string): string {
  if (/^(?:work|kaa?m)/i.test(verb)) return 'works at';
  if (/^(?:live|r[ae]h)/i.test(verb)) return 'lives in';
  if (/^(?:study|pa?[rd]h)/i.test(verb)) return 'studies';
  return 'is';
}

/**
 * Deduplicate candidates against each other and against existing memory.
 */
function deduplicateCandidates(
  candidates: RuleExtraction[],
  memoryRepo: MemoryRepository | undefined,
  _identityId: string,
): RuleExtraction[] {
  // First, deduplicate within the candidate set (by domain + key content)
  const seen = new Set<string>();
  const unique: RuleExtraction[] = [];

  for (const c of candidates) {
    const key = dedupKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  // Second, if memory repo available, filter against existing memory
  if (memoryRepo) {
    // This is a simplified check - in production would query by domain and similarity
    // For now we trust the within-candidate deduplication
    return unique;
  }

  return unique;
}

function dedupKey(c: RuleExtraction): string {
  switch (c.domain) {
    case 'preference':
      return `pref:${c.data['key']}:${c.data['value']}`.toLowerCase();
    case 'relationship':
      return `rel:${c.data['relation']}:${c.data['name']}`.toLowerCase();
    case 'semantic':
      return `sem:${c.data['subject']}:${c.data['predicate']}:${c.data['object']}`.toLowerCase();
    case 'episodic':
      return `epi:${String(c.data['summary'] ?? '').slice(0, 50)}`.toLowerCase();
    default:
      return `${c.domain}:${JSON.stringify(c.data)}`.toLowerCase();
  }
}

/**
 * Which authority a candidate needs, by domain.
 *
 * Two permissions, because `PermissionSet` declares two and the owner can set them
 * independently: `mayMutatePreferences` is the narrower one, and a preference is the one
 * kind of memory that *overwrites* — `preference.set` replaces the value for a key
 * rather than appending a second row — so "may change what she believes I want" is a
 * different grant from "may add to what she knows".
 *
 * Everything else is enrolment. Written as a switch over the closed `MemoryDomain` so a
 * new domain is a compile error here rather than a silent default into the weaker of the
 * two.
 */
function actionFor(domain: MemoryDomain): AuthzAction {
  switch (domain) {
    case 'preference':
      return 'preference:mutate';
    case 'episodic':
    case 'semantic':
    case 'habit':
    case 'relationship':
    case 'learned_pattern':
      return 'knowledge:enroll';
    default: {
      const unhandled: never = domain;
      return unhandled;
    }
  }
}

/**
 * The Scoped Learning Policy lives in `@server/learning/policy.ts`.
 *
 * It used to live here too — `applyScopedLearningPolicy`, with its own copy of the
 * detection helpers — and the two copies disagreed about five cells of Build Book
 * XIII.4's table. `decideScope` is the one implementation both learners read; the file
 * header there records each disagreement and which copy won.
 */

function extractMessageIds(_recalled: RecalledContext): string[] {
  // In a real implementation, this would extract message IDs from the conversation
  // For now, return empty - the provenance will be linked at cycle level
  return [];
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const t = (payload as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}