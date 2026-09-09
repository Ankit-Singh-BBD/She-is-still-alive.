/**
 * What a sentence actually leaves behind, driven through the real application.
 *
 * ## Why this file is separate from `recognizer.test.ts`
 *
 * The unit tests next door assert what the recogniser *proposes*. That is exactly
 * the kind of test that stayed green while the defect this module exists to fix was
 * live: seven tools were installed, every unit test over them passed, and no
 * sentence a person typed could reach one. So these tests assert on **committed
 * effects** — a row in `task`, a row in `episodic_memory`, a row in `preference` —
 * reached through `createApp`, `runtimeFor` and the full twelve stages, with the
 * authorization gate in place and no language faculty wired.
 *
 * Every assertion here fails if `decide: { intent: … }` is removed from
 * `server/app.ts`, however healthy the units underneath remain.
 *
 * ## No key, on purpose
 *
 * `loadConfig({})` leaves `GOOGLE_API_KEY` unset, so `faculties` is `undefined` and
 * stage 6 takes the deterministic path. That is the owner's actual daily
 * configuration, and it is the one in which the three real turns of the smoke run
 * produced `{"action":"respond"}` three times, no task row, and no memory.
 *
 * ## The clock is faked, the timers are not
 *
 * `runCycle` awaits real promises, so intercepting the timer queue would deadlock
 * it. Only `Date` is faked, pinned to a Sunday afternoon so that "kal 7 baje"
 * resolves to an instant this file can compute rather than one CI decides.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';

import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import type { CycleRecord, DecisionProposal } from '@server/cognition/types.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

/** Local Sunday afternoon, so "7 baje" is this evening and "kal 7 baje" is tomorrow. */
const NOW = new Date(2026, 8, 6, 15, 0, 0, 0);

const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 8, day, hour, minute, 0, 0).getTime();

describe('A sentence with no model behind it still reaches the tools', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;

  /** Every row of a table, as plain objects, for an assertion about what was kept. */
  const rows = (table: string): Array<Record<string, unknown>> =>
    db.raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

  const say = async (text: string): Promise<CycleRecord> => {
    const cycle = await app.runtimeFor(owner).runCycle({
      source: 'text',
      payload: { text },
      receivedAt: Date.now(),
      identityId: owner.id,
    });
    expect(cycle.status).toBe('completed');
    return cycle;
  };

  /** What stage 6 settled on, as the record carries it. */
  const decided = (cycle: CycleRecord): DecisionProposal => {
    if (cycle.authorizedDecision === undefined) throw new Error('cycle reached no decision');
    return cycle.authorizedDecision.proposal;
  };

  /** What stage 9 said, as the caller hears it. */
  const spoken = (cycle: CycleRecord): string => cycle.response?.text ?? '';

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    // No GOOGLE_API_KEY: `faculties` is undefined and stage 6 has no model to ask.
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
    vi.useRealTimers();
  });

  it('has no language faculty, which is the configuration under test', () => {
    expect(app.faculties).toBeUndefined();
  });

  it('leaves a task row for the reminder that used to be answered with a greeting', async () => {
    const cycle = await say('Kal mujhe 7 baje yaad dilana ki paani peena hai');

    expect(decided(cycle)).toMatchObject({
      action: 'execute_tool',
      toolId: 'reminder.schedule',
    });

    const tasks = rows('task');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ identity_id: owner.id, kind: 'reminder', status: 'pending' });
    expect(JSON.parse(String(tasks[0]?.['payload_json']))).toMatchObject({
      kind: 'reminder',
      message: 'paani peena hai',
    });
    // Tomorrow at 07:00 local, resolved from "kal … 7 baje" against the pinned now.
    expect(new Date(String(tasks[0]?.['due_at'])).getTime()).toBe(at(7, 7));
  });

  it('answers that reminder with the outcome, not with the name of the tool', async () => {
    // The row above is the effect; this is what he actually hears about it. The two are
    // asserted apart because they broke apart: the task was scheduled correctly and the
    // sentence about it read "Done — I ran reminder.schedule and checked it", which names
    // a mechanism he has no model of and carries nothing he can check. The message and
    // the resolved time are both his own words back — the second one resolved from "kal
    // … 7 baje" by the same clock the `due_at` assertion above uses.
    const said = spoken(await say('Kal mujhe 7 baje yaad dilana ki paani peena hai'));

    expect(said).toContain('paani peena hai');
    expect(said).toContain('tomorrow at 7:00 am');
    expect(said).not.toContain('reminder.schedule');
    // Nor any of the identifiers the tool's output is mostly made of.
    expect(said).not.toContain(owner.id);
    expect(said).not.toMatch(/\b[0-9A-HJKMNP-TV-Z]{26}\b/);
  });

  it('leaves an episodic memory with the hour still in it', async () => {
    const cycle = await say('Yaad rakho ki main subah 6 baje uthta hoon');

    expect(decided(cycle)).toMatchObject({
      action: 'execute_tool',
      toolId: 'memory.remember_event',
    });

    const episodic = rows('episodic_memory').filter((row) => row['source_kind'] === 'conversation');
    expect(episodic).toHaveLength(1);
    expect(episodic[0]).toMatchObject({
      identity_id: owner.id,
      summary: 'main subah 6 baje uthta hoon',
    });
  });

  it('leaves a preference keyed on the thing, so a later stance replaces this one', async () => {
    await say('mujhe chai pasand hai');
    expect(rows('preference')).toMatchObject([{ key: 'chai', value: 'pasand hai' }]);

    await say('nahi, mujhe chai pasand nahi hai');
    // Still one row: `preference.set` overwrites by key, which is only correct
    // because the key is the thing rather than the stance.
    expect(rows('preference')).toMatchObject([{ key: 'chai', value: 'pasand nahi' }]);
  });
});

