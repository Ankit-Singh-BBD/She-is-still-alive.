/**
 * CognitiveRuntime — orchestrates the 12-stage cycle.
 *
 * Stages 1-6 (PERCEIVE..DECIDE) are real implementations living in
 * `server/cognition/stages/{1..6}.ts` (P08). Stages 7-12 remain P07 scaffold
 * stubs until P09/P10.
 *
 * The runtime is the only place stage transitions are decided (Part VII.2):
 * each stage is a pure function, invoked exactly once per cycle, and its typed
 * output is threaded explicitly to its successors. The JSON in a StageTrace is
 * an audit record of what happened — never the transport between stages.
 */

import { ulid } from 'ulid';
import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { MemoryRetrieval } from '@server/memory/retrieval.js';
import type {
  CycleRecord,
  RawStimulus,
  IdentifiedStimulus,
  RecalledContext,
  UnderstandingProposal,
  ReasoningTraceProposal,
  AuthorizedDecision,
  ActionResult,
  VerificationReport,
  AuthorizedResponse,
  AuthorizedLearningDelta,
  UpdateResult,
  PersistResult,
  StageTrace,
  StageNumber,
  AuditCollector,
  AuditEntry,
} from './types.js';

import { perceive } from './stages/1.js';
import { identify } from './stages/2.js';
import { recall } from './stages/3.js';
import { understand, type UnderstandOptions } from './stages/4.js';
import { reason, type ReasonOptions } from './stages/5.js';
import { decide, type DecideOptions } from './stages/6.js';
import { act, type ActOptions } from './stages/7.js';
import { verify, type VerifyOptions } from './stages/8.js';
import { respond, type RespondOptions } from './stages/9.js';
import { learn, type LearnOptions } from './stages/10.js';
import { update, type UpdateOptions } from './stages/11.js';
import { persist, type PersistOptions, type PersistInput } from './stages/12.js';

export interface CognitiveRuntimeOptions {
  db?: Database | undefined;
  identityRepo?: IdentityRepository | undefined;
  eventBus?: EventBus | undefined;
  memoryRetrieval?: MemoryRetrieval | undefined;
  /** Caller identity used by stages 6-7 for authorization. */
  identity?: Identity | undefined;
  understand?: UnderstandOptions | undefined;
  reason?: ReasonOptions | undefined;
  decide?: DecideOptions | undefined;
  act?: ActOptions | undefined;
  verify?: VerifyOptions | undefined;
  respond?: RespondOptions | undefined;
  learn?: LearnOptions | undefined;
  update?: UpdateOptions | undefined;
  persist?: PersistOptions | undefined;
}

interface StageOutcome<O> {
  trace: StageTrace;
  output: O | undefined;
}

/**
 * In-memory audit buffer for one cycle. Stage 9 records disclosure decisions
 * here; stage 12 (PERSIST, P10) flushes them to `audit_log` inside the cycle's
 * transaction (Build Book Part VII.1 stage 12).
 */
export class CycleAuditBuffer implements AuditCollector {
  private readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }

  drain(): AuditEntry[] {
    return [...this.entries];
  }
}

export class CognitiveRuntime {
  private readonly db: Database;
  private readonly identityRepo: IdentityRepository | undefined;
  private readonly eventBus: EventBus | undefined;
  private readonly memoryRetrieval: MemoryRetrieval | undefined;
  private readonly understandOpts: UnderstandOptions;
  private readonly reasonOpts: ReasonOptions;
  private readonly decideOpts: DecideOptions;
  private readonly actOpts: ActOptions;
  private readonly verifyOpts: VerifyOptions;
  private readonly respondOpts: RespondOptions;
  private readonly learnOpts: LearnOptions;
  private readonly updateOpts: UpdateOptions;
  private readonly persistOpts: PersistOptions;

  constructor(options: CognitiveRuntimeOptions = {}) {
    this.db = options.db ?? getDatabase();
    this.identityRepo = options.identityRepo;
    this.eventBus = options.eventBus;
    this.memoryRetrieval = options.memoryRetrieval;
    this.understandOpts = options.understand ?? {};
    this.reasonOpts = options.reason ?? {};
    this.decideOpts = { ...(options.decide ?? {}), identity: options.identity };
    this.actOpts = { ...(options.act ?? {}), identity: options.identity };
    this.verifyOpts = {
      ...(options.verify ?? {}),
      db: options.db,
      identityId: options.identity?.id,
    };
    this.respondOpts = options.respond ?? {};
    this.learnOpts = {
      ...(options.learn ?? {}),
      db: this.db,
    };
    this.updateOpts = {
      ...(options.update ?? {}),
      db: this.db,
    };
    this.persistOpts = {
      ...(options.persist ?? {}),
      db: this.db,
      eventBus: options.eventBus,
    };
  }

