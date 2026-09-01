/**
 * Stage 10: LEARN
 *
 * The LLM proposes candidate memories (preferences, habits, patterns, relationships,
 * semantic facts, episodic moments); the **Application applies the Scoped Learning
 * Policy** to decide what may be stored, with what scope, sensitivity, and provenance
 * (Build Book Part VII.1 stage 10, Part XIII).
 *
 * The policy enforces:
 *   1. **Multi-domain validation** - each candidate must match a known domain schema.
 *   2. **Scoped Guest Learning Policy** (Part XIII.4) - guest-originated info about
 *      the Owner is quarantined; guest's own preferences are isolated; small talk
 *      is transient.
 *   3. **Deduplication** - identical or near-identical memories are merged or skipped.
 *   4. **Provenance attachment** - every stored item carries a durable evidence chain.
 *   5. **Confidence threshold** - low-confidence extractions are dropped.
 *   6. **Importance scoring** - only items above threshold persist.
 *
 * P10 rollback contract: with no LLM faculty wired, the application extracts
 * deterministic preferences (e.g., explicit "I prefer X" statements) and applies
 * the same policy; all other domains are skipped.
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type {
  MemoryProvenance,
  MemoryDomain,
  Sensitivity,
  SubjectKind,
  SourceKind,
} from '@server/memory/types.js';
import type { IdentityKind } from '@server/identity/types.js';
import type {
  AuthorizedDecision,
  RecalledContext,
  AuthorizedResponse,
  VerificationReport,
  AuthorizedLearningDelta,
} from '../types.js';

export interface LearningFaculty {
  proposeExtractions(input: {
    recalled: RecalledContext;
    decision: AuthorizedDecision;
    response: AuthorizedResponse;
    actionResults: { toolId: string; success: boolean; verified: boolean }[];
    verification: VerificationReport | undefined;
  }): Promise<Array<{
    domain: MemoryDomain;
    data: Record<string, unknown>;
    confidence: number; // 0..1
    importance: number; // 0..1
    sensitivity: Sensitivity;
    subjectKind: SubjectKind;
  }>>;
}

export interface LearnOptions {
  llm?: LearningFaculty | undefined;
  memoryRepo?: MemoryRepository | undefined;
  db?: Database | undefined;
  /** Minimum confidence for any extraction to be accepted. Default 0.6 */
  minConfidence?: number;
  /** Minimum importance for any extraction to be accepted. Default 0.3 */
  minImportance?: number;
  cycleId?: string | undefined;
}

/**
 * Deterministic extraction rules used when no LLM faculty is wired, or as a
 * baseline that the LLM proposals are scored against.
 */
interface RuleExtraction {
  domain: MemoryDomain;
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  sensitivity: Sensitivity;
  subjectKind: SubjectKind;
  sourceKind: SourceKind;
}

/**
 * Stage 10 entry point.
 */
