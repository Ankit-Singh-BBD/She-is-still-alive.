/**
 * Devanagari in, Roman Hinglish out.
 *
 * The provider writes Hindi in Devanagari. Every other part of her writes it in Roman.
 *
 * This is not a stylistic difference, it is a matching failure, and it was invisible
 * until the ear was pointed at a real microphone. Against
 * `gemini-3.1-flash-live-preview`, "main theek hoon Ankit, tum batao kaise ho?" spoken
 * aloud comes back from `inputAudioTranscription` as
 *
 *     मैं ठीक हूं अंकित, तुम बताओ कैसे हो?
 *
 * which is a faithful transcription and completely unusable downstream. Everything
 * that reads a stimulus reads Roman: the intent vocabulary in
 * `server/cognition/intent/recognizer.ts` is Roman regexes, the conversation rows
 * are Roman because she authored them, the memory summaries are Roman for the same
 * reason, and `bagOfWordsSimilarity` in `server/memory/retrieval.ts` scores a query
 * by token overlap against them. A Devanagari transcript overlaps none of it. So a
 * spoken turn recalled by importance and recency alone, with the similarity term
 * contributing exactly nothing, and did it silently — she answers, and the answer
 * is simply less informed than the same sentence typed.
 *
 * Folding to one script is the narrow fix: one script enters the mind, and it is the
 * script she already thinks in. The alternative — teaching every vocabulary, scorer
 * and regex a second script — is the same work repeated in five places, and each
 * place would have to be kept in step forever.
 *
 * ## Two callers, which is why this is not in `server/voice/`
 *
 * The ear applies it at the boundary, so nothing downstream ever sees Devanagari from
 * a microphone. The memory scorer applies it to both sides of a comparison, because a
 * turn *typed* in Devanagari reaches the store without passing the ear at all, and a
 * memory written from one of those would otherwise be unreachable from every Roman
 * query. Same rule, two independent reasons for it.
 *
 * ## What it targets, and why not a standard
 *
 * Not ISO 15919, not IAST, not ITRANS. Those are reversible scholarly schemes and
 * they produce `maiṁ ṭhīka hūṁ`, which matches nothing the owner has ever typed.
 * The target is the informal Roman Hinglish an Indian keyboard actually produces,
 * so the mapping deliberately throws information away:
 *
 *  - Retroflex and dental collapse: ट and त are both `t`, ड and द both `d`. Roman
 *    Hinglish has never distinguished them and a reader supplies the difference.
 *  - Vowel length collapses to the short form: ी is `i`, ू is `u`, ा is `a`. This
 *    is the one genuinely arbitrary choice — ठीक is written both "thik" and
 *    "theek" — and it is settled by which one keeps more words right: `a` for ा
 *    gives "batao" and "karo" rather than "bataao" and "karo", and the vowel-length
 *    fold in `bagOfWordsSimilarity` is what makes the remaining variance match
 *    anyway.
 *  - Word-final schwa is deleted, because that is what makes ठीक "thik" and not
 *    "thika", and तुम "tum" and not "tuma". A single-syllable word keeps it, so न
 *    is "na". A medial schwa goes too when Hindi drops it, which is what makes
 *    लगता "lagta" and मतलब "matlab" — see `deleteSchwas`, which is where the two
 *    rules and their interaction are written down.
 *  - Anusvara becomes `m` before a labial and `n` everywhere else, which is the
 *    difference between "sambhav" and "sanbhav".
 *
 * Nothing here is reversible and nothing here needs to be. The Devanagari is not
 * discarded — `server/voice/live/session.ts` accumulates the provider's own text and
 * transliterates on the way out, so what the provider said remains the record of what
 * it said.
 *
 * ## Roman input is untouched
 *
 * The first thing the function does is look for a Devanagari code point and return
 * the string unchanged when there is none. A typed turn, an English turn, and every
 * existing test pass through byte-identical, which is what makes it safe to put on a
 * hot path like the drift comparison.
 */

