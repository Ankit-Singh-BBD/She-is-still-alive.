/**
 * B09.s1 — Correctable memory.
 *
 * The defect this slice removes: `setPreference` overwrites the row for
 * `(identity_id, key)`, so a correction destroyed what was believed before it. There
 * was no link from the old assertion to the new one, no status that said "this was
 * corrected", and therefore no way for retrieval to prefer the correction — or for a
 * person to ask why she changed her mind.
 *
 * The gate (J08) is the last test here: a correction survives closing and reopening
 * the *file* database. An in-memory pass proves nothing about a restart.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { closeDatabase } from '@server/persistence/db.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { loadConfig } from '@server/config/env.js';
import { EventBus } from '@server/events/event-bus.js';
import type { PersistedDomainEvent } from '@server/events/types.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import { MemoryCorrections } from '@server/memory/corrections.js';
import type { MemoryProvenance, RetrievalRequest } from '@server/memory/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

const OWNER = '01HXOWNER00000000000000001';

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

/** Identities exist because every memory row has a foreign key to one. */
function seedIdentity(db: Database): void {
  db.raw
    .prepare(
      `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
       VALUES (?, 'owner', 'Ankit', 'active', datetime('now'), datetime('now'))`,
    )
    .run(OWNER);
}

describe('B09.s1 — corrections supersede rather than overwrite', () => {
  let dir: string;
  let dbPath: string;
  let db: Database;
  let repo: MemoryRepository;
  let corrections: MemoryCorrections;
  let bus: EventBus;
  let retrieval: MemoryRetrieval;
  let heard: PersistedDomainEvent[];

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'madhurita-corrections-'));
    dbPath = path.join(dir, 'test.db');
    db = new Database({ path: dbPath });
    runMigrations(db, migrationsDir);
    seedIdentity(db);
    repo = new MemoryRepository(db);
    bus = new EventBus(db);
    retrieval = new MemoryRetrieval(repo);
    heard = [];
    bus.subscribe((event) => {
      heard.push(event);
    }, ['memory.corrected']);
    corrections = new MemoryCorrections(db, { events: bus, retrieval });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('links old to new, marks the old one superseded, and keeps it readable', () => {
    const before = repo.setPreference({
      identityId: OWNER,
      key: 'address_form',
      value: 'boss',
      provenance: provenance('c1'),
    });

    // "Mujhe boss mat bolo, Ankit bolo."
    const result = corrections.correctPreference({
      identityId: OWNER,
      key: 'address_form',
      newValue: 'Ankit',
      reason: 'boss -> Ankit',
      provenance: provenance('c2'),
    });

    expect(result.oldPreferenceId).toBe(before.id);
    expect(result.newPreferenceId).not.toBe(before.id);

    const record = corrections.getCorrection(result.correctionId);
    expect(record?.oldMemoryId).toBe(before.id);
    expect(record?.newMemoryId).toBe(result.newPreferenceId);
    expect(record?.domain).toBe('preference');
    expect(record?.reason).toBe('boss -> Ankit');
    // Provenance is stored, not summarised away.
    expect(record?.provenance.sourceCycleId).toBe('c2');

    // History retained: the old row is still there, and still says what it said.
    const all = repo.listPreferences(OWNER, true);
    expect(all).toHaveLength(2);
    const old = all.find((p) => p.id === before.id);
    expect(old?.value).toBe('boss');
    expect(old?.lifecycleStatus).toBe('superseded');
  });

  it('retrieves the correction and excludes the superseded assertion', () => {
    repo.setPreference({
      identityId: OWNER,
      key: 'nickname',
      value: 'old_nick',
      provenance: provenance('c1'),
    });
    corrections.correctPreference({
      identityId: OWNER,
      key: 'nickname',
      newValue: 'new_nick',
      provenance: provenance('c2'),
    });

    const active = repo.listPreferences(OWNER, false);
    expect(active).toHaveLength(1);
    expect(active[0]?.value).toBe('new_nick');
    expect(active[0]?.lifecycleStatus).toBe('active');
  });

  it('survives closing and reopening the file database (J08)', () => {
    const before = repo.setPreference({
      identityId: OWNER,
      key: 'theme',
      value: 'light',
      provenance: provenance('c1'),
    });
    const result = corrections.correctPreference({
      identityId: OWNER,
      key: 'theme',
      newValue: 'dark',
      provenance: provenance('c2'),
    });

    db.close();

    const reopened = new Database({ path: dbPath });
    try {
      const repo2 = new MemoryRepository(reopened);
      const corrections2 = new MemoryCorrections(reopened);

      expect(corrections2.getCorrection(result.correctionId)?.newMemoryId).toBe(
        result.newPreferenceId,
      );

      const active = repo2.listPreferences(OWNER, false);
      expect(active).toHaveLength(1);
      expect(active[0]?.value).toBe('dark');

      const old = repo2.listPreferences(OWNER, true).find((p) => p.id === before.id);
      expect(old?.lifecycleStatus).toBe('superseded');
    } finally {
      reopened.close();
      // The afterEach close is now a second close on an already-closed handle;
      // point it at the live one so the hook stays honest.
      db = reopened;
    }
  });

  it('refuses to correct a preference that does not exist', () => {
    expect(() =>
      corrections.correctPreference({
        identityId: OWNER,
        key: 'nonexistent',
        newValue: 'value',
        provenance: provenance('c1'),
      }),
    ).toThrow(/No preference found/);
  });

  it('corrects a correction: the newest assertion is the one that supersedes', () => {
    repo.setPreference({
      identityId: OWNER,
      key: 'color',
      value: 'red',
      provenance: provenance('c1'),
    });
    const first = corrections.correctPreference({
      identityId: OWNER,
      key: 'color',
      newValue: 'blue',
      provenance: provenance('c2'),
    });
    const second = corrections.correctPreference({
      identityId: OWNER,
      key: 'color',
      newValue: 'green',
      provenance: provenance('c3'),
    });

    expect(second.oldPreferenceId).toBe(first.newPreferenceId);

    const active = repo.listPreferences(OWNER, false);
    expect(active).toHaveLength(1);
    expect(active[0]?.value).toBe('green');

    // Both earlier beliefs are retained, in order, and neither is active.
    const history = repo.listPreferences(OWNER, true).filter((p) => p.key === 'color');
    expect(history).toHaveLength(3);
    expect(history.filter((p) => p.lifecycleStatus === 'superseded')).toHaveLength(2);
    expect(corrections.listCorrections(OWNER)).toHaveLength(2);
  });

  /**
   * The two halves of the slice that are not rows: something downstream has to
   * *hear* a correction, and the next read must not answer from an answer
   * computed before it. Both were comments in the first draft of this file; a
   * comment is not a faculty, so they are asserted here.
   */
  it('appends memory.corrected durably and delivers it', async () => {
    repo.setPreference({
      identityId: OWNER,
      key: 'address_form',
      value: 'boss',
      provenance: provenance('c1'),
    });
    const result = corrections.correctPreference({
      identityId: OWNER,
      key: 'address_form',
      newValue: 'Ankit',
      reason: 'boss -> Ankit',
      provenance: provenance('c2'),
    });

    // Durable: the row is in the log, written in the correction's own transaction.
    const row = db.raw
      .prepare(`SELECT type, identity_id, payload_json FROM domain_event WHERE type = ?`)
      .get('memory.corrected') as { identity_id: string; payload_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row?.identity_id).toBe(OWNER);
    const payload = JSON.parse(row?.payload_json ?? '{}');
    expect(payload.correctionId).toBe(result.correctionId);
    expect(payload.key).toBe('address_form');
    expect(payload.oldMemoryId).toBe(result.oldPreferenceId);
    expect(payload.newMemoryId).toBe(result.newPreferenceId);

    // Delivered: subscribers run after the commit, so let the microtasks drain.
    await new Promise((r) => setImmediate(r));
    expect(heard.map((e) => e.type)).toContain('memory.corrected');
  });

  it('does not answer the next retrieval from a cache built before the correction', async () => {
    repo.setPreference({
      identityId: OWNER,
      key: 'address_form',
      value: 'boss',
      provenance: provenance('c1'),
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

    const first = await retrieval.retrieve(ask);
    expect(first.fromCache).toBe(false);
    expect(first.items[0]?.value).toBe('boss');

    // The cache is real, so the same question is served from it.
    const second = await retrieval.retrieve(ask);
    expect(second.fromCache).toBe(true);

    corrections.correctPreference({
      identityId: OWNER,
      key: 'address_form',
      newValue: 'Ankit',
      provenance: provenance('c2'),
    });

    const after = await retrieval.retrieve(ask);
    expect(after.fromCache).toBe(false);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.value).toBe('Ankit');
  });

  /**
   * The cache added for the clause above must not become a way to forget. An
   * ordinary write — no correction, nobody calling `invalidate()` — has to be
   * visible on the very next read, or every other slice that writes a memory and
   * reads it back (stage 10's dedupe, most of all) quietly regresses.
   */
  it('never serves a cached answer across a plain write', async () => {
    const ask: RetrievalRequest = {
      callerId: OWNER,
      callerKind: 'owner',
      query: 'nickname',
      domains: ['preference'],
      limit: 5,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };

    expect((await retrieval.retrieve(ask)).items).toHaveLength(0);
    expect((await retrieval.retrieve(ask)).fromCache).toBe(true);

    repo.setPreference({
      identityId: OWNER,
      key: 'nickname',
      value: 'Bunty',
      provenance: provenance('c1'),
    });

    const seen = await retrieval.retrieve(ask);
    expect(seen.fromCache).toBe(false);
    expect(seen.items[0]?.value).toBe('Bunty');

    // A soft delete is an update, so it moves the fingerprint too.
    const stored = repo.listPreferences(OWNER, false)[0];
    repo.softDeletePreference(stored!.id, OWNER);
    const gone = await retrieval.retrieve(ask);
    expect(gone.fromCache).toBe(false);
    expect(gone.items).toHaveLength(0);
  });
});

