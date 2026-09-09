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
} from './types.js';
import { DEFAULT_LEARNING_OPTIONS } from './types.js';
import { DefaultGuestLearningPolicy, discarded } from './policy.js';
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
  private readonly report: (what: string, error: unknown) => void;

  constructor(params: {
    db: Database;
    eventBus?: EventBus;
    memoryRepo: MemoryRepository;
    identityRepo?: IdentityRepository;
    extractor: LearningExtractor;
    policy?: GuestLearningPolicy;
    options?: LearningPipelineOptions;
    /** Where a failed event publish is reported. Defaults to `console.error`. */
    report?: ((what: string, error: unknown) => void) | undefined;
  }) {
    this.db = params.db;
    this.eventBus = params.eventBus;
    this.memoryRepo = params.memoryRepo;
    this.identityRepo = params.identityRepo;
    this.extractor = params.extractor;
    this.policy = params.policy ?? new DefaultGuestLearningPolicy();
    this.dedupeEngine = new DedupeEngine(this.db);
    this.options = { ...DEFAULT_LEARNING_OPTIONS, ...params.options };
    this.report =
      params.report ??
      ((what, error) => {
        console.error(`[learning] ${what}:`, error);
      });
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

    // 1. Resolve who is speaking, and what the owner is called.
    //
    // The name is looked up once per cycle rather than per candidate, and it is what makes
    // the quarantine row reachable off this path: "Ankit ko chai pasand hai" is a claim
    // about him that never uses the word "owner". Without it the policy could only catch
    // the role word, and the pipeline would file a guest's claim about the owner as the
    // guest's own semantic fact.
    const callerKind = this.resolveCallerKind(cycleRecord.identityId);
    const ownerName = this.resolveOwnerName();

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
          decision: discarded(
            `Below threshold (conf: ${candidate.confidence}, imp: ${candidate.importance})`,
          ),
          dedupe: { action: 'insert', reason: 'Skipped dedupe due to discard' },
        });
        continue;
      }

      // Step B: Scoped Learning Policy evaluation
      const decision = this.policy.evaluate(candidate, candidate.callerId, callerKind, ownerName);

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
          // Held as an `unverified_semantic` row, whatever domain it was extracted as.
          memoryId = this.persistQuarantine(candidate, cycleRecord, decision, ownerName);
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
        this.publish('memory.appended', {
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

  /**
   * The owner's enrolled display name, or undefined when there is no owner yet.
   *
   * Falls back to raw SQL for the same reason `resolveCallerKind` does: the identity
   * repository is optional on this constructor, and the policy's answer must not depend
   * on which of two equivalent wirings a caller chose.
   */
  private resolveOwnerName(): string | undefined {
    if (this.identityRepo) return this.identityRepo.getOwner()?.displayName;
    const row = this.db.raw
      .prepare(`SELECT display_name FROM identity WHERE kind = 'owner' LIMIT 1`)
      .get() as { display_name: string } | undefined;
    return row?.display_name;
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
      // The policy's claim, not this writer's. `persistQuarantine` used to hardcode
      // `'app_rule'` on a row whose entire purpose is to be awaiting validation.
      validatedBy: decision.validatedBy,
    };

    switch (candidate.domain) {
      case 'preference': {
        const content = candidate.content as { key: string; value: string };
        const mem = this.memoryRepo.createPreference({
          identityId: decision.identityId,
          key: content.key,
          value: content.value,
          subjectKind: decision.subjectKind,
          sensitivity: decision.sensitivity,
          confidence: candidate.confidence,
          sourceKind: decision.sourceKind,
          provenance,
        });
        return mem.id;
      }

      case 'episodic': {
        const content = candidate.content as { summary: string; details?: string; importance?: number };
        const mem = this.memoryRepo.createEpisodic({
          identityId: decision.identityId,
          summary: content.summary,
          ...(content.details !== undefined ? { details: content.details } : {}),
          ...(content.importance !== undefined ? { importance: content.importance } : {}),
          subjectKind: decision.subjectKind,
          sensitivity: decision.sensitivity,
          confidence: candidate.confidence,
          sourceKind: decision.sourceKind,
          provenance,
        });
        return mem.id;
      }

      case 'semantic': {
        const content = candidate.content as { subject: string; predicate: string; object: string };
        const mem = this.memoryRepo.createSemantic({
          identityId: decision.identityId,
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
          subjectKind: decision.subjectKind,
          sensitivity: decision.sensitivity,
          confidence: candidate.confidence,
          sourceKind: decision.sourceKind,
          provenance,
        });
        return mem.id;
      }

      case 'habit': {
        const content = candidate.content as { pattern: string; frequency?: string };
        const mem = this.memoryRepo.createHabit({
          identityId: decision.identityId,
          pattern: content.pattern,
          ...(content.frequency !== undefined ? { frequency: content.frequency } : {}),
          subjectKind: decision.subjectKind,
          sensitivity: decision.sensitivity,
          confidence: candidate.confidence,
          sourceKind: decision.sourceKind,
          provenance,
        });
        return mem.id;
      }

      case 'relationship': {
        const content = candidate.content as { name: string; relation: string; notes?: string; importance?: number };
        const mem = this.memoryRepo.createRelationship({
          ownerId: decision.identityId,
          name: content.name,
          relation: content.relation,
          ...(content.notes !== undefined ? { notes: content.notes } : {}),
          ...(content.importance !== undefined ? { importance: content.importance } : {}),
          sensitivity: decision.sensitivity,
        });
        return mem.id;
      }

      case 'learned_pattern': {
        const content = candidate.content as { pattern: string };
        const mem = this.memoryRepo.createLearnedPattern({
          identityId: decision.identityId,
          pattern: content.pattern,
          subjectKind: decision.subjectKind,
          sensitivity: decision.sensitivity,
          confidence: candidate.confidence,
          sourceKind: decision.sourceKind,
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

  /**
   * Hold a non-owner's claim about the owner until he confirms it.
   *
   * Every field here now comes from the decision. It used to take `_decision` unused and
   * hardcode all five of `subject_kind`, `sensitivity`, `source_kind`, `lifecycle_status`
   * and `validatedBy` in its SQL — so the policy computed a quarantine scope that this
   * method overrode, and `validatedBy: 'app_rule'` claimed a rule had validated the one
   * kind of row that exists *because* nothing has validated it. Its provenance also
   * claimed `extractor: 'llm'` for every row including rule-extracted ones, and carried
   * `quarantined: true` and a `quarantineReason` sentence that are not fields of
   * `MemoryProvenance` and that nothing in the codebase reads — the stated reason for the
   * quarantine existed only there, which is why `sensitivity` and `lifecycle_status` had
   * to become the parts that actually do the work.
   *
   * It reached `lifecycle_status` with raw SQL because `MemoryRepository` hardcoded that
   * column, so it also carried its own copy of the table's shape and timestamp format —
   * one INSERT to keep in step with the schema by hand. `createSemantic` now takes a
   * `lifecycleStatus`, so there is one writer of this table again.
   *
   * ## Why every domain lands in `semantic_memory`
   *
   * XIII.4's cell reads "Saved as `unverified_semantic`", and the quarantine branch of
   * the policy fires on *any* domain — a guest can say "Ankit ko chai pasand hai"
   * (`preference`), "Ankit ki behen Priya hai" (`relationship`), or "Ankit roz 6 baje
   * uthta hai" (`habit`), and all three are unverified claims about him. This method used
   * to cast `candidate.content` to `{ subject, predicate, object }` regardless, so for
   * five of the six domains it bound `undefined` to three NOT NULL columns: the insert
   * threw, the loop caught it into `details`, and the claim was silently not held. One
   * table also means one review surface and no upsert collision with the speaker's own
   * rows — `setPreference` matches on `(identity_id, key)` and would have overwritten a
   * guest's own stated preference with an unconfirmed claim about someone else.
   */
  private persistQuarantine(
    candidate: LearningCandidate,
    cycleRecord: CycleRecord,
    decision: ScopedLearningDecision,
    ownerName: string | undefined,
  ): string {
    const claim = quarantinedClaim(candidate, ownerName);

    const mem = this.memoryRepo.createSemantic({
      identityId: decision.identityId,
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      sourceCycle: cycleRecord.id,
      subjectKind: decision.subjectKind,
      sensitivity: decision.sensitivity,
      confidence: candidate.confidence,
      sourceKind: decision.sourceKind,
      lifecycleStatus: decision.lifecycleStatus,
      provenance: {
        sourceCycleId: cycleRecord.id,
        sourceConversationId: cycleRecord.conversationId,
        sourceMessageIds: [],
        extractedAt: Date.now(),
        extractor: candidate.extractor ?? 'rule',
        confidence: candidate.confidence,
        validatedBy: decision.validatedBy,
      },
    });

    return mem.id;
  }

  /**
   * Announce that a memory landed, fire-and-forget, failure reported.
   *
   * See `TaskExecutor.publish`. The row is already committed when this runs — a
   * lost announcement costs a projection an update, and an unhandled rejection
   * would have cost the process its life.
   */
  private publish(type: DomainEventType, payload: Record<string, unknown>): void {
    const bus = this.eventBus;
    if (!bus) return;
    void bus
      .publish({
        type,
        payload,
        identityId: undefined,
        cycleId: undefined,
        timestamp: Date.now(),
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      })
      .catch((error: unknown) => {
        this.report(`publishing ${type}`, error);
      });
  }
}

/**
 * One unverified claim, as the triple that will hold it.
 *
 * The point is that nothing is lost while it waits: whatever domain the speaker's
 * sentence was extracted into, the words survive in `object`, what was asserted survives
 * in `predicate`, and `subject` names who it was asserted about. The owner reviewing his
 * quarantine reads sentences, not a domain tag.
 *
 * `subject` falls back to the role word when there is no enrolled owner name, because
 * that is then the only reason the policy could have fired — `isAboutOwner` matches
 * either the name or the word.
 */
function quarantinedClaim(
  candidate: LearningCandidate,
  ownerName: string | undefined,
): { subject: string; predicate: string; object: string } {
  const content =
    typeof candidate.content === 'object' && candidate.content !== null
      ? (candidate.content as Record<string, unknown>)
      : {};
  const text = (key: string): string => {
    const value = content[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  const about = ownerName?.trim() || 'owner';

  const claim = ((): { subject: string; predicate: string; object: string } => {
    switch (candidate.domain) {
      case 'semantic':
        return {
          subject: text('subject') || about,
          predicate: text('predicate') || 'is',
          object: text('object'),
        };
      case 'preference':
        return {
          subject: about,
          predicate: `prefers:${text('key') || 'unspecified'}`,
          object: text('value'),
        };
      case 'habit':
        return {
          subject: about,
          predicate: text('frequency') ? `habit:${text('frequency')}` : 'habit',
          object: text('pattern'),
        };
      case 'learned_pattern':
        return { subject: about, predicate: 'pattern', object: text('pattern') };
      case 'relationship':
        return {
          subject: about,
          predicate: `relation:${text('relation') || 'unspecified'}`,
          object: [text('name'), text('notes')].filter(Boolean).join(' — '),
        };
      case 'episodic':
        return {
          subject: about,
          predicate: 'episode',
          object: [text('summary'), text('details')].filter(Boolean).join(' — '),
        };
      default: {
        const _exhaustive: never = candidate.domain;
        throw new Error(`Unhandled memory domain: ${String(_exhaustive)}`);
      }
    }
  })();

  // A row whose `object` is empty holds no claim, and writing one would let the caller
  // count it as learned. Empty string satisfies NOT NULL, so the schema will not catch
  // this; the loop records the failure in `details` instead.
  if (claim.object === '') {
    throw new Error(`Quarantined ${candidate.domain} claim carried no text to hold`);
  }

  return claim;
}