const DEVANAGARI = /[ऀ-ॿ]/;

const VIRAMA = '्';
const NUKTA = '़';
const ANUSVARA = 'ं';
const CHANDRABINDU = 'ँ';
const VISARGA = 'ः';
const AVAGRAHA = 'ऽ';
const ZWNJ = '‌';
const ZWJ = '‍';

/** `ज्ञ` is `j` + virama + `ñ` by the syllable rules and "gy" to every reader. */
const GYA = `ज${VIRAMA}ञ`;

/** Independent vowels — a syllable that starts without a consonant. */
const VOWELS: Readonly<Record<string, string>> = {
  अ: 'a',
  आ: 'a',
  इ: 'i',
  ई: 'i',
  उ: 'u',
  ऊ: 'u',
  ऋ: 'ri',
  ॠ: 'ri',
  ऌ: 'li',
  ॡ: 'li',
  ऍ: 'e',
  ऎ: 'e',
  ए: 'e',
  ऐ: 'ai',
  ऑ: 'o',
  ऒ: 'o',
  ओ: 'o',
  औ: 'au',
};

/** Dependent vowel signs — they replace a consonant's implicit `a`. */
const MATRAS: Readonly<Record<string, string>> = {
  'ा': 'a',
  'ि': 'i',
  'ी': 'i',
  'ु': 'u',
  'ू': 'u',
  'ृ': 'ri',
  'ॄ': 'ri',
  'ॢ': 'li',
  'ॣ': 'li',
  'ॅ': 'e',
  'ॆ': 'e',
  'े': 'e',
  'ै': 'ai',
  'ॉ': 'o',
  'ॊ': 'o',
  'ो': 'o',
  'ौ': 'au',
};

/**
 * Consonants, carrying an implicit `a` unless a matra or a virama says otherwise.
 *
 * The retroflex row (ट ठ ड ढ ण) and the dental row (त थ द ध न) map to the same
 * letters on purpose; so do श and ष. See the header.
 */
const CONSONANTS: Readonly<Record<string, string>> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'n',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'ny',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  ऩ: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ऱ: 'r',
  ल: 'l',
  ळ: 'l',
  ऴ: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
};

/**
 * The Perso-Arabic sounds Hindi borrowed, which Devanagari writes as a consonant
 * followed by a nukta.
 *
 * Unicode also has single code points for these (U+0958–U+095F), but they are
 * composition exclusions: NFC will not produce them, so a transcriber emits the
 * two-code-point form. They are listed separately, by escape, because writing them
 * as literals here would be the decomposed pair again and a duplicate key.
 */
const NUKTA_CONSONANTS: Readonly<Record<string, string>> = {
  [`क${NUKTA}`]: 'q',
  [`ख${NUKTA}`]: 'kh',
  [`ग${NUKTA}`]: 'g',
  [`ज${NUKTA}`]: 'z',
  [`ड${NUKTA}`]: 'r',
  [`ढ${NUKTA}`]: 'rh',
  [`फ${NUKTA}`]: 'f',
  [`य${NUKTA}`]: 'y',
  '\u0958': 'q',
  '\u0959': 'kh',
  '\u095A': 'g',
  '\u095B': 'z',
  '\u095C': 'r',
  '\u095D': 'rh',
  '\u095E': 'f',
  '\u095F': 'y',
};

const DIGITS: Readonly<Record<string, string>> = {
  '०': '0',
  '१': '1',
  '२': '2',
  '३': '3',
  '४': '4',
  '५': '5',
  '६': '6',
  '७': '7',
  '८': '8',
  '९': '9',
};

/** Labials, before which an anusvara is heard — and written — as `m`. */
const LABIALS = new Set(['प', 'फ', 'ब', 'भ', 'म', `फ${NUKTA}`, 'फ़']);

