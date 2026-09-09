/**
 * Reading affect from words, deterministically.
 *
 * This exists because `createEmotionReadingModule` returned
 * `{ hint: 'emotion-reading:no-op' }` and the comment above it promised a "real
 * impl [that] classifies affect from voice/text features". Wiring that module as
 * it stood would have satisfied "nothing is unwired" while changing nothing at
 * all, which is the failure mode the whole build is meant to avoid.
 *
 * ## Why not ask the model
 *
 * Because of where this runs. Stage 2 (IDENTIFY) is the second of twelve stages,
 * and its output has to be available to stage 4 in the same cycle. Spending a
 * network round trip there would put a second model call on the critical path of
 * every single turn, and — worse — it would make her tone depend on whether
 * `GOOGLE_API_KEY` is set. The whole architecture says the application decides
 * and the model only proposes; how warm she is toward someone who is upset is not
 * a thing to delegate.
 *
 * So this is a lexicon with real linguistics in it rather than a classifier: it
 * is instant, it is identical on every run, and it works with no key.
 *
 * ## The negation window is the part that matters
 *
 * A polarity lexicon that ignores negation gets "not good" exactly backwards. In
 * English the negator precedes the word it flips ("not good"); in Hindi and in
 * Hinglish it follows ("accha nahi", "theek nahi hai"). So each matched sentiment
 * token looks ±2 tokens for a negator and flips if it finds one, and negators
 * themselves contribute no valence of their own — `nahi` is structure, not
 * sentiment, even though a naive list would score it negative and then also flip
 * the word beside it, counting one negation twice.
 *
 * ## What comes out
 *
 * `valence` (-1 unhappy .. +1 happy) and `arousal` (0 flat .. 1 urgent) are
 * separate axes on purpose, because they call for opposite things from her:
 * arousal governs how *much* she says, valence governs how *warmly*. Collapsing
 * them into one "sentiment" number would lose the distinction between someone
 * who is upset and slow and someone who is upset and in a hurry.
 *
 * `confidence` is how much evidence was found, and is the honest brake on all of
 * it: two words in a forty-word message is not a mood reading, and
 * `personaDeltaFor` refuses to modulate below a floor rather than acting on
 * noise.
 */

/** Where a reading sits on the two axes, and what it was read from. */
export interface AffectReading {
  /** -1 (distressed) .. +1 (pleased). 0 is genuinely neutral, not "unknown". */
  valence: number;
  /** 0 (flat) .. 1 (urgent/agitated). */
  arousal: number;
  /** A coarse label, for diagnostics and stage traces. Never load-bearing. */
  label: AffectLabel;
  /** The tokens and features that produced the reading, for the same reason. */
  cues: string[];
  /** 0 .. 1 — how much evidence the text actually offered. */
  confidence: number;
  /** Token count, so a caller can tell "empty" from "neutral". */
  tokens: number;
}

export type AffectLabel =
  | 'distress'
  | 'frustration'
  | 'sadness'
  | 'delight'
  | 'warmth'
  | 'urgency'
  | 'neutral';

/**
 * Words carrying polarity, English and Hinglish in one table.
 *
 * Romanised Hindi has no fixed spelling, so the common variants are listed
 * outright ("bahut"/"bohot"/"bhot") rather than stemmed — a stemmer for a
 * language with no orthographic standard invents matches it cannot justify.
 */
const NEGATIVE: Record<string, number> = {
  // English
  angry: 0.7, annoyed: 0.5, awful: 0.8, bad: 0.5, broken: 0.5, confused: 0.35,
  disappointed: 0.6, exhausted: 0.5, fail: 0.5, failed: 0.55, frustrated: 0.65,
  hate: 0.8, hurt: 0.6, lonely: 0.7, lost: 0.4, pain: 0.6, sad: 0.7, scared: 0.7,
  sorry: 0.3, stressed: 0.65, stuck: 0.45, terrible: 0.8, tired: 0.45,
  upset: 0.65, useless: 0.6, worried: 0.6, worse: 0.5, worst: 0.7, wrong: 0.45,
  // Hinglish
  bekaar: 0.6, bekar: 0.6, bura: 0.5, chinta: 0.6, dar: 0.6, dikkat: 0.5,
  dukh: 0.7, faltu: 0.5, galat: 0.45, ghatiya: 0.7, gussa: 0.7, mushkil: 0.45,
  nafrat: 0.8, pareshan: 0.7, problem: 0.45, rona: 0.65, takleef: 0.6,
  thak: 0.45, thaka: 0.5, tension: 0.6,
};

