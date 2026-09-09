/**
 * What she says after an action, as the caller hears it.
 *
 * `describeOutcome` is the only thing standing between a verified tool call and a
 * sentence that names the machine instead of the outcome. It reads each tool's own
 * output, so every case here is written against the shape that tool's `outputSchema`
 * promises — and against the shapes it does not: the output has been through
 * `JSON.stringify` and back by the time stage 9 sees it, so a missing or wrong-typed
 * field is a normal input to this function, not an impossible one.
 *
 * The rule the whole file is really testing: **no identifier ever reaches a sentence.**
 * Half of these outputs are mostly ids, stage 9's internal-scrubbing patterns do not know
 * their shapes, and a description that needs one is not written at all.
 */

import { describe, it, expect } from 'vitest';
import { describeOutcome } from '@server/tools/outcomes.js';

/** A pinned local instant, so "today" and "tomorrow" are not decided by CI's clock. */
const NOW = new Date(2026, 8, 6, 15, 0, 0, 0).getTime();
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 8, day, hour, minute, 0, 0).getTime();

const OWNER = 'usr_00000000000000000000000001';
const describe_ = (toolId: string, output: unknown): string | undefined =>
  describeOutcome({ toolId, output }, { callerId: OWNER, now: NOW });

describe('describeOutcome', () => {
  it('says when a reminder is set, and what it is for', () => {
    const said = describe_('reminder.schedule', {
      taskId: '01M1V0V8E0XA1AAQ9SKJTBC0XE',
      identityId: OWNER,
      message: 'paani peena hai',
      dueAt: at(7, 7),
      channel: 'text',
    });

    expect(said).toBe('the reminder for “paani peena hai” is set for tomorrow at 7:00 am');
    expect(said).not.toContain('01M1V0V8E0XA1AAQ9SKJTBC0XE');
    expect(said).not.toContain(OWNER);
  });

  it('says today, tomorrow, or the date, for the same reminder', () => {
    const forDue = (dueAt: number): string | undefined =>
      describe_('reminder.schedule', { message: 'call ma', dueAt, channel: 'text' });

    expect(forDue(at(6, 19, 30))).toContain('today at 7:30 pm');
    expect(forDue(at(7, 7))).toContain('tomorrow at 7:00 am');
    expect(forDue(at(12, 9, 15))).toContain('on 12 September at 9:15 am');
  });

  it('describes the rest of the tools from their own output', () => {
    expect(describe_('reminder.cancel', { taskId: 'tsk_1', identityId: OWNER, status: 'cancelled' })).toBe(
      'that reminder is cancelled',
    );
    expect(describe_('preference.set', { preferenceId: 'prf_1', identityId: OWNER, key: 'chai', value: 'pasand nahi' })).toBe(
      'I have chai down as pasand nahi',
    );
    expect(describe_('memory.remember_event', { memoryId: 'mem_1', domain: 'episodic', summary: 'aaj pehli baar office gaya' })).toBe(
      'I have written down: “aaj pehli baar office gaya”',
    );
    expect(
      describe_('memory.remember_fact', { memoryId: 'mem_1', domain: 'semantic', subject: OWNER, predicate: 'works at', object: 'infosys' }),
    ).toBe('I have it that you work at infosys');
    expect(describe_('memory.recall', { identityId: OWNER, query: 'chai', count: 2, items: [] })).toBe(
      'I found 2 things I had stored about that',
    );
    expect(describe_('memory.recall', { identityId: OWNER, query: 'chai', count: 0, items: [] })).toBe(
      'nothing I have stored matches that',
    );
  });

  it('counts a reminder list and names the soonest one', () => {
    const said = describe_('reminder.list', {
      identityId: OWNER,
      count: 2,
      reminders: [
        { taskId: 'tsk_2', message: 'dawai', dueAt: at(9, 21) },
        { taskId: 'tsk_1', message: 'paani peena hai', dueAt: at(7, 7) },
      ],
    });

    expect(said).toBe('you have 2 reminders on the list, and the next is “paani peena hai” tomorrow at 7:00 am');
    expect(describe_('reminder.list', { identityId: OWNER, count: 0, reminders: [] })).toBe(
      'there is nothing on your reminder list',
    );
  });

  it('says a stored fact back in the person it is about', () => {
    // `semantic_memory` writes facts in the third person; addressed to him they have to
    // agree with "you", or she reads out "you works at infosys".
    const fact = (predicate: string, object: string): string | undefined =>
      describe_('memory.remember_fact', { subject: OWNER, predicate, object });

    expect(fact('works at', 'infosys')).toBe('I have it that you work at infosys');
    expect(fact('lives in', 'dilli')).toBe('I have it that you live in dilli');
    expect(fact('studies', 'law')).toBe('I have it that you study law');
    expect(fact('is', 'an engineer')).toBe('I have it that you are an engineer');
    // Nothing recognisable to change is left exactly as stored.
    expect(fact('grew up in', 'kanpur')).toBe('I have it that you grew up in kanpur');
  });

  it('will not build a sentence around an identifier', () => {
    // A fact about anyone but the caller carries no name in its output — only a subject
    // id — so there is nothing sayable and the generic line answers instead.
    expect(
      describe_('memory.remember_fact', { subject: 'usr_guest00000000000000000001', predicate: 'lives in', object: 'dilli' }),
    ).toBeUndefined();
    // And a field that *is* an id where content was expected is not passed through.
    expect(describe_('preference.set', { key: '01M1V0V8E0XA1AAQ9SKJTBC0XE', value: 'pasand hai' })).toBeUndefined();
    expect(describe_('memory.remember_event', { summary: 'tsk_00000001' })).toBeUndefined();
  });

  it('says nothing rather than guessing', () => {
    // A tool with no case here ran and verified; what it did is not knowable from an id.
    expect(describe_('lock_door', { ok: true })).toBeUndefined();
    // Output that did not survive the round trip in the shape the tool promised.
    expect(describe_('reminder.schedule', { message: 'paani', dueAt: 'tomorrow' })).toBeUndefined();
    expect(describe_('reminder.schedule', undefined)).toBeUndefined();
    expect(describe_('reminder.cancel', { taskId: 'tsk_1', status: 'pending' })).toBeUndefined();
    expect(describe_('memory.recall', { query: 'chai' })).toBeUndefined();
  });

  it('clips user content to the length of a spoken sentence', () => {
    const said = describe_('memory.remember_event', { summary: 'a'.repeat(200) });
    expect(said?.length).toBeLessThan(120);
    expect(said).toContain('…');
  });
});
