/**
 * P05 Memory Domains - Types
 *
 * Multi-domain memory types per Build Book Part X.
 * Every memory row carries the common MemoryItemHeader.
 */

import type { IdentityKind } from '@server/identity/types.js';

/** Memory domains - each has distinct shape, lifecycle, retrieval semantics */
export type MemoryDomain =
  | 'episodic'
  | 'semantic'
  | 'preference'
  | 'habit'
  | 'relationship'
  | 'learned_pattern';

/** Subject of the memory - whose perspective/content this represents */
export type SubjectKind = IdentityKind | 'system';

/** Sensitivity classification - gates retrieval via Knowledge Retrieval Policy */
export type Sensitivity = 'public' | 'person_shared' | 'owner_only' | 'system_internal';

/** Source of the memory content */
export type SourceKind = 'conversation' | 'action' | 'observation' | 'system';

/** Lifecycle status of a memory item */
export type LifecycleStatus = 'active' | 'consolidated' | 'archived' | 'soft_deleted';

/** Provenance chain - mandatory per Build Book X.5 */
export interface MemoryProvenance {
  /** Cycle that produced this memory */
  sourceCycleId: string;
  /** Conversation this memory originated from */
  sourceConversationId: string;
  /** Specific messages that contributed */
  sourceMessageIds: string[];
  /** When extraction occurred (epoch ms) */
  extractedAt: number;
  /** Who proposed the extraction */
  extractor: 'rule' | 'llm' | 'legacy_import';
  /** Confidence of the extraction */
  confidence: number;
  /** How the extraction was validated */
  validatedBy: 'app_rule' | 'owner_confirmation' | 'auto_policy';
}

/** Common header carried by every memory row across all domains */
export interface MemoryItemHeader {
  id: string;                          // ULID
  identityId: string;                  // subject / owner of this memory
  subjectKind: SubjectKind;
  sensitivity: Sensitivity;
  confidence: number;                  // 0..1
  sourceKind: SourceKind;
  provenance: MemoryProvenance;
  createdAt: number;                   // epoch ms
  updatedAt: number;                   // epoch ms
  expiresAt?: number | undefined;                  // optional TTL
  lifecycleStatus: LifecycleStatus;
  deletedAt?: number | undefined;
  deletedBy?: string | undefined;
}

/** Domain-specific memory shapes (data portion beyond header) */
export interface EpisodicMemoryData {
  summary: string;
  details?: string | undefined;
  embedding?: string | undefined;
  occurredAt: number;
  importance: number;
}

export interface SemanticMemoryData {
  subject: string;
  predicate: string;
  object: string;
  sourceCycle?: string | undefined;
  embedding?: string | undefined;
}

export interface PreferenceData {
  key: string;
  value: string;
  statedAt: number;
}

export interface HabitData {
  pattern: string;
  frequency?: string | undefined;
  lastObserved: number;
}

export interface RelationshipData {
  ownerId: string;
  name: string;
  relation: string;
  notes?: string | undefined;
  importance: number;
}

export interface LearnedPatternData {
  pattern: string;
  evidenceCount: number;
}

/** Full memory items combining header + domain data */
export interface EpisodicMemory extends MemoryItemHeader, EpisodicMemoryData {
  // subjectKind, sensitivity, confidence, sourceKind, provenance, etc. from header
}

export interface SemanticMemory extends MemoryItemHeader, SemanticMemoryData {}

export interface Preference extends MemoryItemHeader, PreferenceData {}

export interface Habit extends MemoryItemHeader, HabitData {}

export interface Relationship extends MemoryItemHeader, RelationshipData {}

export interface LearnedPattern extends MemoryItemHeader, LearnedPatternData {}

/** Union type for all memory items */
export type MemoryItem =
  | EpisodicMemory
  | SemanticMemory
  | Preference
  | Habit
  | Relationship
  | LearnedPattern;

/** Retrieval request - caller provides context, application enforces policy */
export interface RetrievalRequest {
  callerId: string;
  callerKind: 'owner' | 'person' | 'guest';
  query: string;
  domains: MemoryDomain[];
  limit: number;
  recencyWeight: number;
  importanceWeight: number;
  similarityWeight: number;
  excludeSoftDeleted: boolean;
}

/** Scoped memory item returned to caller - includes only policy-allowed fields */
export interface ScopedMemoryItem {
  id: string;
  domain: MemoryDomain;
  identityId: string;
  subjectKind: SubjectKind;
  sensitivity: Sensitivity;
  confidence: number;
  summary?: string | undefined;        // episodic
  details?: string | undefined;        // episodic
  subject?: string | undefined;        // semantic
  predicate?: string | undefined;      // semantic
  object?: string | undefined;         // semantic
  key?: string | undefined;            // preference
  value?: string | undefined;          // preference
  pattern?: string | undefined;        // habit, learned_pattern
  frequency?: string | undefined;      // habit
  name?: string | undefined;           // relationship
  relation?: string | undefined;       // relationship
  notes?: string | undefined;          // relationship
  importance?: number | undefined;     // episodic, relationship
  evidenceCount?: number | undefined;  // learned_pattern
  occurredAt?: number | undefined;     // episodic
  statedAt?: number | undefined;       // preference
  lastObserved?: number | undefined;   // habit
  createdAt: number;
  updatedAt: number;
  similarityScore?: number | undefined; // computed during retrieval
}

/** Retrieval result - ranked, filtered by policy */
export interface RetrievalResult {
  items: ScopedMemoryItem[];
  total: number;
  took: number;
  fromCache: boolean;
}

/** Default weights for retrieval ranking */
export const DEFAULT_RETRIEVAL_WEIGHTS = {
  recency: 0.4,
  importance: 0.3,
  similarity: 0.3,
} as const;