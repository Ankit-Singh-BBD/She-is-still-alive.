// Part XXV.2 / Phase P28: Optional import from legacy DB. Validated.
// The new system must boot and work correctly from an empty database.
// The old DB file is preserved as the archive until the owner explicitly purges it.
//
// Rules:
// 1. Dry-run mode: scan and report counts without mutating the destination.
// 2. Owner confirmation is required to perform a non-dry-run import.
// 3. Every imported memory must have provenance, must be scoped, and must pass the Knowledge Retrieval Policy.
// 4. The legacy DB is never mutated; the old DB is preserved as the archive.
import { ulid } from 'ulid';
import DatabaseBetter from 'better-sqlite3';
import type { Database } from '@server/persistence/db.js';
import type { MemoryProvenance } from '@server/memory/types.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';

export interface ImportStats {
  identitiesScanned: number;
  memoriesScanned: number;
  identitiesImported: number;
  memoriesImported: number;
}

type LegacyUser = { id: string; name: string; role: string };
type LegacyMemory = { id: string; user_id: string; text: string; category: string };

function mapRoleToKind(role: string): 'owner' | 'person' | 'guest' {
  if (role === 'admin') return 'owner';
  if (role === 'guest') return 'guest';
  return 'person';
}

function mapKindToSensitivity(kind: 'owner' | 'person' | 'guest'): 'owner_only' | 'person_shared' {
  // Per Knowledge Retrieval Policy: imported memories from a guest never become
  // owner_only; they remain scoped to the legacy subject unless they belong to
  // the owner. (We never import from guest users in practice; but guard anyway.)
  return kind === 'owner' ? 'owner_only' : 'person_shared';
}

export class ImportLegacyScript {
  constructor(
    private dest: Database,
    private legacyDbOrPath: Database | string
  ) {}

  async run(opts: { dryRun?: boolean; ownerConfirmed?: boolean } = {}): Promise<ImportStats> {
    // Accept both a Database object (allows sharing a file handle during tests)
    // and a plain filesystem path. If we receive a path, open readonly so we never
    // contend with another writer and never mutate the archived file.
    const legacyDb: DatabaseBetter.Database =
      typeof this.legacyDbOrPath === 'string'
        ? new DatabaseBetter(this.legacyDbOrPath, { readonly: true })
        : (this.legacyDbOrPath as Database).raw as unknown as DatabaseBetter.Database;
    const closeLegacy = typeof this.legacyDbOrPath === 'string';

    const identitiesScanned = (legacyDb.prepare('SELECT COUNT(*) as cnt FROM old_users').get() as { cnt: number }).cnt;
    const memoriesScanned = (legacyDb.prepare('SELECT COUNT(*) as cnt FROM old_memories').get() as { cnt: number }).cnt;

    if (opts.dryRun) {
      if (closeLegacy) legacyDb.close();
      return { identitiesScanned, memoriesScanned, identitiesImported: 0, memoriesImported: 0 };
    }

    if (!opts.ownerConfirmed) {
      if (closeLegacy) legacyDb.close();
      throw new Error('Owner confirmation required before importing legacy data');
    }

    // Pull all rows from the legacy DB BEFORE opening the transaction so that
    // the destination transaction never holds a lock on the legacy file.
    const oldIdentities = legacyDb.prepare('SELECT id, name, role FROM old_users').all() as LegacyUser[];
    const oldMemories = legacyDb.prepare('SELECT id, user_id, text, category FROM old_memories').all() as LegacyMemory[];
    if (closeLegacy) legacyDb.close();

    // Build new-id mapping outside the transaction so we can validate.
    const newIdentityIdByOldId = new Map<string, string>();
    for (const user of oldIdentities) {
      newIdentityIdByOldId.set(user.id, ulid());
    }

    // Defer INSERTs to a single atomic transaction in the destination.
    const stats: ImportStats = {
      identitiesScanned,
      memoriesScanned,
      identitiesImported: 0,
      memoriesImported: 0,
    };

    const insert = this.dest.raw.transaction(() => {
      for (const user of oldIdentities) {
        const kind = mapRoleToKind(user.role);
        const permissions = DEFAULT_PERMISSIONS[kind];
        const newId = newIdentityIdByOldId.get(user.id)!;
        this.dest.raw
          .prepare(`INSERT INTO identity (id, kind, display_name) VALUES (?, ?, ?)`)
          .run(newId, kind, user.name);
        this.dest.raw
          .prepare(`INSERT INTO permission (identity_id, version, json, effective_from) VALUES (?, 1, ?, datetime('now'))`)
          .run(newId, JSON.stringify(permissions));
        stats.identitiesImported++;
      }

      for (const mem of oldMemories) {
        const identityId = newIdentityIdByOldId.get(mem.user_id);
        if (!identityId) continue;
        const user = oldIdentities.find(u => u.id === mem.user_id);
        if (!user) continue;
        const kind = mapRoleToKind(user.role);
        const sensitivity = mapKindToSensitivity(kind);

        const provenance: MemoryProvenance = {
          sourceCycleId: 'legacy-cycle',
          sourceConversationId: 'legacy-conv',
          sourceMessageIds: [],
          extractedAt: Date.now(),
          extractor: 'legacy_import',
          confidence: 1,
          validatedBy: 'owner_confirmation',
        };

        // Route by category into the matching domain table.
        // The new schema is multi-domain; the legacy schema was a flat (category, text)
        // tuple. category='preference' becomes a row in `preference`; everything else
        // becomes a row in `semantic_memory` (subject/predicate/object) where the
        // legacy id is preserved as `subject` so the row is locatable.
        if (mem.category === 'preference') {
          this.dest.raw.prepare(`
            INSERT INTO preference (
              id, identity_id, subject_kind, sensitivity, confidence, source_kind,
              provenance_json, key, value, stated_at, created_at, updated_at, lifecycle_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), 'active')
          `).run(
            ulid(),
            identityId,
            kind,
            sensitivity,
            1,
            'external',
            JSON.stringify(provenance),
            mem.id,
            mem.text
          );
        } else {
          this.dest.raw.prepare(`
            INSERT INTO semantic_memory (
              id, identity_id, subject_kind, sensitivity, confidence, source_kind,
              provenance_json, subject, predicate, object, created_at, updated_at, lifecycle_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'active')
          `).run(
            ulid(),
            identityId,
            kind,
            sensitivity,
            1,
            'external',
            JSON.stringify(provenance),
            mem.id,
            mem.category,
            mem.text
          );
        }
        stats.memoriesImported++;
      }
    });

    insert();
    return stats;
  }
}

