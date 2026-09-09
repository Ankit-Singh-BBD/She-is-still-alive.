/**
 * What a tool did, in words a person would use.
 *
 * Stage 9 holds `ActionResult[]` — `{toolId, success, output, verified}` — and used to
 * answer a verified action with the id: *"Done — I ran reminder.schedule and checked
 * it."* That is the inside of the machine read out loud. Nobody says the name of the
 * mechanism they used; they say what is now true. *"Done — the reminder for 'paani peena
 * hai' is set for tomorrow at 7:00 am."*
 *
 * ## Why the phrasing lives here and not in stage 9
 *
 * Every sentence below is read out of a *tool's own output schema*. When a tool changes
 * what it returns, the sentence about it has to change in the same commit, and the person
 * making that change is working in this directory. A table of the same knowledge in the
 * speech stage would be edited by whoever next changed the speech stage — which is
 * nobody, until she says something wrong.
 *
 * This module imports nothing from the project on purpose, so that the speech stage
 * importing it can never close a cycle back through the tool registry.
 *
 * ## Nothing here may emit an identifier
 *
 * Half of these outputs are mostly ids: `taskId`, `memoryId`, `preferenceId`,
 * `identityId`, and a `subject` that *is* an identity id whenever the fact is about the
 * speaker. Stage 9's internal-scrubbing patterns do not know those shapes, so a sentence
 * built from them would reach the caller intact. Every value that ends up in a sentence
 * goes through `readable()` first, and a description that cannot be built without an id
 * is not built at all — the caller gets the generic line, which is vaguer and true.
 *
 * ## What a missing description means
 *
 * `undefined`, not a guess. A tool with no case here ran and verified, and the only
 * honest thing the application can say about it is that it happened. Inventing an outcome
 * from `description` or from the id's own words ("lock_door" → "the door is locked") would
 * be stage 9 asserting a state nothing read back.
 */

/** Where a description is read from. `output` is `unknown`: it has been through JSON. */
export interface CompletedAction {
  toolId: string;
  output?: unknown | undefined;
}

export interface DescribeOptions {
  /**
   * Who is being spoken to. A fact whose subject is this identity is rendered "you";
   * a fact about anyone else is rendered not at all, because the only other thing the
   * output carries there is an id.
   */
  callerId?: string | undefined;
  /** The instant "today" and "tomorrow" are measured from. Injectable for tests. */
  now?: number | undefined;
}

/**
 * A clause naming what is now true, or `undefined` when nothing can be said safely.
 *
 * Reads as the tail of a sentence — "Done — " + this — and stands on its own.
 */
export function describeOutcome(action: CompletedAction, opts: DescribeOptions = {}): string | undefined {
  const out = action.output;
  if (typeof out !== 'object' || out === null) return undefined;
  const field = (name: string): string | undefined => readable(str(out, name));
  const now = opts.now ?? Date.now();

  switch (action.toolId) {
    case 'reminder.schedule': {
      const message = field('message');
      const dueAt = num(out, 'dueAt');
      if (message === undefined || dueAt === undefined) return undefined;
      return `the reminder for “${clip(message)}” is set for ${when(dueAt, now)}`;
    }

    case 'reminder.cancel':
      // The output is a task id and the word `cancelled`. The id is unsayable and the
      // rest of the sentence needs nothing else.
      return str(out, 'status') === 'cancelled' ? 'that reminder is cancelled' : undefined;

    case 'reminder.list': {
      const count = num(out, 'count');
      if (count === undefined) return undefined;
      if (count === 0) return 'there is nothing on your reminder list';
      const next = nextReminder(out, now);
      const many = `you have ${count === 1 ? 'one reminder' : `${count} reminders`} on the list`;
      return next === undefined ? many : `${many}, and the next is ${next}`;
    }

    case 'memory.remember_event': {
      const summary = field('summary');
      return summary === undefined ? undefined : `I have written down: “${clip(summary)}”`;
    }

    case 'memory.remember_fact': {
      const predicate = field('predicate');
      const object = field('object');
      // `subject` is an identity id when the fact is about the speaker, and there is no
      // name in this output to use for anyone else.
      const aboutCaller = opts.callerId !== undefined && str(out, 'subject') === opts.callerId;
      if (!aboutCaller || predicate === undefined || object === undefined) return undefined;
      return `I have it that you ${secondPerson(clip(predicate))} ${clip(object)}`;
    }

    case 'preference.set': {
      const key = field('key');
      const value = field('value');
      if (key === undefined || value === undefined) return undefined;
      return `I have ${clip(key)} down as ${clip(value)}`;
    }

    case 'memory.recall': {
      const count = num(out, 'count');
      if (count === undefined) return undefined;
      if (count === 0) return 'nothing I have stored matches that';
      return `I found ${count === 1 ? 'one thing' : `${count} things`} I had stored about that`;
    }

    default:
      return undefined;
  }
}

