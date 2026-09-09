/**
 * Reading an intent out of a sentence, with no model in the process.
 *
 * ## Why this file exists
 *
 * Seven tools are installed at boot and, until `server/cognition/intent/`, not one
 * of them could ever be chosen without a `GOOGLE_API_KEY`. The evidence was a real
 * run: three turns typed into a live server, `cycle.decided` recording
 * `{"action":"respond"}` for all three, and a database with no `task` row and no
 * memory whose `source_cycle` was set — including for the turn that said "kal
 * mujhe 7 baje yaad dilana ki paani peena hai". The tool that would have done it
 * was registered and idle.
 *
 * So the cases below are the sentences a person actually types, in the register
 * they actually type them in. Hinglish is not a nice-to-have here: it is what she
 * is spoken to in, and a recogniser that only read English would leave the same
 * gap with more code in it.
 *
 * ## The clock is passed, not faked
 *
 * `parseWhen` and `propose` both take `now`. That is deliberate — every expectation
 * about a resolved time is arithmetic against a fixed instant rather than against
 * the machine the suite runs on, and it needs no fake timers to be stable.
 *
 * NOW is a Sunday afternoon, local: 2026-09-06 15:00. Local matters, because a
 * reminder is set in the caller's own day and `parseWhen` resolves through
 * `Date#setHours`.
 */

import { describe, it, expect } from 'vitest';

import { createIntentRecognizer, parseWhen } from '@server/cognition/intent/index.js';
import type { IdentifiedStimulus } from '@server/cognition/types.js';
import type { PermissionSet } from '@server/identity/types.js';

const NOW = new Date(2026, 8, 6, 15, 0, 0, 0).getTime();

/** Every tool `installCoreTools` installs, so the recogniser is never the limit. */
const ALL_TOOLS = [
  'memory.remember_event',
  'memory.remember_fact',
  'preference.set',
  'memory.recall',
  'reminder.schedule',
  'reminder.cancel',
  'reminder.list',
];

const OWNER_PERMISSIONS: PermissionSet = {
  mayReadMemories: true,
  mayReadConversations: true,
  mayTriggerActions: 'all',
  mayEnrollNewKnowledge: true,
  mayMutatePreferences: true,
  mayAccessTools: ALL_TOOLS,
  mayBeHeardInVoice: true,
  mayReceiveProactiveMessages: true,
};

const at = (year: number, month: number, day: number, hour: number, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute, 0, 0).getTime();

/** A stimulus in the shape stage 2 hands to stage 6. */
const heard = (
  text: string,
  inputType: IdentifiedStimulus['inputType'] = 'user_message',
): IdentifiedStimulus => ({
  source: 'text',
  payload: { text },
  receivedAt: NOW,
  identityId: 'identity-1',
  identityKind: 'owner',
  callerPermissions: OWNER_PERMISSIONS,
  inputType,
});

