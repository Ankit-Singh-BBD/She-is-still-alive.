/**
 * Writing her origin story into memory, once, without ever writing it twice.
 *
 * `story.ts` is the content; this is the only thing that puts it in the database. It runs
 * at the one moment it can run — the instant an owner exists — and it has to be safe to
 * call on every boot after that, because the only way to know whether a database has been
 * seeded is to look.
 *
 * ## The provenance is the point
 *
 * Every row it writes carries `sourceKind: 'system'` and `sourceCycleId: 'origin'`. That
 * is not decoration: `MemoryRepository.createSemantic` defaults `sourceKind` to
 * `'conversation'` and `sensitivity` to `'person_shared'`, and a row that took those
 * defaults would claim she learned this from something he said. She did not. She was told
 * it by the application, before either of them had said anything, and a memory that
 * misreports where it came from is the honesty bug this whole codebase is built to avoid
 * — one table deeper than usual, and therefore harder to notice.
 *
 * ## Idempotency by content, not by a flag
 *
 * There is no "seeded" boolean anywhere. A flag records *that* seeding happened; the
 * question a second boot actually has is *which of these facts are already there* — and
 * the answer to that is in the rows themselves. So each domain is read back, narrowed to
 * rows this module wrote, and only what is missing is inserted. Extending `story.ts` later
 * therefore adds only the new lines on the next boot, with no migration and no new table.
 *
 * ## Why the marker is in the provenance and not in `source_cycle`
 *
 * `semantic_memory` has a dedicated `source_cycle` column, `createSemantic` accepts it, and
 * it is the obvious place to write `'origin'`. It is also a foreign key onto
 * `cycle_record(id)` (`0003_domain.sql:130`), and no cycle ran here — the entire point of
 * the seed is that it happens before she has thought about anything. So writing `'origin'`
 * into it did not merely misdescribe the row, it failed the insert: every fresh install
 * threw `SQLITE_CONSTRAINT_FOREIGNKEY` on its first `POST /api/bootstrap`, *after* the
 * owner row had already been committed, and then on every boot after that.
 *
 * `source_cycle` is therefore left NULL, which is the honest reading of "this row did not
 * come from a cycle", and the origin marker lives in `provenance_json`, which is free text
 * and is where `learning/pipeline.ts:196-203` already looks first. The episodic check below
 * had always keyed on the provenance for the same reason; the semantic one now matches it.
 * `tests/origin/seed.test.ts` pins both halves — the NULL column and the constraint that
 * makes it mandatory rather than stylistic.
 *
 * The semantic key is the **predicate alone**, not the subject and predicate together.
 * Four of the facts have his name as their subject, so keying on the pair would make a
 * renamed owner look like a new fact and write the whole set again. Predicates are unique
 * across the story instead, and `tests/origin/story.test.ts` fails if that ever stops
 * being true — which is the warning a second `'is'` fact needs, at the moment it is added.
 *
 * A consequence worth stating plainly: if he changes his name, the rows that name him keep
 * the old one. Rewriting them would mean soft-deleting her self-knowledge and re-inserting
 * it, and deciding that a rename should erase what she already believed is a decision, not
 * a detail. It is deliberately not made here.
 *
 * ## What the `relationship` table cannot be asked
 *
 * `relationship` has no `provenance_json` column — `createRelationship` accepts a
 * provenance and drops it, and `mapRelationshipRow` synthesises one on the way back out
 * that says `sourceKind: 'conversation'` and points `sourceCycleId` at the row's own id.
 * So the marker every other domain is filtered by does not survive a round trip here, and
 * the maker row is instead keyed on the two things the table does persist: her name for
 * him and the relation. That the row reads back claiming a conversational origin is a
 * pre-existing gap in the schema rather than something this module can fix from the
 * outside; it is recorded for the authoritative document instead of papered over with a
 * migration invented in passing.
 */

import type { Identity } from '@server/identity/types.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type { MemoryProvenance, Sensitivity, SubjectKind } from '@server/memory/types.js';

import { ORIGIN_SOURCE, originStory, type OriginFact } from './story.js';

/** What one call actually wrote, so a caller can log the first boot and stay quiet after. */
export interface OriginSeedReport {
  /** Semantic rows inserted. Zero on every boot after the first. */
  readonly factsWritten: number;
  /** Whether the `relationship` row naming him was inserted by this call. */
  readonly makerWritten: boolean;
  /** Whether the single episodic memory was inserted by this call. */
  readonly firstMemoryWritten: boolean;
  /** True when any of the above happened — the one thing a log line wants to know. */
  readonly changed: boolean;
}

