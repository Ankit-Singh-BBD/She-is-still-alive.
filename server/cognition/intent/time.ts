/**
 * Reading a time out of a sentence, deterministically, in the words she is
 * actually spoken to in.
 *
 * `reminder.schedule` needs exactly one of `dueAt` or `inMinutes`, and with no
 * language faculty wired nothing in the repository could produce either — so
 * "kal 7 baje yaad dilana" reached stage 6, matched no rule, and was answered
 * with "I hear you." while the tool that would have done it sat registered and
 * idle.
 *
 * ## The rule this file is built around: never invent a time
 *
 * A reminder set for a time nobody asked for is worse than no reminder, because
 * it will fire and be believed. So every reading here is either a time the words
 * actually contain or an admission that it is missing. `dayOnly` exists for
 * exactly that: "kal yaad dilana" names a day and no hour, which is not a time,
 * and the caller turns it into a question rather than a guess at 09:00.
 *
 * ## Why the clock needs a marker
 *
 * A bare number is not a time. "2 litre paani" and "2 baje" differ only in the
 * word after the digit, so a clock is only read when something marks it as one:
 * `baje`, `am`/`pm`, an explicit `:mm`, or a part-of-day word in the sentence.
 * Without that guard the recogniser would schedule a reminder for 02:00 because
 * a message mentioned two litres of water.
 *
 * ## One script, folded at the door
 *
 * Every pattern here is Roman, and `parseWhen` folds its input with
 * `toRomanHinglish` before reading it, so "कल 7 बजे" and "kal 7 baje" are one
 * input rather than two vocabularies. The second vocabulary is not hypothetical —
 * it was here, and `server/cognition/intent/recognizer.ts` documents what that
 * costs. It was half built by definition: `RELATIVE` read `मिनट` and `घंटे` while
 * `RELATIVE_WORDS` beside it read neither, so "20 मिनट बाद" was a duration and "दो
 * घंटे बाद" — the same request in words — was nothing at all.
 *
 * What the fold produces is therefore load-bearing vocabulary, and it is not how a
 * person typing Roman spells things: `मिनट` folds to `minat`, `आज` to `aj`, `रात`
 * to `rat`. Each of those sits beside the hand-spelled form below, because a
 * missing fold spelling is not a missed match — it is a wrong time. With `rat`
 * unread, "raat 9 baje yaad dilana" asked at 07:00 loses the part-of-day window
 * and resolves against a bare 9, which is 09:00 that morning: a reminder set
 * twelve hours early, that will fire and be believed.
 */

import { toRomanHinglish } from '@server/lang/index.js';

/** A time the words actually named. */
export interface AbsoluteWhen {
  kind: 'at';
  /** Epoch milliseconds, resolved against the `now` that was passed in. */
  dueAt: number;
  /** How the reading would be said back, for a rationale on the record. */
  label: string;
}

/** A day with no hour in it — recognised, and deliberately not resolved. */
export interface DayOnlyWhen {
  kind: 'dayOnly';
  label: string;
}

export type WhenReading = AbsoluteWhen | DayOnlyWhen;

/** Milliseconds in the units a person actually says. */
const MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
} as const;

/**
 * "X minute baad", "in 20 minutes", "do ghante baad".
 *
 * The trailing `baad`/`later`/`me` or the leading `in` is required for the
 * *unit-less* reading to be safe, but here the unit itself is the marker — a
 * sentence saying "minute" or "ghante" beside a number is talking about a
 * duration. `baad` is optional so "20 minute me" and "20 minutes" both read.
 */
const RELATIVE =
  /(\d{1,4})\s*(minute?s?|mins?|mint|minat|ghante?|ghanta|ghnte|hours?|hrs?|hr|din|days?)(?![a-z])\s*(?:baad|bad|ke\s*baad|later|me|mein|men)?/i;

/** Word forms of the small numbers, because "do ghante baad" has no digits in it. */
const WORD_NUMBERS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5,
  chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10, dus: 10,
  aadha: 0.5, adha: 0.5, half: 0.5,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30,
};

const RELATIVE_WORDS = new RegExp(
  `\\b(${Object.keys(WORD_NUMBERS).join('|')})\\s*` +
    `(minute?s?|mins?|mint|minat|ghante?|ghanta|ghnte|hours?|hrs?|hr|din|days?)\\b` +
    `\\s*(?:baad|bad|ke\\s*baad|later|me|mein|men)?`,
  'i',
);

/** Which unit a matched word belongs to. */
function unitOf(raw: string): keyof typeof MS {
  const unit = raw.toLowerCase();
  if (/^(?:din|days?)/.test(unit)) return 'day';
  if (/^(?:ghan|ghn|hour|hrs?|hr)/.test(unit)) return 'hour';
  return 'minute';
}

/**
 * Which day is being talked about, as an offset from today.
 *
 * `kal` is genuinely both yesterday and tomorrow in Hindi — the tense of the verb
 * decides, and no regex here reads tense. This function is only ever called about
 * a *reminder*, which cannot be set for yesterday, so tomorrow is not a guess: it
 * is the only reading that can be acted on. `parseWhen` is deliberately not used
 * for remembering, where the ambiguity would matter.
 */
