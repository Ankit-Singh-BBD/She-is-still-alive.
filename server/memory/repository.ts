/**
 * P05 Memory Domains - Repository
 *
 * Multi-domain memory repositories with full CRUD, soft-delete, restore,
 * hard-delete, and provenance tracking per Build Book Part X and IX.
 */

import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import { ulid } from 'ulid';
import type {
  EpisodicMemory,
  SemanticMemory,
  Preference,
  Habit,
  Relationship,
  LearnedPattern,
  MemoryProvenance,
  SubjectKind,
  Sensitivity,
  SourceKind,
  LifecycleStatus,
} from './types.js';

function toIso(epochOrDate: number | Date | string | undefined | null): string | null {
  if (epochOrDate === undefined || epochOrDate === null) return null;
  if (typeof epochOrDate === 'string') return epochOrDate;
  if (typeof epochOrDate === 'number') return new Date(epochOrDate).toISOString();
  return epochOrDate.toISOString();
}

function fromIso(isoOrEpoch: string | number | undefined | null): number {
  if (isoOrEpoch === undefined || isoOrEpoch === null) return Date.now();
  if (typeof isoOrEpoch === 'number') return isoOrEpoch;
  const parsed = new Date(isoOrEpoch).getTime();
  return isNaN(parsed) ? Date.now() : parsed;
}

