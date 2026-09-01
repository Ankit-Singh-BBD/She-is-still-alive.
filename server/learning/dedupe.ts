import type { Database } from '@server/persistence/db.js';
import type { LearningCandidate, DedupeResult } from './types.js';

/**
 * Deduplication Engine
 * Identifies if a candidate memory already exists in the database
 * to prevent duplicates and enable updates (e.g. incrementing evidence count).
 */
export class DedupeEngine {
  constructor(private readonly db: Database) {}

  /**
   * Check if a candidate memory already exists.
   */
  evaluate(candidate: LearningCandidate): DedupeResult {
    if (candidate.domain === 'preference') {
      const content = candidate.content as { key: string; value: string };
      const row = this.db.raw
        .prepare(`SELECT id, value FROM preference WHERE identity_id = ? AND key = ? AND lifecycle_status = 'active'`)
        .get(candidate.callerId, content.key) as { id: string; value: string } | undefined;

      if (row) {
        return {
          action: 'update',
          existingId: row.id,
          reason: `Existing preference key '${content.key}' found; updating value from '${row.value}' to '${content.value}'`,
        };
      }
    }

    if (candidate.domain === 'habit') {
      const content = candidate.content as { pattern: string };
      const row = this.db.raw
        .prepare(`SELECT id FROM habit WHERE identity_id = ? AND pattern = ? AND lifecycle_status = 'active'`)
        .get(candidate.callerId, content.pattern) as { id: string } | undefined;

      if (row) {
        return {
          action: 'update',
          existingId: row.id,
          reason: `Existing habit '${content.pattern}' found; updating observation time`,
        };
      }
    }

    if (candidate.domain === 'relationship') {
      const content = candidate.content as { name: string; relation: string };
      const row = this.db.raw
        .prepare(
          `SELECT id FROM relationship WHERE owner_id = ? AND name = ? AND relation = ? AND lifecycle_status = 'active'`,
        )
        .get(candidate.callerId, content.name, content.relation) as { id: string } | undefined;

      if (row) {
        return {
          action: 'update',
          existingId: row.id,
          reason: `Existing relationship with '${content.name}' found`,
        };
      }
    }

    if (candidate.domain === 'learned_pattern') {
      const content = candidate.content as { pattern: string };
      const row = this.db.raw
        .prepare(`SELECT id FROM learned_pattern WHERE identity_id = ? AND pattern = ? AND lifecycle_status = 'active'`)
        .get(candidate.callerId, content.pattern) as { id: string } | undefined;

      if (row) {
        return {
          action: 'update',
          existingId: row.id,
          reason: `Existing pattern '${content.pattern}' found; incrementing evidence count`,
        };
      }
    }

    return {
      action: 'insert',
      reason: 'No existing duplicate memory found',
    };
  }
}
