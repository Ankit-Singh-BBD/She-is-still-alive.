/**
 * Reading an intent out of a sentence, deterministically.
 *
 * ## What was wrong
 *
 * Seven tools are registered at boot — `memory.remember_event`, `memory.remember_fact`,
 * `preference.set`, `memory.recall`, `reminder.schedule`, `reminder.cancel`,
 * `reminder.list` — and with no language faculty wired *not one of them could ever
 * be chosen*. Stage 6's fallback proposed an action from the reasoning trace's
 * shape and nothing more, so "kal 7 baje yaad dilana ki paani peena hai" was
 * answered "I hear you." while the tool that would have done it sat idle. The
 * honest comment stage 6 carried — "choosing a tool and its arguments needs the
 * language faculty, and none is wired" — was true of the code and not true of the
 * problem. A time and an imperative verb are exactly the two things a rule *can*
 * read.
 *
 * This module is the deterministic floor under stage 6, the same relationship
 * `deterministicDraft` has to `llm.draftResponse` in stage 9: when a model is
 * there, the model proposes; when it is not, this does, and the application's
 * validation and authorization gate runs over the result either way. It proposes.
 * It never decides.
 *
 * ## The two rules it is built on
 *
 * **Only ever name a tool that is installed.** `availableTools` is the registry's
 * own id set. A recogniser that named `reminder.schedule` in a process where
 * reminders were not installed would produce a proposal the executor must fail —
 * a decision that reads as capability on the cycle record and is not one.
 *
 * **When the shape is clear and an argument is missing, ask.** "Yaad dilana"
 * with no time is a recognised request that cannot be carried out, and the
 * proposal for it is `clarify` naming what was missing — not a guessed 09:00, and
 * not the bare `respond` that used to swallow it. This is the same distinction
 * `parseWhen`'s `dayOnly` exists for.
 *
 * ## Why `memory.remember_fact` is not proposed here
 *
 * It takes a subject, a predicate and an object. Splitting a Hinglish clause into
 * that triple without a model means guessing at grammar, and a wrong triple is a
 * fact she will later state back as hers. `memory.remember_event` takes one
 * `summary` string, so what was literally said can be kept without inventing a
 * structure for it — which is the same choice `RuleBasedLearningExtractor` makes,
 * for the same reason. When a faculty is wired it proposes the triple, and this
 * file is not in the cycle at all.
 *
 * ## One script, folded at the door
 *
 * Every pattern below is Roman, and `propose` folds the sentence with
 * `toRomanHinglish` before reading it. That is one line in place of a second
 * vocabulary, and the second vocabulary is not a hypothetical — it was here, six
 * Devanagari alternatives and a Devanagari stripper, and it did active harm:
 *
 *  - The Devanagari stripper `याद\s(?:दिला|रख)` followed by `\w` could not take its
 *    own inflection with it, because `\w` is ASCII. So "याद दिलाना कि पानी पीना है"
 *    was stripped to **"ना** कि पानी पीना है" and `ना` is the negation — the reminder
 *    stored as the opposite of the request. The Roman patterns carry a docstring
 *    about exactly that bug, fixed there and still live here. "याद रखो कि मैं सुबह 6
 *    बजे उठता हूं" was kept as a memory beginning "ो कि".
 *  - `पसंद` matched and then `readStatedPreference` could not read the clause, so the
 *    branch fell through every time. It changed no outcome it was ever reached for.
 *  - `\bक्या\b` could never match at all: `\b` is defined by `\w`, so a boundary
 *    exists nowhere around a Devanagari word.
 *
 * Folding is not the same as rewriting what he typed. The message row keeps his own
 * sentence, exactly as the ear keeps the provider's Devanagari and folds on the way
 * out (`server/voice/live/session.ts`). What gets folded is what a *rule reads* —
 * and one folded sentence reaching patterns that were built and tested against real
 * Hinglish beats two vocabularies where the second one is half-built by definition.
 */

import { toRomanHinglish } from '@server/lang/index.js';

import type { DecisionProposal, IdentifiedStimulus } from '../types.js';

import { parseWhen, timeExpressions } from './time.js';