const DAY_WORDS: { pattern: RegExp; offset: number; label: string }[] = [
  { pattern: /\bparso\b|\bparson\b|day\s+after\s+tomorrow/i, offset: 2, label: 'parso' },
  { pattern: /\bkal\b|\btomorrow\b|\bkl\b/i, offset: 1, label: 'kal' },
  { pattern: /\baa?j\b|\btoday\b|\btonight\b/i, offset: 0, label: 'aaj' },
  { pattern: /next\s+week|agle\s+hafte|agle\s+week/i, offset: 7, label: 'agle hafte' },
];

/**
 * The part of the day, which is what turns "7 baje" into 07:00 or 19:00.
 *
 * `min`/`max` is the 24-hour window the named part covers. A clock reading is
 * moved into that window rather than checked against it, because "shaam 7 baje"
 * means 19:00 and the speaker will not say 19.
 */
const DAY_PARTS: { pattern: RegExp; label: string; min: number; max: number }[] = [
  { pattern: /\bsubah\b|\bsavere\b|\bsawere\b|\bmorning\b/i, label: 'subah', min: 4, max: 11 },
  { pattern: /\bdopahar\b|\bdophar\b|\bafternoon\b|\bnoon\b/i, label: 'dopahar', min: 12, max: 16 },
  { pattern: /\bshaam\b|\bsham\b|\bevening\b/i, label: 'shaam', min: 16, max: 20 },
  { pattern: /\braa?t\b|\bnight\b|\btonight\b/i, label: 'raat', min: 19, max: 23 },
];

/**
 * A clock, with the marker that proves it is one.
 *
 * The marker group is *not* optional. That is the guard described in the header:
 * a number only becomes an hour when the sentence says `baje`, says am/pm, or
 * writes minutes after a colon.
 */
