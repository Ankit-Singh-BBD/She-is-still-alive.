/**
 * Her memory, as four tools she can actually reach.
 *
 * Everything under `server/memory/` has existed and been tested since P05, and
 * nothing outside a test ever wrote to it on her behalf: stage 11 (UPDATE) can
 * persist what stage 10 extracted, but there was no way for a decision to say
 * "remember this" and have it happen. These are that way.
 *
 * Three rules shape the input schemas, and each one exists to stop a specific
 * kind of dishonesty.
 *
 * **A tool never accepts an identity.** Every write goes to
 * `context.identityId` — the caller the application authenticated. If `input`
 * carried an `identityId`, a model that proposed somebody else's would be
 * proposing a write into another person's memory, and the schema would have
 * validated it.
 *
 * **A tool never accepts a sensitivity.** Sensitivity is what the Knowledge
 * Retrieval Policy gates disclosure on, so choosing it is a disclosure decision
 * and belongs to the application. It is derived from the caller's kind: an
 * owner's memories are `owner_only`, everyone else's are `person_shared`. A
 * model that could set this field could mark its own memory `public` and read it
 * back out through any caller.
 *
 * **Every output carries the ids needed to find the row again.** Cognitive stage
 * 8 verifies from `output` + `db` and never sees the input (see `./types.ts`), so
 * an output that omits its own row id is an output nothing can prove.
 */

import { z } from 'zod';
import type { Database } from '@server/persistence/db.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type { MemoryRetrieval } from '@server/memory/retrieval.js';
import { DEFAULT_RETRIEVAL_WEIGHTS } from '@server/memory/types.js';
import type {
  MemoryDomain,
  MemoryProvenance,
  Sensitivity,
  SubjectKind,
} from '@server/memory/types.js';
import { DEFAULT_RETRY_POLICY } from '@server/actions/registry.js';
import type { ToolExecutionContext } from '@server/actions/registry.js';
import { broken, held, parseOutput } from './types.js';
import type { VerifiedTool } from './types.js';

export interface MemoryToolDeps {
  memoryRepo: MemoryRepository;
  memoryRetrieval: MemoryRetrieval;
  /** Used only to resolve the conversation a cycle belongs to. */
  db: Database;
}

const DOMAINS = [
  'episodic',
  'semantic',
  'preference',
  'habit',
  'relationship',
  'learned_pattern',
] as const satisfies readonly MemoryDomain[];

// ── Shared derivations ───────────────────────────────────────────────────────

/**
 * Sensitivity for something the caller just told her.
 *
 * An owner's memories default to `owner_only` because she is a household
 * presence: a guest asking her a question must not be able to retrieve what the
 * owner said in private. Anyone else's are `person_shared`, which
 * `MemoryRetrieval` already scopes to that person plus the owner.
 */
function sensitivityFor(kind: SubjectKind): Sensitivity {
  return kind === 'owner' ? 'owner_only' : 'person_shared';
}

/**
 * The conversation this cycle belongs to, read from `cycle_record`.
 *
 * `ToolExecutionContext` carries a cycle id but no conversation id, and
 * `MemoryProvenance` requires one. Widening the context interface to pass it
 * would put a second copy of a fact the database already holds into every tool
 * call, so this reads the authoritative row instead.
 *
 * `'unknown'` when there is no such row — which happens when the pipeline is
 * driven by something other than a cognitive cycle, such as the task executor.
 * Provenance is a JSON blob and nothing joins on this field, so the honest
 * answer there is to say it is not known rather than to invent an id.
 */
function conversationOf(db: Database, cycleId: string): string {
  const row = db.raw
    .prepare(`SELECT conversation_id FROM cycle_record WHERE id = ?`)
    .get(cycleId) as { conversation_id: string } | undefined;
  return row?.conversation_id ?? 'unknown';
}

/**
 * Provenance for a memory written because a tool call asked for it.
 *
 * `extractor: 'llm'` because a model proposed the call, and `validatedBy:
 * 'app_rule'` because what made it happen was schema validation plus
 * authorization — not the owner confirming it and not a background policy.
 * Recording it as `'rule'` would credit the application with an extraction it
 * did not make.
 */