const POSITIVE: Record<string, number> = {
  // English
  amazing: 0.8, awesome: 0.8, beautiful: 0.6, best: 0.7, better: 0.4, calm: 0.4,
  excited: 0.6, glad: 0.6, good: 0.5, grateful: 0.7, great: 0.7, happy: 0.75,
  hope: 0.4, love: 0.85, lovely: 0.65, nice: 0.5, perfect: 0.7, please: 0.2,
  proud: 0.65, relieved: 0.6, thanks: 0.5, wonderful: 0.8,
  // Hinglish
  accha: 0.5, acha: 0.5, badhiya: 0.65, khush: 0.75, khushi: 0.75, mast: 0.7,
  maza: 0.65, pyaar: 0.85, sahi: 0.4, shaandaar: 0.8, shandar: 0.8,
  shukriya: 0.55, sundar: 0.6, theek: 0.3, zabardast: 0.8,
};

/**
 * Structural negators. Deliberately absent from the polarity tables above: a
 * negator's job is to flip its neighbour, and letting it also score would count
 * the same negation twice and in the wrong direction.
 */
const NEGATORS = new Set([
  'not', "don't", 'dont', 'no', 'never', 'cannot', "can't", 'cant', "isn't",
  'isnt', "wasn't", 'wasnt', 'without', 'nahi', 'nahin', 'nai', 'na', 'mat',
  'bilkul', 'kabhi',
]);

/** Multipliers on the token they modify. */
const INTENSIFIERS: Record<string, number> = {
  very: 1.5, really: 1.4, so: 1.25, extremely: 1.8, totally: 1.4, super: 1.4,
  bahut: 1.5, bohot: 1.5, bhot: 1.5, zyada: 1.35, jyada: 1.35, ekdum: 1.5,
  itna: 1.3, kitna: 1.3,
};

/** Words that raise arousal without settling polarity either way. */
const AROUSAL_WORDS = new Set([
  'now', 'urgent', 'urgently', 'immediately', 'quick', 'quickly', 'asap', 'hurry',
  'emergency', 'abhi', 'jaldi', 'turant', 'fauran', 'arre', 'oye',
]);

/** How far to look for a negator, in tokens, on each side. */
const NEGATION_WINDOW = 2;

/** Below this, a reading is noise and callers must not act on it. */
export const MIN_ACTIONABLE_CONFIDENCE = 0.25;

const NEUTRAL: AffectReading = {
  valence: 0,
  arousal: 0,
  label: 'neutral',
  cues: [],
  confidence: 0,
  tokens: 0,
};

/**
 * Read affect from a piece of text.
 *
 * Total: any input at all, including `undefined` and objects, produces a reading
 * rather than a throw. The registry isolates module failures, but a sensor that
 * relies on being caught is a sensor that reports nothing on the day it matters.
 */
export function readAffect(input: unknown): AffectReading {
  const text = coerceText(input);
  if (text.length === 0) return { ...NEUTRAL };

  const tokens = tokenize(text);
  if (tokens.length === 0) return { ...NEUTRAL };

  const cues: string[] = [];
  let valenceSum = 0;
  let hits = 0;
  let arousalHits = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';
    if (NEGATORS.has(token)) continue;

    if (AROUSAL_WORDS.has(token)) {
      arousalHits += 1;
      cues.push(token);
      continue;
    }

    const negative = NEGATIVE[token];
    const positive = POSITIVE[token];
    if (negative === undefined && positive === undefined) continue;

    const magnitude = (negative ?? positive ?? 0) * intensifierBefore(tokens, i);
    const polarity = negative !== undefined ? -1 : 1;
    const flipped = hasNegatorNear(tokens, i) ? -polarity : polarity;

    valenceSum += flipped * magnitude;
    hits += 1;
    cues.push(flipped === polarity ? token : `not:${token}`);
  }

  // Punctuation and casing carry arousal that no word list can: "ok." and "OK!!!"
  // are the same token and not the same message.
  const shouted = shoutRatio(text);
  const bangs = countRuns(text, /!/g);
  const questions = countRuns(text, /\?/g);
  const elongated = /([a-z])\1{2,}/i.test(text);

  if (shouted > 0.4 && text.length > 6) cues.push('caps');
  if (bangs > 0) cues.push(bangs > 1 ? 'exclaim:multi' : 'exclaim');
  if (questions > 1) cues.push('question:multi');
  if (elongated) cues.push('elongated');

  const valence = clamp(valenceSum / Math.max(1, Math.sqrt(hits)), -1, 1);
  const arousal = clamp(
    arousalHits * 0.3 +
      Math.min(bangs, 3) * 0.18 +
      (questions > 1 ? 0.15 : 0) +
      (shouted > 0.4 && text.length > 6 ? 0.3 : 0) +
      (elongated ? 0.1 : 0) +
      Math.abs(valence) * 0.25,
    0,
    1,
  );

  // Evidence density, not certainty about the label. A long message with one
  // charged word is mostly not about that word.
  const density = (hits + arousalHits) / Math.max(4, tokens.length);
  const confidence = clamp(density * 2.2 + (cues.length > 0 ? 0.1 : 0), 0, 1);

  return {
    valence: round(valence),
    arousal: round(arousal),
    label: labelFor(valence, arousal, confidence),
    cues: cues.slice(0, 8),
    confidence: round(confidence),
    tokens: tokens.length,
  };
}

