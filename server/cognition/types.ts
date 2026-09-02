/** P07 cognitive scaffold types — 12 stage contracts. */

import type { IdentityKind, PermissionSet } from '@server/identity/types.js';
import type { ScopedMemoryItem } from '@server/memory/types.js';

// ── Common ──
export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export interface StageTrace {
  stage: StageNumber;
  stageName: string;
  startedAt: number;
  completedAt?: number | undefined;
  inputJson: string;
  outputJson?: string | undefined;
  error?: string | undefined;
}

export type CycleStatus = 'running' | 'completed' | 'interrupted' | 'failed';

export interface CycleRecord {
  id: string;
  identityId: string;
  conversationId: string;
  status: CycleStatus;
  startedAt: number;
  completedAt?: number | undefined;
  stages: StageTrace[];
  proposedDecision?: unknown; // DecisionProposal from stage 6
  authorizedDecision?: unknown; // AuthorizedDecision after stage 6 validation
  response?: unknown; // AuthorizedResponse from stage 9
  actionResults?: unknown[]; // ActionResult[] from stage 7
  learningDelta?: unknown; // AuthorizedLearningDelta from stage 10
  error?: string | undefined;
}

// ── Stage 1: PERCEIVE ──
export interface RawStimulus {
  source: 'text' | 'audio' | 'system' | 'proactive';
  payload: unknown;
  receivedAt: number;
  identityId: string;
  conversationId?: string | undefined;
  sessionId?: string | undefined;
}

// ── Stage 2: IDENTIFY ──
export interface IdentifiedStimulus extends RawStimulus {
  identityKind: IdentityKind;
  callerPermissions: PermissionSet;
  inputType: 'user_message' | 'system_event' | 'proactive_trigger' | 'interrupt';
  attachedContext?: string | undefined;
}

// ── Stage 3: RECALL ──
export interface RecalledContext {
  stimulus: IdentifiedStimulus;
  episodic: ScopedMemoryItem[];
  semantic: ScopedMemoryItem[];
  preferences: ScopedMemoryItem[];
  habits: ScopedMemoryItem[];
  relationships: ScopedMemoryItem[];
  learnedPatterns: ScopedMemoryItem[];
  retrievedAt: number;
}

// ── Stage 4: UNDERSTAND ──
export interface UnderstandingProposal {
  intent: string;
  confidence: number;
  disambiguationNeeded: boolean;
  clarifyingQuestions: string[];
  entities: Record<string, unknown>;
}

// ── Stage 5: REASON ──
export interface ReasoningTraceProposal {
  steps: Array<{
    description: string;
    conclusion: string;
    confidence: number;
  }>;
  optionsConsidered: string[];
  recommendedApproach: string;
}

// ── Stage 6: DECIDE ──
export interface DecisionProposal {
  action: 'respond' | 'execute_tool' | 'schedule_task' | 'learn' | 'noop' | 'clarify';
  toolId?: string | undefined;
  toolInput?: unknown | undefined;
  taskSpec?: unknown | undefined;
  learningItems?: unknown[] | undefined;
  rationale: string;
}

export interface AuthorizedDecision {
  proposal: DecisionProposal;
  authorized: boolean;
  reason?: string | undefined;
  clearanceChecked: boolean;
}

// ── Stage 7: ACT ──
export interface ActionResult {
  toolId: string;
  success: boolean;
  output?: unknown | undefined;
  error?: string | undefined;
  verified: boolean;
}

// ── Stage 8: VERIFY ──
export interface VerificationReport {
  preconditionsMet: boolean;
  postconditionsMet: boolean;
  discrepancies: string[];
  /**
   * The action results after verification. `verified` is set here and nowhere
   * else: only a re-read of authoritative state may mark an action proven
   * (Build Book Part XI.3).
   */
  results: ActionResult[];
  recheckedAt: number;
}

// ── Stage 9: RESPOND ──
export interface AuthorizedResponse {
  text: string;
  voiceEnabled: boolean;
  disclosuresApplied: string[];
  redacted: boolean;
}

// ── Stage 10: LEARN ──
export interface AuthorizedLearningDelta {
  memories: Array<{
    domain: string;
    data: Record<string, unknown>;
    provenance: {
      sourceCycleId: string;
      sourceConversationId: string;
      sourceMessageIds: string[];
      extractedAt: number;
      extractor: 'rule' | 'llm' | 'legacy_import';
      confidence: number;
      validatedBy: 'app_rule' | 'owner_confirmation' | 'auto_policy';
    };
    sensitivity: 'public' | 'person_shared' | 'owner_only' | 'system_internal';
    subjectKind: IdentityKind | 'system';
  }>;
  extractedAt: number;
}

// ── Stage 11: UPDATE ──
export interface UpdateResult {
  applied: number;
  skipped: number;
  errors: string[];
}

// ── Stage 12: PERSIST ──
export interface PersistResult {
  cycleRecordId: string;
  committedAt: number;
  eventsEmitted: number;
}

// ── Stage handler signature ──
export type StageHandler<I, O> = (input: I) => Promise<O>;

// ── Audit (Part X.4.3 / VII.1 stage 12) ──

/**
 * One auditable decision made during a cycle. Disclosure decisions are recorded
 * in stage 9; stage 12 (PERSIST) commits the collected entries to `audit_log`
 * together with the rest of the cycle artifacts in a single transaction.
 */
export interface AuditEntry {
  actorId: string;
  action: string;
  resource: string;
  decision: 'allowed' | 'redacted' | 'generalized' | 'blocked';
  reason?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  at: number;
}

export interface AuditCollector {
  record(entry: AuditEntry): void;
}

// ── Stage names ──
export const STAGE_NAMES: Record<StageNumber, string> = {
  1: 'PERCEIVE',
  2: 'IDENTIFY',
  3: 'RECALL',
  4: 'UNDERSTAND',
  5: 'REASON',
  6: 'DECIDE',
  7: 'ACT',
  8: 'VERIFY',
  9: 'RESPOND',
  10: 'LEARN',
  11: 'UPDATE',
  12: 'PERSIST',
};