/**
 * Devanagari in, Roman Hinglish out; anything else back unchanged.
 *
 * Three passes rather than one, because a schwa's fate is decided by its
 * neighbours on both sides and the rightmost decision changes the next one to its
 * left. So the text becomes syllables, the syllables lose the schwas Hindi does
 * not pronounce, and only then does anything become a string.
 */
export function toRomanHinglish(text: string): string {
  if (!DEVANAGARI.test(text)) return text;
  const units = parse(text);
  for (const word of words(units)) deleteSchwas(word);
  return render(units);
}

/** One sound with its vowel, or characters that passed straight through. */
type Unit = { readonly syllable: Syllable } | { readonly literal: string };

interface Syllable {
  /** The consonant, or `''` for a syllable that begins with a vowel. */
  readonly onset: string;
  /** Emptied by schwa deletion, which is why it is the one mutable field. */
  vowel: string;
  /** Whether `vowel` is the unwritten `a` — the only kind that may be deleted. */
  readonly implicit: boolean;
  /** An anusvara, chandrabindu or visarga that closed the syllable. */
  coda: string;
}

/**
 * Devanagari to syllables, faithfully. Nothing is dropped here — every deletion
 * is a decision and decisions belong to `deleteSchwas`.
 */
function parse(text: string): Unit[] {
  const units: Unit[] = [];
  let at = 0;

  while (at < text.length) {
    const ch = text[at] as string;

    const consonant = consonantAt(text, at);
    if (consonant !== undefined) {
      at += consonant.length;
      const sign = text[at];
      if (sign === VIRAMA) {
        // A consonant with its vowel explicitly cancelled: half of a cluster.
        units.push({ syllable: { onset: consonant.roman, vowel: '', implicit: false, coda: '' } });
        at += 1;
        continue;
      }
      const matra = sign === undefined ? undefined : MATRAS[sign];
      if (matra !== undefined) {
        units.push({
          syllable: { onset: consonant.roman, vowel: matra, implicit: false, coda: '' },
        });
        at += 1;
        continue;
      }
      units.push({ syllable: { onset: consonant.roman, vowel: 'a', implicit: true, coda: '' } });
      continue;
    }

    const vowel = VOWELS[ch];
    if (vowel !== undefined) {
      units.push({ syllable: { onset: '', vowel, implicit: false, coda: '' } });
      at += 1;
      continue;
    }

    // A matra with no consonant in front of it is malformed input, not a reason to
    // drop a sound the microphone heard.
    const stray = MATRAS[ch];
    if (stray !== undefined) {
      units.push({ syllable: { onset: '', vowel: stray, implicit: false, coda: '' } });
      at += 1;
      continue;
    }

    if (ch === ANUSVARA || ch === CHANDRABINDU) {
      close(units, nasalBefore(text, at + 1));
      at += 1;
      continue;
    }

    if (ch === VISARGA) {
      close(units, 'h');
      at += 1;
      continue;
    }

    const digit = DIGITS[ch];
    if (digit !== undefined) {
      units.push({ literal: digit });
      at += 1;
      continue;
    }

    if (ch === '।' || ch === '॥') {
      units.push({ literal: '.' });
      at += 1;
      continue;
    }

    // Marks that carry no sound of their own, and a stray virama.
    if (ch === AVAGRAHA || ch === ZWNJ || ch === ZWJ || ch === VIRAMA) {
      at += 1;
      continue;
    }

    // Spaces, Latin letters, punctuation, emoji — through untouched, and a word
    // boundary for the schwa rules.
    units.push({ literal: ch });
    at += 1;
  }

  return units;
}

/**
 * The consonant cluster starting at `at`, if one does, with the number of code
 * units it occupied.
 *
 * Longest match first: `ज्ञ` before `ज`, and a nukta pair before the bare
 * consonant it is built on, or `ज` would be read and the nukta left behind as a
 * stray mark.
 */