/** The text of a stimulus, in the two shapes the runtime actually delivers. */
export function stimulusText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload !== null && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * What stage 6 asks of this module.
 *
 * Shaped as a `DecisionProposal` so nothing translates between the two: the
 * recogniser stands exactly where `LlmFaculty.proposeDecision` stands, and
 * `validateProposal` and the authorization gate run over its output unchanged.
 * `undefined` means "these words named nothing I can act on", which is not a
 * failure — it is the ordinary case for most of what is said to her, and stage 6
 * falls through to the reasoning trace for it.
 */
export interface IntentRecognizer {
  propose(stimulus: IdentifiedStimulus, now?: number): DecisionProposal | undefined;
}

/**
 * ## The spellings the fold produces
 *
 * Because `propose` folds, the vocabulary below has to accept what
 * `toRomanHinglish` writes, not only what a person typing Roman writes. They differ:
 * `याद` folds to `yad`, `रिमाइंडर` to `rimaindar`, `नोट` to `not`, `अच्छा` to
 * `achchha`, `नापसंद` to `napsand`, `तुम्हें` to `tumhen`, `आपको` to `apko`. Each
 * one is a rule she can otherwise no longer be told in *at all* — including out
 * loud, since the ear folds too — so both spellings stand in each pattern.
 */

/** `yaad dila` / remind — a request for a future prompt. */
const REMIND =
  /\byaad\s*dila|\byad\s*dila|\bremind\b|\b(?:reminder|rimaind[ae]r)\s*(?:laga|lga|set|banao|bana)|\balarm\s*laga/i;

/** `yaad rakh` / remember — a request to hold on to something. */
const REMEMBER =
  /\byaad\s*rakh|\byad\s*rakh|\bremember\b|\bnote?\s*(?:kar|kr|karlo|karo)\b|\bnote\s*(?:it|this|that)\b|\bdhyan\s*rakh/i;

/** A question about what she holds, rather than an instruction to hold something. */
const RECALL =
  /\byaa?d\s*h(?:ai|ain|a|\b)|\bkya\s*(?:yaa?d|pata|jaa?nt[ieo])\b|\bwhat\s+do\s+you\s+(?:know|remember)\b|\bkya\s*pata\b|\bbatao\b/i;

/**
 * A stated liking, in either direction.
 *
 * `ac[ch]*ha` rather than a list of spellings: `acha`, `achha`, `accha` and the
 * fold's own `achchha` are one word, and `lagta` after it is what makes it a
 * stance rather than a stray syllable.
 */
const PREFERS = /\bpasand\s*(?:hai|h|hain)\b|\bac[ch]*ha\s*lagta\b|\bi\s+(?:prefer|like|love|enjoy)\b|\bfav(?:ou)?rite\b|\bpasandida\b/i;
/**
 * The English negation is only a stance when it says what it is a stance *about*.
 * `\bi\s+(?:don'?t|do\s+not)\b` on its own made "I don't know" and "I don't have
 * time" statements of preference, and with a fallback below that keeps whatever it
 * cannot key, that would have written a memory for every one of them.
 */
