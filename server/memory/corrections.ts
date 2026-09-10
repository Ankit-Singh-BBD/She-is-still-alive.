/**
 * B09.s1 — Memory Corrections with Supersession
 *
 * Correctable memory: resolve specific fact/preference, one transaction create
 * correction old→new, mark old superseded, store provenance, invalidate caches,
 * append event. Next turn retrieves new, excludes superseded.
 *
 * Example: "Mujhe boss mat bolo, Ankit bolo" → update owner's address preference,
 * not global. Correction is general mechanism, not hardcoded branch.
 */

import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import { ulid } from '@server/persistence/ids.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { MemoryDomain, MemoryProvenance } from './types.js';
import { MemoryRepository } from './repository.js';
import type { MemoryRetrieval } from './retrieval.js';

export interface MemoryCorrection {
  id: string;
  oldMemoryId: string;
  newMemoryId: string;
  domain: MemoryDomain;
  identityId: string;
  reason?: string | undefined;
  provenance: MemoryProvenance;
  createdAt: number;
  supersededAt: number;
}

/** Payload of the `memory.corrected` domain event. */
export interface MemoryCorrectedPayload {
  correctionId: string;
  domain: MemoryDomain;
  key: string;
  oldMemoryId: string;
  newMemoryId: string;
  reason?: string | undefined;
}

export interface CorrectionRequest {
  identityId: string;
  domain: MemoryDomain;
  oldMemoryId: string;
  newValue: string; // for preference correction
  reason?: string;
  provenance: MemoryProvenance;
}

/**
 * What a correction has to reach besides the tables.
 *
 * Both are optional and both are real when supplied: with no bus the correction
 * is still durable but nothing downstream hears it, and with no retrieval the
 * next read may still answer from a cache holding the pre-correction belief.
 * `server/app.ts` supplies both; a unit test that only asserts the rows may not.
 */
export interface CorrectionDeps {
  events?: EventBus | undefined;
  retrieval?: MemoryRetrieval | undefined;
}

export class MemoryCorrections {
  private db: Database;
  private repo: MemoryRepository;
  private events: EventBus | undefined;
  private retrieval: MemoryRetrieval | undefined;

  constructor(db?: Database, deps: CorrectionDeps = {}) {
    this.db = db ?? getDatabase();
    this.repo = new MemoryRepository(this.db);
    this.events = deps.events;
    this.retrieval = deps.retrieval;
  }

