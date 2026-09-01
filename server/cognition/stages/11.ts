/**
 * Stage 11: UPDATE
 *
 * The Application applies the authorized learning delta to in-process state
 * and memory tables (Build Book Part VII.1 stage 11).
 *
 * Every memory row is written with full multi-domain schema, common header,
 * sensitivity gating, and provenance linkage.
 *
 * P10 rollback contract: with no learning delta (empty memories array),
 * update reports applied: 0, skipped: 0, errors: [] and performs no writes.
 */

import type { Database } from '@server/persistence/db.js';
import { MemoryRepository } from '@server/memory/repository.js';
import type {
  AuthorizedLearningDelta,
  UpdateResult,
} from '../types.js';

export interface UpdateOptions {
  db?: Database | undefined;
  memoryRepo?: MemoryRepository | undefined;
}

export async function update(
  delta: AuthorizedLearningDelta | undefined,
  opts: UpdateOptions = {},
): Promise<UpdateResult> {
  if (!delta || delta.memories.length === 0) {
    return { applied: 0, skipped: 0, errors: [] };
  }

  const memoryRepo = opts.memoryRepo ?? (opts.db ? new MemoryRepository(opts.db) : undefined);
  if (!memoryRepo) {
    return {
      applied: 0,
      skipped: delta.memories.length,
      errors: ['No MemoryRepository or Database available for update stage'],
    };
  }

  let applied = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const item of delta.memories) {
    try {
      const data = item.data;
      const identityId = (data['identityId'] as string) ?? 'unknown';

      switch (item.domain) {
        case 'preference': {
          const key = (data['key'] as string) ?? 'preference';
          const value = (data['value'] as string) ?? '';
          if (!value) {
            skipped += 1;
            continue;
          }
          memoryRepo.createPreference({
            identityId,
            key,
            value,
            statedAt: (data['statedAt'] as number) ?? Date.now(),
            subjectKind: item.subjectKind as any,
            sensitivity: item.sensitivity,
            confidence: item.provenance.confidence,
            sourceKind: 'conversation',
            provenance: item.provenance,
          });
          applied += 1;
          break;
        }

        case 'relationship': {
          const name = (data['name'] as string) ?? '';
          const relation = (data['relation'] as string) ?? '';
          if (!name || !relation) {
            skipped += 1;
            continue;
          }
          memoryRepo.createRelationship({
            ownerId: identityId,
            name,
            relation,
            notes: (data['notes'] as string) ?? '',
            importance: (data['importance'] as number) ?? 0.5,
            sensitivity: item.sensitivity,
            confidence: item.provenance.confidence,
            provenance: item.provenance,
          });
          applied += 1;
          break;
        }

        case 'semantic': {
          const subject = (data['subject'] as string) ?? identityId;
          const predicate = (data['predicate'] as string) ?? 'is';
          const object = (data['object'] as string) ?? '';
          if (!object) {
            skipped += 1;
            continue;
          }
          memoryRepo.createSemantic({
            identityId,
            subject,
            predicate,
            object,
            sourceCycle: (data['sourceCycle'] as string) ?? item.provenance.sourceCycleId,
            subjectKind: item.subjectKind as any,
            sensitivity: item.sensitivity,
            confidence: item.provenance.confidence,
            sourceKind: 'conversation',
            provenance: item.provenance,
          });
          applied += 1;
          break;
        }

        case 'episodic': {
          const summary = (data['summary'] as string) ?? '';
          if (!summary) {
            skipped += 1;
            continue;
          }
          memoryRepo.createEpisodic({
            identityId,
            summary,
            details: (data['details'] as string) ?? '',
            occurredAt: (data['occurredAt'] as number) ?? Date.now(),
            importance: (data['importance'] as number) ?? 0.5,
            subjectKind: item.subjectKind as any,
            sensitivity: item.sensitivity,
            confidence: item.provenance.confidence,
            sourceKind: 'conversation',
            provenance: item.provenance,
          });
          applied += 1;
          break;
        }

        case 'habit': {
          const pattern = (data['pattern'] as string) ?? '';
          if (!pattern) {
            skipped += 1;
            continue;
          }
          memoryRepo.createHabit({
            identityId,
            pattern,
            frequency: (data['frequency'] as string) ?? '',
            lastObserved: (data['lastObserved'] as number) ?? Date.now(),
            subjectKind: item.subjectKind as any,
            sensitivity: item.sensitivity,
            confidence: item.provenance.confidence,
            sourceKind: 'conversation',
            provenance: item.provenance,
          });
          applied += 1;
          break;
        }

        case 'learned_pattern': {
          const pattern = (data['pattern'] as string) ?? '';
          if (!pattern) {
            skipped += 1;
            continue;
          }
          memoryRepo.createLearnedPattern({
            identityId,
            pattern,
            evidenceCount: (data['evidenceCount'] as number) ?? 1,
            subjectKind: item.subjectKind as any,
            sensitivity: item.sensitivity,
            confidence: item.provenance.confidence,
            sourceKind: 'conversation',
            provenance: item.provenance,
          });
          applied += 1;
          break;
        }

        default:
          skipped += 1;
          errors.push(`Unknown memory domain: ${item.domain}`);
      }
    } catch (e) {
      errors.push(`Failed to apply ${item.domain}: ${e instanceof Error ? e.message : String(e)}`);
      skipped += 1;
    }
  }

  return { applied, skipped, errors };
}