function provenanceFor(db: Database, context: ToolExecutionContext, confidence: number): MemoryProvenance {
  return {
    sourceCycleId: context.cycleId,
    sourceConversationId: conversationOf(db, context.cycleId),
    sourceMessageIds: [],
    extractedAt: Date.now(),
    extractor: 'llm',
    confidence,
    validatedBy: 'app_rule',
  };
}

// ── memory.remember_event ────────────────────────────────────────────────────

const rememberEventInput = z.object({
  summary: z.string().trim().min(1).max(2000),
  details: z.string().trim().max(20_000).optional(),
  importance: z.number().min(0).max(1).optional(),
  /**
   * When it happened, if not now. Bounded because ranking is recency-weighted:
   * an event dated in the future would outrank everything she knows, forever.
   */
  occurredAt: z
    .number()
    .int()
    .min(0)
    .refine((value) => value <= Date.now() + 60_000, {
      message: 'occurredAt cannot be in the future',
    })
    .optional(),
});

const rememberEventOutput = z.object({
  memoryId: z.string().min(1),
  identityId: z.string().min(1),
  domain: z.literal('episodic'),
  summary: z.string(),
});

export function rememberEventTool(
  deps: MemoryToolDeps,
): VerifiedTool<z.infer<typeof rememberEventInput>, z.infer<typeof rememberEventOutput>> {
  const id = 'memory.remember_event';
  return {
    definition: {
      id,
      name: 'Remember an event',
      description:
        'Records something that happened as an episodic memory for the current caller. Use for ' +
        'events, moments and things they did or told you about — not for standing facts.',
      inputSchema: rememberEventInput,
      outputSchema: rememberEventOutput,
      clearanceRequired: 'all',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const memory = deps.memoryRepo.createEpisodic({
          identityId: context.identityId,
          summary: input.summary,
          ...(input.details !== undefined ? { details: input.details } : {}),
          ...(input.occurredAt !== undefined ? { occurredAt: input.occurredAt } : {}),
          importance: input.importance ?? 0.5,
          subjectKind: context.caller.kind,
          sensitivity: sensitivityFor(context.caller.kind),
          sourceKind: 'conversation',
          provenance: provenanceFor(deps.db, context, 1),
        });
        return {
          memoryId: memory.id,
          identityId: memory.identityId,
          domain: 'episodic' as const,
          summary: memory.summary,
        };
      },
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, rememberEventOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { memoryId, identityId, summary } = parsed.value;

      const row = deps.memoryRepo.getEpisodic(memoryId);
      if (!row) return broken(`No episodic memory '${memoryId}' exists; nothing was remembered`);
      if (row.identityId !== identityId) {
        return broken(
          `Episodic memory '${memoryId}' belongs to '${row.identityId}', not to '${identityId}'`,
        );
      }
      if (row.summary !== summary) {
        return broken(`Episodic memory '${memoryId}' does not hold the summary that was written`);
      }
      if (row.lifecycleStatus === 'soft_deleted') {
        return broken(`Episodic memory '${memoryId}' was written but is already deleted`);
      }
      return held();
    },
  };
}

// ── memory.remember_fact ─────────────────────────────────────────────────────

const rememberFactInput = z.object({
  subject: z.string().trim().min(1).max(200),
  predicate: z.string().trim().min(1).max(200),
  object: z.string().trim().min(1).max(2000),
  confidence: z.number().min(0).max(1).optional(),
});

const rememberFactOutput = z.object({
  memoryId: z.string().min(1),
  identityId: z.string().min(1),
  domain: z.literal('semantic'),
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
});