  /**
   * Correct a preference: resolve specific key, create correction record,
   * mark old superseded, create new row with updated value, invalidate caches,
   * append event (future: when domain_event publishing wired).
   *
   * All in one transaction per B09.s1 spec. Returns new preference ID.
   */
  correctPreference(params: {
    identityId: string;
    key: string;
    newValue: string;
    reason?: string;
    provenance: MemoryProvenance;
  }): { correctionId: string; oldPreferenceId: string; newPreferenceId: string } {
    // 1. Resolve specific preference being corrected
    const oldPref = this.repo.getPreference(params.identityId, params.key);
    if (!oldPref) {
      throw new Error(
        `No preference found for identity ${params.identityId} key "${params.key}" — nothing to correct.`
      );
    }

    if (oldPref.lifecycleStatus === 'superseded') {
      throw new Error(
        `Preference ${oldPref.id} is already superseded — correct the newer assertion instead.`
      );
    }

    const correctionId = ulid();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // 2. One transaction: correction record + mark old superseded + insert new preference.
    // `Database.transaction` runs the function itself, so there is no second call here.
    const result = this.db.transaction(() => {
      // Insert correction record
      this.db.raw
        .prepare(
          `
        INSERT INTO memory_correction (
          id, old_memory_id, new_memory_id, domain, identity_id, reason,
          provenance_json, created_at, superseded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          correctionId,
          oldPref.id,
          'PLACEHOLDER', // will update with newPrefId after insert
          'preference',
          params.identityId,
          params.reason ?? null,
          JSON.stringify(params.provenance),
          nowIso,
          nowIso
        );

      // Mark old preference superseded (retain history, no delete)
      this.db.raw
        .prepare(
          `
        UPDATE preference
        SET lifecycle_status = 'superseded', updated_at = ?
        WHERE id = ?
      `
        )
        .run(nowIso, oldPref.id);

      // Create new preference row with corrected value
      // Cannot use setPreference (it upserts same key on same identity_id)
      // Must create separate row with new ID, same key
      const newPrefId = ulid();
      this.db.raw
        .prepare(
          `
        INSERT INTO preference (
          id, identity_id, subject_kind, sensitivity, confidence, source_kind,
          provenance_json, key, value, stated_at, created_at, updated_at,
          expires_at, lifecycle_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          newPrefId,
          params.identityId,
          oldPref.subjectKind,
          oldPref.sensitivity,
          params.provenance.confidence, // use correction's confidence
          'conversation',
          JSON.stringify(params.provenance),
          params.key,
          params.newValue,
          nowIso,
          nowIso,
          nowIso,
          oldPref.expiresAt ? new Date(oldPref.expiresAt).toISOString() : null,
          'active'
        );

      // Update correction record with actual newMemoryId
      this.db.raw
        .prepare(
          `
        UPDATE memory_correction
        SET new_memory_id = ?
        WHERE id = ?
      `
        )
        .run(newPrefId, correctionId);

      // The event is *appended* here, inside the same transaction as the rows it
      // describes, so a crash cannot leave one without the other. Delivery is a
      // separate step after the commit — `server/events/event-bus.ts` says why the
      // async half cannot run inside a better-sqlite3 transaction.
      //
      // `cycle_id` is a foreign key to `cycle_record` (0004_events.sql), and the
      // cycle a correction came from may have been pruned — or, for a correction
      // made outside a cycle, never existed. Passing an id that no longer resolves
      // would abort the whole transaction, so a correction would be refused because
      // of its own bookkeeping. The provenance is kept in full on the correction
      // row either way; this only decides whether the event can also carry the link.
      const cycleId = this.knownCycleId(params.provenance.sourceCycleId);
      const appended = this.events?.append<'memory.corrected', MemoryCorrectedPayload>({
        type: 'memory.corrected',
        identityId: params.identityId,
        cycleId,
        timestamp: now,
        payload: {
          correctionId,
          domain: 'preference',
          key: params.key,
          oldMemoryId: oldPref.id,
          newMemoryId: newPrefId,
          reason: params.reason,
        },
      });

      return {
        correctionId,
        oldPreferenceId: oldPref.id,
        newPreferenceId: newPrefId,
        appended,
      };
    });

    // Retrieval must not answer the next question from an answer computed before
    // the correction — that is exactly how a corrected belief gets spoken again.
    this.retrieval?.invalidate();

    // Delivered after commit. `deliver` never rejects (subscriber failures are
    // bounded and logged there), so nothing downstream can undo a correction that
    // is already durable.
    if (result.appended) void this.events?.deliver(result.appended);

    return {
      correctionId: result.correctionId,
      oldPreferenceId: result.oldPreferenceId,
      newPreferenceId: result.newPreferenceId,
    };
  }

  /**
   * The cycle id if `cycle_record` actually holds it, else undefined.
   *
   * See the call site: this is what keeps a foreign key from turning a valid
   * correction into a failed one.
   */
  private knownCycleId(cycleId: string | undefined): string | undefined {
    if (!cycleId) return undefined;
    const row = this.db.raw.prepare(`SELECT 1 FROM cycle_record WHERE id = ?`).get(cycleId);
    return row ? cycleId : undefined;
  }

  /**
   * Get correction record by ID.
   */
  getCorrection(id: string): MemoryCorrection | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, old_memory_id, new_memory_id, domain, identity_id, reason,
             provenance_json, created_at, superseded_at
      FROM memory_correction
      WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row['id'] as string,
      oldMemoryId: row['old_memory_id'] as string,
      newMemoryId: row['new_memory_id'] as string,
      domain: row['domain'] as MemoryDomain,
      identityId: row['identity_id'] as string,
      reason: (row['reason'] as string | null) ?? undefined,
      provenance: JSON.parse(row['provenance_json'] as string),
      createdAt: new Date(row['created_at'] as string).getTime(),
      supersededAt: new Date(row['superseded_at'] as string).getTime(),
    };
  }

  /**
   * List corrections for a given identity or all.
   */
  listCorrections(identityId?: string): MemoryCorrection[] {
    let query = `
      SELECT id, old_memory_id, new_memory_id, domain, identity_id, reason,
             provenance_json, created_at, superseded_at
      FROM memory_correction
    `;
    const params: unknown[] = [];

    if (identityId) {
      query += ` WHERE identity_id = ?`;
      params.push(identityId);
    }

    query += ` ORDER BY created_at DESC`;

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r['id'] as string,
      oldMemoryId: r['old_memory_id'] as string,
      newMemoryId: r['new_memory_id'] as string,
      domain: r['domain'] as MemoryDomain,
      identityId: r['identity_id'] as string,
      reason: (r['reason'] as string | null) ?? undefined,
      provenance: JSON.parse(r['provenance_json'] as string),
      createdAt: new Date(r['created_at'] as string).getTime(),
      supersededAt: new Date(r['superseded_at'] as string).getTime(),
    }));
  }

  /**
   * Clear retrieval cache explicitly (test helper).
   */
  clearRetrievalCache(): void {
    this.retrieval?.invalidate();
  }
}