const PREFERS_NOT =
  /\bpasand\s*nah(?:i|in|ee)\b|\bnapa?sand\b|\bac[ch]*ha\s*nah(?:i|in|ee)\s*lagta\b|\bi\s+(?:don'?t|do\s+not)\s+(?:like|prefer|enjoy)\b|\bi\s+(?:dislike|hate)\b/i;

/**
 * A question about the reminders themselves.
 *
 * Two things had to be right here, and the first version had neither.
 *
 * **The question word must be a question word.** It used to accept `hai`, `hain`
 * and `lage` within forty characters of the word `reminder`, and those are copulas
 * — they end most Hindi sentences. So "kal 7 baje ka reminder laga do ki bijli ka
 * bill bharna hai" read as a *listing* request: she answered a scheduling
 * instruction by listing what was already there, and the bill went unpaid.
 *
 * **The question word can come first.** "kaunse reminders lage hain" puts it before
 * the noun and "reminders kaunse hain" after, so both orders are matched rather
 * than only the one that happened to be written down first.
 */
const REMINDER_NOUN = String.raw`(?:reminders?|rimaind[ae]rs?|yaa?d\s*dilane\s*wali|alarms?)`;
const ASKS_WHICH = String.raw`(?:kaunse|konse|kitne|dikhao?|batao|list|pending|kya)`;
const LIST_REMINDERS = new RegExp(
  [
    String.raw`\b${ASKS_WHICH}\b[^?]{0,24}?\b${REMINDER_NOUN}\b`,
    String.raw`\b${REMINDER_NOUN}\b[^?]{0,24}?\b${ASKS_WHICH}\b`,
    String.raw`\bwhat\s+reminders?\b`,
    String.raw`\bmy\s+reminders?\b`,
    String.raw`\blist\s+(?:my\s+)?reminders?\b`,
  ].join('|'),
  'i',
);

/** Second-person or interrogative framing, which is what makes a recall a question. */
const ASKED = /\?|\bkya\b|\bwhat\b|\btumhen?\b|\btumko\b|\baa?pko\b|\btujhe\b|\bbatao\b/i;

/**
 * A light verb, absorbed only where it trails one of the requests below.
 *
 * "yaad dila do", "reminder laga do", "note kar lena" — the second word carries no
 * content, it just finishes the imperative. It is matched *in place* rather than
 * removed everywhere, because `do` is also the number two: a global strip would
 * turn "do ghante baad dawai leni hai" into "ghante baad dawai leni hai".
 */
const LIGHT_VERB = String.raw`(?:\s+(?:do|de|dena|dijiye|dijie|lena|lo|le|me|mujhe)\b)?`;

/**
 * The request verbs, taking their whole inflected form with them.
 *
 * `REMIND` and `REMEMBER` above stop at the stem on purpose — `yaad dila`, `yaad
 * dilana` and `yaad dilado` are one request and the stem is what they share, so a
 * detector that stopped anywhere else would miss two of the three. A *stripper*
 * cannot stop there. Subtracting `yaad dila` from "yaad dilana ki paani peena hai"
 * leaves "na ki paani peena hai", and `na` is the Hindi negation: the reminder
 * would have been stored, and read back, as the opposite of what was asked for.
 * The same subtraction turned "yaad rakho ki main subah 6 baje uthta hoon" into a
 * memory beginning "o main…".
 *
 * So these take the inflection with the stem, and the light verb after it with
 * both.
 *
 * Order inside the list is load-bearing: the multi-word forms come first, because
 * `remind\w*` on its own happily matches the "reminder" in "reminder laga do" and
 * leaves "laga do" standing at the front of the message.
 */
const REQUEST_VERBS: RegExp[] = [
  new RegExp(String.raw`\b(?:reminder|rimaind[ae]r)\s*(?:laga\w*|lga\w*|set|banao|bana\w*)${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\balarm\s*laga\w*${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\bnote?\s*(?:kar\w*|kr|it|this|that)\b${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\bdhyan\s*rakh\w*${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\byaa?d\s*dila\w*${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\byaa?d\s*rakh\w*${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\bremind\w*${LIGHT_VERB}`, 'gi'),
  new RegExp(String.raw`\bremember\w*${LIGHT_VERB}`, 'gi'),
];

/** The pronouns and politeness that wrap a request without being part of it. */
const PRONOUNS = /\b(?:mujhe|mereko|mujhko|muje|mere\s*ko|please|plz|pls|zara|thoda)\b/gi;

/**
 * Words that carry the request rather than the content, removed to leave the
 * content behind.
 *
 * This is subtraction, not parsing: what is left is the caller's own words with
 * the instruction taken off the front, which is why a reminder's message reads
 * like something a person wrote. Nothing is added and nothing is reordered.
 */
const INSTRUCTION: RegExp[] = [...REQUEST_VERBS, PRONOUNS, /\b(?:ki|that|to)\b/gi];

/**
 * The time expressions, removed *only* when the time is going somewhere else.
 *
 * This is the distinction the two callers turn on. For a reminder the hour has
 * already been read into `dueAt`, so leaving "kal subah 7 baje" in the message
 * would have her say it back at the moment it is no longer true. For something
 * she is asked to *remember* the hour is the whole content — "main subah 6 baje
 * uthta hoon" without it says only that he gets up — so nothing here is applied.
 * Stripping both at once was the first version of this file and it stored the fact
 * with the fact taken out.
 *
 * The list is `parseWhen`'s own vocabulary rather than a second copy of it; see
 * `timeExpressions`.
 */
const TIME_WORDS: RegExp[] = [
  ...timeExpressions(),
  // Not a time itself: the postposition left standing where one was. "7 baje ko"
  // loses its clock above and would otherwise keep the "ko".
  /\b(?:pe|par|ko|tak|baje|bajey)\b/gi,
];

/**
 * Particles that only ever glued the instruction to the content.
 *
 * Trimmed from the edges, and only after the subtraction above: in the middle of a
 * sentence `ka` and `at` are doing real work, and at an edge they are the seam
 * where the request used to be. Without this, "kal 7 baje ka reminder laga do ki
 * paani peena hai" keeps its "ka" and "remind me to buy milk at 7 pm" ends on a
 * dangling "at".
 *
 * The Hindi negation `na` is deliberately *not* in this list. It used to appear at
 * the front for a reason that no longer exists — the request verbs above now take
 * their own inflection — so anything starting with `na` now is a negation the
 * caller actually wrote, and removing it would invert the sentence.
 */
const EDGE_GLUE =
  /^(?:(?:ka|ke|ki|ko|to|at|on|for|about|aur|and|that)\b[\s,]*)+|(?:[\s,]*\b(?:at|on|by|for|ko|pe|par|tak|ka|ke|ki|aur|and)\b)+$/gi;


/**
 * Whatever the sentence is about, once the instruction has been taken off it.
 *
 * `dropTime` is passed by the reminder path and by nothing else.
 */
function contentOf(text: string, dropTime = false): string {
  let left = text;
  for (const pattern of INSTRUCTION) left = left.replace(pattern, ' ');
  if (dropTime) for (const pattern of TIME_WORDS) left = left.replace(pattern, ' ');
  return left
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_GLUE, ' ')
    .replace(/^[\s,.;:!?—-]+|[\s,.;:!?—-]+$/g, '')
    .trim();
}

