/**
 * P16 — Learning Pipeline Types
 *
 * Learning is the deliberate extraction of memory from cycles.
 * The LLM may propose extractions, but the application validates, scores,
 * dedupes, limits, and records provenance.
 */

import type { MemoryDomain, MemoryProvenance, Sensitivity, SubjectKind, SourceKind } from '@server/memory/types.js';
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
}

/** Result of applying the Scoped Guest Learning Policy */
export interface ScopedLearningDecision {
  /** Whether to proceed with this candidate */
  action: 'persist' | 'update' | 'quarantine' | 'discard';
  /** If quarantine: requires owner confirmation before becoming active */
  quarantineReason?: string;
  /** If discard: why it was rejected */
  discardReason?: string;
  /** Sensitivity level to assign if persisted */
  sensitivity?: Sensitivity;
  /** Subject kind to assign if persisted */
  subjectKind?: SubjectKind;
  /** Source kind to assign if persisted */
  sourceKind?: SourceKind;
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
}

/** Default options */
export const DEFAULT_LEARNING_OPTIONS: Required<LearningPipelineOptions> = {
  confidenceThreshold: 0.7,
  importanceThreshold: 0.5,
  maxExtractionsPerCycle: 5,
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

/** Scoped Guest Learning Policy types */
export interface GuestLearningPolicy {
  /** Evaluate a candidate against the guest learning policy */
  evaluate(candidate: LearningCandidate, callerId: string, callerKind: IdentityKind): ScopedLearningDecision;
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
  status: 'completed' | 'interrupted' | 'failed';
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