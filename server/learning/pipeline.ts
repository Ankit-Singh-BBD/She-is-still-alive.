/**
 * P16 — Learning Pipeline
 *
 * Implements Build Book Part XIII:
 * 1. Takes completed CycleRecord and conversation messages
 * 2. Proposes candidate memories (LLM or rule-based)
 * 3. Enforces Scoped Guest Learning Policy
 * 4. Filters by confidence and importance thresholds
 * 5. Deduplicates against existing memory in DB
 * 6. Persists new/updated memories with full provenance
 * 7. Emits domain events for auditability
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { IdentityKind } from '@server/identity/types.js';
import type { DomainEventType } from '@server/events/types.js';
import type {
  LearningCandidate,
  LearningResult,
  LearningPipelineOptions,
  LearningExtractor,
  GuestLearningPolicy,
  CycleRecord,
  Message,
  ScopedLearningDecision,
  DedupeResult,
} from './types.js';
import { DEFAULT_LEARNING_OPTIONS } from './types.js';
import { DefaultGuestLearningPolicy } from './policy.js';
import { DedupeEngine } from './dedupe.js';

export class LearningPipeline {
  private readonly db: Database;
  private readonly eventBus: EventBus | undefined;
  private readonly memoryRepo: MemoryRepository;
  private readonly identityRepo: IdentityRepository | undefined;
  private readonly extractor: LearningExtractor;
  private readonly policy: GuestLearningPolicy;
  private readonly dedupeEngine: DedupeEngine;
  private readonly options: Required<LearningPipelineOptions>;

  constructor(params: {
    db: Database;
    eventBus?: EventBus;
    memoryRepo: MemoryRepository;
    identityRepo?: IdentityRepository;
    extractor: LearningExtractor;
    policy?: GuestLearningPolicy;
    options?: LearningPipelineOptions;
  }) {
    this.db = params.db;
    this.eventBus = params.eventBus;
    this.memoryRepo = params.memoryRepo;
    this.identityRepo = params.identityRepo;
    this.extractor = params.extractor;
    this.policy = params.policy ?? new DefaultGuestLearningPolicy();
    this.dedupeEngine = new DedupeEngine(this.db);
    this.options = { ...DEFAULT_LEARNING_OPTIONS, ...params.options };
  }

  /**
   * Run the learning pipeline on a completed cycle.
   */
  async processCycle(cycleRecord: CycleRecord, messages: Message[]): Promise<LearningResult> {
    // 0. Refuse to be the second writer for one cycle.
    //
    // Stages 10 and 11 already learn inside the cycle. Running again over the
    // same `cycle_record` would re-propose what was kept and insert `episodic`
    // and `semantic` duplicates, which the dedupe engine has no branch for. See
    // `relearnCycles` for why this is the default.
    if (!this.options.relearnCycles) {
      const already = this.memoriesWrittenBy(cycleRecord.id);
      if (already > 0) {
        return {
          learned: false,
          count: 0,
          skipped: `Cycle ${cycleRecord.id} already wrote ${already} ${already === 1 ? 'memory' : 'memories'} in-cycle; not learning from it twice`,
          details: [],
        };
      }
    }

    // 1. Resolve caller kind
    const callerKind = this.resolveCallerKind(cycleRecord.identityId);

    // 2. Extract candidate memories
    const rawCandidates = await this.extractor.extract(cycleRecord, messages);

    // 3. Process each candidate through the pipeline
    const details: LearningResult['details'] = [];
    let learnedCount = 0;

    for (const candidate of rawCandidates.slice(0, this.options.maxExtractionsPerCycle)) {
      // Step A: Threshold filtering
      if (
        candidate.confidence < this.options.confidenceThreshold ||
        candidate.importance < this.options.importanceThreshold
      ) {
        details.push({
          candidate,
          decision: {
            action: 'discard',
            discardReason: `Below threshold (conf: ${candidate.confidence}, imp: ${candidate.importance})`,
          },
          dedupe: { action: 'insert', reason: 'Skipped dedupe due to discard' },
        });
        continue;
      }

      // Step B: Scoped Learning Policy evaluation
      const decision = this.policy.evaluate(candidate, candidate.callerId, callerKind);

      if (decision.action === 'discard') {
        details.push({
          candidate,
          decision,
          dedupe: { action: 'insert', reason: 'Skipped dedupe due to policy discard' },
        });
        continue;
      }

      // Step C: Deduplication check against DB
      const dedupe = this.dedupeEngine.evaluate(candidate);

      // Step D: Execution / Persistence
      try {
        let memoryId: string | undefined;

        if (decision.action === 'quarantine') {
          // Write to quarantine / unverified_semantic table or mark in semantic memory
          memoryId = this.persistQuarantine(candidate, cycleRecord, decision);
        } else if (dedupe.action === 'update' && dedupe.existingId) {
          memoryId = this.updateExisting(dedupe.existingId, candidate, cycleRecord, decision);
        } else {
          memoryId = this.persistNew(candidate, cycleRecord, decision);
        }

        learnedCount++;
        details.push({
          candidate,
          decision,
          dedupe,
          memoryId,
        });

        // Step E: Emit domain event
        void this.publish('memory.appended', {
          memoryId,
          domain: candidate.domain,
          identityId: candidate.callerId,
          cycleId: cycleRecord.id,
          action: decision.action,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        details.push({
          candidate,
          decision,
          dedupe,
          error: message,
        });
      }
    }

    return {
      learned: learnedCount > 0,
      count: learnedCount,
      details,
    };
  }

  /**
   * How many memory rows this cycle has already written.
   *
   * Read from authoritative state rather than from an event, for the same reason
   * a postcondition verifier re-reads a table instead of trusting a return value:
   * `cycle.learned` says an intention was recorded, and rows are what actually
   * exist.
   *
   * Two honest gaps. `relationship` carries no provenance column at all, so a
   * relationship written in-cycle is invisible here; and `json_valid` is checked
   * before `json_extract` because a row whose `provenance_json` is not JSON would
   * otherwise make this query throw and take the whole pipeline with it.
   */
  private memoriesWrittenBy(cycleId: string): number {
    const byProvenance = (table: string): string =>
      `(SELECT COUNT(*) FROM ${table} WHERE provenance_json IS NOT NULL
          AND json_valid(provenance_json)
          AND json_extract(provenance_json, '$.sourceCycleId') = ?)`;

    const row = this.db.raw
      .prepare(
        `SELECT ${byProvenance('episodic_memory')}
              + (SELECT COUNT(*) FROM semantic_memory
                   WHERE source_cycle = ?
                      OR (provenance_json IS NOT NULL
                          AND json_valid(provenance_json)
                          AND json_extract(provenance_json, '$.sourceCycleId') = ?))
              + ${byProvenance('preference')}
              + ${byProvenance('habit')}
              + ${byProvenance('learned_pattern')}
           AS n`,
      )
      .get(cycleId, cycleId, cycleId, cycleId, cycleId, cycleId) as { n: number } | undefined;

    return row?.n ?? 0;
  }

  private resolveCallerKind(identityId: string): IdentityKind {
    if (this.identityRepo) {
      const identity = this.identityRepo.getIdentity(identityId);
      if (identity) return identity.kind;
    }
    // Fallback: query raw DB
    const row = this.db.raw.prepare(`SELECT kind FROM identity WHERE id = ?`).get(identityId) as
      | { kind: IdentityKind }
      | undefined;
    return row?.kind ?? 'guest';
  }

  private deduplicate(candidate: LearningCandidate): DedupeResult {
    return this.dedupeEngine.evaluate(candidate);
  }

  private persistNew(
    candidate: LearningCandidate,
    cycleRecord: CycleRecord,
    decision: ScopedLearningDecision,
  ): string {
    const provenance = {
      sourceCycleId: cycleRecord.id,
      sourceConversationId: cycleRecord.conversationId,
      sourceMessageIds: [],
      extractedAt: Date.now(),
      // Reported by the extractor rather than assumed. This was hardcoded to
      // `'llm'` while the only extractor in the repository was a stub, so every
      // row it ever wrote would have claimed a model proposed it.
      extractor: candidate.extractor ?? ('rule' as const),
      confidence: candidate.confidence,
      validatedBy: 'auto_policy' as const,
    };

    switch (candidate.domain) {
      case 'preference': {
        const content = candidate.content as { key: string; value: string };
        const mem = this.memoryRepo.createPreference({
          identityId: candidate.callerId,
          key: content.key,
          value: content.value,
          ...(decision.subjectKind ? { subjectKind: decision.subjectKind } : {}),
          ...(decision.sensitivity ? { sensitivity: decision.sensitivity } : {}),
          confidence: candidate.confidence,
          ...(decision.sourceKind ? { sourceKind: decision.sourceKind } : {}),
          provenance,
        });
        return mem.id;
      }

      case 'episodic': {
        const content = candidate.content as { summary: string; details?: string; importance?: number };
        const mem = this.memoryRepo.createEpisodic({
          identityId: candidate.callerId,
          summary: content.summary,
          ...(content.details !== undefined ? { details: content.details } : {}),
          ...(content.importance !== undefined ? { importance: content.importance } : {}),
          ...(decision.subjectKind ? { subjectKind: decision.subjectKind } : {}),
          ...(decision.sensitivity ? { sensitivity: decision.sensitivity } : {}),
          confidence: candidate.confidence,
          ...(decision.sourceKind ? { sourceKind: decision.sourceKind } : {}),
          provenance,
        });
        return mem.id;
      }

      case 'semantic': {
        const content = candidate.content as { subject: string; predicate: string; object: string };
        const mem = this.memoryRepo.createSemantic({
          identityId: candidate.callerId,
          subject: content.subject,
          predicate: content.predicate,
          object: content.object,
          // `semantic_memory` is the one domain with a dedicated `source_cycle`
          // column, and this left it null while `persistQuarantine` a few methods
          // down filled it in. So a fact she quarantined could be traced back to
          // the cycle that produced it and a fact she accepted could not, which
          // is the wrong way round. `memoriesWrittenBy` reads this column first
          // and the provenance JSON second, so the guard was surviving on its
          // fallback.
          sourceCycle: cycleRecord.id,
          ...(decision.subjectKind ? { subjectKind: decision.subjectKind } : {}),
          ...(decision.sensitivity ? { sensitivity: decision.sensitivity } : {}),
          confidence: candidate.confidence,
          ...(decision.sourceKind ? { sourceKind: decision.sourceKind } : {}),
          provenance,
        });
        return mem.id;
      }

      case 'habit': {
        const content = candidate.content as { pattern: string; frequency?: string };
        const mem = this.memoryRepo.createHabit({
          identityId: candidate.callerId,
          pattern: content.pattern,
          ...(content.frequency !== undefined ? { frequency: content.frequency } : {}),
          ...(decision.subjectKind ? { subjectKind: decision.subjectKind } : {}),
          ...(decision.sensitivity ? { sensitivity: decision.sensitivity } : {}),
          confidence: candidate.confidence,
          ...(decision.sourceKind ? { sourceKind: decision.sourceKind } : {}),
          provenance,
        });
        return mem.id;
      }

      case 'relationship': {
        const content = candidate.content as { name: string; relation: string; notes?: string; importance?: number };
        const mem = this.memoryRepo.createRelationship({
          ownerId: candidate.callerId,
          name: content.name,
          relation: content.relation,
          ...(content.notes !== undefined ? { notes: content.notes } : {}),
          ...(content.importance !== undefined ? { importance: content.importance } : {}),
          ...(decision.sensitivity ? { sensitivity: decision.sensitivity } : {}),
        });
        return mem.id;
      }

      case 'learned_pattern': {
        const content = candidate.content as { pattern: string };
        const mem = this.memoryRepo.createLearnedPattern({
          identityId: candidate.callerId,
          pattern: content.pattern,
          ...(decision.subjectKind ? { subjectKind: decision.subjectKind } : {}),
          ...(decision.sensitivity ? { sensitivity: decision.sensitivity } : {}),
          confidence: candidate.confidence,
          ...(decision.sourceKind ? { sourceKind: decision.sourceKind } : {}),
          provenance,
        });
        return mem.id;
      }

      default: {
        const _exhaustive: never = candidate.domain;
        throw new Error(`Unhandled memory domain: ${_exhaustive}`);
      }
    }
  }

  /**
   * Reinforces an existing memory the dedupe engine matched.
   *
   * Every domain the dedupe engine can return `update` for must have a branch
   * here. It previously had none for `relationship` yet still returned
   * `existingId`, so the caller incremented `learnedCount` over a row nothing
   * had written — she reported learning something she had not learned. An
   * unhandled domain, or an UPDATE that matches no row, now throws: the caller
   * records the failure in `details` instead of counting it.
   */
  private updateExisting(
    existingId: string,
    candidate: LearningCandidate,
    _cycleRecord: CycleRecord,
    _decision: ScopedLearningDecision,
  ): string {
    const nowIso = new Date().toISOString();
    let changes: number;

    switch (candidate.domain) {
      case 'preference': {
        const content = candidate.content as { value: string };
        changes = this.db.raw
          .prepare(`UPDATE preference SET value = ?, updated_at = ? WHERE id = ?`)
          .run(content.value, nowIso, existingId).changes;
        break;
      }

      case 'habit': {
        changes = this.db.raw
          .prepare(`UPDATE habit SET last_observed = ?, updated_at = ? WHERE id = ?`)
          .run(nowIso, nowIso, existingId).changes;
        break;
      }

      case 'learned_pattern': {
        changes = this.db.raw
          .prepare(
            `UPDATE learned_pattern SET evidence_count = evidence_count + 1, updated_at = ? WHERE id = ?`,
          )
          .run(nowIso, existingId).changes;
        break;
      }

      case 'relationship': {
        // Dedupe matched on (owner_id, name, relation), so those are unchanged.
        // What a repeat mention can carry is fresher notes and a revised
        // importance; COALESCE keeps the stored value when the candidate omits
        // one rather than blanking it.
        const content = candidate.content as { notes?: string; importance?: number };
        changes = this.db.raw
          .prepare(
            `UPDATE relationship
                SET notes = COALESCE(?, notes),
                    importance = COALESCE(?, importance),
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(content.notes ?? null, content.importance ?? null, nowIso, existingId).changes;
        break;
      }

      default:
        throw new Error(
          `Dedupe returned 'update' for domain '${candidate.domain}', which has no update path`,
        );
    }

    if (changes === 0) {
      throw new Error(
        `Update of existing ${candidate.domain} ${existingId} matched no row; nothing was learned`,
      );
    }

    return existingId;
  }

  private persistQuarantine(
    candidate: LearningCandidate,
    cycleRecord: CycleRecord,
    _decision: ScopedLearningDecision,
  ): string {
    const id = ulid();
    const nowIso = new Date().toISOString();
    const content = candidate.content as { subject: string; predicate: string; object: string };

    const provenance = {
      sourceCycleId: cycleRecord.id,
      sourceConversationId: cycleRecord.conversationId,
      sourceMessageIds: [],
      extractedAt: Date.now(),
      extractor: candidate.extractor ?? 'rule',
      confidence: candidate.confidence,
      validatedBy: 'app_rule',
      quarantined: true,
      quarantineReason: 'Non-owner claims about owner require owner confirmation',
    };

    // Store in semantic_memory with unverified / quarantine lifecycle_status
    this.db.raw
      .prepare(
        `INSERT INTO semantic_memory (id, identity_id, subject_kind, sensitivity, confidence, source_kind,
                                     provenance_json, subject, predicate, object, source_cycle,
                                     created_at, updated_at, lifecycle_status)
         VALUES (?, ?, 'owner', 'owner_only', ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, 'archived')`,
      )
      .run(
        id,
        candidate.callerId,
        candidate.confidence,
        JSON.stringify(provenance),
        content.subject,
        content.predicate,
        content.object,
        cycleRecord.id,
        nowIso,
        nowIso,
      );

    return id;
  }

  private async publish(type: DomainEventType, payload: Record<string, unknown>): Promise<void> {
    if (!this.eventBus) return;
    await this.eventBus.publish({
      type,
      payload,
      identityId: undefined,
      cycleId: undefined,
      timestamp: Date.now(),
      causationId: undefined,
      correlationId: undefined,
      version: 1,
    });
  }
}