/**
 * P16 — Learning Pipeline Types
 *
 * Learning is the deliberate extraction of memory from cycles.
 * The LLM may propose extractions, but the application validates, scores,
 * dedupes, limits, and records provenance.
 */

import type {
  LifecycleStatus,
  MemoryDomain,
  MemoryProvenance,
  Sensitivity,
  SubjectKind,
  SourceKind,
} from '@server/memory/types.js';
import type { IdentityKind } from '@server/identity/types.js';

/** A candidate memory proposed by the LLM for extraction */
export interface LearningCandidate {
  /** Memory domain this candidate belongs to */
  domain: MemoryDomain;
  /** The caller whose cycle triggered this extraction */
  callerId: string;
  /** Caller's identity kind (owner/person/guest) */
  callerKind: IdentityKind;
  /** Proposed memory content (domain-specific) */
  content: unknown;
  /** Confidence score 0..1 from LLM */
  confidence: number;
  /** Importance score 0..1 from LLM */
  importance: number;
  /** Reasoning from LLM about why this should be learned */
  reasoning: string;
  /**
   * Which kind of extractor produced this, recorded in the memory's provenance.
   *
   * Optional because a candidate can be built by hand (a test, a seeder) and
   * there is no honest answer for one that does not say. `persistNew` treats an
   * absent value as `rule`: provenance naming a model where no model ran would
   * have a later reader attribute a regular expression's output to her
   * judgement, which is the more damaging of the two mistakes.
   */
  extractor?: 'rule' | 'llm';
}

/**
 * Result of applying the Scoped Learning Policy (Build Book XIII.4).
 *
 * Every field is required, and that is the point: the writers used to fill the gaps
 * themselves — `persistQuarantine` hardcoded all four of subject kind, sensitivity,
 * source kind and lifecycle status, and took `_decision` unused — so the table lived
 * half in the policy and half in the SQL. A decision a writer cannot complete is a
 * decision a writer cannot quietly overrule.
 *
 * `'update'` is gone from the action union. Nothing ever returned it, and nothing read
 * it: the choice between inserting and updating comes from `DedupeResult`, one step
 * later and on evidence the policy does not have.
 */
export interface ScopedLearningDecision {
  /** Whether to keep this candidate, hold it for confirmation, or drop it. */
  action: 'persist' | 'quarantine' | 'discard';
  /** Why — recorded on a quarantine, logged on a discard. */
  reason: string;
  /**
   * Whose memory this joins.
   *
   * The caller who said it, always. A candidate proposing its own `identityId` is a
   * candidate proposing which person it belongs to, which is the isolation the policy
   * exists to enforce.
   */
  identityId: string;
  /** Who the memory is *about* — a separate question from whose record holds it. */
  subjectKind: SubjectKind;
  /** Who may read it back. */
  sensitivity: Sensitivity;
  /** Whether a person stated it or the system inferred it. */
  sourceKind: SourceKind;
  /** `archived` on a quarantine: held out of ordinary recall until the owner confirms. */
  lifecycleStatus: LifecycleStatus;
  /** The provenance claim that goes with it. Never `app_rule` on a quarantined row. */
  validatedBy: 'app_rule' | 'owner_confirmation' | 'auto_policy';
}

/** Result of the dedupe stage */
export interface DedupeResult {
  /** Whether this is a new memory or update to existing */
  action: 'insert' | 'update';
  /** Existing memory ID if update */
  existingId?: string;
  /** Why this was deduped (or not) */
  reason: string;
}

/** Full learning pipeline result */
export interface LearningResult {
  /** Whether any learning occurred */
  learned: boolean;
  /** Number of memories created/updated */
  count: number;
  /**
   * Set when the pipeline declined to run at all, with the reason.
   *
   * Distinct from `learned: false` with an empty `details`, which means it ran
   * and found nothing worth keeping. The two look identical from the outside
   * otherwise, and "she learned nothing" and "she was not asked to learn" are
   * different facts about a cycle.
   */
  skipped?: string;
  /** Details per candidate */
  details: Array<{
    candidate: LearningCandidate;
    decision: ScopedLearningDecision;
    dedupe: DedupeResult;
    memoryId?: string;
    error?: string;
  }>;
}