const CLOCK_MARKED =
  /(\d{1,2})(?:[:.](\d{2}))?\s*(baje|bajey|bajay|bje|o'?clock|a\.?m\.?|p\.?m\.?)/i;

/** A clock written with minutes and no other marker: "7:30 pe yaad dilana". */
const CLOCK_MINUTES = /(\d{1,2})[:.](\d{2})/;

/** A bare hour leaning on the part-of-day word beside it: "subah 6", "shaam ko 7". */
const CLOCK_BESIDE_PART =
  /(?:subah|savere|sawere|morning|dopahar|dophar|afternoon|shaam|sham|evening|raat|rat|night)\s*(?:ko|ke|me|mein)?\s*(\d{1,2})(?:[:.](\d{2}))?/i;

/**
 * The same vocabulary, in the form a caller needs to *remove* it.
 *
 * `recognizer.ts` takes the time out of a reminder's message, because the hour has
 * already been read into `dueAt` and leaving it in would have her say it back at
 * the moment it is no longer true. That list used to live over there, written a
 * second time by hand, and it had already drifted: it knew "20 minute baad" and
 * not "do ghante baad", so a duration spoken in words went into `dueAt` *and*
 * stayed in the message, which then read "do ghante baad dawai leni hai" two hours
 * later. These are the patterns above and nothing else, so that drift cannot
 * happen again — whatever `parseWhen` can read, a caller can remove.
 *
 * Order is load-bearing in one place: `CLOCK_BESIDE_PART` leans on the part-of-day
 * word beside the digits, so it must run before `DAY_PARTS` takes that word away
 * and leaves a bare "6" behind.
 *
 * These read Roman, like everything else here, and unlike `parseWhen` they cannot
 * fold for the caller — the caller owns the string being stripped. So a caller
 * removing a time must strip from the same folded sentence it read the time out of.
 * `recognizer.ts` does: it folds once at its door and both calls see that.
 */
export function timeExpressions(): RegExp[] {
  const global = (pattern: RegExp): RegExp => new RegExp(pattern.source, `g${pattern.flags.includes('i') ? 'i' : ''}`);
  return [
    global(RELATIVE),
    global(RELATIVE_WORDS),
    global(CLOCK_MARKED),
    global(CLOCK_BESIDE_PART),
    global(CLOCK_MINUTES),
    ...DAY_WORDS.map((day) => global(day.pattern)),
    ...DAY_PARTS.map((part) => global(part.pattern)),
  ];
}

/** Whether an am/pm marker was written, and which. */
function meridiemIn(text: string): 'am' | 'pm' | undefined {
  const marked = CLOCK_MARKED.exec(text);
  const marker = marked?.[3]?.toLowerCase().replace(/\./g, '');
  if (marker === 'am') return 'am';
  if (marker === 'pm') return 'pm';
  return undefined;
}

/** The hour and minute the sentence names, if it names one at all. */
function readClock(text: string): { hour: number; minute: number } | undefined {
  const match = CLOCK_MARKED.exec(text) ?? CLOCK_MINUTES.exec(text) ?? CLOCK_BESIDE_PART.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (!Number.isInteger(hour) || hour > 24 || minute > 59) return undefined;
  return { hour: hour === 24 ? 0 : hour, minute };
}

/**
 * A duration, if the sentence is phrased as one.
 *
 * Checked before the clock, because "20 minute baad" contains a number that
 * `CLOCK_MINUTES` must never be given a chance to read as 20 past something.
 */
function readDuration(text: string): { ms: number; label: string } | undefined {
  const digits = RELATIVE.exec(text);
  const words = digits ? undefined : RELATIVE_WORDS.exec(text);
  const raw = digits ?? words;
  if (!raw) return undefined;

  const amount = digits
    ? Number(digits[1])
    : (WORD_NUMBERS[(words?.[1] ?? '').toLowerCase()] ?? Number.NaN);
  const unit = unitOf(raw[2] ?? '');
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  return { ms: Math.round(amount * MS[unit]), label: `${amount} ${unit}${amount === 1 ? '' : 's'} from now` };
}

/**
 * Moves a spoken hour into the window the part-of-day names.
 *
 * "shaam 7" is 19:00 and "subah 7" is 07:00, from the same digit. A 12-hour clock
 * only ever needs ±12, so this adds or removes exactly that much and nothing else
 * — an hour that already sits in the window is left alone, which is what makes
 * "raat 23 baje" and "raat 11 baje" resolve to the same instant.
 */
function intoWindow(hour: number, part: { min: number; max: number }): number {
  if (hour >= part.min && hour <= part.max) return hour;
  if (hour + 12 >= part.min && hour + 12 <= part.max) return hour + 12;
  if (hour - 12 >= part.min && hour - 12 <= part.max) return hour - 12;
  return hour;
}

/**
 * The hour a bare clock means when nothing disambiguates it.
 *
 * "7 baje yaad dilana" at 3pm means 7pm, not 7am tomorrow: the nearest future
 * occurrence is the ordinary reading, and it is the one a person checking their
 * own watch would arrive at. The caller states the resolved time back in its
 * rationale, so a wrong reading is visible on the record rather than silent.
 */
function nearestFuture(hour: number, minute: number, now: Date): Date {
  const candidates = hour <= 12 ? [hour, hour + 12] : [hour];
  let best: Date | undefined;
  for (const candidate of candidates) {
    for (const dayOffset of [0, 1]) {
      const when = new Date(now);
      when.setDate(when.getDate() + dayOffset);
      when.setHours(candidate % 24, minute, 0, 0);
      if (when.getTime() <= now.getTime()) continue;
      if (best === undefined || when.getTime() < best.getTime()) best = when;
    }
  }
  return best ?? new Date(now.getTime() + MS.day);
}

/**
 * The one entry point: what time, if any, these words name.
 *
 * Order is the whole of the logic. A duration wins over a clock because "20
 * minute baad" contains a number that would otherwise be read as an hour. A day
 * with no clock returns `dayOnly` rather than a resolved midnight, and a clock
 * with no day resolves against today or tomorrow, whichever comes next.
 *
 * `now` is passed in rather than read, so the tests that pin a clock are testing
 * this function and not the machine they run on.
 */
export function parseWhen(text: string, now: number = Date.now()): WhenReading | undefined {
  // One script, for the reason in the header. Roman input comes back byte-identical,
  // so a caller that has already folded — the recogniser has — pays a regex test and
  // nothing else, and a caller that has not cannot get a wrong answer for it.
  const said = toRomanHinglish(text).toLowerCase();

  const duration = readDuration(said);
  if (duration) return { kind: 'at', dueAt: now + duration.ms, label: duration.label };

  const day = DAY_WORDS.find((candidate) => candidate.pattern.test(said));
  const part = DAY_PARTS.find((candidate) => candidate.pattern.test(said));
  const clock = readClock(said);

  if (clock === undefined) {
    // A part of a day is a time of sorts — "kal subah" is a real answer — but it is
    // not an hour, and picking one would be the invention this file exists to
    // refuse. Both of these are questions for the caller to ask.
    if (day || part) {
      return { kind: 'dayOnly', label: [day?.label, part?.label].filter(Boolean).join(' ') };
    }
    return undefined;
  }

  let hour = clock.hour;
  const meridiem = meridiemIn(said);
  if (meridiem === 'pm' && hour < 12) hour += 12;
  else if (meridiem === 'am' && hour === 12) hour = 0;
  else if (meridiem === undefined && part) hour = intoWindow(hour, part);

  const resolved =
    day === undefined && meridiem === undefined && part === undefined
      ? nearestFuture(hour, clock.minute, new Date(now))
      : (() => {
          const when = new Date(now);
          when.setDate(when.getDate() + (day?.offset ?? 0));
          when.setHours(hour % 24, clock.minute, 0, 0);
          // A named hour that has already gone by today, with no day word to place
          // it, means the next one — the same reading `nearestFuture` takes.
          if (day === undefined && when.getTime() <= now) when.setDate(when.getDate() + 1);
          return when;
        })();

  const clockLabel = `${String(resolved.getHours()).padStart(2, '0')}:${String(resolved.getMinutes()).padStart(2, '0')}`;
  return {
    kind: 'at',
    dueAt: resolved.getTime(),
    label: [day?.label, part?.label, clockLabel].filter(Boolean).join(' '),
  };
}