describe('parseWhen', () => {
  it('resolves a day word and a marked clock together', () => {
    const when = parseWhen('kal subah 7 baje yaad dilana', NOW);
    expect(when).toEqual({ kind: 'at', dueAt: at(2026, 9, 7, 7), label: 'kal subah 07:00' });
  });

  it('reads a bare clock as the next time it comes round, not tomorrow morning', () => {
    // 15:00 on the day, so "7 baje" is this evening — the reading a person checking
    // their own watch would arrive at.
    const when = parseWhen('7 baje yaad dilana', NOW);
    expect(when).toEqual({ kind: 'at', dueAt: at(2026, 9, 6, 19), label: '19:00' });
  });

  it('moves a spoken hour into the window its part of day names', () => {
    expect(parseWhen('shaam 7 baje', NOW)).toMatchObject({ dueAt: at(2026, 9, 6, 19) });
    expect(parseWhen('subah 7 baje', NOW)).toMatchObject({ dueAt: at(2026, 9, 7, 7) });
  });

  it('reads "raat 11" and "raat 23" as the same instant', () => {
    const spoken = parseWhen('raat 11 baje', NOW);
    const written = parseWhen('raat 23 baje', NOW);
    expect(spoken).toMatchObject({ dueAt: at(2026, 9, 6, 23) });
    expect(written).toMatchObject({ dueAt: at(2026, 9, 6, 23) });
  });

  it('honours an am/pm marker over the part of day it would otherwise infer', () => {
    expect(parseWhen('kal 9 pm yaad dilana', NOW)).toMatchObject({ dueAt: at(2026, 9, 7, 21) });
    expect(parseWhen('kal 9 am yaad dilana', NOW)).toMatchObject({ dueAt: at(2026, 9, 7, 9) });
    expect(parseWhen('kal 12 am yaad dilana', NOW)).toMatchObject({ dueAt: at(2026, 9, 7, 0) });
  });

  it('reads minutes written after a colon with no other marker', () => {
    expect(parseWhen('7:30 pe yaad dilana', NOW)).toMatchObject({ dueAt: at(2026, 9, 6, 19, 30) });
  });

  it('reads a duration in digits and in words', () => {
    expect(parseWhen('20 minute baad yaad dilana', NOW)).toEqual({
      kind: 'at',
      dueAt: NOW + 20 * 60_000,
      label: '20 minutes from now',
    });
    expect(parseWhen('do ghante baad yaad dilana', NOW)).toEqual({
      kind: 'at',
      dueAt: NOW + 2 * 3_600_000,
      label: '2 hours from now',
    });
  });

  it('reads a duration before a clock, so "20 minute baad" is not twenty past', () => {
    const when = parseWhen('20 minute baad 5 baje yaad dilana', NOW);
    expect(when).toMatchObject({ dueAt: NOW + 20 * 60_000 });
  });

  it('names a day with no hour as a day, and refuses to pick the hour', () => {
    expect(parseWhen('kal yaad dilana', NOW)).toEqual({ kind: 'dayOnly', label: 'kal' });
    expect(parseWhen('kal subah yaad dilana', NOW)).toEqual({ kind: 'dayOnly', label: 'kal subah' });
    expect(parseWhen('shaam ko yaad dilana', NOW)).toEqual({ kind: 'dayOnly', label: 'shaam' });
  });

  it('does not read a bare number as a clock', () => {
    // The whole reason `CLOCK_MARKED` requires a marker: two litres of water is not
    // two o'clock, and a reminder for 02:00 would fire and be believed.
    expect(parseWhen('2 litre paani peena hai', NOW)).toBeUndefined();
    expect(parseWhen('30 push ups karne hain', NOW)).toBeUndefined();
  });

  it('names no time when the sentence contains none', () => {
    expect(parseWhen('yaad dilana', NOW)).toBeUndefined();
    expect(parseWhen('', NOW)).toBeUndefined();
  });

  it('rejects an impossible clock rather than clamping it', () => {
    expect(parseWhen('99:99 pe yaad dilana', NOW)).toBeUndefined();
  });
});

