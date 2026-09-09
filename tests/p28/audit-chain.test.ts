/**
 * The audit hash chain, under tamper.
 *
 * `verifyIntegrity()` used to check only that required fields were non-NULL and
 * timestamps parseable, so a well-formed row could be edited, reordered, or
 * deleted and verification still reported `valid: true`. These tests exist
 * because an integrity check is worthless unless something proves it fails on
 * tampered data — the claim is the whole product here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { AuditLogService, appendAuditEntries } from '@server/security/audit.js';
import { persist } from '@server/cognition/stages/12.js';
import type { AuditEntry } from '@server/cognition/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

const GENESIS = '0'.repeat(64);

interface ChainRow {
  id: string;
  seq: number | null;
  prev_hash: string | null;
  entry_hash: string | null;
}

describe('P28: tamper-evident audit chain', () => {
  let db: Database;
  let audit: AuditLogService;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    audit = new AuditLogService(db);
    // `audit_log.actor_id` has an FK to `identity`, so an actor has to exist.
    db.raw
      .prepare(
        `INSERT INTO identity (id, kind, display_name, status) VALUES ('actor-1', 'owner', 'Owner', 'active')`,
      )
      .run();
  });

  afterEach(() => {
    db.close();
  });

  /** Writes `n` entries and returns their ids in write order. */
  function writeEntries(n: number): string[] {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        audit.log({
          actorId: 'actor-1',
          action: 'memory:read',
          resource: `resource-${i}`,
          decision: i % 2 === 0 ? 'allow' : 'deny',
          reason: `entry ${i}`,
        }),
      );
    }
    return ids;
  }

  function chain(): ChainRow[] {
    return db.raw
      .prepare(`SELECT id, seq, prev_hash, entry_hash FROM audit_log ORDER BY seq ASC`)
      .all() as ChainRow[];
  }

  it('links every entry to its predecessor, starting from genesis', () => {
    writeEntries(4);
    const rows = chain();

    expect(rows).toHaveLength(4);
    expect(rows[0]!.seq).toBe(1);
    expect(rows[0]!.prev_hash).toBe(GENESIS);

    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.seq).toBe(i + 1);
      expect(rows[i]!.entry_hash).toMatch(/^[0-9a-f]{64}$/);
      if (i > 0) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.entry_hash);
    }

    const result = audit.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(4);
    expect(result.unchained).toBe(0);
  });

  it('detects a modified field on a row that still looks well-formed', () => {
    const ids = writeEntries(3);
    expect(audit.verifyIntegrity().valid).toBe(true);

    // The kind of edit the old check could not see: a plausible value swapped in
    // by direct sqlite access, leaving every column non-NULL and parseable.
    db.raw.prepare(`UPDATE audit_log SET decision = 'allow' WHERE id = ?`).run(ids[1]);

    const result = audit.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes(ids[1]!) && e.includes('modified after it was written'))).toBe(true);
  });

  it('detects a deleted row as a gap in the sequence', () => {
    const ids = writeEntries(4);

    db.raw.prepare(`DELETE FROM audit_log WHERE id = ?`).run(ids[2]);

    const result = audit.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Audit chain gap') && e.includes('expected seq 3'))).toBe(true);
    expect(result.checked).toBe(3);
  });

  it('detects a truncated head — the surviving first row no longer chains to genesis', () => {
    const ids = writeEntries(3);

    db.raw.prepare(`DELETE FROM audit_log WHERE id = ?`).run(ids[0]);

    const result = audit.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Audit chain broken'))).toBe(true);
  });

  it('detects a broken link when prev_hash is rewritten to hide an edit', () => {
    const ids = writeEntries(3);

    // Tampering with the link itself, not the content.
    db.raw.prepare(`UPDATE audit_log SET prev_hash = ? WHERE id = ?`).run(GENESIS, ids[2]);

    const result = audit.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Audit chain broken') && e.includes(ids[2]!))).toBe(true);
  });

  it('reports one error per gap rather than cascading through the rest of the chain', () => {
    const ids = writeEntries(6);

    db.raw.prepare(`DELETE FROM audit_log WHERE id = ?`).run(ids[1]);

    const result = audit.verifyIntegrity();
    const gapErrors = result.errors.filter((e) => e.includes('Audit chain gap'));
    expect(gapErrors).toHaveLength(1);
  });

  it('is not forgeable by shifting a delimiter between fields', () => {
    // The property length-prefixing buys: 'a b'+'c' must not hash the same as
    // 'a'+'b c'. With a plain separator these two rows would share a preimage,
    // and free-text `reason`/`metadata_json` make that reachable by an attacker.
    const left = audit.log({ action: 'a b', resource: 'c', decision: 'allow' });
    const right = audit.log({ action: 'a', resource: 'b c', decision: 'allow' });

    const rows = db.raw
      .prepare(`SELECT id, entry_hash FROM audit_log WHERE id IN (?, ?)`)
      .all(left, right) as { id: string; entry_hash: string }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.entry_hash).not.toBe(rows[1]!.entry_hash);
    expect(audit.verifyIntegrity().valid).toBe(true);
  });

  describe('rows written before the chain existed', () => {
    /** Simulates a pre-migration-0007 row: content only, no chain columns. */
    function insertLegacyRow(id: string, timestamp: string): void {
      db.raw
        .prepare(
          `INSERT INTO audit_log (id, actor_id, action, resource, decision, reason, metadata_json, timestamp)
           VALUES (?, NULL, 'memory:read', 'legacy', 'allow', NULL, NULL, ?)`,
        )
        .run(id, timestamp);
    }

    it('reports them as unchained instead of quietly passing them', () => {
      insertLegacyRow('legacy-1', '2026-01-01T00:00:00.000Z');
      insertLegacyRow('legacy-2', '2026-01-02T00:00:00.000Z');

      const result = audit.verifyIntegrity();
      expect(result.valid).toBe(false);
      expect(result.unchained).toBe(2);
      expect(result.errors.some((e) => e.includes('legacy-1') && e.includes('not chained'))).toBe(true);
    });

    it('backfillChain() chains them without altering content, and is idempotent', () => {
      insertLegacyRow('legacy-1', '2026-01-01T00:00:00.000Z');
      insertLegacyRow('legacy-2', '2026-01-02T00:00:00.000Z');

      expect(audit.backfillChain()).toBe(2);

      const after = audit.verifyIntegrity();
      expect(after.valid).toBe(true);
      expect(after.unchained).toBe(0);

      // Content is untouched — backfill establishes a baseline, it does not edit.
      const row = db.raw
        .prepare(`SELECT resource, timestamp FROM audit_log WHERE id = 'legacy-1'`)
        .get() as { resource: string; timestamp: string };
      expect(row.resource).toBe('legacy');
      expect(row.timestamp).toBe('2026-01-01T00:00:00.000Z');

      expect(audit.backfillChain()).toBe(0);
      expect(audit.verifyIntegrity().valid).toBe(true);
    });

    it('backfills behind an existing chain without renumbering it', () => {
      writeEntries(2);
      insertLegacyRow('legacy-1', '2026-01-01T00:00:00.000Z');

      expect(audit.backfillChain()).toBe(1);

      const backfilled = db.raw
        .prepare(`SELECT seq FROM audit_log WHERE id = 'legacy-1'`)
        .get() as { seq: number };
      expect(backfilled.seq).toBe(3);
      expect(audit.verifyIntegrity().valid).toBe(true);
    });
  });

  it('refuses to append outside a transaction, where two writers could fork the chain', () => {
    expect(() =>
      appendAuditEntries(db, [{ action: 'memory:read', resource: 'r', decision: 'allow' }]),
    ).toThrow(/requires an open transaction/);
  });

  it('redacts secrets on the append path, so no caller can store them in plaintext', () => {
    const id = audit.log({
      action: 'identity:authenticate',
      resource: 'owner',
      decision: 'deny',
      reason: 'passphrase: "hunter2-correct-horse"',
      metadata: { apiKey: 'AIzaSyExampleKeyValue', actor: 'owner@example.com' },
    });

    const row = db.raw
      .prepare(`SELECT reason, metadata_json FROM audit_log WHERE id = ?`)
      .get(id) as { reason: string; metadata_json: string };

    expect(row.reason).not.toContain('hunter2-correct-horse');
    expect(row.reason).toContain('[redacted]');
    expect(row.metadata_json).not.toContain('AIzaSyExampleKeyValue');
    expect(row.metadata_json).toContain('owner@example.com');

    // Redaction happens before hashing, so the stored row still verifies.
    expect(audit.verifyIntegrity().valid).toBe(true);
  });

  describe('stage 12 (PERSIST) writes through the chain', () => {
    /**
     * The regression this guards: stage 12 ran its own eight-column INSERT, so
     * every disclosure decision a cycle recorded landed unchained and unredacted
     * while `AuditLogService.log()` chained and redacted correctly. Two write
     * paths, one policy between them.
     */
    async function persistCycleWithAudit(cycleId: string, entries: AuditEntry[]): Promise<void> {
      db.raw.prepare(`INSERT OR IGNORE INTO conversation (id, identity_id) VALUES ('conv-1', 'actor-1')`).run();
      db.raw
        .prepare(`INSERT INTO cycle_record (id, conversation_id, status) VALUES (?, 'conv-1', 'running')`)
        .run(cycleId);

      await persist(
        {
          cycleId,
          status: 'completed',
          startedAt: Date.now(),
          completedAt: Date.now(),
          identityId: 'actor-1',
          conversationId: 'conv-1',
          turns: [],
          actionResults: [],
          decision: undefined,
          response: undefined,
          learningDelta: undefined,
          updateResult: undefined,
          audit: entries,
          stages: [],
        },
        { db },
      );
    }

    it('chains a cycle\'s audit entries and redacts them', async () => {
      await persistCycleWithAudit('cycle-1', [
        {
          actorId: 'actor-1',
          action: 'memory:disclose',
          resource: 'episodic:1',
          decision: 'redacted',
          reason: 'passphrase: "hunter2-correct-horse"',
          at: Date.now(),
        },
        {
          actorId: 'actor-1',
          action: 'memory:disclose',
          resource: 'episodic:2',
          decision: 'allowed',
          at: Date.now(),
        },
      ]);

      const rows = chain();
      expect(rows).toHaveLength(2);
      expect(rows[0]!.seq).toBe(1);
      expect(rows[0]!.prev_hash).toBe(GENESIS);
      expect(rows[1]!.prev_hash).toBe(rows[0]!.entry_hash);
      expect(audit.verifyIntegrity()).toMatchObject({ valid: true, unchained: 0 });

      const reason = db.raw
        .prepare(`SELECT reason FROM audit_log WHERE seq = 1`)
        .get() as { reason: string };
      expect(reason.reason).not.toContain('hunter2-correct-horse');
    });

    it('continues the chain a previous writer started rather than restarting it', async () => {
      writeEntries(2);
      await persistCycleWithAudit('cycle-1', [
        {
          actorId: 'actor-1',
          action: 'memory:disclose',
          resource: 'episodic:1',
          decision: 'allowed',
          at: Date.now(),
        },
      ]);

      const rows = chain();
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
      expect(rows[2]!.prev_hash).toBe(rows[1]!.entry_hash);
      expect(audit.verifyIntegrity().valid).toBe(true);
    });
  });
});
