import { ulid } from '../persistence/ids.js';
import { createHash } from 'node:crypto';
import type { Database } from '../persistence/db.js';
import { REDACTION } from '../cognition/stages/9.js';

/** Genesis link for the first entry in the chain. */
const GENESIS_HASH = '0'.repeat(64);

export interface AuditRecord {
  id: string;
  actorId: string | null;
  action: string;
  resource: string;
  decision: string; // 'allow' | 'deny' | 'execute' | 'error' etc.
  reason: string | null;
  metadataJson: string | null;
  timestamp: string; // ISO string
}

export interface AuditQueryParams {
  actorId?: string;
  action?: string;
  resource?: string;
  decision?: string;
  since?: number; // ms epoch
  until?: number; // ms epoch
  limit?: number;
  offset?: number;
}

export interface AuditIntegrityResult {
  valid: boolean;
  errors: string[];
  /** Rows checked, including unchained ones. */
  checked: number;
  /** Rows written before the hash chain existed (see migration 0007). */
  unchained: number;
}

export class AuditLogService {
  constructor(private db: Database) {}

  /**
   * Logs one audit event securely. Never logs secrets in plaintext: reason and
   * metadata are scrubbed by `appendAuditEntries`, the single append path.
   *
   * The chain-head read and the insert happen in one transaction so two
   * concurrent logs cannot compute the same `seq`/`prev_hash` and fork the
   * chain. better-sqlite3 nests this as a savepoint when the caller is already
   * inside a transaction, so it is safe from either context.
   */
  public log(entry: AuditAppendInput): string {
    const id = entry.id ?? ulid();
    const run = this.db.raw.transaction(() => {
      appendAuditEntries(this.db, [{ ...entry, id }]);
    });
    run();
    return id;
  }