describe('createIntentRecognizer', () => {
  const recognizer = createIntentRecognizer({ availableTools: ALL_TOOLS });

  it('turns the sentence that used to be answered with a greeting into a reminder', () => {
    // The exact turn from the smoke run whose `cycle.decided` read
    // `{"action":"respond"}` and whose database held no task row.
    const proposal = recognizer.propose(
      heard('Kal mujhe 7 baje yaad dilana ki paani peena hai'),
      NOW,
    );

    expect(proposal).toEqual({
      action: 'execute_tool',
      toolId: 'reminder.schedule',
      toolInput: { message: 'paani peena hai', dueAt: at(2026, 9, 7, 7) },
      rationale: expect.stringContaining('kal 07:00'),
    });
  });

  it('states the resolved instant in the rationale, so a wrong reading is on the record', () => {
    const proposal = recognizer.propose(heard('20 minute baad yaad dilana ki dawai leni hai'), NOW);

    expect(proposal?.rationale).toContain(new Date(NOW + 20 * 60_000).toISOString());
    expect(proposal?.toolInput).toEqual({ message: 'dawai leni hai', dueAt: NOW + 20 * 60_000 });
  });

  it('takes the time out of a reminder message, including one spoken in words', () => {
    // The hour is already in `dueAt`. Left in the message it would be read back
    // aloud two hours later, when it is no longer true.
    const proposal = recognizer.propose(heard('do ghante baad yaad dila do ki dawai leni hai'), NOW);

    expect(proposal?.toolInput).toEqual({
      message: 'dawai leni hai',
      dueAt: NOW + 2 * 3_600_000,
    });
  });

  it('leaves no dangling particle where the instruction was', () => {
    const hinglish = recognizer.propose(
      heard('kal 7 baje ka reminder laga do ki bijli ka bill bharna hai'),
      NOW,
    );
    expect(hinglish?.toolInput).toMatchObject({ message: 'bijli ka bill bharna hai' });

    const english = recognizer.propose(heard('remind me to buy milk at 7 pm'), NOW);
    expect(english?.toolInput).toMatchObject({ message: 'buy milk' });
  });

  it('keeps the hour when the hour is the content', () => {
    // The mirror of the case above, and the reason there are two strippers: here
    // nothing has read the time into a field, so "main uthta hoon" would be a
    // different sentence than the one he said.
    const proposal = recognizer.propose(heard('Yaad rakho ki main subah 6 baje uthta hoon'), NOW);

    expect(proposal).toEqual({
      action: 'execute_tool',
      toolId: 'memory.remember_event',
      toolInput: { summary: 'main subah 6 baje uthta hoon' },
      rationale: expect.stringContaining('kept as it was said'),
    });
  });

  it('reads a stated liking as a stance on the thing, not a list of likings', () => {
    // `preference.set` overwrites by key, so the key has to be the thing. Keyed on
    // the stance instead, every new liking would erase the last one.
    expect(recognizer.propose(heard('mujhe chai pasand hai'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'chai', value: 'pasand hai' },
    });
    expect(recognizer.propose(heard('mujhe chai pasand nahi hai'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'chai', value: 'pasand nahi' },
    });
  });

  it('reads the two unambiguous English forms too', () => {
    expect(recognizer.propose(heard('I like black coffee'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'black coffee', value: 'likes' },
    });
    expect(recognizer.propose(heard("I don't like coriander"), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'coriander', value: 'does not like' },
    });
  });

  it('reads a question about what she holds as a recall, not as a thing to hold', () => {
    expect(recognizer.propose(heard('tumhe yaad hai main kab uthta hoon?'), NOW)).toMatchObject({
      toolId: 'memory.recall',
      toolInput: { query: 'tumhe yaad hai main kab uthta hoon' },
    });
  });

  it('reads a question about the reminders before it reads one as a new reminder', () => {
    // "reminder set kiye hain kaunse?" satisfies both patterns. Asked first wins,
    // because scheduling a reminder in answer to a question about reminders is the
    // one reading that leaves a durable row nobody wanted.
    expect(recognizer.propose(heard('reminder set kiye hain kaunse?'), NOW)).toEqual({
      action: 'execute_tool',
      toolId: 'reminder.list',
      toolInput: {},
      rationale: expect.stringContaining('pending'),
    });
    expect(recognizer.propose(heard('kal ke reminders dikhao'), NOW)).toMatchObject({
      toolId: 'reminder.list',
    });
  });

  describe('asks instead of guessing', () => {
    it('when a reminder names no time at all', () => {
      expect(recognizer.propose(heard('mujhe yaad dilana'), NOW)).toEqual({
        action: 'clarify',
        rationale: expect.stringContaining('name no time'),
      });
    });

    it('when a reminder names a day and no hour', () => {
      // Not 09:00. A reminder set for a time nobody asked for will fire and be
      // believed.
      expect(recognizer.propose(heard('kal yaad dilana ki paani peena hai'), NOW)).toEqual({
        action: 'clarify',
        rationale: expect.stringContaining('names a day and not an hour'),
      });
    });

    it('when a bare number is the only number in the sentence', () => {
      expect(
        recognizer.propose(heard('yaad dilana ki 2 litre paani peena hai'), NOW),
      ).toMatchObject({ action: 'clarify' });
    });

    it('when the time is there and nothing is left to say at it', () => {
      expect(recognizer.propose(heard('kal 7 baje yaad dilana'), NOW)).toEqual({
        action: 'clarify',
        rationale: expect.stringContaining('nothing left in the sentence'),
      });
    });

    it('when the only hour in the sentence has already gone by today', () => {
      expect(recognizer.propose(heard('aaj 7 baje yaad dilana ki paani peena hai'), NOW)).toEqual({
        action: 'clarify',
        rationale: expect.stringContaining('already passed'),
      });
    });
  });

  it('proposes nothing for the ordinary case, and lets stage 6 fall through', () => {
    expect(recognizer.propose(heard('Achha.'), NOW)).toBeUndefined();
    expect(recognizer.propose(heard('aaj mausam accha hai'), NOW)).toBeUndefined();
    expect(recognizer.propose(heard('   '), NOW)).toBeUndefined();
  });

  it('reads only words a person addressed to her', () => {
    // `server/autonomic/noticing.ts` writes a proactive trigger's payload as a
    // sentence too. Reading an imperative out of her own noticing would let her
    // instruct herself to act.
    const said = 'kal 7 baje yaad dilana ki paani peena hai';
    expect(recognizer.propose(heard(said, 'proactive_trigger'), NOW)).toBeUndefined();
    expect(recognizer.propose(heard(said, 'system_event'), NOW)).toBeUndefined();
    expect(recognizer.propose(heard(said, 'interrupt'), NOW)).toBeUndefined();
  });

  it('never names a tool this process did not install', () => {
    const withoutReminders = createIntentRecognizer({ availableTools: ['memory.recall'] });

    // A proposal naming an uninstalled tool would be a decision the executor must
    // fail, and it would read as capability on the cycle record.
    expect(withoutReminders.propose(heard('kal 7 baje yaad dilana ki dawai leni hai'), NOW)).toEqual(
      { action: 'clarify', rationale: expect.stringContaining('no reminder tool is installed') },
    );
    expect(withoutReminders.propose(heard('yaad rakho ki main chai peeta hoon'), NOW)).toBeUndefined();
  });

  it('trims a long message to what the tool schema accepts', () => {
    const long = `kal 7 baje yaad dilana ki ${'paani peena hai '.repeat(60)}`;
    const proposal = recognizer.propose(heard(long), NOW);

    expect(proposal?.toolId).toBe('reminder.schedule');
    expect((proposal?.toolInput as { message: string }).message.length).toBeLessThanOrEqual(500);
  });
});