  async runCycle(stimulus: RawStimulus): Promise<CycleRecord> {
    const cycleId = ulid();
    const startedAt = Date.now();
    const cycleRecord = await this.createCycleRecord(cycleId, stimulus, startedAt);

    const stages: StageTrace[] = [];

    // ── Stages 1-6: real implementations (P08) ──

    const r1 = await this.runStage<RawStimulus>(1, 'PERCEIVE', stimulus, () =>
      perceive(stimulus),
    );
    stages.push(r1.trace);
    const perceived = r1.output ?? stimulus;

    const r2 = await this.runStage<IdentifiedStimulus>(2, 'IDENTIFY', perceived, () =>
      identify(perceived, this.identityRepo),
    );
    stages.push(r2.trace);
    const identified = r2.output ?? identify(perceived);

    const r3 = await this.runStage<RecalledContext>(3, 'RECALL', identified, () =>
      recall(identified, this.memoryRetrieval),
    );
    stages.push(r3.trace);
    const recalled = r3.output ?? emptyContext(identified);

    const r4 = await this.runStage<UnderstandingProposal>(4, 'UNDERSTAND', recalled, () =>
      understand(recalled, this.understandOpts),
    );
    stages.push(r4.trace);
    const understanding = r4.output ?? DEFAULT_UNDERSTANDING;

    const r5 = await this.runStage<ReasoningTraceProposal>(
      5,
      'REASON',
      { understanding },
      () => reason(recalled, understanding, this.reasonOpts),
    );
    stages.push(r5.trace);
    const reasoning = r5.output ?? DEFAULT_REASONING;

    const r6 = await this.runStage<AuthorizedDecision>(6, 'DECIDE', { reasoning }, () =>
      decide(reasoning, identified, this.decideOpts),
    );
    stages.push(r6.trace);
    const authorizedDecision = r6.output ?? DEFAULT_DECISION;

    // ── Stages 7-9: real implementations (P09) ──

    const r7 = await this.runStage<ActionResult[]>(7, 'ACT', authorizedDecision, () =>
      act(authorizedDecision, { ...this.actOpts, cycleId }),
    );
    stages.push(r7.trace);
    const actionResults = r7.output ?? [];

    const r8 = await this.runStage<VerificationReport>(8, 'VERIFY', actionResults, () =>
      verify(actionResults, { ...this.verifyOpts, cycleId }),
    );
    stages.push(r8.trace);
    const verification = r8.output;

    const verifiedResults = verification?.results ?? actionResults;

    // Stage 9 records its disclosure decisions into the cycle's audit buffer.
    // Stage 12 (P10) flushes them to `audit_log` together with the rest of the
    // cycle artifacts in one transaction.
    const audit = new CycleAuditBuffer();
    const r9 = await this.runStage<AuthorizedResponse>(
      9,
      'RESPOND',
      { recalled, actionResults: verifiedResults, verification },
      () => respond(recalled, authorizedDecision, verifiedResults, verification, {
        ...this.respondOpts,
        audit,
      }),
    );
    stages.push(r9.trace);
    const response = r9.output;

    // ── Stages 10-12: real implementations (P10) ──

    const r10 = await this.runStage<AuthorizedLearningDelta>(10, 'LEARN', response, () =>
      learn(recalled, authorizedDecision, response ?? DEFAULT_RESPONSE, verifiedResults, verification, {
        ...this.learnOpts,
        cycleId,
      }),
    );
    stages.push(r10.trace);
    const learningDelta = r10.output;

    const r11 = await this.runStage<UpdateResult>(11, 'UPDATE', learningDelta, () =>
      update(learningDelta, this.updateOpts),
    );
    stages.push(r11.trace);
    const updateResult = r11.output;

    const completedAt = Date.now();
    const persistInput: PersistInput = {
      cycleId,
      status: 'completed',
      completedAt,
      identityId: stimulus.identityId,
      actionResults: verifiedResults,
      decision: authorizedDecision,
      response,
      learningDelta,
      updateResult,
      audit: audit.drain(),
      stages: [...stages, /* r12.trace will be appended below */ ],
    };

    const r12 = await this.runStage<PersistResult>(12, 'PERSIST', updateResult, () =>
      persist(persistInput, this.persistOpts),
    );
    stages.push(r12.trace);
    // Stage 12's own trace isn't in `persist`'s transaction — `runStage`
    // creates the trace wrapper *around* the handler that calls `persist`,
    // so its `stage_trace` row hasn't been written yet. Flush it now.
    await this.finalizeCycleRecord(cycleId, [r12.trace]);

    return {
      ...cycleRecord,
      status: 'completed',
      completedAt,
      stages,
      proposedDecision: authorizedDecision.proposal,
      authorizedDecision,
      actionResults: verifiedResults,
      response,
      learningDelta,
    };
  }