/** The soonest reminder in a list output, phrased, or nothing if the list is unreadable. */
function nextReminder(out: object, now: number): string | undefined {
  const list = (out as { reminders?: unknown }).reminders;
  if (!Array.isArray(list)) return undefined;

  let soonest: { message: string; dueAt: number } | undefined;
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const message = readable(str(entry, 'message'));
    const dueAt = num(entry, 'dueAt');
    if (message === undefined || dueAt === undefined) continue;
    if (soonest === undefined || dueAt < soonest.dueAt) soonest = { message, dueAt };
  }
  return soonest === undefined ? undefined : `“${clip(soonest.message)}” ${when(soonest.dueAt, now)}`;
}

/**
 * A due time as a person would say it.
 *
 * The server's own zone, because that is the clock `parseWhen` resolved "7 baje"
 * against; formatting the same instant in a different zone would name an hour he
 * never said.
 */
function when(at: number, now: number): string {
  const time = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(at))
    .replace(/\s?([ap])m$/i, ' $1m');

  const days = daysApart(now, at);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' }).format(new Date(at));
  return `on ${date} at ${time}`;
}

/** Whole calendar days between two instants, local — not a division by 86400000. */
function daysApart(from: number, to: number): number {
  const midnight = (at: number): number => {
    const d = new Date(at);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/**
 * A stored predicate, said back to the person it is about.
 *
 * `semantic_memory` keeps facts in the third person — "works at", "lives in", "studies",
 * "is" — because that is how a fact about anyone is written down and how a recall reads it
 * out. Addressed to the person themselves it has to agree with "you", or she says "I have
 * it that you works at infosys" and sounds like a translation.
 *
 * Only the first word inflects; "works at" keeps its preposition. Anything not recognised
 * is left exactly as stored, because a wrong guess at English morphology is worse than a
 * verb that was already right.
 */
function secondPerson(predicate: string): string {
  const [verb, ...rest] = predicate.split(' ');
  const tail = rest.length === 0 ? '' : ` ${rest.join(' ')}`;
  return `${IRREGULAR[verb?.toLowerCase() ?? ''] ?? deinflect(verb ?? '')}${tail}`;
}

const IRREGULAR: Record<string, string> = { is: 'are', was: 'were', has: 'have', does: 'do' };

function deinflect(verb: string): string {
  if (/[^aeiou]ies$/i.test(verb)) return `${verb.slice(0, -3)}y`; // studies → study
  if (/(?:ch|sh|ss|x|z|o)es$/i.test(verb)) return verb.slice(0, -2); // watches → watch
  if (/[^s]s$/i.test(verb)) return verb.slice(0, -1); // works → work
  return verb;
}

function str(source: unknown, name: string): string | undefined {
  const value = (source as Record<string, unknown>)[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function num(source: unknown, name: string): number | undefined {
  const value = (source as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The same text, unless it is an internal identifier.
 *
 * ULIDs are what this codebase generates for rows, and the prefixed forms are what its
 * identities and tasks look like. A caller has no use for any of them, and a sentence
 * that contains one has leaked the inside of the machine.
 */
function readable(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(text)) return undefined;
  if (/^(?:usr|tsk|mem|prf|cyc|evt|conv)[_-]/i.test(text)) return undefined;
  return text;
}

/** User content, at a length that belongs in a spoken sentence. */
function clip(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