/**
 * The script the provider actually transcribes, and the spellings the fold writes.
 *
 * `propose` folds every sentence with `toRomanHinglish` before a pattern sees it, so
 * nothing below is "Devanagari support" as a feature — it is the ordinary path.
 * Both doors deliver Devanagari: the live provider transcribes it, and a phone
 * keyboard types it.
 *
 * Before the fold the recogniser carried six Devanagari alternatives of its own, and
 * they did not merely miss — they corrupted. `\w` is ASCII, so the stripper for
 * `याद दिला` could not take its own inflection with it and left the Hindi negation
 * standing at the front: "कल 7 बजे याद दिलाना कि पानी पीना है" was scheduled with
 * the message **"ना कि पानी पीना है"** — the opposite of the request, to be read
 * back at 7am. "याद रखो कि …" was kept as a memory beginning "ो कि". `\bक्या\b`
 * could never match at all, because `\b` is defined over ASCII word characters.
 * Those are the first cases below, and they assert the content rather than only the
 * tool, because the tool was always right and the content was not.
 *
 * The rest are the obligation the fold creates. `toRomanHinglish` does not write the
 * spellings a person types: `याद` → `yad`, `रिमाइंडर` → `rimaindar`, `नोट` → `not`,
 * `अच्छा` → `achchha`, `नापसंद` → `napsand`, `तुम्हें` → `tumhen`, `मिनट` → `minat`,
 * `रात` → `rat`. A rule that knows only the hand-typed spelling is a rule she can no
 * longer be told in at all — out loud included, since the ear folds too.
 */