  /**
   * Invokes one stage exactly once, capturing its trace. A thrown stage does not
   * abort the cycle: the error is recorded on the trace and the runtime falls
   * back to the stage's documented default (the P08 rollback contract).
   */
  private async runStage<O>(
    stage: StageNumber,
    stageName: string,
    input: unknown,
    handler: () => Promise<O> | O,
  ): Promise<StageOutcome<O>> {
    const startedAt = Date.now();
    const inputJson = safeStringify(input);
    try {
      const output = await handler();
      return {
        trace: {
          stage,
          stageName,
          startedAt,
          completedAt: Date.now(),
          inputJson,
          outputJson: safeStringify(output),
        },
        output,
      };
    } catch (e) {
      return {
        trace: {
          stage,
          stageName,
          startedAt,
          completedAt: Date.now(),
          inputJson,
          error: e instanceof Error ? e.message : String(e),
        },
        output: undefined,
      };
    }
  }

  // ── Persistence ──

  private async createCycleRecord(
    id: string,
    stimulus: RawStimulus,
    startedAt: number,
  ): Promise<CycleRecord> {
    this.db.raw
      .prepare(
        `INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        stimulus.conversationId ?? 'unknown',
        new Date(startedAt).toISOString(),
        JSON.stringify(stimulus),
      );
    return {
      id,
      identityId: stimulus.identityId,
      conversationId: stimulus.conversationId ?? 'unknown',
      status: 'running',
      startedAt,
      stages: [],
    };
  }

  private async finalizeCycleRecord(
    id: string,
    stages: StageTrace[],
  ): Promise<void> {
    const insertTrace = this.db.raw.prepare(
      `INSERT INTO stage_trace (id, cycle_id, stage, stage_name, started_at, completed_at, input_json, output_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // One transaction so stage traces are persisted reliably.
    this.db.raw.transaction(() => {
      for (const stage of stages) {
        insertTrace.run(
          ulid(),
          id,
          stage.stage,
          stage.stageName,
          new Date(stage.startedAt).toISOString(),
          stage.completedAt ? new Date(stage.completedAt).toISOString() : null,
          stage.inputJson,
          stage.outputJson ?? null,
          stage.error ?? null,
        );
      }
    })();
  }
}

// ── Defaults used when a stage errors (P08 rollback contract) ──

const DEFAULT_RESPONSE: AuthorizedResponse = {
  text: 'Hello — I hear you.',
  voiceEnabled: false,
  disclosuresApplied: ['default'],
  redacted: false,
};

const DEFAULT_UNDERSTANDING: UnderstandingProposal = {
  intent: 'respond',
  confidence: 0,
  disambiguationNeeded: false,
  clarifyingQuestions: [],
  entities: {},
};

const DEFAULT_REASONING: ReasoningTraceProposal = {
  steps: [
    { description: 'Reasoning stage failed; defaulting.', conclusion: 'respond', confidence: 0 },
  ],
  optionsConsidered: ['respond'],
  recommendedApproach: 'respond',
};

const DEFAULT_DECISION: AuthorizedDecision = {
  proposal: { action: 'respond', rationale: 'Decision stage failed; default response' },
  authorized: false,
  reason: 'Decision stage failed',
  clearanceChecked: false,
};

function emptyContext(stimulus: IdentifiedStimulus): RecalledContext {
  return {
    stimulus,
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    retrievedAt: Date.now(),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}