export interface SeedOriginOptions {
  readonly memory: MemoryRepository;
  /** The owner. Her story is stored under his identity, and names him from it. */
  readonly owner: Identity;
  /** Injectable clock, for tests. Only affects `extractedAt` and `occurredAt`. */
  readonly now?: number;
}

/**
 * The provenance every origin row carries.
 *
 * `extractor: 'rule'` because no model was involved — the text is a literal in
 * `story.ts`. `validatedBy: 'app_rule'` for the same reason: nobody confirmed it, the
 * application asserts it. `confidence: 1` is honest here in a way it rarely is; these are
 * not inferences.
 */
function originProvenance(now: number): MemoryProvenance {
  return {
    sourceCycleId: ORIGIN_SOURCE,
    sourceConversationId: ORIGIN_SOURCE,
    sourceMessageIds: [],
    extractedAt: now,
    extractor: 'rule',
    confidence: 1,
    validatedBy: 'app_rule',
  };
}

/**
 * Writes whatever of her origin story is not there yet, and reports what it wrote.
 *
 * Safe to call on every boot, and safe to interrupt: because every row is keyed by its own
 * content, a seed that dies halfway leaves the rows it managed to write and the next call
 * finishes the job. That is why there is no transaction around this — a partial seed is
 * not a broken state, it is a shorter one.
 */
export function seedOrigin(options: SeedOriginOptions): OriginSeedReport {
  const { memory, owner } = options;
  const now = options.now ?? Date.now();
  const story = originStory(owner);
  const provenance = originProvenance(now);

  // Read back only what this module wrote. A fact he stated himself, in his own words,
  // that happens to share a predicate is not an origin row and must not block one.
  const known = new Set(
    memory
      .listSemantic(owner.id)
      .filter((row) => row.provenance.sourceCycleId === ORIGIN_SOURCE)
      .map((row) => row.predicate),
  );

  let factsWritten = 0;
  const writeFacts = (
    facts: readonly OriginFact[],
    subjectKind: SubjectKind,
    sensitivity: Sensitivity,
  ): void => {
    for (const fact of facts) {
      if (known.has(fact.predicate)) continue;
      memory.createSemantic({
        identityId: owner.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        // No `sourceCycle`. It is a foreign key onto `cycle_record`, and no cycle ran —
        // passing `ORIGIN_SOURCE` here is what made every first bootstrap throw. The marker
        // is in `provenance` instead; see the header.
        subjectKind,
        sensitivity,
        confidence: 1,
        sourceKind: 'system',
        provenance,
      });
      // Added as it is written, so a duplicate predicate inside `story.ts` cannot produce
      // two rows in a single pass either.
      known.add(fact.predicate);
      factsWritten += 1;
    }
  };

  writeFacts(story.facts.aboutHer, 'system', 'public');
  writeFacts(story.facts.aboutHim, 'owner', 'owner_only');

  // Keyed on name and relation, the only two things `relationship` persists that identify
  // a row — see the header on why the origin marker cannot be used here.
  const hasMaker = memory
    .listRelationships(owner.id)
    .some((row) => row.name === story.maker.name && row.relation === story.maker.relation);

  if (!hasMaker) {
    memory.createRelationship({
      ownerId: owner.id,
      name: story.maker.name,
      relation: story.maker.relation,
      notes: story.maker.notes,
      // She has exactly one of these and it is the person she was made for. Importance is
      // a retrieval weight, and there is nothing this should ever rank below.
      importance: 1,
      sensitivity: 'owner_only',
      confidence: 1,
      provenance,
    });
  }

  // Exactly one origin episodic row exists by design, so its presence is the whole
  // question — no need to key on the summary text, which contains his name and would
  // change if he renamed himself.
  const hasFirstMemory = memory
    .listEpisodic(owner.id)
    .some((row) => row.provenance.sourceCycleId === ORIGIN_SOURCE);

  if (!hasFirstMemory) {
    memory.createEpisodic({
      identityId: owner.id,
      summary: story.firstMemory.summary,
      details: story.firstMemory.details,
      // The only timestamp in the whole seed that means anything: this really is when it
      // happened. Every other row is knowledge, which is why none of them are episodic.
      occurredAt: now,
      importance: 1,
      subjectKind: 'system',
      sensitivity: 'owner_only',
      confidence: 1,
      sourceKind: 'system',
      provenance,
    });
  }

  return {
    factsWritten,
    makerWritten: !hasMaker,
    firstMemoryWritten: !hasFirstMemory,
    changed: factsWritten > 0 || !hasMaker || !hasFirstMemory,
  };
}