describe('one script, folded at the door', () => {
  const recognizer = createIntentRecognizer({ availableTools: ALL_TOOLS });

  it('stores a Devanagari reminder as the request, not as its own negation', () => {
    expect(recognizer.propose(heard('कल 7 बजे याद दिलाना कि पानी पीना है'), NOW)).toEqual({
      action: 'execute_tool',
      toolId: 'reminder.schedule',
      toolInput: { message: 'pani pina hai', dueAt: at(2026, 9, 7, 7) },
      rationale: expect.stringContaining('kal 07:00'),
    });
  });

  it('keeps a Devanagari memory whole, hour and all', () => {
    expect(recognizer.propose(heard('याद रखो कि मैं सुबह 6 बजे उठता हूं'), NOW)).toMatchObject({
      toolId: 'memory.remember_event',
      toolInput: { summary: 'main subah 6 baje uthta hun' },
    });
  });
  it('reads both directions of a Devanagari preference', () => {
    // `पसंद` used to match the detector and then always fall through the clause
    // reader, so this branch changed no outcome it was ever reached for.
    expect(recognizer.propose(heard('मुझे चाय पसंद है'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'chay', value: 'pasand hai' },
    });
    expect(recognizer.propose(heard('मुझे चाय पसंद नहीं है'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'chay', value: 'pasand nahi' },
    });
  });

  it('answers a Devanagari question about what she holds', () => {
    expect(recognizer.propose(heard('क्या तुम्हें याद है मैंने क्या कहा था?'), NOW)).toMatchObject({
      toolId: 'memory.recall',
    });
  });

  it('lists reminders asked for by their Devanagari name', () => {
    expect(recognizer.propose(heard('कौनसे रिमाइंडर लगे हैं?'), NOW)).toMatchObject({
      toolId: 'reminder.list',
    });
  });

  it('takes an instruction whose verb only exists in the folded spelling', () => {
    // `रिमाइंडर लगा दो` folds to `rimaindar laga do`, and both the detector and the
    // stripper have to know that spelling: the detector to reach the branch, the
    // stripper so the message is the errand and not the instruction.
    expect(recognizer.propose(heard('रिमाइंडर लगा दो कल 8 बजे दवाई लेनी है'), NOW)).toMatchObject({
      toolId: 'reminder.schedule',
      toolInput: { message: 'davai leni hai', dueAt: at(2026, 9, 7, 8) },
    });
    // `नोट कर लो` folds to `not kar lo` — where `not` is the transliteration of नोट
    // and nothing to do with the English word.
    expect(recognizer.propose(heard('नोट कर लो कि मेरा भाई दिल्ली में रहता है'), NOW)).toMatchObject({
      toolId: 'memory.remember_event',
      toolInput: { summary: 'mera bhai dilli men rahta hai' },
    });
  });
  it('reads a stance whose word only exists in the folded spelling', () => {
    // `अच्छा` folds to `achchha`, which is not a spelling anyone types by hand.
    expect(recognizer.propose(heard('मुझे अदरक वाली चाय अच्छा लगता है'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'adrak vali chay', value: 'pasand hai' },
    });
    // And the same word typed the three ways it is typed.
    for (const spelling of ['acha', 'achha', 'accha']) {
      expect(recognizer.propose(heard(`mujhe filter coffee ${spelling} lagta hai`), NOW)).toMatchObject({
        toolId: 'preference.set',
        toolInput: { key: 'filter coffee', value: 'pasand hai' },
      });
    }
  });

  it('reads a dislike as a dislike, whichever spelling carries it', () => {
    // This one was wrong on the Roman path too, and wrong in the worst way: `napasand`
    // *contains* `pasand`, so with no word boundary in front of it the liking branch
    // matched "…chai napasand hai" and stored **a liking of "chai na"** — his dislike
    // recorded as its own opposite, under a key with half the negation stuck to it.
    for (const said of ['mujhe chai napasand hai', 'mujhe chai napsand hai']) {
      expect(recognizer.propose(heard(said), NOW)).toMatchObject({
        toolId: 'preference.set',
        toolInput: { key: 'chai', value: 'pasand nahi' },
      });
    }
    // `नापसंद` folds to `napsand` — one `a` short of the hand-typed spelling.
    expect(recognizer.propose(heard('मुझे चाय नापसंद है'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'chay', value: 'pasand nahi' },
    });
    expect(recognizer.propose(heard('i hate coffee'), NOW)).toMatchObject({
      toolId: 'preference.set',
      toolInput: { key: 'coffee', value: 'does not like' },
    });
  });
  it('keeps a stance it cannot key, and stays quiet about a sentence that is not one', () => {
    // `readPreference` says in its own docstring that a stance it cannot split falls
    // through to `memory.remember_event`. It did not: it fell past `REMEMBER`, past
    // `RECALL`, and was answered as small talk and forgotten.
    expect(recognizer.propose(heard('mera favourite khana biryani hai'), NOW)).toMatchObject({
      toolId: 'memory.remember_event',
      toolInput: { summary: 'mera favourite khana biryani hai' },
    });

    // Which is exactly why the English negation may not be a bare "i don't". With a
    // keep-what-you-cannot-key fallback behind it, `\bi\s+don'?t\b` would have written
    // a memory for every "I don't know" ever typed at her.
    expect(recognizer.propose(heard("i don't know"), NOW)).toBeUndefined();
    expect(recognizer.propose(heard("i don't have time today"), NOW)).toBeUndefined();
    expect(recognizer.propose(heard('kaisi ho aaj?'), NOW)).toBeUndefined();
  });

  it('reads a time whose words only exist in the folded spelling', () => {
    // `मिनट` folds to `minat`, which `RELATIVE` did not have. A reminder that names a
    // duration and gets no time back is answered with "kab?" — she asks for what she
    // was just told.
    expect(parseWhen('20 मिनट बाद याद दिलाना', NOW)).toEqual({
      kind: 'at',
      dueAt: NOW + 20 * 60_000,
      label: '20 minutes from now',
    });
    // And the same request in words, which is the half of the old Devanagari
    // vocabulary that was never built: `RELATIVE` read `घंटे` and `RELATIVE_WORDS`,
    // beside it, could not read `दो`.
    expect(parseWhen('दो घंटे बाद याद दिलाना', NOW)).toMatchObject({
      dueAt: NOW + 2 * 3_600_000,
    });
  });

  it('keeps the part-of-day window when the part of day is spelled the way the fold spells it', () => {
    // The sharpest consequence of a missing fold spelling, because it is silent: with
    // `rat` unread, "raat 9 baje" carries no window, and a bare 9 asked at 07:00
    // resolves to the 9 that is two hours away. The reminder fires at breakfast for a
    // medicine that was meant for the night, and it will be believed.
    const morning = at(2026, 9, 6, 7);
    for (const said of ['raat 9 baje yaad dilana ki dawai leni hai', 'रात 9 बजे याद दिलाना कि दवाई लेनी है']) {
      expect(parseWhen(said, morning)).toMatchObject({ dueAt: at(2026, 9, 6, 21) });
    }
  });
});

