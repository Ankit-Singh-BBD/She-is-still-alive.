/**
 * The ordering guarantee every `ORDER BY … id` in this codebase depends on.
 *
 * Most tables here default their time columns to SQLite's `datetime('now')`, which
 * has **second** granularity, so rows written in the same second carry the same
 * timestamp and the query's next tie-break decides their order. That tie-break is
 * `id`, in the audit chain (`server/security/audit.ts`), in "which conversation is
 * she in" (`server/conversations/repository.ts`), and in the duplicate fold
 * (`server/advanced/dream.ts`). None of those reads is safe unless a later id sorts
 * after an earlier one.
 *
 * The package's plain `ulid()` does not provide that — it re-rolls 80 random bits
 * every call, so same-millisecond ids sort arbitrarily. `server/persistence/ids.ts`
 * exists to provide it, and these are the tests that would fail if it were reverted
 * to a bare `ulid` import.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { ulid as packageUlid } from 'ulid';

import { ulid } from '@server/persistence/ids.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { MemoryRepository } from '@server/memory/repository.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');
const FROZEN = new Date('2026-09-05T23:30:00');

/** Adjacent pairs that sort the wrong way round. Zero is the guarantee. */
function inversions(ids: string[]): number {
  let count = 0;
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i]! <= ids[i - 1]!) count += 1;
  }
  return count;
}

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
});

describe('identifier ordering', () => {
  it('sorts in mint order even when the clock does not move', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FROZEN });

    const ids = Array.from({ length: 200 }, () => ulid());

    expect(inversions(ids)).toBe(0);
    expect(new Set(ids).size).toBe(ids.length);
    // Still a ULID: 26 characters of Crockford base32, so anything that stores or
    // matches an id keeps working.
    expect(ids.every((id) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))).toBe(true);
  });

  it('is the property the package default lacks, which is why this module exists', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: FROZEN });

    // Random 80-bit suffixes: the chance that 200 of them happen to land in
    // ascending order is 1/200!, which is far past any number that could make this
    // flaky. If this assertion ever fails, the package changed its default and
    // `server/persistence/ids.ts` should be reconsidered rather than patched.
    expect(inversions(Array.from({ length: 200 }, () => packageUlid()))).toBeGreaterThan(0);
  });

  it('keeps ordering when the clock steps backwards', () => {
    // NTP correcting a drift, or a test pinning a fake Date. An id that sorted
    // before one already handed out would reorder rows that are already written —
    // the audit chain would verify against the wrong predecessor. Monotonicity wins
    // over a faithful embedded timestamp, which nothing decodes.
    vi.useFakeTimers({ toFake: ['Date'], now: FROZEN });
    const before = [ulid(), ulid()];

    vi.setSystemTime(new Date('2026-09-05T12:00:00'));
    const after = [ulid(), ulid()];

    expect(inversions([...before, ...after])).toBe(0);
  });

  it('orders rows written in one millisecond by insertion, through real SQL', () => {
    // The committed effect, on a real table: `occurred_at` and `created_at` are
    // identical across these rows, so `ORDER BY id` is the only thing separating
    // them — exactly the situation the production queries are in.
    vi.useFakeTimers({ toFake: ['Date'], now: FROZEN });
    const db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    db.raw
      .prepare(`INSERT INTO identity (id, kind, display_name, status) VALUES (?, 'owner', 'Ankit', 'active')`)
      .run('ident-ids');
    const memory = new MemoryRepository(db);

    const written = Array.from({ length: 25 }, (_unused, index) =>
      memory.createEpisodic({
        identityId: 'ident-ids',
        summary: `recollection ${index}`,
        occurredAt: Date.now(),
        provenance: {
          sourceCycleId: 'cycle-seed',
          sourceConversationId: 'conv-seed',
          sourceMessageIds: [],
          extractedAt: Date.now(),
          extractor: 'rule',
          confidence: 1,
          validatedBy: 'app_rule',
        },
      }).id,
    );

    const stored = (
      db.raw
        .prepare(`SELECT summary FROM episodic_memory WHERE identity_id = ? ORDER BY occurred_at ASC, id ASC`)
        .all('ident-ids') as { summary: string }[]
    ).map((row) => row.summary);

    expect(stored).toEqual(written.map((_unused, index) => `recollection ${index}`));

    db.close();
  });
});