export class MemoryRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db ?? getDatabase();
  }

  // ==========================================
  // 1. EPISODIC MEMORY
  // ==========================================

  createEpisodic(params: {
    identityId: string;
    summary: string;
    details?: string;
    embedding?: string;
    occurredAt?: number;
    importance?: number;
    subjectKind?: SubjectKind;
    sensitivity?: Sensitivity;
    confidence?: number;
    sourceKind?: SourceKind;
    provenance: MemoryProvenance;
    expiresAt?: number;
  }): EpisodicMemory {
    const id = ulid();
    const now = Date.now();
    const subjectKind = params.subjectKind ?? 'person';
    const sensitivity = params.sensitivity ?? 'person_shared';
    const confidence = params.confidence ?? 1.0;
    const sourceKind = params.sourceKind ?? 'conversation';
    const occurredAt = params.occurredAt ?? now;
    const importance = params.importance ?? 0.5;
    const lifecycleStatus: LifecycleStatus = 'active';

    const memory: EpisodicMemory = {
      id,
      identityId: params.identityId,
      subjectKind,
      sensitivity,
      confidence,
      sourceKind,
      provenance: params.provenance,
      summary: params.summary,
      details: params.details,
      embedding: params.embedding,
      occurredAt,
      importance,
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresAt,
      lifecycleStatus,
    };

    this.db.raw
      .prepare(
        `
      INSERT INTO episodic_memory (
        id, identity_id, subject_kind, sensitivity, confidence, source_kind,
        provenance_json, summary, details, embedding, occurred_at, importance,
        created_at, updated_at, expires_at, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        params.identityId,
        subjectKind,
        sensitivity,
        confidence,
        sourceKind,
        JSON.stringify(params.provenance),
        params.summary,
        params.details ?? null,
        params.embedding ?? null,
        toIso(occurredAt),
        importance,
        toIso(now),
        toIso(now),
        toIso(params.expiresAt),
        lifecycleStatus
      );

    return memory;
  }

  getEpisodic(id: string): EpisodicMemory | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, summary, details, embedding, occurred_at, importance,
             created_at, updated_at, expires_at, lifecycle_status, deleted_at, deleted_by
      FROM episodic_memory
      WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapEpisodicRow(row);
  }

  listEpisodic(identityId?: string, includeDeleted = false): EpisodicMemory[] {
    let query = `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, summary, details, embedding, occurred_at, importance,
             created_at, updated_at, expires_at, lifecycle_status, deleted_at, deleted_by
      FROM episodic_memory
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (identityId) {
      conditions.push('identity_id = ?');
      params.push(identityId);
    }
    if (!includeDeleted) {
      conditions.push("lifecycle_status != 'soft_deleted' AND deleted_at IS NULL");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY occurred_at DESC';

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEpisodicRow(r));
  }

  softDeleteEpisodic(id: string, deletedBy: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE episodic_memory
      SET lifecycle_status = 'soft_deleted', deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND lifecycle_status != 'soft_deleted'
    `
      )
      .run(now, deletedBy, now, id);

    return result.changes > 0;
  }

  restoreEpisodic(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE episodic_memory
      SET lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL, updated_at = ?
      WHERE id = ? AND lifecycle_status = 'soft_deleted'
    `
      )
      .run(now, id);

    return result.changes > 0;
  }

  hardDeleteEpisodic(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM episodic_memory WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private mapEpisodicRow(row: Record<string, unknown>): EpisodicMemory {
    return {
      id: row['id'] as string,
      identityId: row['identity_id'] as string,
      subjectKind: row['subject_kind'] as SubjectKind,
      sensitivity: row['sensitivity'] as Sensitivity,
      confidence: Number(row['confidence']),
      sourceKind: row['source_kind'] as SourceKind,
      provenance: JSON.parse(row['provenance_json'] as string),
      summary: row['summary'] as string,
      details: (row['details'] as string | null) ?? undefined,
      embedding: (row['embedding'] as string | null) ?? undefined,
      occurredAt: fromIso(row['occurred_at'] as string),
      importance: Number(row['importance']),
      createdAt: fromIso(row['created_at'] as string),
      updatedAt: fromIso(row['updated_at'] as string),
      expiresAt: row['expires_at'] ? fromIso(row['expires_at'] as string) : undefined,
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      deletedAt: row['deleted_at'] ? fromIso(row['deleted_at'] as string) : undefined,
      deletedBy: (row['deleted_by'] as string | null) ?? undefined,
    };
  }

  // ==========================================
  // 2. SEMANTIC MEMORY
  // ==========================================

  createSemantic(params: {
    identityId: string;
    subject: string;
    predicate: string;
    object: string;
    sourceCycle?: string;
    embedding?: string;
    subjectKind?: SubjectKind;
    sensitivity?: Sensitivity;
    confidence?: number;
    sourceKind?: SourceKind;
    provenance: MemoryProvenance;
    expiresAt?: number;
  }): SemanticMemory {
    const id = ulid();
    const now = Date.now();
    const subjectKind = params.subjectKind ?? 'person';
    const sensitivity = params.sensitivity ?? 'person_shared';
    const confidence = params.confidence ?? 1.0;
    const sourceKind = params.sourceKind ?? 'conversation';
    const lifecycleStatus: LifecycleStatus = 'active';

    const memory: SemanticMemory = {
      id,
      identityId: params.identityId,
      subjectKind,
      sensitivity,
      confidence,
      sourceKind,
      provenance: params.provenance,
      subject: params.subject,
      predicate: params.predicate,
      object: params.object,
      sourceCycle: params.sourceCycle,
      embedding: params.embedding,
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresAt,
      lifecycleStatus,
    };

    this.db.raw
      .prepare(
        `
      INSERT INTO semantic_memory (
        id, identity_id, subject_kind, sensitivity, confidence, source_kind,
        provenance_json, subject, predicate, object, source_cycle, embedding,
        created_at, updated_at, expires_at, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        params.identityId,
        subjectKind,
        sensitivity,
        confidence,
        sourceKind,
        JSON.stringify(params.provenance),
        params.subject,
        params.predicate,
        params.object,
        params.sourceCycle ?? null,
        params.embedding ?? null,
        toIso(now),
        toIso(now),
        toIso(params.expiresAt),
        lifecycleStatus
      );

    return memory;
  }

  getSemantic(id: string): SemanticMemory | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, subject, predicate, object, source_cycle, embedding,
             created_at, updated_at, expires_at, lifecycle_status, deleted_at, deleted_by
      FROM semantic_memory
      WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapSemanticRow(row);
  }

  listSemantic(identityId?: string, includeDeleted = false): SemanticMemory[] {
    let query = `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, subject, predicate, object, source_cycle, embedding,
             created_at, updated_at, expires_at, lifecycle_status, deleted_at, deleted_by
      FROM semantic_memory
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (identityId) {
      conditions.push('identity_id = ?');
      params.push(identityId);
    }
    if (!includeDeleted) {
      conditions.push("lifecycle_status != 'soft_deleted' AND deleted_at IS NULL");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at DESC';

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapSemanticRow(r));
  }

  softDeleteSemantic(id: string, deletedBy: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE semantic_memory
      SET lifecycle_status = 'soft_deleted', deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND lifecycle_status != 'soft_deleted'
    `
      )
      .run(now, deletedBy, now, id);

    return result.changes > 0;
  }

  restoreSemantic(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE semantic_memory
      SET lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL, updated_at = ?
      WHERE id = ? AND lifecycle_status = 'soft_deleted'
    `
      )
      .run(now, id);

    return result.changes > 0;
  }

  hardDeleteSemantic(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM semantic_memory WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private mapSemanticRow(row: Record<string, unknown>): SemanticMemory {
    return {
      id: row['id'] as string,
      identityId: row['identity_id'] as string,
      subjectKind: row['subject_kind'] as SubjectKind,
      sensitivity: row['sensitivity'] as Sensitivity,
      confidence: Number(row['confidence']),
      sourceKind: row['source_kind'] as SourceKind,
      provenance: JSON.parse(row['provenance_json'] as string),
      subject: row['subject'] as string,
      predicate: row['predicate'] as string,
      object: row['object'] as string,
      sourceCycle: (row['source_cycle'] as string | null) ?? undefined,
      embedding: (row['embedding'] as string | null) ?? undefined,
      createdAt: fromIso(row['created_at'] as string),
      updatedAt: fromIso(row['updated_at'] as string),
      expiresAt: row['expires_at'] ? fromIso(row['expires_at'] as string) : undefined,
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      deletedAt: row['deleted_at'] ? fromIso(row['deleted_at'] as string) : undefined,
      deletedBy: (row['deleted_by'] as string | null) ?? undefined,
    };
  }

  // ==========================================
  // 3. PREFERENCES
  // ==========================================

  createPreference(params: Parameters<MemoryRepository['setPreference']>[0]): Preference {
    return this.setPreference(params);
  }

  setPreference(params: {
    identityId: string;
    key: string;
    value: string;
    statedAt?: number;
    subjectKind?: SubjectKind;
    sensitivity?: Sensitivity;
    confidence?: number;
    sourceKind?: SourceKind;
    provenance: MemoryProvenance;
    expiresAt?: number;
  }): Preference {
    const now = Date.now();
    const statedAt = params.statedAt ?? now;
    const subjectKind = params.subjectKind ?? 'person';
    const sensitivity = params.sensitivity ?? 'person_shared';
    const confidence = params.confidence ?? 1.0;
    const sourceKind = params.sourceKind ?? 'conversation';
    const lifecycleStatus: LifecycleStatus = 'active';

    // Check if preference already exists for identity + key
    const existing = this.db.raw
      .prepare(
        `
      SELECT id FROM preference WHERE identity_id = ? AND key = ?
    `
      )
      .get(params.identityId, params.key) as { id: string } | undefined;

    const id = existing?.id ?? ulid();

    if (existing) {
      this.db.raw
        .prepare(
          `
        UPDATE preference
        SET value = ?, stated_at = ?, confidence = ?, subject_kind = ?, sensitivity = ?,
            source_kind = ?, provenance_json = ?, updated_at = ?, expires_at = ?,
            lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL
        WHERE id = ?
      `
        )
        .run(
          params.value,
          toIso(statedAt),
          confidence,
          subjectKind,
          sensitivity,
          sourceKind,
          JSON.stringify(params.provenance),
          toIso(now),
          toIso(params.expiresAt),
          id
        );
    } else {
      this.db.raw
        .prepare(
          `
        INSERT INTO preference (
          id, identity_id, subject_kind, sensitivity, confidence, source_kind,
          provenance_json, key, value, stated_at, created_at, updated_at, expires_at, lifecycle_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
        )
        .run(
          id,
          params.identityId,
          subjectKind,
          sensitivity,
          confidence,
          sourceKind,
          JSON.stringify(params.provenance),
          params.key,
          params.value,
          toIso(statedAt),
          toIso(now),
          toIso(now),
          toIso(params.expiresAt),
          lifecycleStatus
        );
    }

    return {
      id,
      identityId: params.identityId,
      subjectKind,
      sensitivity,
      confidence,
      sourceKind,
      provenance: params.provenance,
      key: params.key,
      value: params.value,
      statedAt,
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresAt,
      lifecycleStatus,
    };
  }

  getPreference(identityId: string, key: string): Preference | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, key, value, stated_at, created_at, updated_at,
             expires_at, lifecycle_status, deleted_at, deleted_by
      FROM preference
      WHERE identity_id = ? AND key = ?
    `
      )
      .get(identityId, key) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapPreferenceRow(row);
  }

  listPreferences(identityId?: string, includeDeleted = false): Preference[] {
    let query = `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, key, value, stated_at, created_at, updated_at,
             expires_at, lifecycle_status, deleted_at, deleted_by
      FROM preference
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (identityId) {
      conditions.push('identity_id = ?');
      params.push(identityId);
    }
    if (!includeDeleted) {
      conditions.push("lifecycle_status != 'soft_deleted' AND deleted_at IS NULL");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY key ASC';

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapPreferenceRow(r));
  }

  softDeletePreference(id: string, deletedBy: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE preference
      SET lifecycle_status = 'soft_deleted', deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND lifecycle_status != 'soft_deleted'
    `
      )
      .run(now, deletedBy, now, id);

    return result.changes > 0;
  }

  restorePreference(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE preference
      SET lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL, updated_at = ?
      WHERE id = ? AND lifecycle_status = 'soft_deleted'
    `
      )
      .run(now, id);

    return result.changes > 0;
  }

  hardDeletePreference(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM preference WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private mapPreferenceRow(row: Record<string, unknown>): Preference {
    return {
      id: row['id'] as string,
      identityId: row['identity_id'] as string,
      subjectKind: row['subject_kind'] as SubjectKind,
      sensitivity: row['sensitivity'] as Sensitivity,
      confidence: Number(row['confidence']),
      sourceKind: row['source_kind'] as SourceKind,
      provenance: JSON.parse(row['provenance_json'] as string),
      key: row['key'] as string,
      value: row['value'] as string,
      statedAt: fromIso(row['stated_at'] as string),
      createdAt: fromIso(row['created_at'] as string),
      updatedAt: fromIso(row['updated_at'] as string),
      expiresAt: row['expires_at'] ? fromIso(row['expires_at'] as string) : undefined,
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      deletedAt: row['deleted_at'] ? fromIso(row['deleted_at'] as string) : undefined,
      deletedBy: (row['deleted_by'] as string | null) ?? undefined,
    };
  }

  // ==========================================
  // 4. HABITS
  // ==========================================

  createHabit(params: {
    identityId: string;
    pattern: string;
    frequency?: string;
    lastObserved?: number;
    subjectKind?: SubjectKind;
    sensitivity?: Sensitivity;
    confidence?: number;
    sourceKind?: SourceKind;
    provenance: MemoryProvenance;
    expiresAt?: number;
  }): Habit {
    const id = ulid();
    const now = Date.now();
    const lastObserved = params.lastObserved ?? now;
    const subjectKind = params.subjectKind ?? 'person';
    const sensitivity = params.sensitivity ?? 'person_shared';
    const confidence = params.confidence ?? 1.0;
    const sourceKind = params.sourceKind ?? 'observation';
    const lifecycleStatus: LifecycleStatus = 'active';

    const habit: Habit = {
      id,
      identityId: params.identityId,
      subjectKind,
      sensitivity,
      confidence,
      sourceKind,
      provenance: params.provenance,
      pattern: params.pattern,
      frequency: params.frequency,
      lastObserved,
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresAt,
      lifecycleStatus,
    };

    this.db.raw
      .prepare(
        `
      INSERT INTO habit (
        id, identity_id, subject_kind, sensitivity, confidence, source_kind,
        provenance_json, pattern, frequency, last_observed, created_at, updated_at,
        expires_at, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        params.identityId,
        subjectKind,
        sensitivity,
        confidence,
        sourceKind,
        JSON.stringify(params.provenance),
        params.pattern,
        params.frequency ?? null,
        toIso(lastObserved),
        toIso(now),
        toIso(now),
        toIso(params.expiresAt),
        lifecycleStatus
      );

    return habit;
  }

  getHabit(id: string): Habit | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, pattern, frequency, last_observed, created_at, updated_at,
             expires_at, lifecycle_status, deleted_at, deleted_by
      FROM habit
      WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapHabitRow(row);
  }

  listHabits(identityId?: string, includeDeleted = false): Habit[] {
    let query = `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, pattern, frequency, last_observed, created_at, updated_at,
             expires_at, lifecycle_status, deleted_at, deleted_by
      FROM habit
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (identityId) {
      conditions.push('identity_id = ?');
      params.push(identityId);
    }
    if (!includeDeleted) {
      conditions.push("lifecycle_status != 'soft_deleted' AND deleted_at IS NULL");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY last_observed DESC';

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapHabitRow(r));
  }

  softDeleteHabit(id: string, deletedBy: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE habit
      SET lifecycle_status = 'soft_deleted', deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND lifecycle_status != 'soft_deleted'
    `
      )
      .run(now, deletedBy, now, id);

    return result.changes > 0;
  }

  restoreHabit(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE habit
      SET lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL, updated_at = ?
      WHERE id = ? AND lifecycle_status = 'soft_deleted'
    `
      )
      .run(now, id);

    return result.changes > 0;
  }

  hardDeleteHabit(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM habit WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private mapHabitRow(row: Record<string, unknown>): Habit {
    return {
      id: row['id'] as string,
      identityId: row['identity_id'] as string,
      subjectKind: row['subject_kind'] as SubjectKind,
      sensitivity: row['sensitivity'] as Sensitivity,
      confidence: Number(row['confidence']),
      sourceKind: row['source_kind'] as SourceKind,
      provenance: JSON.parse(row['provenance_json'] as string),
      pattern: row['pattern'] as string,
      frequency: (row['frequency'] as string | null) ?? undefined,
      lastObserved: fromIso(row['last_observed'] as string),
      createdAt: fromIso(row['created_at'] as string),
      updatedAt: fromIso(row['updated_at'] as string),
      expiresAt: row['expires_at'] ? fromIso(row['expires_at'] as string) : undefined,
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      deletedAt: row['deleted_at'] ? fromIso(row['deleted_at'] as string) : undefined,
      deletedBy: (row['deleted_by'] as string | null) ?? undefined,
    };
  }

  // ==========================================
  // 5. RELATIONSHIPS
  // ==========================================

  createRelationship(params: {
    ownerId: string;
    name: string;
    relation: string;
    notes?: string;
    importance?: number;
    sensitivity?: Sensitivity;
    confidence?: number;
    provenance?: MemoryProvenance;
  }): Relationship {
    const id = ulid();
    const now = Date.now();
    const importance = params.importance ?? 0.5;
    const sensitivity = params.sensitivity ?? 'owner_only';
    const confidence = params.confidence ?? 1.0;
    const lifecycleStatus: LifecycleStatus = 'active';

    const provenance = params.provenance ?? {
      sourceCycleId: id,
      sourceConversationId: id,
      sourceMessageIds: [],
      extractedAt: now,
      extractor: 'rule',
      confidence,
      validatedBy: 'app_rule',
    };

    const relationship: Relationship = {
      id,
      identityId: params.ownerId,
      ownerId: params.ownerId,
      subjectKind: 'owner',
      sensitivity,
      confidence,
      sourceKind: 'conversation',
      provenance,
      name: params.name,
      relation: params.relation,
      notes: params.notes,
      importance,
      createdAt: now,
      updatedAt: now,
      lifecycleStatus,
    };

    this.db.raw
      .prepare(
        `
      INSERT INTO relationship (
        id, owner_id, name, relation, notes, importance, sensitivity,
        created_at, updated_at, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        params.ownerId,
        params.name,
        params.relation,
        params.notes ?? null,
        importance,
        sensitivity,
        toIso(now),
        toIso(now),
        lifecycleStatus
      );

    return relationship;
  }

  getRelationship(id: string): Relationship | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, owner_id, name, relation, notes, importance, sensitivity,
             created_at, updated_at, lifecycle_status, deleted_at, deleted_by
      FROM relationship
      WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapRelationshipRow(row);
  }

  listRelationships(ownerId?: string, includeDeleted = false): Relationship[] {
    let query = `
      SELECT id, owner_id, name, relation, notes, importance, sensitivity,
             created_at, updated_at, lifecycle_status, deleted_at, deleted_by
      FROM relationship
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (ownerId) {
      conditions.push('owner_id = ?');
      params.push(ownerId);
    }
    if (!includeDeleted) {
      conditions.push("lifecycle_status != 'soft_deleted' AND deleted_at IS NULL");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY importance DESC, name ASC';

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRelationshipRow(r));
  }

  softDeleteRelationship(id: string, deletedBy: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE relationship
      SET lifecycle_status = 'soft_deleted', deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND lifecycle_status != 'soft_deleted'
    `
      )
      .run(now, deletedBy, now, id);

    return result.changes > 0;
  }

  restoreRelationship(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE relationship
      SET lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL, updated_at = ?
      WHERE id = ? AND lifecycle_status = 'soft_deleted'
    `
      )
      .run(now, id);

    return result.changes > 0;
  }

  hardDeleteRelationship(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM relationship WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private mapRelationshipRow(row: Record<string, unknown>): Relationship {
    const ownerId = row['owner_id'] as string;
    const now = fromIso(row['created_at'] as string);
    return {
      id: row['id'] as string,
      identityId: ownerId,
      ownerId,
      subjectKind: 'owner',
      sensitivity: row['sensitivity'] as Sensitivity,
      confidence: 1.0,
      sourceKind: 'conversation',
      provenance: {
        sourceCycleId: row['id'] as string,
        sourceConversationId: row['id'] as string,
        sourceMessageIds: [],
        extractedAt: now,
        extractor: 'rule',
        confidence: 1.0,
        validatedBy: 'app_rule',
      },
      name: row['name'] as string,
      relation: row['relation'] as string,
      notes: (row['notes'] as string | null) ?? undefined,
      importance: Number(row['importance']),
      createdAt: now,
      updatedAt: fromIso(row['updated_at'] as string),
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      deletedAt: row['deleted_at'] ? fromIso(row['deleted_at'] as string) : undefined,
      deletedBy: (row['deleted_by'] as string | null) ?? undefined,
    };
  }

  // ==========================================
  // 6. LEARNED PATTERNS
  // ==========================================

  createLearnedPattern(params: {
    identityId: string;
    pattern: string;
    evidenceCount?: number;
    subjectKind?: SubjectKind;
    sensitivity?: Sensitivity;
    confidence?: number;
    sourceKind?: SourceKind;
    provenance: MemoryProvenance;
    expiresAt?: number;
  }): LearnedPattern {
    const id = ulid();
    const now = Date.now();
    const evidenceCount = params.evidenceCount ?? 1;
    const subjectKind = params.subjectKind ?? 'person';
    const sensitivity = params.sensitivity ?? 'person_shared';
    const confidence = params.confidence ?? 1.0;
    const sourceKind = params.sourceKind ?? 'system';
    const lifecycleStatus: LifecycleStatus = 'active';

    const patternItem: LearnedPattern = {
      id,
      identityId: params.identityId,
      subjectKind,
      sensitivity,
      confidence,
      sourceKind,
      provenance: params.provenance,
      pattern: params.pattern,
      evidenceCount,
      createdAt: now,
      updatedAt: now,
      expiresAt: params.expiresAt,
      lifecycleStatus,
    };

    this.db.raw
      .prepare(
        `
      INSERT INTO learned_pattern (
        id, identity_id, subject_kind, sensitivity, confidence, source_kind,
        provenance_json, pattern, evidence_count, created_at, updated_at,
        expires_at, lifecycle_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        id,
        params.identityId,
        subjectKind,
        sensitivity,
        confidence,
        sourceKind,
        JSON.stringify(params.provenance),
        params.pattern,
        evidenceCount,
        toIso(now),
        toIso(now),
        toIso(params.expiresAt),
        lifecycleStatus
      );

    return patternItem;
  }

  getLearnedPattern(id: string): LearnedPattern | null {
    const row = this.db.raw
      .prepare(
        `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, pattern, evidence_count, created_at, updated_at,
             expires_at, lifecycle_status, deleted_at, deleted_by
      FROM learned_pattern
      WHERE id = ?
    `
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.mapLearnedPatternRow(row);
  }

  listLearnedPatterns(identityId?: string, includeDeleted = false): LearnedPattern[] {
    let query = `
      SELECT id, identity_id, subject_kind, sensitivity, confidence, source_kind,
             provenance_json, pattern, evidence_count, created_at, updated_at,
             expires_at, lifecycle_status, deleted_at, deleted_by
      FROM learned_pattern
    `;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (identityId) {
      conditions.push('identity_id = ?');
      params.push(identityId);
    }
    if (!includeDeleted) {
      conditions.push("lifecycle_status != 'soft_deleted' AND deleted_at IS NULL");
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY evidence_count DESC, created_at DESC';

    const rows = this.db.raw.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapLearnedPatternRow(r));
  }

  softDeleteLearnedPattern(id: string, deletedBy: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE learned_pattern
      SET lifecycle_status = 'soft_deleted', deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND lifecycle_status != 'soft_deleted'
    `
      )
      .run(now, deletedBy, now, id);

    return result.changes > 0;
  }

  restoreLearnedPattern(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.raw
      .prepare(
        `
      UPDATE learned_pattern
      SET lifecycle_status = 'active', deleted_at = NULL, deleted_by = NULL, updated_at = ?
      WHERE id = ? AND lifecycle_status = 'soft_deleted'
    `
      )
      .run(now, id);

    return result.changes > 0;
  }

  hardDeleteLearnedPattern(id: string): boolean {
    const result = this.db.raw.prepare(`DELETE FROM learned_pattern WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  private mapLearnedPatternRow(row: Record<string, unknown>): LearnedPattern {
    return {
      id: row['id'] as string,
      identityId: row['identity_id'] as string,
      subjectKind: row['subject_kind'] as SubjectKind,
      sensitivity: row['sensitivity'] as Sensitivity,
      confidence: Number(row['confidence']),
      sourceKind: row['source_kind'] as SourceKind,
      provenance: JSON.parse(row['provenance_json'] as string),
      pattern: row['pattern'] as string,
      evidenceCount: Number(row['evidence_count']),
      createdAt: fromIso(row['created_at'] as string),
      updatedAt: fromIso(row['updated_at'] as string),
      expiresAt: row['expires_at'] ? fromIso(row['expires_at'] as string) : undefined,
      lifecycleStatus: row['lifecycle_status'] as LifecycleStatus,
      deletedAt: row['deleted_at'] ? fromIso(row['deleted_at'] as string) : undefined,
      deletedBy: (row['deleted_by'] as string | null) ?? undefined,
    };
  }
}