export function rememberFactTool(
  deps: MemoryToolDeps,
): VerifiedTool<z.infer<typeof rememberFactInput>, z.infer<typeof rememberFactOutput>> {
  const id = 'memory.remember_fact';
  return {
    definition: {
      id,
      name: 'Remember a fact',
      description:
        'Records a standing fact about the current caller as a semantic memory, in ' +
        'subject-predicate-object form. Use for things that stay true, not for events.',
      inputSchema: rememberFactInput,
      outputSchema: rememberFactOutput,
      clearanceRequired: 'all',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const confidence = input.confidence ?? 1;
        const memory = deps.memoryRepo.createSemantic({
          identityId: context.identityId,
          subject: input.subject,
          predicate: input.predicate,
          object: input.object,
          sourceCycle: context.cycleId,
          subjectKind: context.caller.kind,
          sensitivity: sensitivityFor(context.caller.kind),
          confidence,
          sourceKind: 'conversation',
          provenance: provenanceFor(deps.db, context, confidence),
        });
        return {
          memoryId: memory.id,
          identityId: memory.identityId,
          domain: 'semantic' as const,
          subject: memory.subject,
          predicate: memory.predicate,
          object: memory.object,
        };
      },
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, rememberFactOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { memoryId, identityId, subject, predicate, object } = parsed.value;

      const row = deps.memoryRepo.getSemantic(memoryId);
      if (!row) return broken(`No semantic memory '${memoryId}' exists; nothing was remembered`);
      if (row.identityId !== identityId) {
        return broken(
          `Semantic memory '${memoryId}' belongs to '${row.identityId}', not to '${identityId}'`,
        );
      }
      if (row.subject !== subject || row.predicate !== predicate || row.object !== object) {
        return broken(
          `Semantic memory '${memoryId}' does not hold the fact that was written ` +
            `('${row.subject} ${row.predicate} ${row.object}')`,
        );
      }
      if (row.lifecycleStatus === 'soft_deleted') {
        return broken(`Semantic memory '${memoryId}' was written but is already deleted`);
      }
      return held();
    },
  };
}

// ── preference.set ───────────────────────────────────────────────────────────

const setPreferenceInput = z.object({
  key: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(2000),
});

const setPreferenceOutput = z.object({
  preferenceId: z.string().min(1),
  identityId: z.string().min(1),
  key: z.string(),
  value: z.string(),
});

export function setPreferenceTool(
  deps: MemoryToolDeps,
): VerifiedTool<z.infer<typeof setPreferenceInput>, z.infer<typeof setPreferenceOutput>> {
  const id = 'preference.set';
  return {
    definition: {
      id,
      name: 'Set a preference',
      description:
        'Records or updates one of the current caller’s stated preferences. Overwrites the ' +
        'existing value for that key rather than adding a second one.',
      inputSchema: setPreferenceInput,
      outputSchema: setPreferenceOutput,
      clearanceRequired: 'all',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const preference = deps.memoryRepo.setPreference({
          identityId: context.identityId,
          key: input.key,
          value: input.value,
          subjectKind: context.caller.kind,
          sensitivity: sensitivityFor(context.caller.kind),
          sourceKind: 'conversation',
          provenance: provenanceFor(deps.db, context, 1),
        });
        return {
          preferenceId: preference.id,
          identityId: preference.identityId,
          key: preference.key,
          value: preference.value,
        };
      },
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, setPreferenceOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { preferenceId, identityId, key, value } = parsed.value;

      // Read by (identity, key) rather than by id, because that is the pair the
      // table is unique on and the pair a later read will use. A row that exists
      // under a different id for the same key would mean the upsert did not
      // upsert.
      const row = deps.memoryRepo.getPreference(identityId, key);
      if (!row) return broken(`'${identityId}' has no preference '${key}'; nothing was stored`);
      if (row.id !== preferenceId) {
        return broken(
          `Preference '${key}' for '${identityId}' is row '${row.id}', not the '${preferenceId}' ` +
            `that was reported — the same key is stored twice`,
        );
      }
      if (row.value !== value) {
        return broken(
          `Preference '${key}' for '${identityId}' reads '${row.value}', not the '${value}' ` +
            `that was written`,
        );
      }
      if (row.lifecycleStatus === 'soft_deleted') {
        return broken(`Preference '${key}' for '${identityId}' was written but is already deleted`);
      }
      return held();
    },
  };
}

// ── memory.recall ────────────────────────────────────────────────────────────

