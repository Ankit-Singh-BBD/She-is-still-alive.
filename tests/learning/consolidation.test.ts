/**
 * The out-of-band learner, driven through the real application.
 *
 * ## The defect this file holds closed
 *
 * `LearningPipeline.processCycle` was built, constructed at boot, named in the
 * boot banner — and called from nowhere but its own unit tests. The banner told
 * the operator that with no key "out-of-band learning keeps only what was
 * literally said", and out of band nothing ran at all. Every assertion here fails
 * if `ConsolidationSweep` stops being started, or stops being handed the
 * pipeline.
 *
 * So these tests assert on **committed effects** — a row in `semantic_memory`, a
 * cursor in `app_meta` — reached through `createApp`, `runtimeFor` and the full
 * twelve stages, then one `consolidation.pass()`.
 *
 * ## No key, on purpose
 *
 * `loadConfig({})` leaves `GOOGLE_API_KEY` unset, so `faculties` is `undefined`,
 * stage 10 falls back to `extractByRules` — which is English-only — and the
 * out-of-band extractor falls back to `RuleBasedLearningExtractor`, which reads
 * Hinglish too. That gap is not incidental to the test: it is the owner's actual
 * daily configuration, and "Mera naam Ankit hai" is a sentence the in-cycle path
 * keeps nothing from and this sweep does. When stage 10 learns Hinglish, this
 * sweep becomes the safety net it is meant to be rather than the only reader of
 * that sentence — and these tests keep passing, because they assert on the row,
 * not on which path wrote it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { ConsolidationSweep } from '@server/learning/consolidation.js';
import type { CycleRecord } from '@server/cognition/types.js';
// The record the *sweep* rebuilds from a row, which is a different, narrower type
// than the one a live cycle returns — same name, two modules.
import type { CycleRecord as StoredCycle } from '@server/learning/types.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

describe('A cycle the in-cycle learn stage kept nothing from is learned from later', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;

  const rows = (table: string): Array<Record<string, unknown>> =>
    db.raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

  const say = async (
    text: string,
    source: 'text' | 'system' = 'text',
  ): Promise<CycleRecord> => {
    const cycle = await app.runtimeFor(owner).runCycle({
      source,
      payload: { text },
      receivedAt: Date.now(),
      identityId: owner.id,
    });
    expect(cycle.status).toBe('completed');
    return cycle;
  };

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  it('keeps a name the in-cycle learn stage had no rule for', async () => {
    const cycle = await say('Mera naam Ankit hai');

    // The in-cycle path kept nothing: stage 10's rules are English-only, and
    // `mera naam … hai` is not among the intent recognizer's tools either. If
    // this expectation ever fails it is good news — stage 10 learned Hinglish —
    // and the assertion to change is this one, not the row assertions below.
    expect(rows('semantic_memory')).toHaveLength(0);
    expect(app.consolidation.cursor()).toBeUndefined();

    const report = await app.consolidation.pass();

    expect(report.errors).toEqual([]);
    expect(report.considered).toBe(1);
    expect(report.learnedFrom).toBe(1);
    expect(report.memories).toBeGreaterThanOrEqual(1);

    const semantic = rows('semantic_memory');
    expect(semantic).toHaveLength(1);
    expect(semantic[0]?.['subject']).toBe('speaker');
    expect(semantic[0]?.['predicate']).toBe('is named');
    expect(semantic[0]?.['object']).toBe('Ankit');
    expect(semantic[0]?.['identity_id']).toBe(owner.id);
    // Traceable back to the cycle it came from, which is also what stops the
    // next pass from writing it again.
    expect(semantic[0]?.['source_cycle']).toBe(cycle.id);
  });

  it('writes it once, with or without the cursor', async () => {
    await say('Mera naam Ankit hai');
    await app.consolidation.pass();
    expect(rows('semantic_memory')).toHaveLength(1);

    // What the cursor is for: the cycle is not read again at all, so the whole
    // mechanism costs at most one extraction per cycle for the life of the
    // database rather than a growing re-read of history.
    const second = await app.consolidation.pass();
    expect(second.considered).toBe(0);
    expect(second.memories).toBe(0);

    // What actually keeps the fact single. Delete the cursor — the case of a
    // restored backup, a rolled-back `app_meta`, a bug in this file — and the
    // pass reads the cycle again. The pipeline's own step 0 sees the row this
    // sweep wrote (`source_cycle` names the cycle) and refuses to be the second
    // writer. A lost cursor costs one wasted call, never a duplicate memory.
    db.raw.prepare('DELETE FROM app_meta WHERE key = ?').run('learning.consolidatedThrough');
    expect(app.consolidation.cursor()).toBeUndefined();

    const third = await app.consolidation.pass();
    expect(third.considered).toBe(1);
    expect(third.alreadyLearned).toBe(1);
    expect(third.memories).toBe(0);
    expect(rows('semantic_memory')).toHaveLength(1);
  });

  it('remembers how far it read, in a row an operator can read', async () => {
    const cycle = await say('Mera naam Ankit hai');
    await app.consolidation.pass();

    const stored = db.raw
      .prepare('SELECT completed_at FROM cycle_record WHERE id = ?')
      .get(cycle.id) as { completed_at: string };

    // Both halves, and `completedAt` byte-for-byte as the column holds it: the
    // keyset comparison in `candidates()` is a string comparison against that
    // column, so a reformatted timestamp here would silently re-read or skip.
    expect(app.consolidation.cursor()).toEqual({
      completedAt: stored.completed_at,
      cycleId: cycle.id,
    });

    const row = db.raw
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get('learning.consolidatedThrough') as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row?.value ?? 'null')).toEqual({
      completedAt: stored.completed_at,
      cycleId: cycle.id,
    });
  });

  it('declines a cycle the in-cycle path already learned from', async () => {
    await say('mujhe chai pasand hai');

    // Committed inside the cycle, by the intent recognizer's `preference.set`
    // rather than by a learn stage — but written with the cycle in its
    // provenance either way, which is all the guard reads.
    const preferences = rows('preference');
    expect(preferences.length).toBeGreaterThan(0);

    const report = await app.consolidation.pass();

    expect(report.considered).toBe(1);
    expect(report.alreadyLearned).toBe(1);
    expect(report.learnedFrom).toBe(0);
    expect(report.memories).toBe(0);
    expect(report.errors).toEqual([]);
    expect(rows('preference')).toHaveLength(preferences.length);
  });

  it('never asks the extractor about a cycle nobody spoke in', async () => {
    // A system trigger writes its incoming turn with `role: 'system'`, and a
    // proactive cycle writes no incoming turn at all. Both extractors read only
    // `role === 'user'`, so she cannot learn a fact from her own noticing — but
    // "the extractor returns nothing" and "the extractor is never called" are
    // different costs once a model is behind it. This asserts the second.
    await say('battery low', 'system');

    let asked = 0;
    const sweep = new ConsolidationSweep({
      db,
      learning: {
        processCycle: async () => {
          asked += 1;
          throw new Error('the extractor must not be asked about a cycle she was alone in');
        },
      },
      report: () => {},
    });

    const report = await sweep.pass();

    expect(asked).toBe(0);
    expect(report.considered).toBe(1);
    expect(report.nothingSaid).toBe(1);
    expect(report.memories).toBe(0);
    expect(report.errors).toEqual([]);
    // Advanced anyway: a cycle with nothing to learn from is finished with, and
    // re-reading it every pass forever would be the same waste as no cursor.
    expect(sweep.cursor()).toBeDefined();
  });

  it('hands the extractor the cycle its own verdict, not just the turns', async () => {
    // A stored cycle used to carry neither. `cycle_record` had an `output_json` column
    // that nothing filled and no column at all for the decision, so the record this
    // sweep rebuilt was a header — id, status, timing — and the model-backed extractor
    // was asked what was worth learning from a transcript with the cycle's own verdict
    // missing beside it. `describeDecision` and `describeAnswer` in the extractor
    // render exactly these two fields and returned `undefined` on every real row.
    await say('mujhe chai pasand hai');

    let seen: StoredCycle | undefined;
    const sweep = new ConsolidationSweep({
      db,
      learning: {
        processCycle: async (record) => {
          seen = record;
          return { learned: false, count: 0, details: [] };
        },
      },
      report: () => {},
    });
    await sweep.pass();

    // What she answered, as stage 9 authorized it.
    expect(JSON.parse(String(seen?.outputJson))).toMatchObject({ text: expect.any(String) });
    // And what she decided, parsed — the field is `unknown` because it comes out of a
    // JSON column, and the extractor guards every access into it.
    expect(seen?.authorizedDecision).toMatchObject({
      authorized: true,
      proposal: { action: expect.any(String) },
    });
  });

  it('reads a row written before the verdict columns, and one written badly', async () => {
    // This pass exists to read *old* rows, so it is the one place most likely to meet a
    // shape a version that no longer exists wrote. Neither costs more than a line of
    // the prompt, and a throw here would stall the cursor on the same row forever.
    const cycle = await say('mujhe chai pasand hai');
    db.raw
      .prepare(`UPDATE cycle_record SET decision_json = ?, output_json = NULL WHERE id = ?`)
      .run('{not json', cycle.id);

    let seen: StoredCycle | undefined;
    const sweep = new ConsolidationSweep({
      db,
      learning: {
        processCycle: async (record) => {
          seen = record;
          return { learned: false, count: 0, details: [] };
        },
      },
      report: () => {},
    });
    const report = await sweep.pass();

    expect(report.errors).toEqual([]);
    expect(seen?.authorizedDecision).toBeUndefined();
    expect(seen?.outputJson).toBeUndefined();
  });

  it('reads a batch at a time and says when more is waiting', async () => {
    const sweep = new ConsolidationSweep({
      db,
      learning: { processCycle: async () => ({ learned: false, count: 0, details: [] }) },
      report: () => {},
      cyclesPerPass: 2,
    });

    await say('Mera naam Ankit hai');
    await say('mujhe chai pasand hai');
    await say('my name is Ankit');

    const first = await sweep.pass();
    expect(first.considered).toBe(2);
    // The signal the sweep re-schedules itself faster on, so a first boot
    // against existing history drains in minutes instead of hours.
    expect(first.backlog).toBe(true);

    const second = await sweep.pass();
    expect(second.considered).toBe(1);
    expect(second.backlog).toBe(false);
  });
});

/**
 * `FLAG_LEARNING` had no consumer anywhere in the tree: `grep -rn 'flags\.learning'`
 * over `server`, `src` and `tests` returned nothing, so the banner printed it
 * among the flags that were on and turning it off changed nothing at all. These
 * two assertions are what make the flag real, and they are about the boot report
 * as much as the sweep — an operator who turns learning off is owed a line
 * saying what she stopped doing.
 */
describe('FLAG_LEARNING decides whether she goes back over old cycles', () => {
  let db: Database;
  let app: MadhuritaApp;

  const boot = async (env: Record<string, string>): Promise<MadhuritaApp> => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig(env), db, installGlobalDatabase: false });
    await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
    return app;
  };

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  it('runs the sweep when the flag is on, and stops it on shutdown', async () => {
    const report = await (await boot({})).start();

    expect(app.consolidation.isRunning()).toBe(true);
    expect(report.started.some((line) => line.startsWith('learning consolidation'))).toBe(true);

    await app.stop();
    expect(app.consolidation.isRunning()).toBe(false);
  });

  it('leaves the sweep stopped when the flag is off, and says so', async () => {
    const report = await (await boot({ FLAG_LEARNING: 'false' })).start();

    expect(app.consolidation.isRunning()).toBe(false);
    expect(report.started.some((line) => line.startsWith('learning consolidation'))).toBe(false);
    expect(report.absent.some((line) => line.startsWith('learning consolidation'))).toBe(true);
  });
});
