/**
 * B09.s2 — Knowledge Retrieval Policy: DB-first filters, bounded paging, held-out recall.
 *
 * The five acceptance tests for B09.s2:
 *
 *  1. SQL-level identity isolation and sensitivity gating — a non-owner's query never
 *     reads rows they have no business seeing, enforced in the WHERE clause rather than
 *     in JS after the fact.
 *  2. Candidate ceiling truncation — when a domain holds more rows than the scan was
 *     allowed to score, the result says so (`truncated: true`) rather than presenting
 *     a partial ranking as what the whole store had to offer.
 *  3. Ranked offset paging — `offset` pages through the top-scoring items, not through
 *     raw recency, so page 2 of a question is the second-best answers to it.
 *  4. Correction ancestry linkage — when a returned item exists because something older
 *     was corrected, `correctedFromId` names the source memory.
 *  5. Held-out Hinglish paraphrase recall — a memory written with one Hinglish spelling
 *     is retrieved by a stimulus using a different Hinglish spelling of the same word,
 *     via phonetic normalization (`toRomanHinglish` + vowel-length folding).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import { MemoryCorrections } from '@server/memory/corrections.js';
import type { MemoryProvenance, RetrievalRequest } from '@server/memory/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

const OWNER = '01HXOWNER00000000000000001';
const PERSON = '01HXPERSON0000000000000001';

function provenance(cycleId: string): MemoryProvenance {
  return {
    sourceCycleId: cycleId,
    sourceConversationId: '01HX0000000000000000000002',
    sourceMessageIds: ['01HX0000000000000000000003'],
    extractedAt: Date.now(),
    extractor: 'rule',
    confidence: 0.9,
    validatedBy: 'owner_confirmation',
  };
}

function seedIdentities(db: Database): void {
  db.raw
    .prepare(
      `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
       VALUES (?, 'owner', 'Ankit', 'active', datetime('now'), datetime('now'))`,
    )
    .run(OWNER);
  db.raw
    .prepare(
      `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
       VALUES (?, 'person', 'Guest', 'active', datetime('now'), datetime('now'))`,
    )
    .run(PERSON);
}

describe('B09.s2 — DB-first filtering and bounded ranked retrieval', () => {
  let dir: string;
  let db: Database;
  let repo: MemoryRepository;
  let retrieval: MemoryRetrieval;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'madhurita-retrieval-'));
    db = new Database({ path: path.join(dir, 'test.db') });
    runMigrations(db, migrationsDir);
    seedIdentities(db);
    repo = new MemoryRepository(db);
    retrieval = new MemoryRetrieval(repo);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('enforces identity isolation and sensitivity gating in SQL, not JS', async () => {
    // Owner writes three preferences: one public, one person_shared, one owner_only.
    repo.setPreference({
      identityId: OWNER,
      key: 'public_info',
      value: 'visible to all',
      provenance: provenance('c1'),
      sensitivity: 'public',
    });
    repo.setPreference({
      identityId: OWNER,
      key: 'shared_info',
      value: 'visible to person',
      provenance: provenance('c2'),
      sensitivity: 'person_shared',
    });
    repo.setPreference({
      identityId: OWNER,
      key: 'private_info',
      value: 'owner only',
      provenance: provenance('c3'),
      sensitivity: 'owner_only',
    });

    // Person writes their own preference.
    repo.setPreference({
      identityId: PERSON,
      key: 'person_info',
      value: 'about person',
      provenance: provenance('c4'),
      sensitivity: 'person_shared',
    });

    // A row *about* the person that the owner alone may read. This is the case that
    // makes the sensitivity clause load-bearing: identity isolation lets it through
    // (it is the person's own row), so only the gate on sensitivity keeps it back.
    repo.setPreference({
      identityId: PERSON,
      key: 'person_note_info',
      value: 'what the owner privately noted',
      provenance: provenance('c5'),
      sensitivity: 'owner_only',
    });

    // Owner reads everything.
    const ownerAsk: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'info',
      domains: ['preference'],
      limit: 10,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };
    const ownerResult = await retrieval.retrieve(ownerAsk);
    expect(ownerResult.items).toHaveLength(5);

    // Identity Isolation, as the policy states it: a non-owner reads only rows about
    // themselves. `person_shared` means "the owner, or the person the item is about"
    // — so the owner's own `public`/`person_shared` rows are still not the person's to
    // read, and their `identity_id` predicate excludes them in SQL before any row is
    // mapped into this process.
    const personAsk: RetrievalRequest = {
      callerId: PERSON,
      callerKind: 'person',
      query: 'info',
      domains: ['preference'],
      limit: 10,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };
    const personResult = await retrieval.retrieve(personAsk);
    const keys = personResult.items.map((i) => i.key);
    expect(keys).toEqual(['person_info']);
    // Excluded by Identity Isolation — the owner's rows, whatever their sensitivity.
    expect(keys).not.toContain('public_info');
    expect(keys).not.toContain('shared_info');
    expect(keys).not.toContain('private_info');
    // Excluded by Sensitivity Gating alone — isolation would have allowed it.
    expect(keys).not.toContain('person_note_info');
  });

  /**
   * The filters above must be in the WHERE clause, not a `.filter()` after six tables
   * have been read. The distinction is invisible from the items alone — both orders
   * return the same list — so it is asserted where it shows: the repository call the
   * retrieval layer makes returns only the rows the caller may read.
   */
  it('excludes forbidden rows in SQL rather than after loading them', () => {
    repo.setPreference({
      identityId: OWNER,
      key: 'owner_secret',
      value: 'private',
      provenance: provenance('c1'),
      sensitivity: 'owner_only',
    });
    repo.setPreference({
      identityId: PERSON,
      key: 'person_open',
      value: 'shared',
      provenance: provenance('c2'),
      sensitivity: 'person_shared',
    });

    // The scope a non-owner's request produces, passed to the repository directly.
    const rows = repo.listPreferences({
      identityId: PERSON,
      allowedSensitivities: ['public', 'person_shared'],
      limit: 100,
    });

    expect(rows.map((r) => r.key)).toEqual(['person_open']);

    // And an empty allow-list means nothing, not "no filter" — `IN ()` is not valid
    // SQL, so a caller permitted to read no sensitivity at all must get no rows.
    expect(repo.listPreferences({ identityId: PERSON, allowedSensitivities: [] })).toHaveLength(0);
  });

  it('reports truncation when a domain scan reaches the candidate ceiling', async () => {
    // A tiny ceiling, so the bound can be reached without filling the database.
    const bounded = new MemoryRetrieval(repo, { candidateCeiling: 3 });

    for (let i = 0; i < 5; i++) {
      repo.setPreference({
        identityId: OWNER,
        key: `pref_${i}`,
        value: `value ${i}`,
        provenance: provenance(`c${i}`),
      });
    }

    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'pref value',
      domains: ['preference'],
      limit: 10,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };

    // The answer is honest about being partial: five rows exist, three were scored.
    const capped = await bounded.retrieve(ask);
    expect(capped.truncated).toBe(true);
    expect(capped.items).toHaveLength(3);
    // `total` counts what was scored, and says so — it is a floor, not a census.
    expect(capped.total).toBe(3);

    // The same store, scanned by a retrieval whose ceiling is above the row count:
    // nothing was left out, and the result does not claim otherwise.
    const whole = new MemoryRetrieval(repo, { candidateCeiling: 50 });
    const full = await whole.retrieve(ask);
    expect(full.truncated).toBe(false);
    expect(full.items).toHaveLength(5);
    expect(full.total).toBe(5);
  });

  /**
   * The paging clause is deliberately not in SQL. Preferences come back ordered by
   * `key ASC`, so a `LIMIT/OFFSET` on the scan would page alphabetically — page 1 of
   * "nickname" would be whatever sorts first, which may match nothing at all. The
   * keys below are chosen so the two orders disagree: alphabetically `aaa_colour`
   * leads, by relevance `zzz_nickname` does.
   */
  it('pages through ranked items, not through the scan order', async () => {
    repo.setPreference({
      identityId: OWNER,
      key: 'aaa_colour',
      value: 'dark',
      provenance: provenance('c1'),
    });
    repo.setPreference({
      identityId: OWNER,
      key: 'mmm_address_form',
      value: 'Ankit',
      provenance: provenance('c2'),
    });
    repo.setPreference({
      identityId: OWNER,
      key: 'zzz_nickname',
      value: 'Bunty',
      provenance: provenance('c3'),
    });

    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'zzz_nickname Bunty',
      domains: ['preference'],
      limit: 1,
      recencyWeight: 0.1,
      importanceWeight: 0.1,
      similarityWeight: 0.8,
      excludeSoftDeleted: true,
    };

    // Page 1 is the best answer to the question, not the first row of the scan.
    const page1 = await retrieval.retrieve(ask);
    expect(page1.items.map((i) => i.key)).toEqual(['zzz_nickname']);

    // Page 2 continues down the ranking, and does not repeat page 1.
    const page2 = await retrieval.retrieve({ ...ask, offset: 1 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.key).not.toBe('zzz_nickname');

    // Together the pages cover the ranking exactly once — no row seen twice, none
    // dropped between pages.
    const page3 = await retrieval.retrieve({ ...ask, offset: 2 });
    const paged = [page1, page2, page3].flatMap((p) => p.items.map((i) => i.key));
    expect([...paged].sort()).toEqual(['aaa_colour', 'mmm_address_form', 'zzz_nickname']);

    // Past the end is empty, not a wrapped-around first page.
    const past = await retrieval.retrieve({ ...ask, offset: 3 });
    expect(past.items).toHaveLength(0);
    // And `total` still reports everything that was ranked, not the size of the page.
    expect(past.total).toBe(3);
  });

  it('attaches correctedFromId when a returned item is a correction', async () => {
    const before = repo.setPreference({
      identityId: OWNER,
      key: 'address_form',
      value: 'boss',
      provenance: provenance('c1'),
    });

    const corrections = new MemoryCorrections(db);
    corrections.correctPreference({
      identityId: OWNER,
      key: 'address_form',
      newValue: 'Ankit',
      reason: 'boss -> Ankit',
      provenance: provenance('c2'),
    });

    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'address_form',
      domains: ['preference'],
      limit: 5,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };

    const retrieved = await retrieval.retrieve(ask);
    expect(retrieved.items).toHaveLength(1);
    const item = retrieved.items[0];
    expect(item?.value).toBe('Ankit');
    expect(item?.correctedFromId).toBe(before.id);
  });

  it('recalls a Hinglish memory via a paraphrased Hinglish stimulus', async () => {
    // Store a preference with one Hinglish spelling.
    repo.setPreference({
      identityId: OWNER,
      key: 'greeting',
      value: 'theek hoon, shukriya', // "theek" (ठीक), "hoon" (हूँ), "shukriya" (शुक्रिया)
      provenance: provenance('c1'),
    });

    // Recall with a different Hinglish spelling of the same words.
    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'thik hun shukria', // vowel-length variants: ee->i, oo->u, iya->ia
      domains: ['preference'],
      limit: 5,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };

    const result = await retrieval.retrieve(ask);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.value).toBe('theek hoon, shukriya');
  });

  it('recalls a Devanagari memory via a Roman Hinglish stimulus', async () => {
    // Store a preference in Devanagari.
    repo.setPreference({
      identityId: OWNER,
      key: 'status',
      value: 'सब ठीक है', // "sab theek hai"
      provenance: provenance('c1'),
    });

    // Recall with a Roman Hinglish query.
    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'sab thik hai',
      domains: ['preference'],
      limit: 5,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };

    const devanagariResult = await retrieval.retrieve(ask);
    expect(devanagariResult.items).toHaveLength(1);
    expect(devanagariResult.items[0]?.value).toBe('सब ठीक है');
  });

  it('never serves a cached answer across a plain write', async () => {
    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'color',
      domains: ['preference'],
      limit: 5,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };

    // First read: no results, and the cache is primed.
    const empty = await retrieval.retrieve(ask);
    expect(empty.items).toHaveLength(0);
    expect(empty.fromCache).toBe(false);

    // Second read: served from cache.
    const cached = await retrieval.retrieve(ask);
    expect(cached.fromCache).toBe(true);

    // Write a new preference.
    repo.setPreference({
      identityId: OWNER,
      key: 'color',
      value: 'blue',
      provenance: provenance('c1'),
    });

    // Third read: the write moved the fingerprint, so the cache is invalid.
    const fresh = await retrieval.retrieve(ask);
    expect(fresh.fromCache).toBe(false);
    expect(fresh.items).toHaveLength(1);
    expect(fresh.items[0]?.value).toBe('blue');
  });
});