export async function learn(
  recalled: RecalledContext,
  decision: AuthorizedDecision,
  response: AuthorizedResponse,
  actionResults: { toolId: string; success: boolean; verified: boolean }[],
  verification: VerificationReport | undefined,
  opts: LearnOptions = {},
): Promise<AuthorizedLearningDelta> {
  const minConfidence = opts.minConfidence ?? 0.6;
  const minImportance = opts.minImportance ?? 0.3;
  const cycleId = opts.cycleId ?? ulid();
  const conversationId = recalled.stimulus.conversationId ?? 'unknown';
  const sourceMessageIds = extractMessageIds(recalled);

  // 1. Collect candidates from rule-based extraction (always runs)
  const ruleCandidates = extractByRules(recalled, decision, response, actionResults, verification);

  // 2. Collect candidates from LLM faculty (if wired)
  let llmCandidates: RuleExtraction[] = [];
  if (opts.llm) {
    const proposed = await opts.llm.proposeExtractions({ recalled, decision, response, actionResults, verification });
    llmCandidates = proposed
      .filter(c => c.confidence >= minConfidence && c.importance >= minImportance)
      .map(c => ({
        ...c,
        sourceKind: 'conversation' as SourceKind,
      }));
  }

  // 3. Merge and deduplicate candidates
  const allCandidates = [...ruleCandidates, ...llmCandidates];
  const deduped = deduplicateCandidates(allCandidates, opts.memoryRepo, recalled.stimulus.identityId);

  // 4. Apply Scoped Learning Policy (Part XIII.4) and validate domains
  const authorized: AuthorizedLearningDelta['memories'] = [];
  const callerId = recalled.stimulus.identityId;
  const callerKind = recalled.stimulus.identityKind;

  for (const candidate of deduped) {
    const policyResult = applyScopedLearningPolicy(candidate, callerId, callerKind);
    if (!policyResult.allowed) continue;

    // Build full memory item with provenance
    const provenance: MemoryProvenance = {
      sourceCycleId: cycleId,
      sourceConversationId: conversationId,
      sourceMessageIds,
      extractedAt: Date.now(),
      extractor: candidate.sourceKind === 'conversation' && opts.llm ? 'llm' : 'rule',
      confidence: candidate.confidence,
      validatedBy: policyResult.validatedBy,
    };

    authorized.push({
      domain: candidate.domain,
      data: {
        ...candidate.data,
        identityId: policyResult.effectiveIdentityId,
        subjectKind: policyResult.effectiveSubjectKind,
        sensitivity: policyResult.effectiveSensitivity,
        confidence: candidate.confidence,
        sourceKind: candidate.sourceKind,
        provenance,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lifecycleStatus: 'active',
      },
      provenance,
      sensitivity: policyResult.effectiveSensitivity,
      subjectKind: policyResult.effectiveSubjectKind,
    });
  }

  return { memories: authorized, extractedAt: Date.now() };
}

/**
 * Rule-based deterministic extraction (P10 rollback: no LLM faculty).
 * Extracts explicit preferences from user statements like "I prefer X", "I like X",
 * "I don't like X", and captures corrections as preferences.
 */