/**
 * The persona deltas a reading justifies — the module's actual effect on her.
 *
 * Two rules, and they pull on different dimensions on purpose:
 *
 *  - **Arousal governs length.** Someone agitated or in a hurry is not helped by
 *    more sentences, so high arousal shortens her.
 *  - **Valence governs warmth.** Strong feeling in *either* direction earns more
 *    warmth: distress because it is needed, delight because meeting it flatly is
 *    its own kind of coldness.
 *
 * Below `MIN_ACTIONABLE_CONFIDENCE` the answer is no deltas at all. A tone shift
 * on one ambiguous word is worse than none, because it is unpredictable — and
 * unpredictable tone is exactly what reads as machine.
 */
export function personaDeltaFor(reading: AffectReading): {
  warmthDelta?: number;
  verbosityDelta?: number;
} {
  if (reading.confidence < MIN_ACTIONABLE_CONFIDENCE) return {};

  const delta: { warmthDelta?: number; verbosityDelta?: number } = {};
  if (Math.abs(reading.valence) >= 0.3) delta.warmthDelta = 1;
  if (reading.arousal >= 0.55) delta.verbosityDelta = -1;
  return delta;
}

// ── Internals ──

function labelFor(valence: number, arousal: number, confidence: number): AffectLabel {
  if (confidence < MIN_ACTIONABLE_CONFIDENCE) return 'neutral';
  if (valence <= -0.3) {
    if (arousal >= 0.6) return 'distress';
    if (arousal >= 0.35) return 'frustration';
    return 'sadness';
  }
  if (valence >= 0.3) return arousal >= 0.5 ? 'delight' : 'warmth';
  return arousal >= 0.55 ? 'urgency' : 'neutral';
}

/**
 * Is there a negator within the window on either side?
 *
 * Both sides, because word order differs by language and this codebase is used
 * in two at once: "not working" puts the negator first, "kaam nahi kar raha"
 * puts it after.
 */
function hasNegatorNear(tokens: string[], index: number): boolean {
  const from = Math.max(0, index - NEGATION_WINDOW);
  const to = Math.min(tokens.length - 1, index + NEGATION_WINDOW);
  for (let i = from; i <= to; i += 1) {
    if (i !== index && NEGATORS.has(tokens[i] ?? '')) return true;
  }
  return false;
}

function intensifierBefore(tokens: string[], index: number): number {
  for (let i = Math.max(0, index - 2); i < index; i += 1) {
    const factor = INTENSIFIERS[tokens[i] ?? ''];
    if (factor !== undefined) return factor;
  }
  return 1;
}

/**
 * Tokenize for lookup, not for display.
 *
 * Apostrophes survive because `don't` is in the negator set as one token; every
 * other separator collapses. Latin range only: the lexicons are romanised, so
 * Devanagari input scores nothing rather than scoring wrongly — a gap this
 * function is honest about instead of guessing at.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((t) => t.length > 0);
}

function coerceText(input: unknown): string {
  if (typeof input === 'string') return input.trim();
  if (input === null || typeof input !== 'object') return '';

  // The stage inputs this actually sees: a RawStimulus at stage 2, a
  // RecalledContext at stage 4. Both put the words somewhere different, so both
  // paths are named rather than reached for by a deep search — a generic walk
  // would eventually pick up a memory summary and read *her own* recall as his
  // mood.
  const record = input as Record<string, unknown>;
  const direct = payloadText(record['payload']);
  if (direct.length > 0) return direct;

  const stimulus = record['stimulus'];
  if (stimulus !== null && typeof stimulus === 'object') {
    return payloadText((stimulus as Record<string, unknown>)['payload']);
  }
  return '';
}

function payloadText(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim();
  if (payload === null || typeof payload !== 'object') return '';
  const text = (payload as Record<string, unknown>)['text'];
  return typeof text === 'string' ? text.trim() : '';
}

function shoutRatio(text: string): number {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

function countRuns(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