  /**
   * Hardened query method: allows filtering but always bounds limit/offset.
   */
  public query(params: AuditQueryParams): AuditRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];

    if (params.actorId) {
      clauses.push('actor_id = ?');
      args.push(params.actorId);
    }
    if (params.action) {
      clauses.push('action = ?');
      args.push(params.action);
    }
    if (params.resource) {
      clauses.push('resource = ?');
      args.push(params.resource);
    }
    if (params.decision) {
      clauses.push('decision = ?');
      args.push(params.decision);
    }
    if (params.since !== undefined) {
      clauses.push(`datetime(timestamp) >= datetime(?)`);
      args.push(new Date(params.since).toISOString());
    }
    if (params.until !== undefined) {
      clauses.push(`datetime(timestamp) <= datetime(?)`);
      args.push(new Date(params.until).toISOString());
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(params.limit ?? 100, 1000);
    const offset = Math.max(params.offset ?? 0, 0);

    // Final SQL using parameterization, not string interpolation for values
    const sql = `SELECT id, actor_id, action, resource, decision, reason, metadata_json, timestamp FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
    args.push(limit, offset);

    const rows = this.db.raw.prepare(sql).all(...args) as {
      id: string;
      actor_id: string | null;
      action: string;
      resource: string;
      decision: string;
      reason: string | null;
      metadata_json: string | null;
      timestamp: string;
    }[];

    return rows.map(r => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      resource: r.resource,
      decision: r.decision,
      reason: r.reason,
      metadataJson: r.metadata_json,
      timestamp: r.timestamp,
    }));
  }

  /**
   * Recomputes the audit hash chain and reports every way it fails to match.
   *
   * This detects what the old field-completeness check could not:
   *   - a modified row      → its recomputed `entry_hash` differs
   *   - a deleted row       → a gap in the dense `seq` sequence
   *   - a reordered chain   → a `prev_hash` that does not match its predecessor
   *   - a truncated chain   → the first row's `prev_hash` is not the genesis
   *
   * A row with no `entry_hash` predates migration 0007. Those are counted in
   * `unchained` and reported as errors rather than passed over, because a
   * verification that quietly ignores rows it cannot check is the bug this
   * replaces. `backfillChain()` resolves them.
   */
  public verifyIntegrity(): AuditIntegrityResult {
    const rows = this.db.raw
      .prepare(
        `SELECT id, actor_id, action, resource, decision, reason, metadata_json, timestamp,
                seq, prev_hash, entry_hash
           FROM audit_log
          ORDER BY seq IS NULL, seq ASC, timestamp ASC, id ASC`,
      )
      .all() as AuditChainRow[];

    const errors: string[] = [];
    let unchained = 0;
    let expectedSeq = 1;
    let expectedPrev = GENESIS_HASH;

    for (const r of rows) {
      if (!r.id || !r.action || !r.resource || !r.decision || !r.timestamp) {
        errors.push(`Incomplete audit record: ${r.id}`);
      }
      if (Number.isNaN(Date.parse(r.timestamp))) {
        errors.push(`Invalid timestamp for audit record: ${r.id}`);
      }

      if (r.seq === null || r.entry_hash === null) {
        unchained++;
        errors.push(`Audit record ${r.id} is not chained (predates migration 0007)`);
        continue;
      }

      if (r.seq !== expectedSeq) {
        errors.push(
          `Audit chain gap: expected seq ${expectedSeq}, found ${r.seq} at record ${r.id} — a record was deleted or reordered`,
        );
        // Resynchronize so one gap does not cascade into an error per row.
        expectedSeq = r.seq;
      }

      if (r.prev_hash !== expectedPrev) {
        errors.push(
          `Audit chain broken at seq ${r.seq} (${r.id}): prev_hash does not match the preceding entry`,
        );
      }

      const recomputed = hashEntry(
        {
          id: r.id,
          actorId: r.actor_id,
          action: r.action,
          resource: r.resource,
          decision: r.decision,
          reason: r.reason,
          metadataJson: r.metadata_json,
          timestamp: r.timestamp,
          seq: r.seq,
        },
        r.prev_hash ?? GENESIS_HASH,
      );
      if (recomputed !== r.entry_hash) {
        errors.push(`Audit record ${r.id} (seq ${r.seq}) was modified after it was written`);
      }

      expectedPrev = r.entry_hash;
      expectedSeq = r.seq + 1;
    }

    return { valid: errors.length === 0, errors, checked: rows.length, unchained };
  }

  /**
   * Chains any rows written before migration 0007, in timestamp order, without
   * altering their content. Idempotent: already-chained rows are left alone.
   * Returns how many rows were chained.
   *
   * This cannot prove the pre-migration rows were untampered — nothing can,
   * retroactively. It establishes the baseline from which tampering becomes
   * detectable.
   */
  public backfillChain(): number {
    const run = this.db.raw.transaction(() => {
      const head = this.db.raw
        .prepare(`SELECT seq, entry_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1`)
        .get() as { seq: number; entry_hash: string | null } | undefined;

      let seq = (head?.seq ?? 0) + 1;
      let prevHash = head?.entry_hash ?? GENESIS_HASH;

      const pending = this.db.raw
        .prepare(
          `SELECT id, actor_id, action, resource, decision, reason, metadata_json, timestamp
             FROM audit_log
            WHERE seq IS NULL
            ORDER BY timestamp ASC, id ASC`,
        )
        .all() as Omit<AuditChainRow, 'seq' | 'prev_hash' | 'entry_hash'>[];

      const update = this.db.raw.prepare(
        `UPDATE audit_log SET seq = ?, prev_hash = ?, entry_hash = ? WHERE id = ?`,
      );

      for (const r of pending) {
        const entryHash = hashEntry(
          {
            id: r.id,
            actorId: r.actor_id,
            action: r.action,
            resource: r.resource,
            decision: r.decision,
            reason: r.reason,
            metadataJson: r.metadata_json,
            timestamp: r.timestamp,
            seq,
          },
          prevHash,
        );
        update.run(seq, prevHash, entryHash, r.id);
        prevHash = entryHash;
        seq++;
      }

      return pending.length;
    });

    return run();
  }

  /**
   * Returns total count of audit logs
   */
  public count(): number {
    const row = this.db.raw.prepare(`SELECT COUNT(*) as cnt FROM audit_log`).get() as { cnt: number };
    return row.cnt;
  }

}

interface AuditChainRow {
  id: string;
  actor_id: string | null;
  action: string;
  resource: string;
  decision: string;
  reason: string | null;
  metadata_json: string | null;
  timestamp: string;
  seq: number | null;
  prev_hash: string | null;
  entry_hash: string | null;
}

/** One entry to append. `id` and `timestamp` are minted when absent. */
export interface AuditAppendInput {
  id?: string;
  actorId?: string | null;
  action: string;
  resource: string;
  decision: string;
  reason?: string | null;
  metadata?: unknown | null;
  /** ms epoch; defaults to now. */
  timestamp?: number;
}

/**
 * Appends entries to the tamper-evident chain. This is the only function that
 * may INSERT into `audit_log`.
 *
 * Stage 12 (PERSIST) used to run its own INSERT over eight columns, so every
 * disclosure decision a cycle recorded landed with `seq`/`prev_hash`/
 * `entry_hash` NULL: unchained, carrying no tamper evidence, and reported as an
 * error by `verifyIntegrity()`. It also skipped redaction entirely. Both
 * callers now funnel through here, so there is one chain implementation and one
 * redaction policy rather than two that drift.
 *
 * The caller must already be in a transaction — reading the chain head and
 * inserting its successor has to be atomic, or two writers compute the same
 * `seq` and fork the chain. Ownership sits with the caller so a cycle can
 * commit its audit entries in the same transaction as the rest of its
 * artifacts, which is what stops a cycle splitting its audit story across two
 * writes.
 *
 * Returns the ids written, in order.
 */
export function appendAuditEntries(db: Database, entries: AuditAppendInput[]): string[] {
  if (entries.length === 0) return [];
  if (!db.raw.inTransaction) {
    throw new Error(
      'appendAuditEntries requires an open transaction: the chain-head read and the insert must be atomic',
    );
  }

  const head = db.raw
    .prepare(`SELECT seq, entry_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1`)
    .get() as { seq: number; entry_hash: string | null } | undefined;

  let seq = (head?.seq ?? 0) + 1;
  let prevHash = head?.entry_hash ?? GENESIS_HASH;

  const insert = db.raw.prepare(
    `INSERT INTO audit_log
       (id, actor_id, action, resource, decision, reason, metadata_json, timestamp,
        seq, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const ids: string[] = [];
  for (const entry of entries) {
    const row: HashableEntry = {
      id: entry.id ?? ulid(),
      actorId: entry.actorId ?? null,
      action: entry.action,
      resource: entry.resource,
      decision: entry.decision,
      reason: entry.reason ? scrubSecrets(entry.reason) : null,
      metadataJson: entry.metadata ? scrubSecrets(JSON.stringify(entry.metadata)) : null,
      timestamp: entry.timestamp ? new Date(entry.timestamp).toISOString() : new Date().toISOString(),
      seq,
    };
    const entryHash = hashEntry(row, prevHash);

    insert.run(
      row.id,
      row.actorId,
      row.action,
      row.resource,
      row.decision,
      row.reason,
      row.metadataJson,
      row.timestamp,
      row.seq,
      prevHash,
      entryHash,
    );

    ids.push(row.id);
    prevHash = entryHash;
    seq++;
  }

  return ids;
}

/**
 * Redacts known secret shapes before an entry is hashed and stored. Applied on
 * the append path so no caller can bypass it — an audit log that leaks the
 * passphrase it was recording an attempt against is worse than no log.
 */
function scrubSecrets(input: string): string {
  let out = input;
  out = out.replace(/("passphrase"\s*:\s*")([^"]+)(")/gi, `$1${REDACTION}$3`);
  out = out.replace(/("recoveryCode"\s*:\s*")([^"]+)(")/gi, `$1${REDACTION}$3`);
  out = out.replace(/("apiKey"\s*:\s*")([^"]+)(")/gi, `$1${REDACTION}$3`);
  out = out.replace(/("api_key"\s*:\s*")([^"]+)(")/gi, `$1${REDACTION}$3`);
  out = out.replace(/("secretsOf"\s*:\s*")([^"]+)(")/gi, `$1${REDACTION}$3`);
  out = out.replace(/(Bearer\s+)[A-Za-z0-9\-_.]+/gi, `$1${REDACTION}`);
  // URL query params: api_key=..., apiKey=..., token=..., secret=..., passphrase=..., recoveryCode=...
  out = out.replace(
    /([?&](?:api_key|apiKey|passphrase|token|secret|recoveryCode)=)([^&\s"]+)/gi,
    `$1${REDACTION}`,
  );
  // Free-form passphrase: "..." within a reason string
  out = out.replace(/(passphrase:\s*)"([^"]+)"/gi, `$1"${REDACTION}"`);
  return out;
}

interface HashableEntry {
  id: string;
  actorId: string | null;
  action: string;
  resource: string;
  decision: string;
  reason: string | null;
  metadataJson: string | null;
  timestamp: string;
  seq: number;
}

/**
 * Canonical hash over one entry and its predecessor's hash.
 *
 * Every field is length-prefixed (`<byteLength>:<value>`) before being joined,
 * so no combination of field values can collide with a different combination by
 * shifting a delimiter — a plain separator would be forgeable because `reason`
 * and `metadata_json` are free text. `prev_hash` is part of the preimage; that
 * is what makes this a chain rather than a set of independent checksums.
 */
function hashEntry(entry: HashableEntry, prevHash: string): string {
  const parts = [
    String(entry.seq),
    entry.id,
    entry.actorId ?? '',
    entry.action,
    entry.resource,
    entry.decision,
    entry.reason ?? '',
    entry.metadataJson ?? '',
    entry.timestamp,
    prevHash,
  ];
  const preimage = parts.map((p) => `${Buffer.byteLength(p, 'utf8')}:${p}`).join('');
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}
