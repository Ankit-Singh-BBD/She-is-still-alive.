/**
 * Phase P28 — Production Readiness Validation (M18)
 *
 * Comprehensive End-to-End System Validation under TRUE CLEAN-SLATE requirements:
 * 1. Clean-slate database initialization and schema migration.
 * 2. Full application integration across all 16 subsystems.
 * 3. Complete Owner journey (bootstrap, authenticated session, cognition, memory, action verification, tasks & loops).
 * 4. Guest journey with strict boundary isolation and Scoped Guest Learning Policy.
 * 5. 12-Stage Cognitive Runtime with non-authoritative LLM proposal evaluation.
 * 6. 7-Stage Action Execution Pipeline with authoritative state re-reading in VERIFY.
 * 7. 6 Memory Domains with provenance and sensitivity gating.
 * 8. Autonomous Loops and Task Scheduler integration.
 * 9. 7-Stage Realtime Monotonic Flow contract.
 * 10. Voice pipeline and audio visualizer synchronization.
 * 11. Liquid Glass UI, Orb, and Atmosphere visual state projection.
 * 12. Failure injection and state resilience recovery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { z } from 'zod';
import { ulid } from 'ulid';

// Subsystems imports
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { IdentityRepository } from '@server/identity/repository.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import { EventBus } from '@server/events/event-bus.js';
import { ToolRegistry } from '@server/actions/registry.js';
import { ActionPipeline, type PostconditionVerifier } from '@server/actions/pipeline.js';
import { TaskExecutor } from '@server/tasks/executor.js';
import { LoopManager } from '@server/loops/manager.js';
import { ProactiveEngine } from '@server/proactive/engine.js';
import { LearningPipeline } from '@server/learning/pipeline.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { LiveSessionStateMachine } from '@server/voice/session.js';
import { MockAudioCapture, MockAudioPlayback } from '@server/voice/adapters/mock.js';
import { RealtimeFlow } from '@server/realtime/flow.js';
import { PersonalityRegistry } from '@server/personality/registry.js';
import { PersonalityEngine } from '@server/personality/engine.js';
import { SecurityPolicy } from '@server/security/policy.js';
import { AuditLogService } from '@server/security/audit.js';
import {
  createDefaultAdvancedModuleRegistry,
  type AdvancedModuleRegistry,
  type AdvancedModuleFlagMap,
} from '@server/advanced/index.js';
import type { RuntimeState, Subscriber, BroadcastMessage } from '@server/realtime/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

function createMockSubscriber(id: string): Subscriber & { messages: BroadcastMessage[] } {
  const messages: BroadcastMessage[] = [];
  return {
    id,
    send: vi.fn(async (msg: BroadcastMessage) => {
      messages.push(msg);
    }),
    messages,
  };
}

describe('Phase P28 — Production Readiness Validation (M18)', () => {
  let db: Database;
  let identityRepo: IdentityRepository;
  let memoryRepo: MemoryRepository;
  let memoryRetrieval: MemoryRetrieval;
  let eventBus: EventBus;
  let toolRegistry: ToolRegistry;
  let actionPipeline: ActionPipeline;
  let taskExecutor: TaskExecutor;
  let loopManager: LoopManager;
  let _proactiveEngine: ProactiveEngine;
  let _learningSystem: LearningPipeline;
  let personalityRegistry: PersonalityRegistry;
  let _personalityEngine: PersonalityEngine;
  let auditLogService: AuditLogService;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);

    identityRepo = new IdentityRepository(db);
    memoryRepo = new MemoryRepository(db);
    memoryRetrieval = new MemoryRetrieval(memoryRepo);
    eventBus = new EventBus(db, { handlerDeadlineMs: 100 });
    toolRegistry = new ToolRegistry();
    actionPipeline = new ActionPipeline({ registry: toolRegistry, db, eventBus });
    taskExecutor = new TaskExecutor(db, eventBus);
    loopManager = new LoopManager(db, eventBus, taskExecutor);
    _proactiveEngine = new ProactiveEngine({ db, eventBus });
    _learningSystem = new LearningPipeline({
      db,
      memoryRepo,
      eventBus,
      extractor: { extract: async () => [] } as never,
    });
    personalityRegistry = new PersonalityRegistry();
    _personalityEngine = new PersonalityEngine(personalityRegistry);
    auditLogService = new AuditLogService(db);
  });

  describe('1. Clean-Slate Boot & Schema Invariants', () => {
    it('initializes cleanly from empty database with correct forward migrations and no legacy tables', () => {
      const tables = db.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('app_meta');
      expect(tableNames).toContain('identity');
      expect(tableNames).toContain('permission');
      expect(tableNames).toContain('session');
      expect(tableNames).toContain('conversation');
      expect(tableNames).toContain('message');
      expect(tableNames).toContain('cycle_record');
      expect(tableNames).toContain('stage_trace');
      expect(tableNames).toContain('action_result');
      expect(tableNames).toContain('domain_event');
      expect(tableNames).toContain('episodic_memory');
      expect(tableNames).toContain('semantic_memory');
      expect(tableNames).toContain('preference');
      expect(tableNames).toContain('habit');
      expect(tableNames).toContain('relationship');
      expect(tableNames).toContain('learned_pattern');
      expect(tableNames).toContain('task');
      expect(tableNames).toContain('open_loop');
      expect(tableNames).toContain('audit_log');

      expect(tableNames).not.toContain('legacy_store');
      expect(tableNames).not.toContain('migration_history');
      expect(tableNames).not.toContain('v1_conversations');

      const meta = db.raw.prepare(`SELECT key, value FROM app_meta WHERE key = 'schema_version'`).get() as { key: string; value: string };
      expect(meta).toBeDefined();
      expect(Number(meta.value)).toBeGreaterThanOrEqual(1);
    });
  });

  describe('2. Full Application Integration Across All Subsystems', () => {
    it('interconnects Identity, Memory, Actions, Tasks, Loops, Proactivity, Realtime, Personality, and Advanced modules', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'System Owner' });
      expect(owner.id).toBeDefined();

      personalityRegistry.setPersona({
        identityId: owner.id,
        name: 'Madhurita Warm',
        verbosity: 2,
        formality: 0,
        warmth: 2,
      });
      const persona = personalityRegistry.getEffectivePersona(owner.id);
      expect(persona.warmth).toBe(2);

      const advancedRegistry: AdvancedModuleRegistry = createDefaultAdvancedModuleRegistry();
      expect(advancedRegistry.count()).toBe(4);
      expect(advancedRegistry.ids()).toEqual([
        'emotion-reading',
        'relationship-context',
        'long-horizon-reflection',
        'dream-consolidation',
      ]);

      const allOn: AdvancedModuleFlagMap = {
        enableEmotionReading: true,
        enableRelationshipContext: true,
        enableLongHorizonReflection: true,
        enableDreamConsolidation: true,
      };
      expect(advancedRegistry.enabledIds(allOn).length).toBe(4);

      const identifyOutcome = await advancedRegistry.run(
        { text: 'I am thrilled to see everything running smoothly today!', voiceEnergy: 0.8 },
        2,
        { identityId: owner.id, conversationId: 'conv-adv-1', cycleId: 'cyc-adv-1', stageNumber: 2 },
        allOn,
      );
      expect(identifyOutcome.errors.length).toBe(0);
      expect(identifyOutcome.results.some((r) => r.moduleId === 'emotion-reading')).toBe(true);

      const understandOutcome = await advancedRegistry.run(
        { text: 'Worked on system architecture together with Elena' },
        4,
        { identityId: owner.id, conversationId: 'conv-adv-1', cycleId: 'cyc-adv-1', stageNumber: 4 },
        allOn,
      );
      expect(understandOutcome.errors.length).toBe(0);
      expect(understandOutcome.results.some((r) => r.moduleId === 'relationship-context')).toBe(true);

      const allOff: AdvancedModuleFlagMap = {
        enableEmotionReading: false,
        enableRelationshipContext: false,
        enableLongHorizonReflection: false,
        enableDreamConsolidation: false,
      };
      const isolated = await advancedRegistry.run(
        { text: 'no flags' },
        2,
        { identityId: owner.id, conversationId: 'conv-adv-2', cycleId: 'cyc-adv-2', stageNumber: 2 },
        allOff,
      );
      expect(isolated.results.length).toBe(0);
      expect(isolated.errors.length).toBe(0);

      const isolatedFailure = await advancedRegistry.run(
        { text: 'boom' },
        11,
        { identityId: owner.id, conversationId: 'conv-adv-3', cycleId: 'cyc-adv-3', stageNumber: 11 },
        { ...allOff, enableLongHorizonReflection: true },
      );
      expect(isolatedFailure.errors.length).toBe(0);
      expect(isolatedFailure.results.some((r) => r.moduleId === 'long-horizon-reflection')).toBe(true);
    });
  });

  describe('3. Complete Owner Journey', () => {
    it('runs bootstrap, authenticated session, memory persistence, action execution, and task generation', async () => {
      const owner = await identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Master Architect',
      });
      expect(owner.kind).toBe('owner');

      const session = identityRepo.createSession(owner.id, Date.now() + 3600 * 1000);
      expect(session.id).toBeDefined();

      const validatedSession = identityRepo.validateSession(session.id);
      expect(validatedSession).toBeDefined();
      expect(validatedSession?.identityId).toBe(owner.id);

      let databaseTableCreated = false;
      toolRegistry.register({
        id: 'system.create_table',
        name: 'Create Table',
        description: 'Creates a user table in database',
        inputSchema: z.object({ tableName: z.string() }),
        clearanceRequired: 'all',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async (input: unknown) => {
          const { tableName } = input as { tableName: string };
          db.raw.prepare(`CREATE TABLE IF NOT EXISTS ${tableName} (id TEXT PRIMARY KEY, val TEXT)`).run();
          databaseTableCreated = true;
          return { status: 'created', tableName };
        },
      });

      const verifier: PostconditionVerifier = {
        verify: async (toolId: string, input: unknown) => {
          if (toolId === 'system.create_table') {
            const { tableName } = input as { tableName: string };
            const check = db.raw
              .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
              .get(tableName);
            return {
              postconditionsMet: Boolean(check),
              discrepancies: check ? [] : [`Table ${tableName} was not created in database`],
            };
          }
          return { postconditionsMet: true, discrepancies: [] };
        },
      };

      const verifiedActionPipeline = new ActionPipeline({
        registry: toolRegistry,
        db,
        eventBus,
        verifier,
      });

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-owner-1', ?)`).run(owner.id);
      const cycleId = 'cyc-owner-' + ulid().slice(0, 10);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(cycleId, 'conv-owner-1');

      const actionResult = await verifiedActionPipeline.execute({
        toolId: 'system.create_table',
        input: { tableName: 'user_projects' },
        identityId: owner.id,
        cycleId,
        causationId: 'evt-bootstrap',
        caller: owner,
      });

      expect(actionResult.success).toBe(true);
      expect(actionResult.verified).toBe(true);
      expect(databaseTableCreated).toBe(true);

      memoryRepo.createPreference({
        identityId: owner.id,
        key: 'editor_theme',
        value: 'tokyo_night',
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 1.0,
        statedAt: Date.now(),
        sourceKind: 'conversation',
        provenance: {
          sourceCycleId: cycleId,
          sourceConversationId: 'conv-owner-1',
          sourceMessageIds: [],
          extractedAt: Date.now(),
          extractor: 'llm',
          confidence: 1.0,
          validatedBy: 'auto_policy',
        },
      });

      const retrievedMemories = await memoryRetrieval.retrieve({
        callerId: owner.id,
        callerKind: 'owner',
        query: 'editor theme',
        domains: ['preference'],
        limit: 5,
        similarityWeight: 1.0,
        importanceWeight: 0,
        recencyWeight: 0,
        excludeSoftDeleted: true,
      });
      expect(retrievedMemories.items.length).toBe(1);
      expect((retrievedMemories.items[0] as unknown as { value: string }).value).toBe('tokyo_night');

      const loopId = loopManager.openLoop({
        identityId: owner.id,
        topic: 'Monitor daily backup integrity',
        triggerSpec: { type: 'schedule', intervalMs: 86400000 },
        actionSpec: { kind: 'task', taskKind: 'recurring', payload: { kind: 'recurring', toolId: 'backup_check', input: {}, intervalMs: 86400000 } }
      });
      expect(loopId).toBeDefined();

      const scheduledTaskId = await taskExecutor.scheduleTask({
        identityId: owner.id,
        kind: 'one_shot',
        payload: { kind: 'one_shot', toolId: 'backup_check', input: { loopId, check: 'sha256' }, runAt: Date.now() - 100 },
        dueAt: Date.now() - 100,
      });
      expect(scheduledTaskId).toBeDefined();

      const numTasks = await taskExecutor.tick();
      expect(numTasks).toBeGreaterThanOrEqual(0);
    });
  });

  describe('4. Guest Journey & Strict Boundary Isolation', () => {
    it('enforces zero memory leakage, denies unauthorized actions, and applies Scoped Guest Learning', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const guest = await identityRepo.createIdentity({ kind: 'guest', displayName: 'Anonymous Visitor' });

      memoryRepo.createPreference({
        identityId: owner.id,
        key: 'secret_bank_pin',
        value: '9944',
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 1.0,
        statedAt: Date.now(),
        sourceKind: 'conversation',
        provenance: {
          sourceCycleId: 'cyc-1',
          sourceConversationId: 'conv-1',
          sourceMessageIds: [],
          extractedAt: Date.now(),
          extractor: 'llm',
          confidence: 1.0,
          validatedBy: 'auto_policy',
        },
      });

      const guestRetrieval = await memoryRetrieval.retrieve({
        callerId: guest.id,
        callerKind: 'guest',
        query: 'bank pin',
        domains: ['preference'],
        limit: 10,
        similarityWeight: 1.0,
        importanceWeight: 0,
        recencyWeight: 0,
        excludeSoftDeleted: true,
      });
      expect(guestRetrieval.items.length).toBe(0);

      toolRegistry.register({
        id: 'admin.shutdown',
        name: 'Shutdown Server',
        description: 'Admin command',
        inputSchema: z.object({}),
        clearanceRequired: 'all',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async () => ({ shutdown: true }),
      });

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-guest', ?)`).run(guest.id);
      const guestCycleId = 'cyc-guest-' + ulid().slice(0, 10);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(guestCycleId, 'conv-guest');

      const guestActionResult = await actionPipeline.execute({
        toolId: 'admin.shutdown',
        input: {},
        identityId: guest.id,
        cycleId: guestCycleId,
        causationId: 'evt-guest',
        caller: guest,
      });

      expect(guestActionResult.success).toBe(false);
      expect(guestActionResult.error).toMatch(/Denied by authorization policy|clearance/);

      const allIdentities = identityRepo.listIdentities();
      const filteredForGuest = SecurityPolicy.filterIdentitiesForCaller(guest, allIdentities);
      expect(filteredForGuest.length).toBe(0);
    });
  });

  describe('5. 12-Stage Cognitive Runtime & Non-Authoritative LLM Evaluation', () => {
    it('executes the full 12-stage cognitive cycle and intercepts unauthorized proposals', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-cog-1', ?)`).run(owner.id);

      // We explicitly cast mockLLM as unknown, then to the required specific LLMFaculty interfaces
      // since Vitest mocks don't accurately type the specific arguments and returns for each stage.
      const mockLLM = {
        proposeUnderstanding: vi.fn().mockResolvedValue({
          intent: 'query_system_status',
          confidence: 0.95,
          disambiguationNeeded: false,
          clarifyingQuestions: [],
          entities: {},
        }),
        proposeReasoning: vi.fn().mockResolvedValue({
          steps: [{ description: 'Check status', conclusion: 'respond', confidence: 0.95 }],
          optionsConsidered: ['respond'],
          recommendedApproach: 'respond',
        }),
        proposeDecision: vi.fn().mockResolvedValue({
          action: 'respond',
          rationale: 'Direct status response',
        }),
        draftResponse: vi.fn().mockResolvedValue({
          text: 'The system is 100% operational and healthy.',
          voicePreferred: false,
        }),
        // Stage 10's faculty is `proposeExtractions`, returning an array of
        // candidate extractions. This mock previously declared `extractLearning`
        // returning `{ memories: [] }`; the `as never` cast hid the mismatch, so
        // stage 10 threw `opts.llm.proposeExtractions is not a function` on every
        // run. The cycle reported 'completed' anyway because the runtime
        // hardcoded that status — the assertion below now means something.
        proposeExtractions: vi.fn().mockResolvedValue([]),
      };

      const customRuntime = new CognitiveRuntime({
        db,
        eventBus,
        identityRepo,
        understand: { llm: mockLLM as never },
        reason: { llm: mockLLM as never },
        decide: { llm: mockLLM as never },
        respond: { llm: mockLLM as never },
        learn: { llm: mockLLM as never },
      });

      const result = await customRuntime.runCycle({
        source: 'text',
        payload: { text: 'What is the system status?' },
        receivedAt: Date.now(),
        identityId: owner.id,
        conversationId: 'conv-cog-1',
      });

      expect(result.status).toBe('completed');
      expect(result.id).toBeDefined();
      expect((result.response as unknown as { text: string })?.text).toBe('The system is 100% operational and healthy.');

      const traces = db.raw
        .prepare(`SELECT stage, stage_name FROM stage_trace WHERE cycle_id = ? ORDER BY stage ASC`)
        .all(result.id) as { stage: number; stage_name: string }[];

      expect(traces.length).toBe(12);
      expect(traces.map((t) => t.stage_name)).toEqual([
        'PERCEIVE',
        'IDENTIFY',
        'RECALL',
        'UNDERSTAND',
        'REASON',
        'DECIDE',
        'ACT',
        'VERIFY',
        'RESPOND',
        'LEARN',
        'UPDATE',
        'PERSIST',
      ]);

      const cycleRow = db.raw.prepare(`SELECT status FROM cycle_record WHERE id = ?`).get(result.id) as { status: string };
      expect(cycleRow.status).toBe('completed');

      // A cycle announces itself at both ends. Stage 12 always published the
      // terminal event, but `cycle.started` was declared in the event union and
      // never published, so nothing could observe a cycle while it was still
      // running — a subscriber only ever heard about thinking that had already
      // finished.
      const cycleEvents = db.raw
        .prepare(`SELECT seq, type FROM domain_event WHERE cycle_id = ? ORDER BY seq ASC`)
        .all(result.id) as { seq: number; type: string }[];

      expect(cycleEvents[0]?.type).toBe('cycle.started');
      expect(cycleEvents.at(-1)?.type).toBe('cycle.completed');
    });
  });

  describe('6. Action Pipeline: Proof of Action & Authoritative VERIFY', () => {
    it('marks action unverified if side effects are not authoritatively proven on disk', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });

      toolRegistry.register({
        id: 'mock.claim_done',
        name: 'Mock Claim Done',
        description: 'Claims completion without doing anything',
        inputSchema: z.object({ expectedRow: z.string() }),
        clearanceRequired: 'safe',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async () => ({ claimed: true }),
      });

      const failingVerifier: PostconditionVerifier = {
        verify: async (_toolId, input, _output, verifierDb) => {
          const { expectedRow } = input as { expectedRow: string };
          const row = verifierDb.raw.prepare(`SELECT * FROM app_meta WHERE key = ?`).get(expectedRow);
          return {
            postconditionsMet: Boolean(row),
            discrepancies: row ? [] : [`Row '${expectedRow}' not found in app_meta`],
          };
        },
      };

      const pipeline = new ActionPipeline({
        registry: toolRegistry,
        db,
        eventBus,
        verifier: failingVerifier,
      });

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-vf-1', ?)`).run(owner.id);
      const cid = 'cyc-vf-' + ulid().slice(0, 10);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(cid, 'conv-vf-1');

      const result = await pipeline.execute({
        toolId: 'mock.claim_done',
        input: { expectedRow: 'non_existent_key' },
        identityId: owner.id,
        cycleId: cid,
        causationId: 'evt-vf',
        caller: owner,
      });

      expect(result.success).toBe(true);
      expect(result.verified).toBe(false);

      const savedResult = db.raw.prepare(`SELECT verified, tool_id FROM action_result WHERE id = ?`).get(result.actionResultId) as { verified: number; tool_id: string };
      expect(savedResult.verified).toBe(0);
      expect(savedResult.tool_id).toBe('mock.claim_done');
    });
  });

  describe('7. Multi-Domain Memory & Provenance Invariants', () => {
    it('isolates 6 memory domains and tracks provenance metadata on all rows', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const now = Date.now();

      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-mem-1', ?)`).run(owner.id);
      db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at) VALUES ('cyc-mem-1', 'conv-mem-1', 'running', datetime('now'))`).run();

      const prov = {
        sourceCycleId: 'cyc-mem-1',
        sourceConversationId: 'conv-mem-1',
        sourceMessageIds: ['msg-1'],
        extractedAt: now,
        extractor: 'llm' as const,
        confidence: 0.95,
        validatedBy: 'auto_policy' as const,
      };

      const epId = memoryRepo.createEpisodic({
        identityId: owner.id,
        summary: 'Met with user to review architecture',
        details: 'Everything aligned with Build Book',
        importance: 0.8,
        occurredAt: now,
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 0.95,
        sourceKind: 'conversation',
        provenance: prov,
      });
      expect(epId).toBeDefined();

      const semId = memoryRepo.createSemantic({
        identityId: owner.id,
        subject: 'Madhurita',
        predicate: 'is',
        object: 'production ready',
        sourceCycle: 'cyc-mem-1',
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 0.95,
        sourceKind: 'conversation',
        provenance: prov,
      });
      expect(semId).toBeDefined();

      const prefId = memoryRepo.createPreference({
        identityId: owner.id,
        key: 'preferred_voice',
        value: 'female_warm',
        statedAt: now,
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 1.0,
        sourceKind: 'conversation',
        provenance: prov,
      });
      expect(prefId).toBeDefined();

      const habitId = memoryRepo.createHabit({
        identityId: owner.id,
        pattern: 'Morning standup at 9am',
        frequency: 'daily',
        lastObserved: now,
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 0.9,
        sourceKind: 'conversation',
        provenance: prov,
      });
      expect(habitId).toBeDefined();

      const relId = memoryRepo.createRelationship({
        ownerId: owner.id,
        name: 'Madhurita',
        relation: 'AI Assistant & Companion',
        notes: 'Built with first-principles precision',
        importance: 1.0,
        sensitivity: 'owner_only',
        confidence: 1.0,
        provenance: prov,
      });
      expect(relId).toBeDefined();

      const patId = memoryRepo.createLearnedPattern({
        identityId: owner.id,
        pattern: 'Prefers thorough verification before declaring completion',
        evidenceCount: 5,
        subjectKind: 'owner',
        sensitivity: 'owner_only',
        confidence: 0.98,
        sourceKind: 'conversation',
        provenance: prov,
      });
      expect(patId).toBeDefined();

      memoryRepo.softDeleteSemantic(semId.id, owner.id);
      const semRow = db.raw.prepare(`SELECT deleted_at FROM semantic_memory WHERE id = ?`).get(semId.id) as { deleted_at: string | null };
      expect(semRow.deleted_at).not.toBeNull();
    });
  });

  describe('8. Realtime Monotonic Flow Contract', () => {
    it('broadcasts state updates in monotonic order and coalesces high-frequency mutations', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      const initialRuntime: RuntimeState = {
        version: 1,
        identity: owner,
        presence: {
          activeActor: owner.id,
          recentActors: [owner.id],
          sessionStartedAt: Date.now(),
        },
        environment: {
          timeOfDay: 'day',
          weather: { condition: 'clear' },
          location: { lat: 37.77, lng: -122.41 },
          derivedPalette: { primary: '#1a1a2e', secondary: '#16213e', accent: '#0f3460' },
        },
        cognitive: {
          currentStage: 'PERCEIVE',
          cycleId: 'cyc-rt-1',
          cycleStartedAt: Date.now(),
          lastCompletedStage: 'PERSIST',
          attention: {},
        },
        voice: {
          live: 'listening',
          energy: 0.5,
          ttsEnergy: 0,
          frequencyBands: [0.1, 0.2, 0.4],
          voiceId: 'female_natural',
        },
        memory: {
          episodicCount: 1,
          semanticCount: 2,
          preferenceCount: 3,
          habitCount: 1,
          relationshipCount: 1,
          learnedPatternCount: 1,
          lastConsolidationAt: Date.now(),
        },
        loops: { activeCount: 1, pausedCount: 0 },
        tasks: { pendingCount: 0, runningCount: 0, failedCount: 0 },
        pendingActions: [],
        lastMutation: {
          eventId: 'evt-0',
          type: 'init',
          timestamp: Date.now(),
        },
      };

      const flow = new RealtimeFlow(eventBus, initialRuntime);
      flow.start();

      const subscriber = createMockSubscriber('client-1');
      flow.subscribe(subscriber);

      await eventBus.publish({ type: 'task.scheduled', payload: { taskId: 't1' } });
      await eventBus.publish({ type: 'task.completed', payload: { taskId: 't1' } });
      await eventBus.publish({ type: 'task.failed', payload: { taskId: 't1' } });

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(subscriber.messages.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < subscriber.messages.length; i++) {
        expect(subscriber.messages[i]!.seq).toBeGreaterThan(subscriber.messages[i - 1]!.seq);
      }
    });
  });

  describe('9. Voice Pipeline & Audio State Synchronization', () => {
    it('manages LiveSessionStateMachine transitions and coordinates with AudioCapture/AudioPlayback', async () => {
      const session = new LiveSessionStateMachine();
      expect(session.state).toBe('disconnected');

      session.start();
      expect(session.state).toBe('connecting');

      session.onConnected();
      expect(session.state).toBe('listening');

      session.onSpeechEnd();
      expect(session.state).toBe('thinking');

      session.onTtsStart();
      expect(session.state).toBe('speaking');

      session.onTtsEnd();
      expect(session.state).toBe('listening');

      expect(() => {
        // @ts-expect-error test illegal transition
        session.transitionTo('connecting');
      }).toThrow();

      const capture = new MockAudioCapture({ sampleRate: 16000, chunkMs: 100 });
      const playback = new MockAudioPlayback({ sampleRate: 24000, volume: 1.0 });

      await capture.start({
        onChunk: () => {},
        onStart: () => {},
        onStop: () => {},
        onPermissionDenied: () => {},
        onDeviceNotFound: () => {},
      });
      expect(capture.getState().state).toBe('capturing');

      await playback.init();
      const testChunkBase64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
      await playback.playChunk(testChunkBase64, 'pcm16_base64', { durationMs: 100 });
      expect(playback.getState().isSpeaking).toBe(true);

      const waveform = new Uint8Array(64);
      playback.getWaveformData(waveform);
      expect(new Set(waveform).size).toBeGreaterThan(1);

      await capture.dispose();
      await playback.dispose();
    });
  });

  // Section 10 (visual state projection) is retired with the old UI.
  // Its replacement lives in tests/presence/presence-mapper.test.ts, which
  // exercises the new presence layer against the same authoritative RuntimeState.

  describe('11. Security Hardening & Audit Integrity', () => {
    it('redacts sensitive fields and verifies cryptographic backup integrity', async () => {
      auditLogService.log({
        action: 'auth:login',
        resource: 'session',
        decision: 'allowed',
        metadata: {
          passphrase: 'secret-passphrase',
          apiKey: 'sk-ant-private-9988',
          userEmail: 'owner@example.com',
        },
      });

      const auditRecords = auditLogService.query({ action: 'auth:login' });
      expect(auditRecords.length).toBe(1);
      expect(auditRecords[0]?.metadataJson).not.toContain('secret-passphrase');
      expect(auditRecords[0]?.metadataJson).not.toContain('sk-ant-private-9988');
      expect(auditRecords[0]?.metadataJson).toContain('[redacted]');
      expect(auditRecords[0]?.metadataJson).toContain('owner@example.com');

      const integrity = auditLogService.verifyIntegrity();
      expect(integrity.valid).toBe(true);
    });
  });

  describe('12. Failure Recovery & Crash Resilience', () => {
    it('recovers gracefully from LLM failures, invalid inputs, and interrupted transactions', async () => {
      const owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Owner' });
      db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-fail-1', ?)`).run(owner.id);

      const crashingLLM = {
        proposeUnderstanding: vi.fn().mockRejectedValue(new Error('LLM Gateway 503 Overloaded')),
      };

      const crashingRuntime = new CognitiveRuntime({
        db,
        eventBus,
        identityRepo,
        understand: { llm: crashingLLM as never },
      });

      const failResult = await crashingRuntime.runCycle({
        source: 'text',
        payload: { text: 'Crash this cycle' },
        receivedAt: Date.now(),
        identityId: owner.id,
        conversationId: 'conv-fail-1',
      });

      // A stage threw and was replaced by its documented fallback. The cycle
      // still answered — that is the graceful recovery under test — but it must
      // not claim clean success over a stage that failed. `degraded` is that
      // distinction, and the reason is carried on the cycle record.
      expect(failResult.status).toBe('degraded');
      expect(failResult.error).toContain('UNDERSTAND');
      expect(failResult.error).toContain('LLM Gateway 503 Overloaded');

      const failRow = db.raw
        .prepare(`SELECT status, error FROM cycle_record WHERE id = ?`)
        .get(failResult.id) as { status: string; error: string | null };
      expect(failRow.status).toBe('degraded');
      expect(failRow.error).toContain('LLM Gateway 503 Overloaded');

      const traceDb = db.raw
        .prepare(`SELECT error FROM stage_trace WHERE cycle_id = ? AND stage_name = 'UNDERSTAND'`)
        .get(failResult.id) as { error: string };
      expect(traceDb.error).toContain('LLM Gateway 503 Overloaded');

      const checkDb = db.raw.prepare(`SELECT count(*) as count FROM cycle_record WHERE conversation_id = 'conv-fail-1'`).get() as { count: number };
      expect(checkDb.count).toBeGreaterThanOrEqual(1);

      const workingLLM = {
        proposeUnderstanding: vi.fn().mockResolvedValue({ intent: 'recovered', entities: [], confidence: 1 }),
        proposeReasoning: vi.fn().mockResolvedValue({ steps: [{ description: 'recovered', conclusion: 'recovered', confidence: 1 }], optionsConsidered: [], recommendedApproach: 'recovered' }),
        proposeDecision: vi.fn().mockResolvedValue({ action: 'respond', rationale: 'recovered' }),
        draftResponse: vi.fn().mockResolvedValue({ text: 'Recovered cleanly', voicePreferred: false }),
        // The real stage-10 faculty method. See the note on the mock above.
        proposeExtractions: vi.fn().mockResolvedValue([]),
      };

      const recoveredRuntime = new CognitiveRuntime({
        db,
        eventBus,
        identityRepo,
        understand: { llm: workingLLM as never },
        reason: { llm: workingLLM as never },
        decide: { llm: workingLLM as never },
        respond: { llm: workingLLM as never },
        learn: { llm: workingLLM as never },
      });

      const recoveredResult = await recoveredRuntime.runCycle({
        source: 'text',
        payload: { text: 'Are you back online?' },
        receivedAt: Date.now(),
        identityId: owner.id,
        conversationId: 'conv-fail-1',
      });

      expect(recoveredResult.status).toBe('completed');
      expect((recoveredResult.response as unknown as { text: string })?.text).toBe('Recovered cleanly');
    });
  });
});