/** Trims to a schema's ceiling on a word boundary where one is near. */
function capped(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max - 24 ? cut.slice(0, space) : cut).trim();
}

/**
 * A phrase that is already the content, with only its wrapping removed.
 *
 * `contentOf` is the wrong tool for a preference key: it also strips `ki`, which is
 * the instruction's seam in "yaad dilana **ki** paani peena hai" and an ordinary
 * genitive in "subah **ki** chai". A key is one noun phrase, so only the pronouns
 * and the edge particles come off.
 */
function phraseOf(text: string): string {
  return text
    .replace(PRONOUNS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(EDGE_GLUE, ' ')
    .trim();
}

/**
 * A stated liking, as the key and value `preference.set` stores.
 *
 * The key is the *thing* and the value is the stance, which is what makes the
 * tool's overwrite semantics correct rather than lossy: "mujhe chai pasand hai"
 * and a later "mujhe chai pasand nahi" are two stances on one key, and the second
 * is meant to replace the first. Keying on the stance instead — `likes` → `chai`
 * — would have made every new liking erase the last one.
 *
 * Only the forms that put the thing before the stance are read — `X pasand hai`,
 * `X pasand nahi`, `X napasand`, `X achha lagta`, `i like X`. `mera favourite khana
 * biryani hai` puts it after and needs a grammar to split, so it falls through to
 * `memory.remember_event`, which keeps the sentence as it was said. Losing the
 * structure is a smaller cost than inventing the wrong one.
 *
 * ## Why the key may not cross a comma
 *
 * The pronoun in front is optional, and an optional prefix on an unanchored pattern
 * means the capture can start anywhere — so "nahi, mujhe chai pasand nahi hai" was
 * read as a stance on the key "nahi, chai". `[^,.;!?]` confines the key to the
 * clause the stance was actually made in, which is where a noun phrase lives.
 *
 * ## Why `pasand` needs a word boundary in front of it
 *
 * `napasand` *contains* `pasand`. Without the `\b`, "mujhe chai napasand hai" was
 * read by the liking branch — the sentence has `pasand` followed by `hai` — and
 * stored as **a liking of "chai na"**: his dislike recorded as its own opposite,
 * under a key with the negation's first syllable stuck to it. The boundary makes
 * that impossible and the branch above it reads the word he actually said.
 *
 * ## Exported, because there must not be a second one
 *
 * `server/cognition/stages/10.ts` learns preferences out of the same sentences from
 * the other end of the cycle, and it had its own list: five English patterns whose
 * `positive: true|false` flag was never read, so "i don't like coriander" was stored
 * as a liking. Two vocabularies for one stance is how that happens, and how a fix
 * here would leave the other half wrong. Stage 10 calls this instead.
 *
 * The input must already be folded to Roman — both callers fold at their own door.
 */
export function readStatedPreference(text: string): { key: string; value: string } | undefined {
  const napasand = /(?:mujhe|mereko|muje|mujhko)?\s*([^,.;!?]+?)\s*\bnapa?sand\b/i.exec(text);
  if (napasand?.[1]) return { key: capped(phraseOf(napasand[1]), 120), value: 'pasand nahi' };

  const negatedHindi = /(?:mujhe|mereko|muje|mujhko)?\s*([^,.;!?]+?)\s*\bpasand\s*nah(?:i|in|ee)/i.exec(text);
  if (negatedHindi?.[1]) return { key: capped(phraseOf(negatedHindi[1]), 120), value: 'pasand nahi' };

  const dislikedHindi = /(?:mujhe|mereko|muje|mujhko)?\s*([^,.;!?]+?)\s*\bac[ch]*ha\s*nah(?:i|in|ee)\s*lagta/i.exec(text);
  if (dislikedHindi?.[1]) return { key: capped(phraseOf(dislikedHindi[1]), 120), value: 'pasand nahi' };

  const likedHindi = /(?:mujhe|mereko|muje|mujhko)?\s*([^,.;!?]+?)\s*\bpasand\s*h(?:ai|ain|\b)/i.exec(text);
  if (likedHindi?.[1]) return { key: capped(phraseOf(likedHindi[1]), 120), value: 'pasand hai' };

  const likedLagta = /(?:mujhe|mereko|muje|mujhko)?\s*([^,.;!?]+?)\s*\bac[ch]*ha\s*lagta/i.exec(text);
  if (likedLagta?.[1]) return { key: capped(phraseOf(likedLagta[1]), 120), value: 'pasand hai' };

  const dislikedEnglish = /\bi\s+(?:don'?t|do\s+not)\s+(?:like|prefer|enjoy)\s+([^,.;!?]+)/i.exec(text);
  if (dislikedEnglish?.[1]) return { key: capped(phraseOf(dislikedEnglish[1]), 120), value: 'does not like' };

  const hatedEnglish = /\bi\s+(?:dislike|hate)\s+([^,.;!?]+)/i.exec(text);
  if (hatedEnglish?.[1]) return { key: capped(phraseOf(hatedEnglish[1]), 120), value: 'does not like' };

  const likedEnglish = /\bi\s+(?:prefer|like|love|enjoy)\s+([^,.;!?]+)/i.exec(text);
  if (likedEnglish?.[1]) return { key: capped(phraseOf(likedEnglish[1]), 120), value: 'likes' };

  return undefined;
}

/**
 * The recogniser, over the tools this process actually installed.
 *
 * `availableTools` is snapshotted at construction because `installCoreTools` runs
 * once at boot, before any cycle: a set read later would be the same set, and
 * taking it once makes it impossible for a tool to disappear between the proposal
 * and the execution of the same cycle.
 */
export function createIntentRecognizer(deps: { availableTools: Iterable<string> }): IntentRecognizer {
  const installed = new Set(deps.availableTools);

  const tool = (
    toolId: string,
    toolInput: Record<string, unknown>,
    rationale: string,
  ): DecisionProposal | undefined =>
    installed.has(toolId) ? { action: 'execute_tool', toolId, toolInput, rationale } : undefined;

  return {
    propose(stimulus: IdentifiedStimulus, now: number = Date.now()): DecisionProposal | undefined {
      // Only words a person actually addressed to her. A `system_event` or a
      // `proactive_trigger` carries a sensor's phrasing — `server/autonomic/noticing.ts`
      // writes those as sentences too — and reading an imperative out of her own
      // noticing would let her instruct herself to act.
      if (stimulus.inputType !== 'user_message') return undefined;

      // Folded to one script before any pattern sees it, for the reason in the module
      // header: every rule below is Roman, `toRomanHinglish` returns Roman input
      // byte-identical, and a typed Devanagari sentence is otherwise read by a second
      // vocabulary that was never more than a third built. Nothing about the stored
      // turn changes — the `message` row keeps his own words.
      const said = toRomanHinglish(stimulusText(stimulus.payload)).trim();
      if (said === '') return undefined;

      // Asked *about* her reminders, before the branch that would read the word
      // `reminder` as a request for a new one — but only when the sentence names no
      // hour. A question about what is already set does not carry a clock; an
      // instruction to set one does, and that single test tells "reminder set kiye
      // hain kaunse?" from "kal 7 baje ka reminder laga do ki bill bharna hai"
      // without either of them having to read tense.
      if (LIST_REMINDERS.test(said) && parseWhen(said, now)?.kind !== 'at') {
        const listed = tool('reminder.list', {}, 'Asked which reminders are pending');
        if (listed) return listed;
      }

      if (REMIND.test(said)) return proposeReminder(said, now, tool);

      if (PREFERS.test(said) || PREFERS_NOT.test(said)) {
        const stated = readStatedPreference(said);
        if (stated && stated.key !== '') {
          const set = tool(
            'preference.set',
            stated,
            `Stated a preference about "${stated.key}" plainly enough to store as one`,
          );
          if (set) return set;
        }
        // A liking whose clause could not be split — "mera favourite khana biryani
        // hai" puts the thing after the stance — is still something he told her about
        // himself, and `readStatedPreference` says in its own docstring that this is where
        // it goes. Until this branch existed it went nowhere: the sentence fell past
        // `REMEMBER`, past `RECALL`, and was answered as small talk and forgotten.
        const kept = tool(
          'memory.remember_event',
          { summary: capped(said, 2000) },
          'A preference stated in a form too loose to key, kept as it was said',
        );
        if (kept) return kept;
      }

      if (REMEMBER.test(said)) {
        const content = contentOf(said);
        const kept = tool(
          'memory.remember_event',
          { summary: capped(content === '' ? said : content, 2000) },
          'Asked to remember something, kept as it was said',
        );
        if (kept) return kept;
      }

      if (RECALL.test(said) && ASKED.test(said)) {
        const asked = tool(
          'memory.recall',
          { query: capped(contentOf(said) || said, 500) },
          'Asked what she remembers',
        );
        if (asked) return asked;
      }

      // Nothing actionable was said, which is the ordinary case. Stage 6 falls
      // through to the reasoning trace rather than treating this as a refusal.
      return undefined;
    },
  };
}

/**
 * A reminder, or the reason there is not one.
 *
 * Every branch that cannot schedule returns `clarify` with a rationale naming
 * exactly what was missing, and that rationale is durable — it goes onto the
 * cycle record. The alternative is what used to happen: the request matched
 * nothing, the cycle proposed `respond`, and "kal yaad dilana" was answered with
 * a greeting while nothing anywhere recorded that a reminder had been asked for.
 *
 * Nothing here defaults a time. `reminder.schedule` takes `dueAt` in absolute
 * epoch milliseconds precisely so the resolution is visible on the record and in
 * her answer, rather than happening inside the tool where nobody could check it.
 */
function proposeReminder(
  said: string,
  now: number,
  tool: (
    toolId: string,
    toolInput: Record<string, unknown>,
    rationale: string,
  ) => DecisionProposal | undefined,
): DecisionProposal {
  const when = parseWhen(said, now);
  const message = contentOf(said, true);

  if (when === undefined) {
    return {
      action: 'clarify',
      rationale: 'A reminder was asked for, and the words name no time to set it for',
    };
  }
  if (when.kind === 'dayOnly') {
    return {
      action: 'clarify',
      rationale: `A reminder was asked for "${when.label}", which names a day and not an hour`,
    };
  }
  if (message === '') {
    return {
      action: 'clarify',
      rationale: `A reminder was asked for ${when.label}, with nothing left in the sentence to say at that time`,
    };
  }
  if (when.dueAt <= now) {
    return {
      action: 'clarify',
      rationale: `The only time in the sentence reads as ${new Date(when.dueAt).toISOString()}, which has already passed`,
    };
  }

  return (
    tool(
      'reminder.schedule',
      { message: capped(message, 500), dueAt: when.dueAt },
      `Asked to be reminded at ${when.label}, read as ${new Date(when.dueAt).toISOString()}`,
    ) ?? {
      action: 'clarify',
      rationale: 'A reminder was asked for, and no reminder tool is installed in this process',
    }
  );
}