/** Options for the learning pipeline */
export interface LearningPipelineOptions {
  /** Minimum confidence threshold for learning (default 0.7) */
  confidenceThreshold?: number;
  /** Minimum importance threshold for learning (default 0.5) */
  importanceThreshold?: number;
  /** Maximum memories to extract per cycle (default 5) */
  maxExtractionsPerCycle?: number;
  /**
   * Whether to process a cycle that already wrote memories of its own.
   *
   * False by default, and the default matters. Cognitive stage 10 proposes
   * extractions and stage 11 writes them *inside* the cycle, so a cycle that ran
   * the full twelve stages has already learned. This pipeline is the out-of-band
   * path — for cycles that ran without it, or for a later consolidation pass —
   * and running both over the same cycle writes the same fact twice.
   *
   * The dedupe engine does not save us: it matches `preference`, `habit`,
   * `relationship` and `learned_pattern`, and has no branch for `episodic` or
   * `semantic`. Those two would insert a duplicate row every time, and a memory
   * she holds twice is a memory she is more confident about for no reason.
   */
  relearnCycles?: boolean;
}

/** Default options */
export const DEFAULT_LEARNING_OPTIONS: Required<LearningPipelineOptions> = {
  confidenceThreshold: 0.7,
  importanceThreshold: 0.5,
  maxExtractionsPerCycle: 5,
  relearnCycles: false,
};

/** Provenance for a learning extraction */
export interface LearningProvenance extends MemoryProvenance {
  /** The learning pipeline version */
  pipelineVersion: number;
  /** Which LLM model proposed the extraction */
  model?: string;
  /** Number of tokens used for extraction */
  tokensUsed?: number;
}

/** Scoped Learning Policy seam — see `policy.ts` for the one implementation. */
export interface GuestLearningPolicy {
  /**
   * Evaluate a candidate against the Scoped Learning Policy.
   *
   * `ownerName` is what makes the quarantine row work off this seam as well as in
   * cognition: "Ankit ko chai pasand hai" names him without using the word "owner", and
   * a policy that is not told his enrolled name cannot see that it is a claim about him.
   */
  evaluate(
    candidate: LearningCandidate,
    callerId: string,
    callerKind: IdentityKind,
    ownerName?: string,
  ): ScopedLearningDecision;
}

/** Learning extractor interface - can be LLM-based or rule-based */
export interface LearningExtractor {
  /** Extract learning candidates from a completed cycle */
  extract(cycleRecord: CycleRecord, messages: Message[]): Promise<LearningCandidate[]>;
}

/** Minimal cycle record for learning */
export interface CycleRecord {
  id: string;
  identityId: string;
  conversationId: string;
  startedAt: number;
  completedAt: number;
  /**
   * Includes `'degraded'`, which is a status the runtime actually writes.
   *
   * `server/cognition/runtime.ts` derives the status from the stage traces and
   * settles on `'degraded'` when a stage threw and was replaced by its fallback;
   * migration `0010_cycle_status_guard.sql` permits it by trigger. This union
   * omitted it, so the out-of-band learner had no type for a cycle that finished
   * with a bruise — and a degraded cycle is exactly the kind the in-cycle learn
   * stage may have missed, which makes it the *most* interesting one to
   * consolidate later.
   *
   * Widening is safe for every existing consumer: the field is only ever read as
   * a string, into a prompt or a report line.
   */
  status: 'completed' | 'degraded' | 'interrupted' | 'failed';
  inputJson?: string;
  outputJson?: string;
  proposedDecision?: unknown;
  authorizedDecision?: unknown;
}

/** Minimal message for learning */
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: number;
}