const recallInput = z.object({
  query: z.string().trim().min(1).max(500),
  domains: z.array(z.enum(DOMAINS)).min(1).max(DOMAINS.length).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const recallOutput = z.object({
  identityId: z.string().min(1),
  query: z.string(),
  count: z.number().int().min(0),
  items: z.array(
    z.object({
      id: z.string().min(1),
      domain: z.enum(DOMAINS),
      text: z.string(),
    }),
  ),
});

export function recallTool(
  deps: MemoryToolDeps,
): VerifiedTool<z.infer<typeof recallInput>, z.infer<typeof recallOutput>> {
  const id = 'memory.recall';
  return {
    definition: {
      id,
      name: 'Recall memories',
      description:
        'Searches what she remembers about the current caller. Returns only what the Knowledge ' +
        'Retrieval Policy allows that caller to be told.',
      inputSchema: recallInput,
      outputSchema: recallOutput,
      // A read is `safe`: it mutates nothing, and the policy that decides what
      // comes back is enforced inside MemoryRetrieval regardless of who asks.
      clearanceRequired: 'safe',
      retryPolicy: DEFAULT_RETRY_POLICY,
      timeoutMs: 5_000,
      execute: async (input, context) => {
        const result = await deps.memoryRetrieval.retrieve({
          callerId: context.identityId,
          callerKind: context.caller.kind,
          query: input.query,
          domains: input.domains ?? [...DOMAINS],
          limit: input.limit ?? 8,
          recencyWeight: DEFAULT_RETRIEVAL_WEIGHTS.recency,
          importanceWeight: DEFAULT_RETRIEVAL_WEIGHTS.importance,
          similarityWeight: DEFAULT_RETRIEVAL_WEIGHTS.similarity,
          excludeSoftDeleted: true,
        });

        const items = result.items.map((item) => ({
          id: item.id,
          domain: item.domain,
          text: describe(item),
        }));
        return {
          identityId: context.identityId,
          query: input.query,
          count: items.length,
          items,
        };
      },
    },
    /**
     * A read changes nothing, so there is no new row to find. What there is to
     * check is whether she read anything at all: every id she reported is
     * re-read from its own table and must still be there and still be live.
     *
     * That makes this the postcondition that catches a fabricated recall — a
     * model inventing a memory and an id to go with it fails here, and stage 9
     * is then forbidden from presenting it as something she remembers.
     */
    postcondition: (evidence) => {
      const parsed = parseOutput(id, recallOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const { count, items } = parsed.value;

      if (count !== items.length) {
        return broken(
          `'${id}' reported ${count} memories but returned ${items.length}; its own answer is ` +
            `inconsistent`,
        );
      }

      const missing: string[] = [];
      for (const item of items) {
        const row = lookup(deps.memoryRepo, item.domain, item.id);
        if (!row) {
          missing.push(`no ${item.domain} memory '${item.id}' exists`);
        } else if (row.lifecycleStatus === 'soft_deleted') {
          missing.push(`${item.domain} memory '${item.id}' is deleted`);
        }
      }
      if (missing.length > 0) {
        return broken(
          `'${id}' returned memories that authoritative state does not confirm: ` +
            missing.join('; '),
        );
      }
      return held();
    },
  };
}

/** One line of human-readable text per domain, for the response stage to use. */
function describe(item: {
  domain: MemoryDomain;
  summary?: string | undefined;
  subject?: string | undefined;
  predicate?: string | undefined;
  object?: string | undefined;
  key?: string | undefined;
  value?: string | undefined;
  pattern?: string | undefined;
  name?: string | undefined;
  relation?: string | undefined;
}): string {
  switch (item.domain) {
    case 'episodic':
      return item.summary ?? '';
    case 'semantic':
      return [item.subject, item.predicate, item.object].filter(Boolean).join(' ');
    case 'preference':
      return `${item.key ?? ''}: ${item.value ?? ''}`;
    case 'habit':
    case 'learned_pattern':
      return item.pattern ?? '';
    case 'relationship':
      return `${item.name ?? ''} (${item.relation ?? ''})`;
    default: {
      const unhandled: never = item.domain;
      return String(unhandled);
    }
  }
}

/** Re-reads one memory by domain and id. Returns null when it is not there. */
function lookup(
  repo: MemoryRepository,
  domain: MemoryDomain,
  id: string,
): { lifecycleStatus: string } | null {
  switch (domain) {
    case 'episodic':
      return repo.getEpisodic(id);
    case 'semantic':
      return repo.getSemantic(id);
    case 'preference':
      return repo.listPreferences(undefined, true).find((p) => p.id === id) ?? null;
    case 'habit':
      return repo.getHabit(id);
    case 'relationship':
      return repo.getRelationship(id);
    case 'learned_pattern':
      return repo.getLearnedPattern(id);
    default: {
      const unhandled: never = domain;
      return unhandled;
    }
  }
}
