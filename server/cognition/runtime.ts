/**
 * CognitiveRuntime — orchestrates the 12-stage cycle.
 *
 * All twelve stages are real implementations living in
 * `server/cognition/stages/{1..12}.ts`: 1-6 (PERCEIVE..DECIDE) from P08, 7-9
 * (ACT, VERIFY, RESPOND) from P09, and 10-12 (LEARN, UPDATE, PERSIST) from P10.
 *
 * The runtime is the only place stage transitions are decided (Part VII.2):
 * each stage is a pure function, invoked exactly once per cycle, and its typed
 * output is threaded explicitly to its successors. The JSON in a StageTrace is
 * an audit record of what happened — never the transport between stages.
 *
 * A stage that throws does not abort the cycle: the error is recorded on its
 * trace, the documented fallback is substituted, and the cycle reports
 * `degraded` rather than `completed` so the outcome never overstates itself.
 */

import { ulid } from '@server/persistence/ids.js';
import type { Database } from '@server/persistence/db.js';
import { getDatabase } from '@server/persistence/db.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { MemoryRetrieval } from '@server/memory/retrieval.js';
import type { ConversationRepository } from '@server/conversations/repository.js';
import type { TranscriptReader, TurnDraft } from '@server/conversations/messages.js';
// Type-only, and only here. `server/cognition/types.ts` stays free of any
// reference to an opt-in subsystem — a core type that named `server/advanced`
// would invert the dependency for a field most cycles never populate. The
// orchestrator is the right place to know about wiring; that is what it is for.
import type {
  AdvancedCognitiveExtension,
  AdvancedCycleNote,
  AdvancedModuleFlagMap,
  AdvancedModuleRegistry,
} from '@server/advanced/index.js';
import type {
  CycleRecord,
  CycleStatus,
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

import { CycleGate } from './gate.js';
import type { CycleLease, InterruptionCause } from './gate.js';
import { buildResponseFrameForCycle } from './frame-bridge.js';
import { perceive } from './stages/1.js';
import { identify, effectiveCaller } from './stages/2.js';
import { recall } from './stages/3.js';
import { understand, type UnderstandOptions } from './stages/4.js';
import { reason, type ReasonOptions } from './stages/5.js';
import { decide, type DecideOptions } from './stages/6.js';
import { act, type ActOptions } from './stages/7.js';
import { verify, type VerifyOptions } from './stages/8.js';
import { fallbackResponse, respond, type RespondOptions } from './stages/9.js';
import { learn, type LearnOptions } from './stages/10.js';
import { update, type UpdateOptions } from './stages/11.js';
import { persist, type PersistOptions, type PersistInput } from './stages/12.js';

export interface CognitiveRuntimeOptions {
  db?: Database | undefined;
  identityRepo?: IdentityRepository | undefined;
  eventBus?: EventBus | undefined;
  memoryRetrieval?: MemoryRetrieval | undefined;
  /**
   * Opens the conversation a cycle is recorded against when the stimulus does
   * not name one. Without it, an unnamed conversation is an error rather than a
   * guess.
   */
  conversations?: ConversationRepository | undefined;
  /**
   * Reads the recent turns of the conversation for stage 3, and is the reason
   * she can refer to what was just said. Absent, every cycle starts from
   * memory alone and `RecalledContext.recentTurns` stays undefined — which the
   * prompts report as "not loaded" rather than as "nothing was said".
   */
  transcript?: TranscriptReader | undefined;
  /** Caller identity used by stages 6-7 for authorization. */
  identity?: Identity | undefined;
  /**
   * The per-identity cycle lane (Build Book VII.3).
   *
   * Must be the *shared* gate, not a fresh one: `App.runtimeFor` builds a new
   * `CognitiveRuntime` per request, so a gate constructed here per runtime would
   * serialize a request against itself and nothing else. The default below exists
   * for tests and for a standalone runtime, where one runtime is the only runtime.
   */
  gate?: CycleGate | undefined;
  /**
   * Notified once per cycle that produced a record, whatever started it.
   *
   * It used to be how `/api/state` learned that a cycle had happened, and that was
   * wrong in a way worth keeping written down: this fires after the lease is
   * released, which is after stage 12 published the cycle's terminal event — and
   * the terminal event is the last thing a cycle emits. So the projector's fold
   * always waited for the next unrelated event, and until one arrived the interface
   * reported the *previous* cycle. `RuntimeState.cognitive` is projected from
   * `cycle.started`, `cycle.stage.completed` and the terminal event now, and wants
   * nothing from here.
   *
   * What is left is the one thing no event carries: the second argument's
   * advanced-module reports. Those are notes and per-module error counts produced
   * inside the cycle and written to no row, so `server/app.ts` reads them here to
   * raise an `error.raised` for a module that failed — otherwise a whole opt-in
   * subsystem can break in production and say nothing at all.
   *
   * An observer, not a stage: it is handed the finished record and cannot influence
   * it.
   */
  onCycle?:
    | ((record: CycleRecord, extras: { advanced: AdvancedCognitiveExtension }) => void)
    | undefined;
  /**
   * The advanced modules, run **inside** the cycle.
   *
   * There used to be a second mechanism — `AdvancedModuleCognitiveHook`, which ran
   * the same registry over an already-finished `CycleRecord`. It is deleted, and the
   * reason it is deleted rather than kept as an offline replay path is that replay is
   * the wrong shape for what these modules are *for*: a module that reads affect at
   * stage 2 exists so that stage 9 can speak in the register it found, and a pass
   * that starts after stage 12 has committed cannot inform any stage of the cycle it
   * is reading. Its writes landed a turn late, every turn. Leaving that constructor
   * exported would have left a supported way to reintroduce the bug.
   *
   * So when this is wired the modules run stage by stage as the cycle proceeds, and
   * this is the only path there is.
   */
  advanced?:
    | {
        registry: AdvancedModuleRegistry;
        flags: AdvancedModuleFlagMap;
      }
    | undefined;
  understand?: UnderstandOptions | undefined;
  reason?: ReasonOptions | undefined;
  decide?: DecideOptions | undefined;
  act?: ActOptions | undefined;
  verify?: VerifyOptions | undefined;
  respond?: RespondOptions | undefined;
  frame?: {
    facts?: { text: string; provenance: 'verified' | 'observed' | 'inferred'; source?: string }[] | undefined;
    world?: import('@server/conversation/frame.js').ResponseFrame['world'] | null | undefined;
    peopleContext?: string[] | undefined;
    acceptedJobIds?: string[] | undefined;
    verifiedOutcomeIds?: string[] | undefined;
    activeWork?: import('@server/conversation/frame.js').ResponseFrame['activeWork'] | undefined;
    uncertainties?: string[] | undefined;
    stylePreferences?: import('@server/conversation/frame.js').ResponseFrame['stylePreferences'] | undefined;
    viewIntent?: import('@server/conversation/frame.js').ResponseFrame['viewIntent'] | undefined;
  } | undefined;
  learn?: LearnOptions | undefined;
  update?: UpdateOptions | undefined;
  persist?: PersistOptions | undefined;
}

interface StageOutcome<O> {
  trace: StageTrace;
  output: O | undefined;
}

/**
 * What one full cycle produced: the record, and everything true about the cycle
 * that is not part of the record.
 *
 * The advanced-module reports are the second kind. They are not on `CycleRecord`
 * because that type is what gets persisted, projected and replayed, and a field
 * that is empty on every cycle where the modules are switched off would invite
 * exactly the reading this codebase keeps deleting — a shape that looks like it
 * carries something. Internal to the runtime; `observed` unpacks it.
 */
interface CycleOutcome {
  record: CycleRecord;
  advanced: AdvancedCognitiveExtension;
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
  private readonly conversations: ConversationRepository | undefined;
  private readonly transcript: TranscriptReader | undefined;
  private readonly understandOpts: UnderstandOptions;
  private readonly reasonOpts: ReasonOptions;
  private readonly decideOpts: DecideOptions;
  private readonly actOpts: ActOptions;
  /**
   * Who this runtime was built for — the shape only. Never handed to an
   * authorization gate as-is; `effectiveCaller` refreshes the three fields that
   * decide anything from stage 2's per-cycle read.
   */
  private readonly boundIdentity: Identity | undefined;
  private readonly verifyOpts: VerifyOptions;
  private readonly respondOpts: RespondOptions;
  /** Optional ResponseFrame source (B08.s2): world + people + verified/accepted ids wired from App. */
  private readonly frameOpts: NonNullable<CognitiveRuntimeOptions['frame']>;
  private readonly learnOpts: LearnOptions;
  private readonly updateOpts: UpdateOptions;
  private readonly persistOpts: PersistOptions;
  private readonly gate: CycleGate;
  private readonly onCycle:
    | ((record: CycleRecord, extras: { advanced: AdvancedCognitiveExtension }) => void)
    | undefined;
  private readonly advanced:
    | { registry: AdvancedModuleRegistry; flags: AdvancedModuleFlagMap }
    | undefined;

  constructor(options: CognitiveRuntimeOptions = {}) {
    this.db = options.db ?? getDatabase();
    this.identityRepo = options.identityRepo;
    this.eventBus = options.eventBus;
    this.memoryRetrieval = options.memoryRetrieval;
    this.conversations = options.conversations;
    this.transcript = options.transcript;
    this.understandOpts = options.understand ?? {};
    this.reasonOpts = options.reason ?? {};
    // Deliberately *not* `{...options.decide, identity: options.identity}`. The
    // caller these two stages authorize against is composed per cycle by
    // `effectiveCaller`, from stage 2's fresh read — see its note. Binding the
    // construction-time identity here is what made a permission revoked mid-call
    // invisible to the gate for the life of a voice socket.
    this.decideOpts = options.decide ?? {};
    this.actOpts = options.act ?? {};
    this.boundIdentity = options.identity;
    this.verifyOpts = {
      ...(options.verify ?? {}),
      // `this.db`, not `options.db`: stage 8's whole job is to re-read
      // authoritative state, and it reports "no database to re-read" when it has
      // none. A runtime constructed without an explicit database still has one
      // (the process-wide instance), and handing stage 8 `undefined` there would
      // make every verification fail for a reason that is not true.
      db: this.db,
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
    this.gate = options.gate ?? new CycleGate();
    this.onCycle = options.onCycle;
    this.frameOpts = (options.frame ?? {}) as NonNullable<CognitiveRuntimeOptions['frame']>;
    this.advanced = options.advanced;
  }

  async runCycle(stimulus: RawStimulus): Promise<CycleRecord> {
    if (stimulus.source === 'proactive') {
      // Loud on purpose. This path interrupts whatever she is doing for that
      // identity, and a proactive stimulus interrupting him is the one thing the
      // whole gate exists to prevent. `runIfIdle` is the method that means "only
      // if she is free".
      throw new Error(
        'A proactive stimulus must never interrupt an in-flight cycle; use runIfIdle instead.',
      );
    }
    const lease = await this.gate.claim(stimulus);
    let outcome: CycleOutcome;
    try {
      outcome = await this.execute(stimulus, lease);
    } finally {
      // An un-released lane never opens again, so this runs even if `execute`
      // throws in a way no stage fallback covered.
      lease.release();
    }
    return this.observed(outcome);
  }

  /**
   * Runs a cycle only if this identity has nothing in flight, and never
   * interrupts. Returns `null` when it was declined — nothing ran, and nothing
   * was written, so there is no record to return and none was created.
   *
   * This is how unprompted cognition asks for a turn (Build Book VII.3, and the
   * yielding half of VII.5). She defers to him by construction: most ticks of the
   * autonomic loop land here, and the ones that arrive mid-conversation get `null`
   * rather than a place in the queue.
   */
  async runIfIdle(stimulus: RawStimulus): Promise<CycleRecord | null> {
    const admission = await this.gate.tryClaim(stimulus);
    if (admission.kind === 'declined') return null;
    let outcome: CycleOutcome;
    try {
      outcome = await this.execute(stimulus, admission.lease);
    } finally {
      admission.lease.release();
    }
    return this.observed(outcome);
  }

  /**
   * Hands a finished record to the observer, and returns it unchanged.
   *
   * Notified after the lease is released, so an observer cannot hold her lane, and
   * wrapped because a reader that throws must not turn a cycle that committed into
   * one that reports as failed to its caller. The rows are already written by the
   * time this runs; the only thing a throw here could still break is the truth of
   * what the caller is told.
   */
  private observed(outcome: CycleOutcome): CycleRecord {
    try {
      this.onCycle?.(outcome.record, { advanced: outcome.advanced });
    } catch {
      // Intentionally ignored — see doc comment.
    }
    return outcome.record;
  }

  /**
   * The twelve stages, once, under a lease.
   *
   * Cancellation is checked *after* each stage rather than inside one: this is a
   * single thread and a running stage cannot be preempted, and VII.5 requires
   * exactly that an in-flight ACT be allowed to finish. So an interruption stops
   * the cycle from taking further steps, and never from recording the ones it
   * already took — stage 8 still verifies whatever stage 7 did, and stage 12
   * always commits.
   */
  private async execute(stimulus: RawStimulus, lease: CycleLease): Promise<CycleOutcome> {
    const cycleId = lease.cycleId;
    const startedAt = lease.startedAt;

    // Resolved once, before anything else, and then carried on the stimulus
    // itself.
    //
    // It used to be resolved inside `createCycleRecord` and thrown away: the
    // `cycle_record` row pointed at a real conversation while the stimulus every
    // stage saw still had `conversationId: undefined`, and the record this
    // method returned said `'unknown'`. So stage 10 wrote
    // `sourceConversationId: 'unknown'` into the provenance of everything it
    // learned, and stage 3 had no conversation to read a transcript from.
    // Resolving once and threading it fixes all three.
    const conversationId = this.resolveConversationId(stimulus);
    const situated: RawStimulus = { ...stimulus, conversationId };

    const cycleRecord = await this.createCycleRecord(cycleId, situated, conversationId, startedAt);

    const stages: StageTrace[] = [];

    /** Set once, the first time a boundary finds the lease displaced. */
    let interruption: InterruptionCause | undefined;

    const moduleNotes: AdvancedCycleNote[] = [];
    let moduleSuccesses = 0;
    let moduleErrors = 0;

    /**
     * The advanced modules that hook one stage, run once that stage is done.
     *
     * Ordering is the whole design here, and it is two constraints at once:
     *
     *  - **After the stage.** A module is a faculty, not an authority (Part XX.2,
     *    and `server/advanced/types.ts`). Running it before the stage would let its
     *    return value or its writes decide what the stage produces, which is the one
     *    thing the contract forbids. It sees the same input the stage saw — the same
     *    value `runStage` recorded on the trace.
     *  - **Before the next stage.** This is what running in-cycle buys. Emotion
     *    reading at stage 2 writes a persona override; stage 9 resolves her register
     *    later in this same cycle and finds it. Under the deleted after-the-cycle
     *    mechanism that write landed after the cycle had already spoken, so she
     *    answered in the register of the *previous* turn — permanently one turn
     *    behind.
     *
     * `hooksStage` first, so a runtime with no advanced modules pays one map walk
     * per stage and builds nothing. The `try` is belt-and-braces: `registry.run`
     * catches module throws itself, so reaching this handler means the dispatcher
     * broke, and a broken dispatcher must still not cost her the cycle.
     */
    const runModules = async (stage: StageNumber, input: unknown): Promise<void> => {
      const wired = this.advanced;
      if (wired === undefined) return;
      if (!wired.registry.hooksStage(stage, wired.flags)) return;

      const context = {
        identityId: stimulus.identityId,
        conversationId,
        cycleId,
        stageNumber: stage,
      };

      try {
        const { results, errors } = await wired.registry.run(input, stage, context, wired.flags);
        moduleSuccesses += results.length;
        moduleErrors += errors.length;
        if (results.length > 0 || errors.length > 0) {
          moduleNotes.push({ stage, results, errors });
        }
      } catch (err: unknown) {
        moduleErrors += 1;
        moduleNotes.push({
          stage,
          results: [],
          errors: [{ moduleId: 'registry', message: err instanceof Error ? err.message : String(err) }],
        });
      }
    };

    /**
     * One stage, unless the cycle has already been displaced — in which case it
     * is skipped, no trace is pushed, and the caller's fallback stands. That the
     * trace list is short is the record of where the cycle stopped.
     */
    const step = async <O>(
      stage: StageNumber,
      stageName: string,
      input: unknown,
      // `Promise<O> | O`, matching `runStage`: stages 1 and 2 are synchronous, and
      // requiring a promise here would only force two pointless `async` wrappers.
      handler: () => Promise<O> | O,
      fallback: O,
    ): Promise<O> => {
      if (interruption) return fallback;
      const outcome = await this.runStage<O>(stage, stageName, input, handler);
      stages.push(outcome.trace);
      await this.announceStage(cycleId, stimulus.identityId, outcome.trace);
      await runModules(stage, input);
      if (interruption === undefined && lease.signal.aborted) {
        interruption = lease.interruptedBy();
      }
      return outcome.output ?? fallback;
    };

    // ── Stages 1-6: real implementations (P08) ──

    const perceived = await step<RawStimulus>(
      1,
      'PERCEIVE',
      situated,
      () => perceive(situated),
      situated,
    );

    const identified = await step<IdentifiedStimulus>(
      2,
      'IDENTIFY',
      perceived,
      () => identify(perceived, this.identityRepo),
      identify(perceived),
    );

    const recalled = await step<RecalledContext>(
      3,
      'RECALL',
      identified,
      () => recall(identified, this.memoryRetrieval, this.transcript),
      emptyContext(identified),
    );

    const understanding = await step<UnderstandingProposal>(
      4,
      'UNDERSTAND',
      recalled,
      () => understand(recalled, this.understandOpts),
      DEFAULT_UNDERSTANDING,
    );

    const reasoning = await step<ReasoningTraceProposal>(
      5,
      'REASON',
      { understanding },
      () => reason(recalled, understanding, this.reasonOpts),
      DEFAULT_REASONING,
    );

    // The caller both gates authorize against, as of *this* cycle rather than as of
    // the runtime's construction. One composition, shared by stages 6 and 7, so the
    // two cannot drift into disagreeing about who is asking.
    const caller = effectiveCaller(identified, this.boundIdentity);

    const authorizedDecision = await step<AuthorizedDecision>(
      6,
      'DECIDE',
      { reasoning },
      () => decide(reasoning, identified, { ...this.decideOpts, identity: caller }),
      DEFAULT_DECISION,
    );

    // ── Stages 7-9: real implementations (P09) ──

    const actionResults = await step<ActionResult[]>(
      7,
      'ACT',
      authorizedDecision,
      () => act(authorizedDecision, { ...this.actOpts, cycleId, identity: caller }),
      [],
    );

    // The one stage an interruption may not skip. If stage 7 touched the world,
    // whether it worked is a fact about the world now, and abandoning the cycle
    // without re-reading it would leave an unverified action in the record
    // forever — VII.5's "allowed to complete its verify/persist/rollback".
    const mustVerify = actionResults.length > 0;
    const r8 =
      mustVerify || !interruption
        ? await this.runStage<VerificationReport>(8, 'VERIFY', actionResults, () =>
            verify(actionResults, { ...this.verifyOpts, cycleId }),
          )
        : undefined;
    if (r8) stages.push(r8.trace);
    if (r8) await this.announceStage(cycleId, stimulus.identityId, r8.trace);
    // Stage 8 bypasses `step`, so its module pass has to be asked for by hand. It
    // is here rather than omitted because no module hooks stage 8 *today*: leaving
    // the gap would mean a module that declared `hooks: [8]` tomorrow would be
    // registered, flagged, counted as enabled, and never once called.
    if (r8) await runModules(8, actionResults);
    const verification = r8?.output;

    const verifiedResults = verification?.results ?? actionResults;

    // ── B08.s2 ResponseFrame: built between VERIFY and RESPOND, so stage 9
    // writes from verified facts + world snapshot rather than guesses. When
    // `frameOpts` is absent (tests without env, early slices) the frame is null
    // and prompts render without the block — no wording changes.
    const verifiedOutcomeIds = verifiedResults
      .filter((r) => r.verified)
      .map((r) => r.toolId)
      // stable dedup: coordinator-style work may later emit `work.create:uuid`
      // ids; toolId carries the outcome provenance for grounding. Kept minimal
      // per B08.s2 — no synthetic job ids invented here.
      .filter((v, i, a) => a.indexOf(v) === i);
    const acceptedJobIds = actionResults
      .filter((r) => r.attempted && !r.verified)
      .map((r) => r.toolId)
      .filter((v, i, a) => a.indexOf(v) === i);
    const frame = buildResponseFrameForCycle({
      cycleId,
      recalled,
      verification,
      verifiedOutcomeIds,
      acceptedJobIds,
      activeWork: verifiedOutcomeIds.length === 0 ? acceptedJobIds.map((id) => ({ id, status: 'accepted' })) : [],
      frameOpts: this.frameOpts,
    });

    // Stage 9 records its disclosure decisions into the cycle's audit buffer.
    // Stage 12 (P10) flushes them to `audit_log` together with the rest of the
    // cycle artifacts in one transaction.
    const audit = new CycleAuditBuffer();
    const response = await step<AuthorizedResponse | undefined>(
      9,
      'RESPOND',
      { recalled, actionResults: verifiedResults, verification },
      () =>
        respond(recalled, authorizedDecision, verifiedResults, verification, {
          ...this.respondOpts,
          audit,
          ...(frame !== null ? { frame } : {}),
        }),
      undefined,
    );

    // A drafting faculty that threw must not cost her the turn.
    //
    // Stage 9's fallback is deliberately not passed to `step` as its fifth
    // argument, because that value is also what an *interrupted* cycle returns —
    // and a cycle displaced by a newer one has no business speaking. So the
    // fallback is built here instead, under both conditions that make it honest:
    // stage 9 actually failed, and the cycle was not displaced.
    //
    // The trace keeps the error either way, so this cannot turn a degraded cycle
    // into a clean one. See `fallbackResponse` for why silence was the wrong
    // reading of the honesty contract.
    const respondFailed = stages.some((s) => s.stage === 9 && s.error !== undefined);
    const answer =
      response ??
      (respondFailed && interruption === undefined
        ? fallbackResponse(recalled, authorizedDecision, verifiedResults, verification, {
            ...this.respondOpts,
            audit,
          })
        : undefined);

    // ── Stages 10-12: real implementations (P10) ──

    const learningDelta = await step<AuthorizedLearningDelta | undefined>(
      10,
      'LEARN',
      answer,
      () =>
        learn(
          recalled,
          authorizedDecision,
          answer ?? DEFAULT_RESPONSE,
          verifiedResults,
          verification,
          // The owner's name is read here rather than held on the runtime because he can
          // rename himself between cycles, and the guest quarantine keys on the name he
          // is enrolled under right now.
          { ...this.learnOpts, cycleId, ownerName: this.identityRepo?.getOwner()?.displayName },
        ),
      undefined,
    );

    const updateResult = await step<UpdateResult | undefined>(
      11,
      'UPDATE',
      learningDelta,
      () => update(learningDelta, this.updateOpts),
      undefined,
    );

    const completedAt = Date.now();

    // A stage that threw was replaced by its documented fallback, so the cycle
    // still produced a response — but reporting it as a clean 'completed' would
    // be a claim the traces contradict. Derive the status from the traces.
    //
    // An interruption outranks both: the cycle did not finish, and whether a
    // stage also happened to fail on the way out does not change that.
    const failedStages = stages.filter((s) => s.error !== undefined);
    const cycleStatus: CycleStatus = interruption
      ? 'interrupted'
      : failedStages.length > 0
        ? 'degraded'
        : 'completed';
    const stageErrors =
      failedStages.length > 0
        ? failedStages.map((s) => `${s.stageName}: ${s.error ?? 'unknown error'}`).join('; ')
        : undefined;
    const cycleError = interruption
      ? [
          `Interrupted after ${stages.length} stage(s) by ${interruption.bySource} cycle ${interruption.byCycleId}`,
          stageErrors,
        ]
          .filter(Boolean)
          .join('; ')
      : stageErrors;

    const persistInput: PersistInput = {
      cycleId,
      status: cycleStatus,
      error: cycleError,
      completedAt,
      startedAt,
      identityId: stimulus.identityId,
      conversationId,
      turns: transcriptTurns({
        stimulus: situated,
        cycleId,
        response: answer,
        startedAt,
        completedAt,
      }),
      actionResults: verifiedResults,
      decision: authorizedDecision,
      response: answer,
      learningDelta,
      updateResult,
      audit: audit.drain(),
      interruption,
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

    // The stage-12 module pass, deliberately *after* the commit and after the
    // flush. A module hooking 12 is asking to work on what the cycle made durable
    // — dream consolidation folds duplicate recollections, and the rows this cycle
    // learned are only visible, and only safely touchable, once the transaction
    // that wrote them has closed. Running it before the commit would have it fold a
    // row `persist` was still about to write.
    await runModules(12, updateResult);

    // Stage 12 runs after the status above was computed. If persistence itself
    // threw, nothing durable was written and the cycle genuinely failed.
    const persistFailed = r12.trace.error !== undefined;
    const finalStatus: CycleStatus = persistFailed ? 'failed' : cycleStatus;
    const finalError = persistFailed
      ? [cycleError, `PERSIST: ${r12.trace.error ?? 'unknown error'}`].filter(Boolean).join('; ')
      : cycleError;

    if (persistFailed) {
      // The status column still reads whatever `persist` last committed (or
      // 'running' if it never got that far). Correct it out-of-band so the row
      // does not outlive the process claiming success.
      this.recordCycleFailure(cycleId, finalError ?? 'persist failed', completedAt);
    }

    return {
      record: {
        ...cycleRecord,
        status: finalStatus,
        error: finalError,
        completedAt,
        stages,
        // What she proposed, which is only the same thing as what was authorized
        // when nothing was refused. On a refusal `proposal` holds the fallback, so
        // reading it here recorded a `clarify` she never proposed.
        proposedDecision: authorizedDecision.refusedProposal ?? authorizedDecision.proposal,
        authorizedDecision,
        actionResults: verifiedResults,
        response: answer,
        learningDelta,
      },
      advanced: {
        notes: moduleNotes,
        successCount: moduleSuccesses,
        errorCount: moduleErrors,
      },
    };
  }

  /**
   * Best-effort correction of a cycle row when stage 12 itself threw. Runs
   * outside any transaction and swallows its own errors — if the database is
   * unreachable there is nothing further this can do, and throwing here would
   * mask the original persistence error from the caller.
   */
  private recordCycleFailure(cycleId: string, error: string, completedAt: number): void {
    try {
      this.db.raw
        .prepare(
          `UPDATE cycle_record
              SET status = 'failed', completed_at = ?, error = ?
            WHERE id = ?`,
        )
        .run(new Date(completedAt).toISOString(), error, cycleId);
    } catch {
      // Intentionally ignored — see doc comment.
    }
  }

  /**
   * Says that one stage of twelve is done, while the cycle is still running.
   *
   * `cycle.stage.completed` was a declared event type with no publisher, and the
   * absence was visible in the interface: `RuntimeState.cognitive.currentStage`
   * could only ever change when a whole cycle ended, so `src/visual/mood.ts` gave
   * every thought she has ever had the same energy and `doingWords` described all
   * of them with the same word. Eleven small events per cycle is what buys a
   * two-second thought that visibly moves.
   *
   * Published for stages 1-11 only. Stage 12 announces itself by publishing the
   * cycle's terminal event, and stage 12's own trace is not written until after
   * that event — so a `cycle.stage.completed` for `PERSIST` would have to arrive
   * after `cycle.completed`, and "completed is always last" is part of the replay
   * contract in `stages/12.ts`.
   *
   * `ok: false` still counts as completed: a stage that threw is a stage the
   * runtime is finished with, and the fallback it substituted is what the next
   * stage receives. Silence would leave the interface showing her stuck on a stage
   * she has already left.
   */
  private async announceStage(
    cycleId: string,
    identityId: string,
    trace: StageTrace,
  ): Promise<void> {
    if (!this.eventBus) return;
    // `completedAt` is optional on `StageTrace` because a trace can exist for a
    // stage that is still running. One that reached here cannot be: `runStage`
    // stamps it in a `finally`. The fallback keeps the type honest without
    // inventing a duration.
    const endedAt = trace.completedAt ?? trace.startedAt;
    await this.eventBus.publish({
      type: 'cycle.stage.completed',
      payload: {
        stage: trace.stageName,
        index: trace.stage,
        ok: trace.error === undefined,
        durationMs: endedAt - trace.startedAt,
      },
      identityId,
      cycleId,
      timestamp: endedAt,
      correlationId: cycleId,
      version: 1,
    });
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

  /**
   * The conversation this cycle belongs to.
   *
   * `cycle_record.conversation_id` is a foreign key, and the previous fallback
   * for a stimulus that carried no conversation was the string `'unknown'` — a
   * value that can never satisfy that key. So a cycle without a conversation id
   * did not degrade, it threw on its first insert, and nothing in `server/`
   * created a conversation for it to point at.
   *
   * Now: an id that is supplied is honoured (and opened if the caller invented
   * it), and an absent one opens or continues the caller's conversation. With no
   * repository injected there is nothing that could honestly be inserted, so
   * that says what is missing instead of failing on a constraint three frames
   * later.
   */
  private resolveConversationId(stimulus: RawStimulus): string {
    if (stimulus.conversationId !== undefined && stimulus.conversationId !== '') {
      return this.conversations
        ? this.conversations.ensure(stimulus.conversationId, stimulus.identityId)
        : stimulus.conversationId;
    }
    if (!this.conversations) {
      throw new Error(
        'runCycle() was given a stimulus with no conversationId and the runtime has no ' +
          'ConversationRepository to open one with. Pass `conversations` when constructing ' +
          'CognitiveRuntime, or set conversationId on the stimulus.',
      );
    }
    return this.conversations.openOrContinue(
      stimulus.identityId,
      stimulus.source === 'audio' ? 'voice' : 'text',
    ).id;
  }

  private async createCycleRecord(
    id: string,
    stimulus: RawStimulus,
    conversationId: string,
    startedAt: number,
  ): Promise<CycleRecord> {
    this.db.raw
      .prepare(
        `INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(
        id,
        conversationId,
        new Date(startedAt).toISOString(),
        JSON.stringify(stimulus),
      );

    // Announce the start. Stage 12 publishes the terminal event
    // (`cycle.completed` / `cycle.degraded` / `cycle.failed`), but nothing
    // published the opening one, so `cycle.started` sat declared and unused and
    // a subscriber could only ever learn about a cycle after it was over —
    // which is no use at all to anything that wants to show that she is
    // thinking while she is thinking.
    if (this.eventBus) {
      await this.eventBus.publish({
        type: 'cycle.started',
        payload: {
          cycleId: id,
          conversationId,
          source: stimulus.source,
        },
        identityId: stimulus.identityId,
        cycleId: id,
        timestamp: startedAt,
        causationId: undefined,
        correlationId: id,
        version: 1,
      });
    }

    return {
      id,
      identityId: stimulus.identityId,
      // The resolved conversation, not `stimulus.conversationId ?? 'unknown'`.
      // The caller is told which thread this cycle is in, which is also the
      // thread its transcript was written to.
      conversationId,
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
  // `unavailable`, not `denied`: the stage threw before the authz matrix was ever
  // consulted. There is also no `refusedProposal` — nothing was proposed to refuse.
  clearance: { kind: 'unavailable', reason: 'Decision stage failed before authorization' },
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

/**
 * The turns this cycle should add to the transcript.
 *
 * Two rules, both of them about not writing a line nobody said:
 *
 *   - The user's turn is written only when the stimulus actually carried text. A
 *     system trigger, a proactive wake-up or an audio stimulus with no
 *     transcript yet has nothing to quote, and serialising its payload into the
 *     transcript would put JSON in her mouth. When voice lands (P19) the
 *     transcript belongs in `payload.text` and this needs no change.
 *   - Her turn is written only when there is an authorized response with words in
 *     it. That used to mean "only when stage 9 did not throw", on the reasoning
 *     that recording a fallback would be a claim the traces contradict — but the
 *     effect was that one failed call to the provider made her ignore a person
 *     entirely, and a transcript with his question and no answer in it is not a
 *     more honest record, just a worse one. The runtime now builds stage 9's
 *     fallback when stage 9 fails (see `fallbackResponse`), so what is written is
 *     a line she really did emit, carrying `respond_stage_fallback` to say where
 *     it came from, in a cycle whose status is `degraded`. An interrupted cycle
 *     still writes nothing: it was displaced, and it has no answer to record.
 *     The text stored is the authorized one — post-redaction, what she actually
 *     said — never a draft.
 *
 * The timestamps are the cycle's own: the stimulus arrived when it arrived, and
 * the answer exists as of `completedAt`. Ordering never depends on them being
 * distinct (see `MessageRepository.recentForCaller`), but they are the honest
 * times, and `startedAt` is the fallback for a stimulus that carried none.
 */
function transcriptTurns(input: {
  stimulus: RawStimulus;
  cycleId: string;
  response: AuthorizedResponse | undefined;
  startedAt: number;
  completedAt: number;
}): TurnDraft[] {
  const turns: TurnDraft[] = [];

  const said = textOf(input.stimulus.payload);
  const role = incomingRole(input.stimulus.source);
  if (said.trim() !== '' && role !== undefined) {
    turns.push({
      role,
      text: said,
      timestamp: input.stimulus.receivedAt || input.startedAt,
      metadata: { cycleId: input.cycleId, source: input.stimulus.source },
    });
  }

  const answered = input.response?.text ?? '';
  if (answered.trim() !== '') {
    turns.push({
      role: 'assistant',
      text: answered,
      timestamp: input.completedAt,
      metadata: {
        cycleId: input.cycleId,
        redacted: input.response?.redacted ?? false,
        disclosuresApplied: input.response?.disclosuresApplied ?? [],
      },
    });
  }

  return turns;
}

/** The text a stimulus carried, if it carried any. */
function textOf(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const text = (payload as { text?: unknown }).text;
    if (typeof text === 'string') return text;
  }
  return '';
}

/**
 * Whose turn the *incoming* half of a cycle is, or `undefined` for no turn at all.
 *
 * `role: 'user'` in `message` is a claim that the person said this, so it may only
 * be written when a person did. The four stimulus sources do not all mean that:
 *
 *  - `text` / `audio` — he spoke. His turn.
 *  - `system` — something happened. `MessageRole` has a `'system'` slot for
 *    exactly this, and using it keeps the event in the transcript without
 *    attributing it to him.
 *  - `proactive` — *nobody* said anything. The payload is the seed her own
 *    noticing produced ("a reminder you set has come due"), and writing it as a
 *    user turn was putting her internal prompt in his mouth: the transcript would
 *    show him asking to be reminded at the moment the reminder fired, stage 3
 *    would recall it as something he said, and stage 10 could learn a preference
 *    from a sentence he never uttered. So an unprompted cycle contributes one turn
 *    — hers.
 */
function incomingRole(source: RawStimulus['source']): 'user' | 'system' | undefined {
  switch (source) {
    case 'text':
    case 'audio':
      return 'user';
    case 'system':
      return 'system';
    case 'proactive':
      return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null';
  } catch {
    return '"[unserializable]"';
  }
}