/**
 * J08, at the level the gate is actually written for.
 *
 * The tests above prove the rows and the cache. This one proves the *application*:
 * the real composition root, over a real file on disk, shut down and started again
 * — which is the only way to show that what she would say next follows the
 * correction rather than the belief it replaced.
 */
describe('B09.s1 — J08: a correction survives a restart of the whole app', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'madhurita-j08-'));
    dbPath = path.join(dir, 'app.db');
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(): Promise<MadhuritaApp> {
    const db = new Database({ path: dbPath });
    return createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
  }

  it('retrieves the corrected preference, and never the superseded one, after reboot', async () => {
    const first = await boot();
    const owner = await first.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });

    first.memoryRepo.setPreference({
      identityId: owner.id,
      key: 'address_form',
      value: 'boss',
      provenance: provenance('c1'),
    });

    // Read once before the correction, so a cache exists to be wrong.
    const ask = {
      callerId: owner.id,
      callerKind: 'owner' as const,
      query: 'address_form boss Ankit',
      domains: ['preference' as const],
      limit: 5,
      recencyWeight: 0.2,
      importanceWeight: 0.2,
      similarityWeight: 0.6,
      excludeSoftDeleted: true,
    };
    expect((await first.memoryRetrieval.retrieve(ask)).items[0]?.value).toBe('boss');

    // "Mujhe boss mat bolo, Ankit bolo." — through the app's own corrections.
    first.memoryCorrections.correctPreference({
      identityId: owner.id,
      key: 'address_form',
      newValue: 'Ankit',
      reason: 'boss -> Ankit',
      provenance: provenance('c2'),
    });

    // Same process, immediately after: the old belief is already gone from view.
    const sameRun = await first.memoryRetrieval.retrieve(ask);
    expect(sameRun.items.map((i) => i.value)).toEqual(['Ankit']);

    await first.stop();
    first.db.close();
    closeDatabase();

    // Restart over the same file.
    const second = await boot();
    try {
      const afterRestart = await second.memoryRetrieval.retrieve(ask);
      expect(afterRestart.items.map((i) => i.value)).toEqual(['Ankit']);
      expect(second.memoryRepo.getPreference(owner.id, 'address_form')?.value).toBe('Ankit');

      // History is still there, and still says what she used to be told.
      const history = second.memoryRepo
        .listPreferences(owner.id, true)
        .filter((p) => p.key === 'address_form');
      expect(history).toHaveLength(2);
      expect(history.find((p) => p.value === 'boss')?.lifecycleStatus).toBe('superseded');

      // And the correction itself is readable, with its reason and its link.
      const [correction] = second.memoryCorrections.listCorrections(owner.id);
      expect(correction?.reason).toBe('boss -> Ankit');
      expect(correction?.newMemoryId).toBe(
        second.memoryRepo.getPreference(owner.id, 'address_form')?.id,
      );
    } finally {
      await second.stop();
      second.db.close();
    }
  });
});