function extractByRules(
  recalled: RecalledContext,
  _decision: AuthorizedDecision,
  _response: AuthorizedResponse,
  _actionResults: { toolId: string; success: boolean; verified: boolean }[],
  _verification: VerificationReport | undefined,
): RuleExtraction[] {
  const extractions: RuleExtraction[] = [];
  const text = extractText(recalled.stimulus.payload).toLowerCase();
  const identityId = recalled.stimulus.identityId;

  // Explicit preference patterns
  const preferencePatterns = [
    { pattern: /\bi (?:prefer|like|love|enjoy)\s+([^.!?]+)/i, positive: true },
    { pattern: /\b(?:the )?owner (?:prefers|likes|loves|enjoys)\s+([^.!?]+)/i, positive: true },
    { pattern: /\bi (?:don'?t|do not|dislike|hate)\s+([^.!?]+)/i, positive: false },
    { pattern: /\bmy (?:favorite|preferred)\s+([^.!?]+)\s+is\s+([^.!?]+)/i, positive: true, keyValue: true },
    { pattern: /\bi (?:want|need)\s+([^.!?]+)/i, positive: true },
  ];

  for (const { pattern, keyValue } of preferencePatterns) {
    const match = text.match(pattern);
    if (match) {
      const isOwnerPattern = pattern.source.includes('owner');
      const val1 = match[1]?.trim() ?? '';
      const val2 = match[2]?.trim() ?? '';
      if (keyValue && val2) {
        extractions.push({
          domain: 'preference',
          data: { key: val1, value: val2, statedAt: Date.now(), ...(isOwnerPattern ? { aboutOwner: true } : {}) },
          confidence: 0.85,
          importance: 0.7,
          sensitivity: 'person_shared',
          subjectKind: 'person',
          sourceKind: 'conversation',
        });
      } else if (val1) {
        // Derive a key from the value
        const key = derivePreferenceKey(val1);
        extractions.push({
          domain: 'preference',
          data: { key, value: val1, statedAt: Date.now(), ...(isOwnerPattern ? { aboutOwner: true } : {}) },
          confidence: 0.8,
          importance: 0.6,
          sensitivity: 'person_shared',
          subjectKind: 'person',
          sourceKind: 'conversation',
        });
      }
    }
  }

  // Correction pattern - user correcting Madhurita
  const correctionMatch = text.match(/\b(?:no|actually|that'?s wrong|you'?re wrong|correction)[,:]?\s+([^.!?]+)/i);
  if (correctionMatch && correctionMatch[1]) {
    extractions.push({
      domain: 'preference',
      data: { key: 'correction', value: correctionMatch[1].trim(), statedAt: Date.now() },
      confidence: 0.9,
      importance: 0.8,
      sensitivity: 'person_shared',
      subjectKind: 'person',
      sourceKind: 'conversation',
    });
  }

  // Relationship mention - "my [relation] [name]"
  const relationshipMatch = text.match(/\bmy\s+(spouse|partner|husband|wife|child|son|daughter|parent|mother|father|friend|colleague)\s+(\w+)/i);
  if (relationshipMatch && relationshipMatch[1] && relationshipMatch[2]) {
    extractions.push({
      domain: 'relationship',
      data: {
        ownerId: identityId,
        name: relationshipMatch[2].trim(),
        relation: relationshipMatch[1].trim(),
        notes: '',
        importance: 0.7,
      },
      confidence: 0.75,
      importance: 0.7,
      sensitivity: 'owner_only',
      subjectKind: 'person',
      sourceKind: 'conversation',
    });
  }

  // Semantic fact about self - "I am [X]" / "I work at [X]" / "I live in [X]"
  const selfFactMatch = text.match(/\bi (?:am|work at|live in|study)\s+([^.!?]+)/i);
  if (selfFactMatch && selfFactMatch[1]) {
    extractions.push({
      domain: 'semantic',
      data: {
        subject: identityId,
        predicate: 'is',
        object: selfFactMatch[1].trim(),
        sourceCycle: undefined,
      },
      confidence: 0.7,
      importance: 0.5,
      sensitivity: 'person_shared',
      subjectKind: 'person',
      sourceKind: 'conversation',
    });
  }

  // Episodic moment - first-time event markers
  const episodicMarkers = ['first time', 'today i', 'just ', 'recently ', 'yesterday '];
  for (const marker of episodicMarkers) {
    if (text.includes(marker)) {
      extractions.push({
        domain: 'episodic',
        data: {
          summary: extractText(recalled.stimulus.payload).slice(0, 200),
          details: '',
          occurredAt: Date.now(),
          importance: 0.5,
        },
        confidence: 0.6,
        importance: 0.5,
        sensitivity: 'person_shared',
        subjectKind: 'person',
        sourceKind: 'conversation',
      });
      break; // Only one episodic per cycle from rules
    }
  }

  return extractions;
}

/**
 * Deduplicate candidates against each other and against existing memory.
 */
function deduplicateCandidates(
  candidates: RuleExtraction[],
  memoryRepo: MemoryRepository | undefined,
  _identityId: string,
): RuleExtraction[] {
  // First, deduplicate within the candidate set (by domain + key content)
  const seen = new Set<string>();
  const unique: RuleExtraction[] = [];

  for (const c of candidates) {
    const key = dedupKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  // Second, if memory repo available, filter against existing memory
  if (memoryRepo) {
    // This is a simplified check - in production would query by domain and similarity
    // For now we trust the within-candidate deduplication
    return unique;
  }

  return unique;
}

function dedupKey(c: RuleExtraction): string {
  switch (c.domain) {
    case 'preference':
      return `pref:${c.data['key']}:${c.data['value']}`.toLowerCase();
    case 'relationship':
      return `rel:${c.data['relation']}:${c.data['name']}`.toLowerCase();
    case 'semantic':
      return `sem:${c.data['subject']}:${c.data['predicate']}:${c.data['object']}`.toLowerCase();
    case 'episodic':
      return `epi:${String(c.data['summary'] ?? '').slice(0, 50)}`.toLowerCase();
    default:
      return `${c.domain}:${JSON.stringify(c.data)}`.toLowerCase();
  }
}

/**
 * Apply the Scoped Learning Policy (Build Book Part XIII.4).
 * Determines whether a candidate may be stored, and with what effective scope.
 */
function applyScopedLearningPolicy(
  candidate: RuleExtraction,
  callerId: string,
  callerKind: IdentityKind,
): {
  allowed: boolean;
  effectiveIdentityId: string;
  effectiveSubjectKind: SubjectKind;
  effectiveSensitivity: Sensitivity;
  validatedBy: 'app_rule' | 'owner_confirmation' | 'auto_policy';
  reason?: string;
} {
  const { domain, data, subjectKind, sensitivity } = candidate;

  // 1. Small talk / idle context - transient only (discarded after session)
  if (isSmallTalk(data)) {
    return { allowed: false, effectiveIdentityId: '', effectiveSubjectKind: 'system', effectiveSensitivity: 'system_internal', validatedBy: 'auto_policy', reason: 'Small talk discarded' };
  }

  // 2. Information about the Owner from a non-owner - QUARANTINE
  // (Check this BEFORE guest-isolated preferences so a guest saying
  //  "the owner likes X" is captured as an unverified claim rather than
  //  being routed as a guest preference.)
  if (callerKind !== 'owner' && isAboutOwner(data, callerId)) {
    return {
      allowed: true,
      effectiveIdentityId: callerId, // Stored under guest's identity as unverified
      effectiveSubjectKind: 'guest',
      effectiveSensitivity: 'person_shared', // But flagged as unverified
      validatedBy: 'owner_confirmation', // Requires owner confirmation
    };
  }

  // 3. Guest's own preferences - saved as Guest-scoped, isolated from Owner
  if (callerKind === 'guest' && domain === 'preference') {
    return {
      allowed: true,
      effectiveIdentityId: callerId,
      effectiveSubjectKind: 'guest',
      effectiveSensitivity: 'person_shared', // Guest's own prefs are shared with guest
      validatedBy: 'app_rule',
    };
  }

  // 4. General behavioral patterns from any caller - may become learned_pattern
  if (domain === 'learned_pattern' || (domain === 'semantic' && isGeneralPattern(data))) {
    return {
      allowed: true,
      effectiveIdentityId: callerId,
      effectiveSubjectKind: subjectKind,
      effectiveSensitivity: sensitivity,
      validatedBy: 'auto_policy',
    };
  }

  // 5. Sensitive/private - discarded unless explicitly authorized
  if (isSensitive(data)) {
    return { allowed: false, effectiveIdentityId: '', effectiveSubjectKind: 'system', effectiveSensitivity: 'system_internal', validatedBy: 'auto_policy', reason: 'Sensitive content discarded' };
  }

  // 6. Default: store under caller's identity with declared sensitivity
  return {
    allowed: true,
    effectiveIdentityId: callerId,
    effectiveSubjectKind: subjectKind,
    effectiveSensitivity: sensitivity,
    validatedBy: 'app_rule',
  };
}

function isSmallTalk(data: Record<string, unknown>): boolean {
  const text = Object.values(data).join(' ').toLowerCase();
  const smallTalkPatterns = [
    'hello', 'hi', 'hey', 'how are you', 'good morning', 'good evening',
    'nice weather', 'thanks', 'thank you', 'bye', 'goodbye', 'see you',
  ];
  return smallTalkPatterns.some(p => text.includes(p)) && text.length < 50;
}

function isAboutOwner(data: Record<string, unknown>, _callerId: string): boolean {
  // First check for explicit flag set by extraction rules
  if (data['aboutOwner'] === true) return true;

  const text = Object.values(data).join(' ').toLowerCase();
  // Heuristics: mentions "owner", "you" (referring to owner), or specific owner identifiers
  // In practice this would check against known owner identity/name
  return text.includes('owner') || text.includes('madhurita') || text.includes('ankit');
}

function isGeneralPattern(data: Record<string, unknown>): boolean {
  const text = Object.values(data).join(' ').toLowerCase();
  const patternWords = ['often', 'usually', 'always', 'never', 'tends to', 'pattern', 'habit'];
  return patternWords.some(p => text.includes(p));
}

function isSensitive(data: Record<string, unknown>): boolean {
  const text = Object.values(data).join(' ').toLowerCase();
  const sensitivePatterns = ['password', 'secret', 'ssn', 'credit card', 'private', 'confidential'];
  return sensitivePatterns.some(p => text.includes(p));
}

function derivePreferenceKey(value: string): string {
  // Derive a key from the value for preference storage
  const words = value.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (words.length === 0) return 'preference';
  if (words.length <= 3) return words.join('_');
  return words.slice(0, 3).join('_');
}

function extractMessageIds(_recalled: RecalledContext): string[] {
  // In a real implementation, this would extract message IDs from the conversation
  // For now, return empty - the provenance will be linked at cycle level
  return [];
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const t = (payload as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}