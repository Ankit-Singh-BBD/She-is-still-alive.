/**
 * Writing her origin story, and never writing it twice.
 *
 * These run against a real in-memory database with the real migrations, because every
 * interesting thing about `seedOrigin` is a database fact: what a second call sees, what a
 * row says about where it came from, and which tables stay empty.
 *
 * The three that matter most, in the order they would hurt:
 *
 *  - **Nothing is written twice.** This runs on every boot. A seed that appended would
 *    turn her self-knowledge into nineteen copies of itself by the end of the week, and
 *    retrieval would rank her own biography above everything he ever told her.
 *
 *  - **No row claims she was told any of it.** `createSemantic` defaults `sourceKind` to
 *    `'conversation'`. Taking that default would make installed knowledge indistinguishable
 *    from something he said — the honesty bug, one table deeper than usual.
 *
 *  - **Three tables stay empty.** She has observed nothing and learned nothing at the
 *    moment this runs, so a seeded `habit` or `learned_pattern` would be a lie about the
 *    mechanism rather than about the content.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { IdentityRepository } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import { ORIGIN_SOURCE, originStory, seedOrigin } from '@server/origin/index.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

/** A fixed instant, so `occurredAt` is something the test can assert rather than allow. */
const NOW = 1_764_000_000_000;