/**
 * `FLAG_ACTIONS=false`, which until recently turned nothing off.
 *
 * The flag was assigned from env, printed in the boot banner among the ones that were
 * on, and read by nothing. Its meaning is now exactly one thing: `runtimeFor` withholds
 * the executor from stage 7. So the test has to assert on the *seam* rather than on a
 * config value — the same sentence as the block above, and what is different about
 * where it ends up.
 *
 * Three separate claims, because they broke apart once already:
 *
 *  1. Stage 6 still chooses the tool. Gating the decision instead of the boundary is
 *     what an earlier defect did, and it answered "Kal 7 baje yaad dilana" with a
 *     greeting and left no trace that anything had been declined.
 *  2. Nothing is committed. The `task` table is the effect the block above asserts is
 *     present; here its absence is the point.
 *  3. She says it did not happen — not that she could not confirm it. Those are two
 *     different sentences and the second one is a false claim about her own behaviour.
 */
describe('With actions switched off, she still decides — and says she did not act', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({ FLAG_ACTIONS: 'false' }), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  it('names the flag at boot, and says the decision survives it', async () => {
    const report = await app.start();
    const line = report.absent.find((entry) => entry.startsWith('actions —'));
    expect(line).toBeDefined();
    // The operator has to be told stage 6 still chooses the tool, or the first thing
    // they will do with this line is go looking for the bug in the recogniser.
    expect(line).toContain('FLAG_ACTIONS is off');
    expect(line).toContain('stage 6 still chooses the tool');
  });

  it('reaches the same decision, commits nothing, and refuses before dispatch', async () => {
    const cycle = await app.runtimeFor(owner).runCycle({
      source: 'text',
      payload: { text: 'Kal mujhe 7 baje yaad dilana ki paani peena hai' },
      receivedAt: Date.now(),
      identityId: owner.id,
    });

    // A refusal is a recorded outcome, not a thrown stage: the cycle is clean.
    expect(cycle.status).toBe('completed');
    expect(cycle.authorizedDecision?.proposal).toMatchObject({
      action: 'execute_tool',
      toolId: 'reminder.schedule',
    });

    expect(db.raw.prepare('SELECT * FROM task').all()).toHaveLength(0);

    const results = cycle.actionResults ?? [];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolId: 'reminder.schedule',
      attempted: false,
      success: false,
      verified: false,
    });
    expect(results[0]?.error).toContain('No tool executor is wired');
  });

  it('says nothing happened, rather than that she could not confirm it', async () => {
    const cycle = await app.runtimeFor(owner).runCycle({
      source: 'text',
      payload: { text: 'Kal mujhe 7 baje yaad dilana ki paani peena hai' },
      receivedAt: Date.now(),
      identityId: owner.id,
    });

    const said = cycle.response?.text ?? '';
    // `NOT_ATTEMPTED_NOTICE`. Matched on the clause that carries the claim rather than
    // on the whole string, so rewording the sentence does not fail the test — but
    // turning it back into "I started on that" does.
    expect(said).toContain('I did not do that');
    expect(said).toContain('nothing has changed on your side');
    expect(said).not.toContain('I started on that');
    expect(said).not.toContain('could not confirm');
    // And not a word about why. Three of the four refusal reasons are the inside of
    // the machine, and the flag's name is not something he has any use for.
    expect(said).not.toContain('FLAG_ACTIONS');
    expect(said).not.toContain('executor');
    expect(said).not.toContain('reminder.schedule');
  });
});