function consonantAt(text: string, at: number): { roman: string; length: number } | undefined {
  if (text.startsWith(GYA, at)) return { roman: 'gy', length: GYA.length };

  const pair = text.slice(at, at + 2);
  const nukta = NUKTA_CONSONANTS[pair];
  if (nukta !== undefined) return { roman: nukta, length: 2 };

  const ch = text[at];
  if (ch === undefined) return undefined;

  const precomposed = NUKTA_CONSONANTS[ch];
  if (precomposed !== undefined) return { roman: precomposed, length: 1 };

  const plain = CONSONANTS[ch];
  return plain === undefined ? undefined : { roman: plain, length: 1 };
}

/**
 * Closes the syllable in progress with a nasal or an `h`.
 *
 * An anusvara belongs to the syllable before it — पसंद is `pa·san·d`, not
 * `pa·sa·n·d` — and that placement is what stops the schwa rules from treating the
 * nasal as a syllable of its own. With no syllable to close it becomes a literal,
 * because a sound the microphone heard should still appear.
 */
function close(units: Unit[], sound: string): void {
  const last = units[units.length - 1];
  if (last !== undefined && 'syllable' in last) last.syllable.coda += sound;
  else units.push({ literal: sound });
}

/**
 * The words, as runs of syllables between literals.
 *
 * The syllables are the same objects the caller holds, so mutating them here is
 * how the deletion reaches `render`.
 */
function words(units: Unit[]): Syllable[][] {
  const found: Syllable[][] = [];
  let run: Syllable[] = [];
  for (const unit of units) {
    if ('syllable' in unit) run.push(unit.syllable);
    else if (run.length > 0) {
      found.push(run);
      run = [];
    }
  }
  if (run.length > 0) found.push(run);
  return found;
}

/** `m` before a labial, `n` otherwise. "sambhav", never "sanbhav". */
function nasalBefore(text: string, at: number): string {
  const pair = text.slice(at, at + 2);
  if (LABIALS.has(pair)) return 'm';
  const ch = text[at];
  return ch !== undefined && LABIALS.has(ch) ? 'm' : 'n';
}

/**
 * Schwa deletion, which is the difference between Hinglish and a transliteration
 * machine.
 *
 * Devanagari writes every consonant with an inherent `a` and Hindi does not
 * pronounce most of them. Two rules cover nearly all of it:
 *
 *  - **Word-final.** ठीक is "thik" and तुम is "tum", never "thika" and "tuma". A
 *    single-syllable word keeps its schwa, or न would be "n".
 *  - **Medial, in `V C ə C V`.** लगता is "lagta": the schwa on ग sits between a
 *    vowel and a full syllable, so it goes. मतलब is "matlab" for the same reason,
 *    and the two rules interact — the schwa on ल survives only *because* the one on
 *    ब was deleted first, which is why this runs right to left.
 *
 * A closed syllable is left alone: the `a` in पसंद is carrying a nasal and is not
 * a deletable schwa. And the first syllable of a word is never touched, which is
 * what keeps बताओ "batao" rather than "btao".
 */
function deleteSchwas(word: Syllable[]): void {
  const last = word.length - 1;

  const tail = word[last];
  if (tail !== undefined && tail.implicit && tail.coda === '' && word.length > 1) tail.vowel = '';

  for (let at = last - 1; at > 0; at -= 1) {
    const here = word[at];
    const before = word[at - 1];
    const after = word[at + 1];
    if (here === undefined || before === undefined || after === undefined) continue;
    if (!here.implicit || here.coda !== '' || here.onset === '') continue;
    // `V C ə C V`, read against the vowels as they stand after the deletions to
    // the right of here.
    if (before.vowel === '' || after.onset === '' || after.vowel === '') continue;
    here.vowel = '';
  }
}

function render(units: Unit[]): string {
  let out = '';
  for (const unit of units) {
    out +=
      'syllable' in unit
        ? unit.syllable.onset + unit.syllable.vowel + unit.syllable.coda
        : unit.literal;
  }
  return out;
}