describe('seedOrigin', () => {
  let db: Database;
  let memory: MemoryRepository;
  let owner: Identity;

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    memory = new MemoryRepository(db);
    // A real row in `identity`, not a TypeScript literal. `semantic_memory.identity_id` and
    // `episodic_memory.identity_id` are foreign keys onto that table, so a fixture owner who
    // exists only in the test process cannot exercise the inserts this file is about — it
    // makes every insert here fail for a reason production would never hit, which is exactly
    // how it hid the `source_cycle` bug this suite now pins. It is also the real shape of
    // the call: `POST /api/bootstrap` seeds the owner it has just enrolled.
    owner = await new IdentityRepository(db).createIdentity({
      kind: 'owner',
      displayName: 'Ankit Singh',
      preferredName: 'Ankit',
    });
  });

  afterEach(() => {
    db.close();
    closeDatabase();
  });

  const seed = (): ReturnType<typeof seedOrigin> => seedOrigin({ memory, owner, now: NOW });

  /** How many rows a table holds, asked of the database rather than of the repository. */
  const rows = (table: string): number => {
    const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  };

  it('writes the whole story on a database that has none of it', () => {
    const story = originStory(owner);
    const expected = story.facts.aboutHer.length + story.facts.aboutHim.length;

    const report = seed();

    expect(report.factsWritten).toBe(expected);
    expect(report.makerWritten).toBe(true);
    expect(report.firstMemoryWritten).toBe(true);
    expect(report.changed).toBe(true);
    expect(rows('semantic_memory')).toBe(expected);
    expect(rows('relationship')).toBe(1);
    expect(rows('episodic_memory')).toBe(1);
  });

  it('writes nothing the second time, and says so', () => {
    const first = seed();
    const before = rows('semantic_memory');

    const second = seed();

    expect(second.factsWritten).toBe(0);
    expect(second.makerWritten).toBe(false);
    expect(second.firstMemoryWritten).toBe(false);
    // The flag a caller logs off. `start()` runs this on every boot; a report that said
    // "changed" every time would make the one boot that really did seed her unfindable.
    expect(second.changed).toBe(false);
    expect(rows('semantic_memory')).toBe(before);
    expect(rows('relationship')).toBe(1);
    expect(rows('episodic_memory')).toBe(1);
    expect(first.changed).toBe(true);
  });

  it('writes only what is missing, so the story can grow later', () => {
    seed();
    const one = memory.listSemantic(owner.id)[0];
    expect(one).toBeDefined();
    // Standing in for a nineteenth fact appearing in `story.ts` after she has been
    // running for a month: everything else is already there, and only the new line
    // should be written.
    db.raw.prepare('DELETE FROM semantic_memory WHERE id = ?').run(one?.id);

    const report = seed();

    expect(report.factsWritten).toBe(1);
    expect(report.changed).toBe(true);
  });

  it('leaves a fact he stated himself alone, even when it shares a predicate', () => {
    // The filter is `provenance.sourceCycleId === 'origin'`, not "any row with this
    // predicate". If it were the latter, something he actually said could suppress a fact
    // she is supposed to know about herself — and the row that suppressed it would look
    // like the cause of nothing.
    memory.createSemantic({
      identityId: owner.id,
      subject: 'Ankit',
      predicate: 'loves',
      object: 'the sound of rain',
      provenance: {
        sourceCycleId: 'some-real-cycle',
        sourceConversationId: 'some-real-conversation',
        sourceMessageIds: [],
        extractedAt: NOW,
        extractor: 'llm',
        confidence: 0.8,
        validatedBy: 'auto_policy',
      },
    });

    const report = seed();
    const loves = memory
      .listSemantic(owner.id)
      .filter((row) => row.predicate === 'loves')
      .map((row) => row.object);

    expect(loves).toHaveLength(2);
    expect(loves).toContain('the sound of rain');
    const story = originStory(owner);
    expect(report.factsWritten).toBe(story.facts.aboutHer.length + story.facts.aboutHim.length);
  });

  describe('what the rows say about where they came from', () => {
    it('says the system installed them, not that he mentioned them', () => {
      seed();
      for (const row of memory.listSemantic(owner.id)) {
        expect(row.sourceKind).toBe('system');
        // The marker is in the provenance, not in the dedicated `source_cycle` column —
        // that column is a foreign key onto `cycle_record`, and no cycle ran. The test
        // below pins the column and the constraint behind this choice.
        expect(row.sourceCycle).toBeUndefined();
        expect(row.provenance.sourceCycleId).toBe(ORIGIN_SOURCE);
        // No model was involved — the text is a literal in `story.ts` — and nobody
        // confirmed it, so `app_rule` is the only honest validator.
        expect(row.provenance.extractor).toBe('rule');
        expect(row.provenance.validatedBy).toBe('app_rule');
        expect(row.provenance.sourceMessageIds).toEqual([]);
        expect(row.provenance.extractedAt).toBe(NOW);
      }
    });

    /**
     * The regression this exists to prevent took the whole application down.
     *
     * `source_cycle` is the obvious home for the origin marker and `createSemantic` accepts
     * it, but `0003_domain.sql:130` makes it a foreign key onto `cycle_record(id)` and
     * `'origin'` is not a cycle, because no cycle ran. Writing it there did not record
     * something untrue — it threw `SQLITE_CONSTRAINT_FOREIGNKEY`, on the first
     * `POST /api/bootstrap` of a fresh install, *after* the owner row was committed. So the
     * 201 never arrived, the retry answered `already_bootstrapped`, and every `npm start`
     * from then on died in `start()`. One line, and she could not be enrolled or booted.
     *
     * Reading the column back through the repository would not catch it coming back: a
     * reintroduced value fails at the insert, not on the way out. So this asserts against
     * the database and the schema instead of against the mapped row.
     */
    it('leaves source_cycle NULL, because it is a foreign key onto cycles that never ran', () => {
      seed();

      const written = db.raw
        .prepare('SELECT source_cycle FROM semantic_memory')
        .all() as Array<{ source_cycle: string | null }>;
      expect(written.length).toBeGreaterThan(0);
      for (const row of written) expect(row.source_cycle).toBeNull();

      // The constraint that makes the line above mandatory rather than stylistic. If
      // `source_cycle` ever stops being a foreign key the choice is free again — and this
      // is where whoever changes it will be told.
      const ddl = db.raw
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'semantic_memory'`)
        .get() as { sql: string };
      expect(ddl.sql).toContain('FOREIGN KEY(source_cycle) REFERENCES cycle_record(id)');

      // And the pragma that makes the constraint bite at runtime rather than sit in the
      // schema being decorative.
      const fk = db.raw.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(fk.foreign_keys).toBe(1);
    });

    it('labels what is about her public and what is about him owner-only', () => {
      seed();
      const story = originStory(owner);
      const byPredicate = new Map(
        memory.listSemantic(owner.id).map((row) => [row.predicate, row] as const),
      );

      for (const fact of story.facts.aboutHer) {
        const row = byPredicate.get(fact.predicate);
        expect(row?.sensitivity, fact.predicate).toBe('public');
        expect(row?.subjectKind).toBe('system');
      }
      for (const fact of story.facts.aboutHim) {
        const row = byPredicate.get(fact.predicate);
        // Identity isolation already hides these from a guest, because they are stored
        // under his id — but that is a property of today's retrieval policy, and a label
        // that would be wrong if the policy changed is wrong now.
        expect(row?.sensitivity, fact.predicate).toBe('owner_only');
        expect(row?.subjectKind).toBe('owner');
      }
    });

    it('writes every fact with full confidence, which is honest here and rarely is', () => {
      seed();
      for (const row of memory.listSemantic(owner.id)) {
        expect(row.confidence).toBe(1);
      }
    });
  });

  describe('what it deliberately does not write', () => {
    it('invents no preference, no habit and no learned pattern', () => {
      seed();
      // She has been told nothing, has watched nothing happen twice, and has learned
      // nothing. A row in any of these would be a claim about the *mechanism* — that
      // something was observed — and no amount of true content would make it honest.
      expect(rows('preference')).toBe(0);
      expect(rows('habit')).toBe(0);
      expect(rows('learned_pattern')).toBe(0);
    });

    it('makes exactly one thing an event, and dates it to now', () => {
      seed();
      const episodic = memory.listEpisodic(owner.id);

      expect(episodic).toHaveLength(1);
      const first = episodic[0];
      // The only timestamp in the seed that means anything. Everything else predates her
      // or is timeless, and `occurredAt` is later used for ranking — so dating a fact
      // about the twelve stages to the moment of seeding would be a small fabrication in
      // a column that gets read.
      expect(first?.occurredAt).toBe(NOW);
      expect(first?.sourceKind).toBe('system');
      expect(first?.subjectKind).toBe('system');
      expect(first?.sensitivity).toBe('owner_only');
      expect(first?.importance).toBe(1);
      expect(first?.summary).toContain('Ankit');
      expect(first?.provenance.sourceCycleId).toBe(ORIGIN_SOURCE);
    });
  });

  describe('the one row in the relationship table', () => {
    it('names him, by the name he chose, as the one who made her', () => {
      seed();
      const all = memory.listRelationships(owner.id);

      expect(all).toHaveLength(1);
      expect(all[0]?.name).toBe('Ankit');
      expect(all[0]?.relation).toBe('the one who made her');
      expect(all[0]?.sensitivity).toBe('owner_only');
      // A retrieval weight, and there is nothing she should ever rank above him.
      expect(all[0]?.importance).toBe(1);
      expect(all[0]?.notes ?? '').not.toBe('');
    });

    it('is keyed on name and relation, because the table drops the origin marker', () => {
      seed();
      const again = seedOrigin({ memory, owner, now: NOW });
      expect(again.makerWritten).toBe(false);
      expect(rows('relationship')).toBe(1);
      // Worth stating in a test rather than only in a comment: `relationship` has no
      // `provenance_json` column, so `createRelationship` accepts a provenance and drops
      // it, and a re-read synthesises one claiming `sourceKind: 'conversation'` with the
      // row's own id as the cycle. That is a gap in the schema, not something the seed can
      // close from outside, and this asserts the shape as it actually is so nobody writes
      // a filter that depends on the marker surviving.
      expect(memory.listRelationships(owner.id)[0]?.provenance.sourceCycleId).not.toBe(
        ORIGIN_SOURCE,
      );
      expect(memory.listRelationships(owner.id)[0]?.sourceKind).toBe('conversation');
    });
  });
});
