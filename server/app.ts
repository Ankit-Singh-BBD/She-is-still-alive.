/**
 * The composition root.
 *
 * Every subsystem in `server/` is written to be constructed with its
 * dependencies passed in. That is what makes them testable, and it is also why
 * none of them can start themselves. This file is the one place that knows the
 * whole graph: it opens the database, migrates it, builds each subsystem in
 * dependency order, and starts the loops that make her run when nobody is
 * talking to her.
 *
 * Three rules govern it.
 *
 *  1. **One database.** It is opened here, migrated here, and installed as the
 *     process-wide instance here. Any subsystem constructed later without an
 *     explicit `db` finds this one rather than opening an empty second copy.
 *
 *  2. **Nothing is faked to make boot succeed.** Where a dependency does not
 *     exist yet, the app boots without that faculty and says so, rather than
 *     substituting a stub that would report itself working. An absent language
 *     model, an empty tool registry and an unenrolled owner are all supported
 *     states.
 *
 *  3. **`start()` and `stop()` are symmetric.** Whatever `start()` begins,
 *     `stop()` ends, in reverse order, so a test can boot and shut down the
 *     real application without leaking a timer or a file handle.
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import type { Config } from '@server/config/env.js';
import { loadConfig } from '@server/config/env.js';
import { Database, setDatabase, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { AuditLogService } from '@server/security/audit.js';
import { EventBus } from '@server/events/event-bus.js';
import type { PersistedDomainEvent } from '@server/events/types.js';
import { IdentityRepository } from '@server/identity/repository.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import { MemoryCorrections } from '@server/memory/corrections.js';
import { ConversationRepository } from '@server/conversations/repository.js';
import { MessageRepository } from '@server/conversations/messages.js';
import { EnvironmentService, WEATHER_TTL_MS } from '@server/environment/index.js';
import type { WeatherProvider } from '@server/environment/index.js';
import { ToolRegistry } from '@server/actions/registry.js';
import { ActionPipeline } from '@server/actions/pipeline.js';
import {
  ToolVerifierRegistry,
  PipelineToolExecutor,
  installCoreTools,
  clearanceLookup,
  toolRoster,
} from '@server/tools/index.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { CycleGate } from '@server/cognition/gate.js';
import { TaskExecutor } from '@server/tasks/executor.js';
import { LoopManager } from '@server/loops/manager.js';
import { ProactiveEngine } from '@server/proactive/engine.js';
import { AutonomicLoop, Noticing } from '@server/autonomic/index.js';
import type { TickReport } from '@server/autonomic/index.js';
import { PersonalityRegistry } from '@server/personality/registry.js';
import { PersonalityEngine } from '@server/personality/engine.js';
import { PersonalityService, timeOfDayDeltas } from '@server/personality/index.js';
import {
  createDefaultAdvancedModuleRegistry,
  type AdvancedModuleFlagMap,
} from '@server/advanced/index.js';
import { LearningPipeline } from '@server/learning/pipeline.js';
import { ConsolidationSweep } from '@server/learning/consolidation.js';
import type { ConsolidationPassReport } from '@server/learning/consolidation.js';
import { createLearningExtractor, knownMemoryLookupFrom } from '@server/learning/extractor.js';
import { createIntentRecognizer } from '@server/cognition/intent/index.js';
import { createLanguageFaculties } from '@server/llm/index.js';
import type { LanguageFaculties, LanguageModel } from '@server/llm/index.js';
import { WorldModel } from '@server/world/model.js';
import { FacultyRouter } from '@server/llm/router.js';
import { LocalFacultyProvider } from '@server/llm/local.js';
import { LanguageModelFaculty } from '@server/llm/provider.js';
import type { FacultyRole } from '@server/llm/provider.js';
import { GeminiLanguageModel, createGeminiTransport } from '@server/llm/gemini.js';
import { TokenBudgetManager } from '@server/cognition/budgets.js';
import {
  createGeminiLiveTransportFactory,
  RENDERER_INSTRUCTION,
  type VoiceEar,
} from '@server/voice/live/index.js';
import { createEncryptedBackup } from '@server/backup/backup.js';
import type { BackupManifest } from '@server/backup/backup.js';
import { seedOrigin } from '@server/origin/index.js';
import type { OriginSeedReport } from '@server/origin/index.js';
import type { Identity } from '@server/identity/types.js';
import { RealtimeFlow } from '@server/realtime/flow.js';
import { RuntimeStateProjector } from '@server/http/state.js';
import { RateLimiter } from '@server/http/rate-limit.js';
import { devOrigins } from '@server/http/server.js';
import { VOICE_PATH } from '@server/http/ws.js';
import type { RouteDeps } from '@server/http/deps.js';

/** Where the numbered migration files live, resolved relative to this module. */
const MIGRATIONS_DIR = fileURLToPath(new URL('./persistence/migrations', import.meta.url));

/**
 * The three rate limits, and why they are three rather than one.
 *
 * They guard different things and are keyed differently, so a single limiter
 * would have to pick one victim: keyed by IP it would let one person's burst
 * throttle everyone behind the same address, and keyed by identity it could not
 * guard the login route at all, because a request that has not authenticated yet
 * has no identity to key by.
 *
 *  - `CREDENTIAL` is keyed by socket address and guards `POST /api/bootstrap` and
 *    `POST /api/session`. It is *not* the lockout — `IdentityRepository` already
 *    counts failed passphrase attempts and locks the account after five. This is
 *    the layer in front of that: the lockout costs a scrypt hash per attempt
 *    (N=16384), so an unthrottled attacker can spend the CPU of this process
 *    without ever getting past five guesses. Both routes call `forget()` on
 *    success, so a person who mistypes twice and then succeeds keeps nothing.
 *
 *  - `AUTHENTICATED` is keyed by identity id and guards everything else. Loose
 *    enough that no real client notices; tight enough that a runaway loop in the
 *    browser cannot spin the server.
 *
 *  - `CYCLE` is keyed by identity id and guards `POST /api/chat` alone, which is
 *    the request that may call a language model, execute a tool and write
 *    memories. Twenty a minute is more than anyone types and few enough that a
 *    stuck client cannot spend an API quota.
 */
const CREDENTIAL_LIMIT = { limit: 10, windowMs: 60_000 } as const;
const AUTHENTICATED_LIMIT = { limit: 300, windowMs: 60_000 } as const;
const CYCLE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export interface AppOptions {
  /** Defaults to `loadConfig()` — the real environment. */
  config?: Config;
  /**
   * A database to use instead of opening one from `config.database.path`.
   * Tests pass an in-memory database; it is migrated here either way, so a
   * caller does not have to remember to.
   */
  db?: Database;
  /**
   * Whether to install the database as the process-wide instance. True by
   * default, and only ever false for a test that wants two isolated apps in
   * one process — where the second `setDatabase` would rightly be refused.
   */
  installGlobalDatabase?: boolean;
  /**
   * A language model to use instead of the real Gemini transport.
   *
   * The seam that lets a test drive the *real* faculty adapters — the prompts,
   * the schemas, the Zod parse, the failure translation — with no API key and no
   * network. Absent in production, where `config.llm` decides.
   */
  languageModel?: LanguageModel;
  /**
   * A weather provider to use instead of Open-Meteo.
   *
   * Same seam as `languageModel`, for the same reason: it lets a test exercise
   * the real `EnvironmentService` — the TTL, the stale-reading rule, the
   * `environment.changed` publish — with no network.
   */
  weatherProvider?: WeatherProvider;
}

/** What the app decided at boot, for the banner and for tests to assert on. */
export interface BootReport {
  /** Audit rows written before the chain migration that this boot chained. */
  auditRowsChained: number;
  /**
   * Cycles left `running` by a process that died mid-thought, closed by this
   * boot. Zero after a clean shutdown, which is the normal case.
   */
  cyclesReconciled: number;
  /**
   * Events replayed into `RuntimeStateProjector` to rebuild `presence`, `voice`
   * and `cognitive` (Book VI.6). Zero on a fresh database.
   */
  eventsReplayed: number;
  /** Registered tool ids, in registration order. */
  tools: readonly string[];
  /** Whether an owner identity exists. False on a fresh database. */
  ownerEnrolled: boolean;
  /** Background loops that are now running. */
  started: readonly string[];
  /**
   * Faculties that are not available in this configuration, each with the
   * reason. Printed at boot so the operator is never guessing.
   */
  absent: readonly string[];
}

export interface MadhuritaApp {
  readonly config: Config;
  readonly db: Database;
  readonly audit: AuditLogService;
  readonly eventBus: EventBus;
  readonly identityRepo: IdentityRepository;
  readonly memoryRepo: MemoryRepository;
  readonly memoryRetrieval: MemoryRetrieval;
  /**
   * Corrections (B09.s1). Holds the bus and the retrieval it must invalidate, so
   * a correction made anywhere in the process is durable, heard, and cannot be
   * answered around from a cache computed before it.
   */
  readonly memoryCorrections: MemoryCorrections;
  readonly conversations: ConversationRepository;
  /**
   * The conversation's turns. Written by stage 12 inside the cycle's own
   * transaction and read by stage 3, which is what gives her more than one turn
   * of memory of the exchange she is actually in.
   */
  readonly messages: MessageRepository;
  readonly registry: ToolRegistry;
  readonly pipeline: ActionPipeline;
  /**
   * The postconditions that prove a tool did what it said. Shared by the
   * pipeline's VERIFY stage and cognitive stage 8.
   */
  readonly verifiers: ToolVerifierRegistry;
  /** Stage 7's seam to the pipeline. */
  readonly toolExecutor: PipelineToolExecutor;
  readonly taskExecutor: TaskExecutor;
  readonly loopManager: LoopManager;
  readonly proactive: ProactiveEngine;
  /**
   * Her unprompted half: the sensors, and the heartbeat that gives them a turn.
   *
   * Exposed so a test can drive one tick with `autonomic.tick()` instead of
   * waiting for the timer, and so an operator can read `autonomic.report()` to
   * see what the last tick actually did — noticed, authorized, spoken, yielded.
   */
  readonly autonomic: AutonomicLoop;
  /**
   * The sensors on their own, without the heartbeat.
   *
   * Exposed because "what does she notice about the state right now" is a
   * question worth being able to ask — of a test, and of an operator — without
   * running a cycle and speaking the answer.
   */
  readonly noticing: Noticing;
  /** The last autonomic tick, or `undefined` before the first one. */
  autonomicReport(): TickReport | undefined;
  /**
   * How she sounds, per caller.
   *
   * `PersonalityService` rather than the bare `PersonalityEngine` this used to be.
   * The engine was constructed here and read by nothing — a `new` with no reader,
   * which is the same defect as a status nothing writes. The service is what the
   * two consumers actually need: `instructionFor` for the model's system
   * instruction, `profileFor` for stage 9's choice between sentences it already
   * has.
   *
   * Exposed because "what register is she in for this person, and why" is worth
   * being able to ask — `profileFor(id).sources` names the signals currently
   * shaping it.
   */
  readonly personality: PersonalityService;
  /**
   * Where she is and what the sky is doing.
   *
   * Refreshed on a timer only when there are coordinates to ask about — no
   * configured location and no client report means no request, and a snapshot
   * that says so. `environment.changed` is published from here; before this it
   * was a declared event type nothing in the repository ever emitted.
   */
  readonly environment: EnvironmentService;
  /**
   * The out-of-band learner, for a cycle that has already been recorded.
   *
   * Separate from stages 10 and 11, which learn during the cycle. It declines a
   * cycle that already wrote memories, so the two paths cannot both keep the
   * same fact.
   */
  readonly learning: LearningPipeline;
  /**
   * The sweep that calls `learning.processCycle`, started under `FLAG_LEARNING`.
   *
   * Exposed so a test can drive one pass with `pass()` rather than wait for the
   * timer, and so an operator can ask where consolidation has read to.
   */
  readonly consolidation: ConsolidationSweep;
  /** The last consolidation pass, or `undefined` before the first one. */
  consolidationReport(): ConsolidationPassReport | undefined;
  /**
   * The language faculty, or `undefined` when none is configured.
   *
   * `undefined` is a supported way to run, not a broken one: stages 4-6, 9 and
   * 10 each carry a deterministic fallback, and the boot report says which
   * configuration this is.
   */
  readonly faculties: LanguageFaculties | undefined;
  readonly facultyRouter: FacultyRouter | undefined;
  readonly worldModel: WorldModel;

  /**
   * The live model as an ear and a mouth, or `undefined` when she is text-only.
   *
   * Passed to `attachVoiceGateway` by `server/main.ts`, which is the only thing
   * that has an `http.Server` to attach to. Exposed rather than attached here
   * because construction must not need a listener: a test builds the app, reads
   * `voiceEar`, and drives a `VoiceSession` over a fake channel with no socket
   * anywhere.
   *
   * `undefined` is a supported configuration, not a fault — `FLAG_VOICE` off or
   * no `GOOGLE_API_KEY`. The socket still opens, `ready.canHear` says `false`,
   * and `say` still runs the twelve stages.
   */
  readonly voiceEar: VoiceEar | undefined;

  /**
   * Reads the parts of `RuntimeState` that live in the database, and holds the
   * parts that live only in this process.
   *
   * Exposed because two callers need it and neither owns it: the realtime flow
   * projects through it on every event, and `GET /api/state` builds a one-shot
   * answer from it when the flow does not exist.
   */
  readonly projector: RuntimeStateProjector;

  /**
   * The realtime fan-out, or `undefined` when it cannot exist yet.
   *
   * A function rather than a field because it becomes possible partway through
   * the process's life: it needs an owner identity to build its first
   * `RuntimeState` from, and on a fresh database the owner is created by an HTTP
   * request. So this creates and starts the flow the first time it is asked with
   * an owner present, and returns the same one forever after.
   *
   * `undefined` is not a failure. With `FLAG_REALTIME` off it is the configured
   * answer, and before bootstrap it is the honest one — there is no state to
   * stream when there is nobody to stream it about.
   */
  realtime(): RealtimeFlow | undefined;

  /** The three request counters. See the constants at the top of this file. */
  readonly limits: RouteDeps['limits'];

  /**
   * The slice of this app the HTTP transport is allowed to see.
   *
   * Built here rather than in `server/main.ts` so that a test can drive the real
   * routes against a real database without reassembling the graph, and so that
   * the projector, the flow and the limiters have exactly one owner — the thing
   * whose `stop()` shuts them down.
   */
  readonly routeDeps: RouteDeps;

  /**
   * A cognitive runtime scoped to one caller.
   *
   * Stages 6 (DECIDE) and 7 (ACT) authorize against the identity they were
   * constructed with, and refuse when there is none. So a runtime is built per
   * caller rather than once per process — an app-wide runtime would either
   * carry no identity and be unable to act, or carry someone else's.
   */
  runtimeFor(identity: Identity): CognitiveRuntime;

  /**
   * Takes an encrypted backup now.
   *
   * This needs the owner's passphrase because the encryption key is derived
   * from it, and the server stores only its hash. That is why there is no
   * unattended backup timer: honouring `BACKUP_ENABLED` on a schedule would
   * mean holding the passphrase in memory for the life of the process.
   */
  backupNow(ownerPassphrase: string): Promise<BackupManifest>;

  start(): Promise<BootReport>;
  stop(): Promise<void>;
  isRunning(): boolean;
  readonly bootReport: BootReport | undefined;
}

/**
 * Builds the application.
 *
 * Construction is separate from `start()`: this opens the database and wires
 * the graph, `start()` begins the background work. A test that only wants the
 * wiring can skip `start()` entirely and pay no timers for it.
 */
export function createApp(options: AppOptions = {}): MadhuritaApp {
  const config = options.config ?? loadConfig();

  // ── Persistence ──────────────────────────────────────────────────────────
  const db = options.db ?? new Database({ path: config.database.path });
  runMigrations(db, MIGRATIONS_DIR);
  if (options.installGlobalDatabase !== false) {
    setDatabase(db);
  }
  const ownsDatabase = options.db === undefined;

  // ── Audit, events, identity ──────────────────────────────────────────────
  const audit = new AuditLogService(db);
  const eventBus = new EventBus(db);
  const identityRepo = new IdentityRepository(db, eventBus);

  // ── Memory ───────────────────────────────────────────────────────────────
  const memoryRepo = new MemoryRepository(db);
  const memoryRetrieval = new MemoryRetrieval(memoryRepo);
  const memoryCorrections = new MemoryCorrections(db, { events: eventBus, retrieval: memoryRetrieval });
  const conversations = new ConversationRepository(db);
  const messages = new MessageRepository(db);

  // ── Action execution ─────────────────────────────────────────────────────
  //
  // One verifier registry serves both places that verify: the pipeline's own
  // VERIFY stage and cognitive stage 8. Two would eventually disagree, and an
  // `action_result` row reading `verified = 1` under a sentence saying the action
  // could not be confirmed is exactly the kind of split the honesty rule exists
  // to prevent.
  const registry = new ToolRegistry();
  const verifiers = new ToolVerifierRegistry();
  const pipeline = new ActionPipeline({ registry, db, eventBus, verifier: verifiers });

  // ── Scheduling ───────────────────────────────────────────────────────────
  const taskExecutor = new TaskExecutor(db, eventBus, {
    registry,
    pipeline,
    identityRepo,
    pollIntervalMs: config.intervals.taskSweepMs,
  });
  const loopManager = new LoopManager(db, eventBus, taskExecutor, {
    pollIntervalMs: config.intervals.loopSweepMs,
  });

  // ── Tools ────────────────────────────────────────────────────────────────
  //
  // Installed at construction rather than in `start()`, because `runtimeFor()`
  // is usable without starting the background loops and a runtime that could
  // reason its way to a tool call but not execute it would be a different
  // application depending on whether a timer was running.
  //
  // Order matters only in that the tools need the task executor, which needs the
  // pipeline, which needs the registry they install into.
  const tools = installCoreTools({
    registry,
    verifiers,
    memoryRepo,
    memoryRetrieval,
    taskExecutor,
    db,
  });
  const toolExecutor = new PipelineToolExecutor({ pipeline, identityRepo });
  const clearanceFor = clearanceLookup(registry);

  /**
   * How stage 6 chooses a tool when there is no model to choose one.
   *
   * Built over `tools` — the ids `installCoreTools` actually installed — so the
   * recogniser can only ever name something this process can run. It reads a time
   * and an imperative out of a sentence in Hinglish or English and proposes the
   * matching tool; everything it cannot read without guessing, it declines to
   * propose. See `server/cognition/intent/` for the two rules it holds to.
   */
  const intentRecognizer = createIntentRecognizer({ availableTools: tools });

  // ── Proactivity ──────────────────────────────────────────────────────────
  // Quiet hours come from configuration, not from the engine's defaults, so
  // that the window an operator set is the window she actually honours.
  const proactive = new ProactiveEngine({
    db,
    eventBus,
    identityRepo,
    options: {
      enabled: config.proactivity.enabled,
      quietHours: {
        startHour: config.proactivity.quietHoursStart,
        endHour: config.proactivity.quietHoursEnd,
      },
    },
  });

  // ── Autonomic layer ──────────────────────────────────────────────────────
  //
  // The half of her that runs when nobody is typing. Every piece of this existed
  // and none of it was connected: `ProactiveEngine` could judge an unprompted
  // thought, `runIfIdle` could run one, and nothing ever *proposed* one —
  // `runCycle` had exactly one caller in the repository and it was a test.
  //
  // `runtimeFor` and `publishError` are function declarations below, so they are
  // hoisted and the loop can be fully constructed here. `start()` only switches
  // it on.
  const noticing = new Noticing({ tasks: taskExecutor, loops: loopManager });

  const autonomic = new AutonomicLoop({
    noticing,
    proactive,
    // Resolved per tick, never captured: an owner who was suspended between
    // ticks must stop being spoken to, and on a fresh database there is nobody
    // to capture yet.
    owner: () => identityRepo.getOwner(),
    runtimeFor: (identity) => runtimeFor(identity),
    report: (where, error) => {
      void publishError(where, error);
    },
    // The same cadence the deferral sweep used, because this loop now *is* the
    // deferral sweep — see `start()`.
    tickMs: config.intervals.proactiveSweepMs,
  });

  // Reminders stop being discarded here.
  //
  // `TaskExecutor.executePayload` completed a reminder and returned when no
  // handler was registered, on the reasonable-sounding grounds that a missing
  // dispatcher is not the executor's fault. The effect was that every reminder he
  // ever set was marked delivered and never said. This is the dispatcher; it
  // returns whether she actually spoke, so an undelivered reminder retries
  // instead of being marked done.
  taskExecutor.setHandlers({
    onReminder: (identityId, message) => autonomic.deliverReminder(identityId, message),
  });

  // ── Personality ──────────────────────────────────────────────────────────
  //
  // The five internal flags move together, off one env switch. Partial
  // combinations — warmth on, formality off — are not deployment decisions anyone
  // makes; they are a matrix of states nobody would test. `FLAG_PERSONALITY`
  // answers the question an operator actually has: does she adapt how she speaks,
  // or does everyone get the same neutral register.
  const personalityFlags = {
    enablePersonalityModulation: config.flags.personality,
    enablePersonaOverride: config.flags.personality,
    enableVerbosityControl: config.flags.personality,
    enableFormalityControl: config.flags.personality,
    enableWarmthControl: config.flags.personality,
  };
  const personality = new PersonalityService({
    engine: new PersonalityEngine(new PersonalityRegistry()),
    flags: personalityFlags,
  });

  // ── Advanced faculties ───────────────────────────────────────────────────
  //
  // Built once for the process and handed to every runtime, because two of the
  // four hold state that must not be per-request: the reflection module's idea of
  // what it has already written, and the dream module's fold history. A registry
  // rebuilt per cycle would rediscover the same patterns forever.
  //
  // The flags come from config already `AND`ed with the master switch, so this map
  // is a straight rename with no logic in it — the decision was made in
  // `loadConfig` and is printed at boot.
  const advancedFlags: AdvancedModuleFlagMap = {
    enableEmotionReading: config.flags.emotionReading,
    enableRelationshipContext: config.flags.relationshipContext,
    enableLongHorizonReflection: config.flags.longHorizonReflection,
    enableDreamConsolidation: config.flags.dreamConsolidation,
  };
  const advancedRegistry = createDefaultAdvancedModuleRegistry({
    personality,
    memory: memoryRepo,
    // Dream consolidation is the one faculty whose effect nothing else would
    // notice. It folds rows *after* `cycle.completed` has been published, so the
    // memory counts in `RuntimeState` were recomputed a moment before those rows
    // left the default view — and during quiet hours the next cycle that would fix
    // them may be hours away. `memory.consolidated` is already routed to a recount
    // in `server/http/state.ts`; this is what gives it a publisher.
    eventBus,
    // The same window `ProactiveEngine` honours, from the same source. Dream
    // consolidation folds memories during the hours she is not speaking, and two
    // definitions of "quiet" would eventually mean she reorganised her memory in
    // the middle of a conversation.
    quietHours: {
      startHour: config.proactivity.quietHoursStart,
      endHour: config.proactivity.quietHoursEnd,
    },
  });

  // ── Environment ──────────────────────────────────────────────────────────
  //
  // `config.location` is the operator's answer; a browser that was granted
  // geolocation overrides it at runtime through `setClientLocation`. Neither is
  // required — with no coordinates she reports an unknown sky and a palette
  // derived from the local hour, which is the honest state rather than a
  // fabricated one.
  const environment = new EnvironmentService({
    ...(options.weatherProvider ? { provider: options.weatherProvider } : {}),
    ...(config.location
      ? { configuredLocation: { lat: config.location.latitude, lng: config.location.longitude } }
      : {}),
    eventBus,
  });

  // ── Language faculty ─────────────────────────────────────────────────────
  //
  // Built after the tools because stage 6 is only allowed to name a tool that is
  // actually installed, and the roster is read through a function rather than
  // copied so the two can never disagree.
  //
  // `undefined` here is the no-key configuration, not a failure. Nothing else in
  // the process constructs a Gemini client, and the key never leaves the closure
  // inside `createGeminiTransport`.
  //
  // `Faculties` as a router: the seam `server/llm/provider.ts` allows a provider
  // swap without touching call sites. For now `LanguageFaculties` remains the hosted
  // implementation wired behind the router when FACULTY_MODE permits it — stages still
  // consume it directly until they adopt `FacultyRouter.complete`. The router itself
  // is constructed here so `describe()` and provenance already go through one place,
  // and `mode: local-only` deterministically yields `undefined` (no silent fallback).
  const faculties = createLanguageFaculties({
    config,
    // Descriptions and argument shapes, not ids: `registry.list().map(t => t.id)` told
    // her the seven names and left her to invent every field the executor validates.
    tools: () => toolRoster(registry.list()),
    // Her register as prompt lines, resolved per draft rather than baked in at
    // construction — the overrides expire, and a system instruction captured once
    // at boot would describe a mood she was in when the process started. `''` when
    // personality is off, which the faculty treats as "no tone block".
    tone: (identityId) => personality.instructionFor(identityId),
    ...(options.languageModel ? { model: options.languageModel } : {}),
  });

  // FacultyRouter — the one seam the task asks for. Not yet consumed by stages,
  // but constructed once so the mode math is testable and provenance is single.
  const facultyRouter: FacultyRouter | undefined = (() => {
    const mode = config.llm.facultyMode;
    if (options.languageModel) {
      const hosted = {
        id: 'google' as const,
        modelId: options.languageModel.modelId,
        createFaculty: (role: FacultyRole) =>
          new LanguageModelFaculty({ id: `google:${role}`, role, model: options.languageModel! }),
      };
      return new FacultyRouter({ providers: { reason: hosted, decide: hosted, respond: hosted, learn: hosted, live: hosted }, mode });
    }
    if (mode === 'local-only') {
      const local = new LocalFacultyProvider();
      return new FacultyRouter({ providers: { reason: local, decide: local, respond: local, learn: local, live: local }, mode });
    }
    if (faculties) {
      const hosted = {
        id: 'google' as const,
        modelId: faculties.modelId,
        createFaculty: (role: FacultyRole) => {
          const m = new GeminiLanguageModel({
            transport: createGeminiTransport(config.llm.apiKey!),
            model: config.llm.reasoningModel,
            temperature: config.llm.temperature,
            timeoutMs: config.llm.timeoutMs,
            budgets: new TokenBudgetManager(),
          });
          return new LanguageModelFaculty({ id: `google:${role}`, role, model: m });
        },
      };
      return new FacultyRouter({ providers: { reason: hosted, decide: hosted, respond: hosted, learn: hosted, live: hosted }, mode });
    }
    // No key, hybrid/quality without faculties — honestly no router-derived faculty.
    return undefined;
  })();

  const worldModel = new WorldModel({ environment });

  // ── Her ear and her mouth ────────────────────────────────────────────────
  //
  // Built here for the same reason the language faculty is: this is the only
  // place in the process that turns `config.llm.apiKey` into a client, and the
  // key stays inside the closure `createGeminiLiveTransportFactory` returns.
  //
  // Three conditions, and each `undefined` means something different to the
  // browser — all of which arrive as `ready.canHear: false` and none of which
  // closes the socket. `FLAG_VOICE` off is an operator who does not want a
  // microphone in the building. No `GOOGLE_API_KEY` is the no-key configuration
  // that stages 4-6, 9 and 10 already degrade for. Either way `say` still runs
  // the twelve stages in the same conversation with the same memory, so she is
  // narrowed to text rather than switched off.
  //
  // `RENDERER_INSTRUCTION` rather than her personality instruction, and that is
  // the whole design: this model is a mouth. Her register is decided by stage 9
  // on the reasoning model, and by the time a line reaches here it has been
  // authorized word for word. A tone block here would invite the mouth to
  // rephrase, which is exactly what the drift check exists to catch.
  const voiceEar: VoiceEar | undefined =
    config.flags.voice && config.llm.enabled && config.llm.apiKey !== undefined
      ? {
          connect: createGeminiLiveTransportFactory(config.llm.apiKey),
          config: {
            model: config.llm.liveModel,
            systemInstruction: RENDERER_INSTRUCTION,
            voiceName: config.llm.voiceName,
            languageCode: config.llm.voiceLanguage,
            temperature: config.llm.temperature,
          },
        }
      : undefined;

  // ── Out-of-band learning ─────────────────────────────────────────────────
  //
  // Stages 10 and 11 already learn *inside* a cycle. This is the other path: it
  // takes a stored `cycle_record` and its conversation, and runs over cycles
  // that finished without the learn stage keeping anything — a `degraded` cycle
  // whose stage 10 threw, or one that predates a rule that now exists. It
  // refuses by default to process a cycle that already wrote memories of its
  // own, so having both wired cannot double-write.
  //
  // `ConsolidationSweep` below is its caller. Until it existed, `processCycle`
  // was constructed here, named in the boot banner, and reachable from nothing
  // but a test.
  //
  // The extractor is the model-backed one when a model exists and the
  // rule-based one when it does not — there is always a way to keep what was
  // literally said, so an absent key narrows what she notices rather than
  // switching learning off.
  const resolveKind = (identityId: string) => identityRepo.getIdentity(identityId)?.kind;
  const learning = new LearningPipeline({
    db,
    eventBus,
    memoryRepo,
    identityRepo,
    extractor: createLearningExtractor({
      ...(faculties ? { faculty: faculties } : {}),
      resolveKind,
      known: knownMemoryLookupFrom(memoryRetrieval, resolveKind),
    }),
  });

  const consolidation = new ConsolidationSweep({
    db,
    learning,
    report: (where, error) => {
      void publishError(where, error);
    },
    intervalMs: config.intervals.learningSweepMs,
  });

  /**
   * One lane per identity, for the whole process (Build Book VII.3: never two
   * cycles at once for the same identity).
   *
   * Constructed here, once, and handed to every runtime `runtimeFor` builds. It
   * cannot live inside `CognitiveRuntime`, because `runtimeFor` returns a *new*
   * runtime for every caller — a gate held in runtime state would be a lock each
   * request takes against itself, which serializes nothing.
   */
  const cycleGate = new CycleGate();

  let running = false;
  let weatherTimer: ReturnType<typeof setTimeout> | undefined;
  let bootReport: BootReport | undefined;

  // ── The transport's dependencies ─────────────────────────────────────────
  //
  // Built here and nowhere else. `server/main.ts` starts a listener over these;
  // a test can mount the same routes on the same deps with no listener at all.

  const projector = new RuntimeStateProjector({ db, identityRepo, environment });

  // The projector folds `presence`, `voice` and `cognitive` out of the event log,
  // and it has to keep doing that whether or not anyone is streaming: with
  // realtime off, `GET /api/state` answers from `buildInitial`, and a fold driven
  // only by `RealtimeFlow` would have left her reporting no thoughts and no voice
  // for the whole life of the process. `observe` is idempotent per event id, so
  // this costs nothing when the flow is folding the same event.
  const unfollow = eventBus.subscribe((event) => projector.observe(event));

  const limits = {
    credential: new RateLimiter(CREDENTIAL_LIMIT),
    authenticated: new RateLimiter(AUTHENTICATED_LIMIT),
    cycle: new RateLimiter(CYCLE_LIMIT),
  } as const;

  let flow: RealtimeFlow | undefined;

  /**
   * The realtime fan-out, created on first use.
   *
   * Three reasons it is lazy rather than built in `start()`:
   *
   *  1. It needs an owner. `RealtimeFlow`'s constructor takes the initial
   *     `RuntimeState`, and `RuntimeState.identity` is an `Identity` — not an
   *     optional one. On a fresh database there is no owner until an HTTP request
   *     creates one, so an eager build would either fail or invent an identity,
   *     and inventing one is the `{ lat: 0, lng: 0 }` mistake in another column.
   *  2. The state it starts from must be read *after* the owner exists, so the
   *     memory, task and loop counts in the first snapshot are the real ones.
   *  3. `POST /api/bootstrap` and `POST /api/session` both call this for its side
   *     effect, so the flow exists from the moment an owner does — without this
   *     being lazy, the stream would stay dead for the life of the process after
   *     the very request that should have woken it.
   */
  function realtime(): RealtimeFlow | undefined {
    if (flow !== undefined) return flow;
    if (!config.flags.realtime) return undefined;
    const owner = identityRepo.getOwner();
    if (owner === null) return undefined;
    flow = new RealtimeFlow(eventBus, projector.buildInitial(owner), {
      // The hook that makes `RuntimeState` a projection rather than a frozen
      // literal. Bound through an arrow because it reads `this.presence`.
      project: (previous, event) => projector.project(previous, event),
      // No `report` hook on purpose — see `RealtimeFlowOptions.report`. The
      // reporter this file passes everywhere else publishes `error.raised`, and
      // the flow subscribes to that bus: a subscriber whose write failed would
      // have its failure broadcast back to it, fail again, and publish again.
    });
    flow.start();
    return flow;
  }

  /**
   * A cognitive runtime scoped to one caller. See `MadhuritaApp.runtimeFor`.
   *
   * A function declaration rather than a method on the returned object because
   * `routeDeps` below needs it too, and a route reaching back through the app
   * object to find it would make the transport depend on the whole `MadhuritaApp`
   * rather than on the slice `RouteDeps` names.
   */
  function runtimeFor(identity: Identity): CognitiveRuntime {
    // One faculty object satisfies all five stage-local interfaces, and each
    // stage receives it under its own key — so a stage that was never wired
    // stays unwired rather than inheriting a neighbour's. The conditional
    // spread is not cosmetic: `UnderstandOptions.llm` is declared `llm?:
    // LlmFaculty` without `| undefined`, and this project runs with
    // `exactOptionalPropertyTypes`, so passing an explicit `undefined` would
    // not compile.
    const llm = faculties ? { llm: faculties } : {};

    // Her baseline, from this identity's own kind — the only thing that stops the
    // first sentence of a new conversation coming from nowhere. Idempotent, and it
    // leaves an existing persona alone, so calling it on every runtime build is
    // cheap and cannot flatten an override written a moment ago.
    personality.ensureBaseline(identity);

    // What the hour is doing to her, refreshed here because this is the one place
    // that runs before every cycle and already knows who is asking.
    // `environment.snapshot()` triggers no network call — it reads the last
    // observation and re-derives the band from the clock — and `day` clears the
    // slot rather than writing a zero.
    personality.noteTimeOfDay(identity.id, timeOfDayDeltas(environment.snapshot().timeOfDay));

    return new CognitiveRuntime({
      db,
      identityRepo,
      eventBus,
      memoryRetrieval,
      conversations,
      transcript: messages,
      identity,
      // The shared gate, so two requests for one identity queue against each
      // other rather than each against a private lane of its own.
      gate: cycleGate,
      // What the cycle could not tell anyone else. `RuntimeState.cognitive` no
      // longer arrives here — it is projected from `cycle.started`,
      // `cycle.stage.completed` and the terminal event, because this observer
      // fires *after* the terminal event and so was always a cycle behind.
      //
      // What is left is the advanced modules' own report. Their failures are
      // isolated by design (a module that throws must not take the cycle with
      // it), collected into `extras.advanced`, and written to no row — so
      // without this, an entire opt-in subsystem could fail on every cycle and
      // say nothing at all. Each isolated failure becomes an `error.raised`,
      // which is where every other swallowed error in this file reports to.
      onCycle: (_record, extras) => {
        for (const note of extras.advanced.notes) {
          for (const failure of note.errors) {
            void publishError(`advanced:${failure.moduleId}:stage-${note.stage}`, failure.message);
          }
        }
      },
      understand: llm,
      reason: llm,
      // With a faculty, the model proposes the tool and its arguments. Without one,
      // `intentRecognizer` reads what it can out of the words — a time, an
      // imperative — and stage 6's authorization gate runs over either proposal
      // unchanged. Before it existed, a process with no key could never choose any
      // of the seven tools installed above, whatever was asked of her.
      // `clearanceFor` here as well as in `act` below, and for the same reason: both
      // gates call `check()` with the same inputs, so a hardcoded `'safe'` at DECIDE
      // only moved the refusal to a later stage and misattributed it.
      decide: { ...llm, intent: intentRecognizer, clearanceFor },
      // Stage 7 dispatches through the pipeline; stage 8 re-reads authoritative
      // state through the same registry the pipeline verified against.
      //
      // `FLAG_ACTIONS` turns off the executor and nothing else, which is the whole
      // of its meaning. It was read nowhere before this line — assigned from env,
      // printed in the boot banner among the flags that were on, and turning it off
      // changed not one thing she did. Withholding the executor is how it was always
      // documented to work: `server/cognition/stages/7.ts` re-checks authorization,
      // finds no executor, and records `refusal(toolId, 'No tool executor is wired;
      // action is disabled')` — its P09 rollback contract, written years before
      // anything could reach it.
      //
      // `clearanceFor` stays either way. It is what stage 7 checks the decision
      // against *before* it looks for an executor, and a refusal that skipped the
      // authorization check would report the wrong reason for the same silence.
      //
      // Note what is deliberately not gated: stage 6 still proposes the tool. She
      // decides what the sentence asked for, the boundary refuses to perform it, and
      // stage 9 says so. Gating the *decision* instead would put her back where an
      // earlier defect had her — answering "Kal 7 baje yaad dilana" with a greeting
      // and scheduling nothing, with no trace saying anything was declined.
      act: config.flags.actions
        ? { executor: toolExecutor, clearanceFor }
        : { clearanceFor },
      verify: { verifiers },
      // Stage 9 gets the numbers, not the prose: it is choosing between sentences
      // it already holds. Resolved per call, inside the stage, so a module that
      // read affect at stage 2 of *this* cycle has already landed by the time the
      // register is decided.
      respond: { ...llm, tone: (identityId: string) => personality.profileFor(identityId) },
      // B08.s2 ResponseFrame: world snapshot + bounded people context. People Graph is
      // consent-scoped stub (empty until B09); WorldModel snapshot is the one honest
      // source — weather is a field modifier with TTL, not a centre. Runtime builds
      // the frame between VERIFY (verifiedOutcomeIds) and RESPOND (grounding).
      frame: { world: worldModel.snapshot(), peopleContext: worldModel.peopleContext(6) },
      // `memoryRepo` is passed whether or not a model is wired: stage 10's
      // deduplication is application logic, and without the repository it was
      // silently trusting within-candidate dedup alone.
      learn: { ...llm, memoryRepo },
      // The advanced modules, run stage by stage as the cycle proceeds. This is the
      // only path — the after-the-cycle one is gone, because its writes always
      // landed a turn late. See `CognitiveRuntimeOptions.advanced`.
      advanced: { registry: advancedRegistry, flags: advancedFlags },
    });
  }

  /**
   * Writes whatever of her origin story is not in memory yet.
   *
   * A function declaration for the same reason `runtimeFor` is one: `routeDeps` needs it,
   * and so does `start()`. Two callers, one moment each — `POST /api/bootstrap` calls it
   * for a brand-new owner, and `start()` calls it for a database that already had one
   * before this module existed. Neither has to know which case it is in, because the seed
   * is keyed by content and writing nothing is a valid outcome.
   */
  function rememberOrigin(owner: Identity): OriginSeedReport {
    return seedOrigin({ memory: memoryRepo, owner });
  }

  const routeDeps: RouteDeps = {
    config,
    db,
    eventBus,
    identityRepo,
    conversations,
    messages,
    environment,
    projector,
    realtime,
    runtimeFor,
    rememberOrigin,
    bootReport: () => bootReport,
    // `publishError` writes an `error.raised` event and an audit row, and
    // swallows its own failure. A route that reported into a `console.error`
    // instead would be a failure nothing could audit afterwards.
    report: (what, error) => {
      void publishError(what, error);
    },
    limits,
    allowedOrigins: devOrigins(config.isProduction),
  };

  /**
   * Looking up at the sky, on a timer.
   *
   * Rescheduled from the tail of each attempt rather than on an interval, for the
   * same reason as the deferral sweep: a slow or hanging request must not stack
   * up behind itself. `refresh()` is itself a no-op when the cached reading is
   * still inside its TTL, so a nudge from anywhere else costs nothing.
   *
   * A failure here is not reported as an error event. `EnvironmentService`
   * already turns an unreachable provider into a stale reading, which is a
   * normal state and not a fault; only a genuine throw is worth publishing.
   */
  async function sweepWeather(): Promise<void> {
    try {
      await environment.refresh();
    } catch (error) {
      await publishError('weather refresh', error);
    } finally {
      if (running) {
        weatherTimer = setTimeout(() => {
          void sweepWeather();
        }, WEATHER_TTL_MS);
      }
    }
  }

  async function publishError(where: string, error: unknown): Promise<void> {
    try {
      await eventBus.publish({
        type: 'error.raised',
        payload: {
          where,
          message: error instanceof Error ? error.message : String(error),
        },
        identityId: undefined,
        cycleId: undefined,
        timestamp: Date.now(),
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      });
    } catch {
      // If even the event bus is failing, there is nowhere left to report to.
      // Swallowing here is deliberate: the alternative is an unhandled
      // rejection that takes the process down during a routine sweep.
    }
  }

  /**
   * How much of the event log a boot folds back into the projector.
   *
   * The three fields `restore` rebuilds are last-writer-wins over a handful of
   * event types, and one cycle publishes at most about twenty events — so this
   * window covers the last several cycles with room to spare, while keeping boot
   * time flat as the log grows. Missing the window is not a failure mode: a
   * field the tail never mentions keeps the honest default it has today, which
   * is exactly the state this whole path improves on.
   */
  const BOOT_REPLAY_EVENTS = 512;

  /** The tail of the log, oldest first, so a fold applies it in order. */
  function replayTail(): readonly PersistedDomainEvent[] {
    const last = eventBus.lastSequence();
    return eventBus.replay(Math.max(0, last - BOOT_REPLAY_EVENTS), BOOT_REPLAY_EVENTS);
  }

  /**
   * Closes every cycle the last process left mid-thought.
   *
   * `cycle_record.status` is set to `'running'` when a cycle is admitted and
   * moved to its terminal value by stage 12. A process that dies in between
   * leaves the row saying a cycle is in flight — in a process that no longer
   * exists. Nothing reconciled that, so every crash left a permanent row
   * claiming she is still thinking about something, and `GET /api/state` counts
   * from these tables.
   *
   * `'failed'` and not `'interrupted'`: interruption is specifically a later
   * stimulus displacing an earlier cycle (Book VII.5) and names the cycle that
   * displaced it. Nothing displaced this one; the process ended.
   *
   * Row and event in one transaction, through the synchronous `append`, for the
   * reason Book IX.5 gives — a status the log does not carry is a status the
   * stream will never show, and the projector's fold reads the log.
   */
  function closeAbandonedCycles(): number {
    const abandoned = db.raw
      .prepare(
        // The identity comes through the conversation: `cycle_record` is keyed by
        // `conversation_id` and holds no caller of its own. `LEFT JOIN` so a cycle
        // whose conversation row is gone is still closed rather than skipped.
        `SELECT c.id AS id, v.identity_id AS identity_id, c.started_at AS started_at
           FROM cycle_record c
           LEFT JOIN conversation v ON v.id = c.conversation_id
          WHERE c.status = 'running'`,
      )
      .all() as { id: string; identity_id: string | null; started_at: string | null }[];
    if (abandoned.length === 0) return 0;

    const completedAt = Date.now();
    const reason = 'The process ended before this cycle reached PERSIST.';

    db.raw.transaction(() => {
      const close = db.raw.prepare(
        `UPDATE cycle_record SET status = 'failed', completed_at = ?, error = ? WHERE id = ?`,
      );
      for (const row of abandoned) {
        close.run(new Date(completedAt).toISOString(), reason, row.id);
        eventBus.append({
          type: 'cycle.failed',
          payload: {
            status: 'failed' as const,
            startedAt: row.started_at === null ? completedAt : Date.parse(row.started_at),
            completedAt,
            abandoned: true,
            reason,
          },
          identityId: row.identity_id ?? undefined,
          cycleId: row.id,
          timestamp: completedAt,
        });
      }
    })();

    return abandoned.length;
  }

  async function start(): Promise<BootReport> {
    if (running) {
      throw new Error('start() called on an app that is already running');
    }

    // Every executable tool must also be provable. `installTool()` installs the
    // definition and its postcondition together, so this can only fail if
    // something registered with the registry directly — and a tool that can run
    // but cannot be verified is a tool whose every success stage 8 has to report
    // as unproven. Better to refuse to boot than to discover that in a trace.
    //
    // Checked before `running` is set and before a single timer starts, so a
    // refusal leaves nothing behind to clean up.
    const unprovable = registry
      .list()
      .map((tool) => tool.id)
      .filter((id) => !verifiers.has(id));
    if (unprovable.length > 0) {
      throw new Error(
        `These tools are registered with no postcondition verifier: ${unprovable.join(', ')}. ` +
          `Install tools through installTool() so a tool is never executable without being ` +
          `provable.`,
      );
    }

    running = true;

    // Chain any audit rows written before migration 0007, before this boot
    // writes any of its own. Idempotent, so a normal boot chains zero rows.
    const auditRowsChained = audit.backfillChain();

    // ── Book VI.6: durable state reconstruction ──────────────────────────────
    //
    // Two steps, in this order, and both before anything can serve a request or
    // start a cycle. The first makes the durable record true; the second makes
    // the in-memory projection agree with it.
    const cyclesReconciled = closeAbandonedCycles();
    const eventsReplayed = projector.restore(replayTail());

    const started: string[] = [];
    const absent: string[] = [];

    if (config.flags.tasks) {
      taskExecutor.start();
      started.push(`task executor (every ${config.intervals.taskSweepMs}ms)`);
      // Open loops schedule their work *through* the task executor, so they
      // are gated on the same flag: a loop manager without an executor would
      // evaluate triggers and then have nowhere to put the resulting task.
      loopManager.start();
      started.push(`loop manager (every ${config.intervals.loopSweepMs}ms)`);
    } else {
      absent.push('scheduling — FLAG_TASKS is off; reminders and open loops will not fire');
    }

    // The out-of-band learner, gated on the flag that names it. `FLAG_LEARNING`
    // had no consumer anywhere in the tree before this line: the banner printed
    // it among the flags that were on, and turning it off changed nothing.
    //
    // What it covers is exactly this sweep. Stages 10 and 11 learn inside the
    // cycle and are not gated — a cycle without them would answer from a memory
    // it then refused to update — so the honest reading of the flag is "she goes
    // back over old cycles", and that is what the absent line below says.
    if (config.flags.learning) {
      consolidation.start();
      started.push(
        `learning consolidation (every ${config.intervals.learningSweepMs}ms — cycles the ` +
          `in-cycle learn stage kept nothing from)`,
      );
    } else {
      absent.push(
        'learning consolidation — FLAG_LEARNING is off; stages 10 and 11 still learn inside ' +
          'each cycle, but a cycle they kept nothing from is never revisited',
      );
    }

    if (config.flags.proactivity && config.proactivity.enabled) {
      // One timer, two jobs, and they must not be two timers. The autonomic tick
      // calls `processDeferred` itself and then *speaks* what the tree
      // authorized; a separate deferral sweep would consume the same claimed
      // rows and drop them, so half her deferred thoughts would vanish
      // depending on which timer fired first.
      autonomic.start();
      started.push(
        `autonomic loop (every ${config.intervals.proactiveSweepMs}ms — sensors, ` +
          `deferral replay, unprompted cycles)`,
      );
    } else {
      absent.push(
        'proactivity — she will answer when spoken to but will never start anything herself, ' +
          'and deferred candidates will not be re-evaluated',
      );
    }

    const ownerEnrolled = identityRepo.hasOwner();

    // Her origin story, for a database that had an owner before this code existed.
    // `POST /api/bootstrap` seeds a new owner the moment it creates one, so this only ever
    // does anything on the first boot after the feature landed — or after `story.ts` grew
    // a line, which is the case that makes it worth calling every time rather than once.
    // Reported only when it actually wrote something: "seeded 0 facts" on every boot for
    // the rest of the process's life would be noise dressed as news.
    const owner = identityRepo.getOwner();
    if (owner !== null) {
      const seeded = rememberOrigin(owner);
      if (seeded.changed) {
        started.push(
          `origin story (${seeded.factsWritten} fact${seeded.factsWritten === 1 ? '' : 's'} written` +
            `${seeded.firstMemoryWritten ? ', first memory' : ''}` +
            `${seeded.makerWritten ? ', maker' : ''})`,
        );
      }
    }

    // Weather only runs when there is somewhere to ask about. Starting the sweep
    // without coordinates would be a timer that can never do anything, and
    // reporting it as started would be a claim the code does not honour.
    if (environment.locationSource() === 'none') {
      absent.push(
        'location — no LOCATION_LATITUDE/LONGITUDE; the sky is unknown and the palette comes ' +
          'from the local hour until a client reports where she is',
      );
    } else {
      // Deliberately not awaited: boot must not wait on a public API, and a
      // first reading arriving a second late costs nothing.
      void sweepWeather();
      started.push(
        `environment (${environment.locationSource()} location, weather every ${WEATHER_TTL_MS}ms)`,
      );
    }

    // The realtime fan-out, woken here when there is already an owner to wake it
    // for. On a fresh database this reports absent and `POST /api/bootstrap`
    // starts it the moment the owner exists — which is why `realtime()` is lazy
    // rather than something `start()` alone decides.
    if (!config.flags.realtime) {
      absent.push('realtime — FLAG_REALTIME is off; GET /api/stream will refuse rather than hang');
    } else if (realtime() !== undefined) {
      started.push('realtime fan-out (SSE, coalesced per subscriber)');
    } else {
      absent.push(
        'realtime — no owner at boot; the fan-out starts as soon as one is enrolled, because ' +
          'its first state needs an identity to be about',
      );
    }

    // Reported off `faculties`, not off `config.llm.enabled`. The flag says what
    // was asked for; this says what was actually built and handed to the stages.
    if (faculties) {
      started.push(`language faculty (${faculties.modelId}) — stages 4-6, 9 and 10`);
    } else if (config.llm.facultyMode === 'local-only') {
      absent.push(
        'language faculty — FACULTY_MODE=local-only; stages 4-6, 9 and 10 use deterministic fallbacks, ' +
          'no hosted call is attempted and no token is spent',
      );
    } else if (!config.llm.enabled) {
      absent.push(
        'language faculty — no GOOGLE_API_KEY; stages 4-6, 9 and 10 use their deterministic ' +
          'fallbacks, and out-of-band learning keeps only what was literally said',
      );
    } else {
      absent.push(
        'language faculty — configured but not constructed; stages 4-6, 9 and 10 use their fallbacks',
      );
    }
    // Reported here rather than beside the timers above because nothing starts or
    // stops: the flag decides whether `runtimeFor` hands stage 7 an executor, and
    // that is a property of every cycle rather than of a running loop. Off, she still
    // reasons her way to the right tool and the boundary declines to run it — so the
    // line has to say that the decision survives, or a reader will assume the tool
    // call was never chosen and go looking for the bug in stage 6.
    if (!config.flags.actions) {
      absent.push(
        'actions — FLAG_ACTIONS is off; stage 6 still chooses the tool and stage 7 refuses to ' +
          'run it, so every tool call is recorded as a refusal and she says so instead of doing it',
      );
    }
    if (tools.length === 0) {
      absent.push('tools — none registered; stage 7 has nothing it can execute');
    }
    // Same rule as the faculty above: reported off the thing that was built.
    // `FLAG_VOICE` on with no key would otherwise print "voice" and mean text.
    if (voiceEar !== undefined) {
      started.push(
        `voice (${voiceEar.config.model}) — ear and mouth on ${VOICE_PATH}; the twelve stages ` +
          'stay on the reasoning model',
      );
    } else if (!config.flags.voice) {
      absent.push(
        `voice — FLAG_VOICE is off; ${VOICE_PATH} still accepts a socket for text, and ` +
          'she answers there without being heard or heard back',
      );
    } else {
      absent.push(
        `voice — no GOOGLE_API_KEY; ${VOICE_PATH} accepts a socket and reports canHear: false, ` +
          'so a spoken turn is impossible but a typed one still runs the full cycle',
      );
    }
    if (!ownerEnrolled) {
      absent.push(
        'owner — no identity enrolled; stages 6 and 7 refuse to authorize an unknown caller',
      );
    }
    if (config.backup.enabled) {
      absent.push(
        'unattended backup — BACKUP_ENABLED is on, but the backup key is derived from the ' +
          'owner passphrase and the server stores only its hash, so a backup must be ' +
          'triggered by an authenticated owner rather than a timer',
      );
    }

    bootReport = {
      auditRowsChained,
      cyclesReconciled,
      eventsReplayed,
      tools,
      ownerEnrolled,
      started,
      absent,
    };

    await eventBus.publish({
      type: 'boot.completed',
      payload: {
        env: config.env,
        databasePath: db.path,
        llmEnabled: config.llm.enabled,
        reasoningModel: config.llm.reasoningModel,
        liveModel: config.llm.liveModel,
        toolCount: tools.length,
        ownerEnrolled,
        auditRowsChained,
        started,
      },
      identityId: undefined,
      cycleId: undefined,
      timestamp: Date.now(),
      causationId: undefined,
      correlationId: undefined,
      version: 1,
    });

    return bootReport;
  }

  async function stop(): Promise<void> {
    if (!running) return;
    running = false;

    if (weatherTimer) {
      clearTimeout(weatherTimer);
      weatherTimer = undefined;
    }
    autonomic.stop();
    loopManager.stop();
    taskExecutor.stop();
    consolidation.stop();

    // Before the database closes, and deliberately so. `RealtimeFlow` projects
    // through `RuntimeStateProjector`, which runs six `COUNT(*)` subselects on
    // every event — against a closed handle that throws inside an event handler,
    // which is the hardest kind of failure to read. Unsubscribing first means the
    // last thing the flow can do has already happened.
    if (flow !== undefined) {
      flow.stop();
      flow = undefined;
    }
    // The projector's own fold, for the same reason and in the same breath. It
    // touches no table, but a handler left on a bus after `stop()` is a handler
    // that can still be called.
    unfollow();

    // Their sweeps are `unref`'d and would not hold the process open, but a
    // `stop()` that leaves a live `setInterval` behind is a `stop()` a test
    // cannot trust.
    limits.credential.stop();
    limits.authenticated.stop();
    limits.cycle.stop();

    // Only close a database this app opened. One handed in belongs to the
    // caller — closing it would pull the floor out from under a test that
    // still has assertions to make.
    if (ownsDatabase) {
      if (options.installGlobalDatabase !== false) {
        closeDatabase();
      } else {
        db.close();
      }
    }
  }

  return {
    config,
    db,
    audit,
    eventBus,
    identityRepo,
    memoryRepo,
    memoryRetrieval,
    memoryCorrections,
    conversations,
    messages,
    registry,
    pipeline,
    verifiers,
    toolExecutor,
    taskExecutor,
    loopManager,
    proactive,
    autonomic,
    noticing,
    autonomicReport: () => autonomic.report(),
    personality,
    environment,
    learning,
    consolidation,
    consolidationReport: () => consolidation.report(),
    faculties,
    facultyRouter,
    worldModel,
    voiceEar,
    projector,
    realtime,
    limits,
    routeDeps,

    runtimeFor,

    async backupNow(ownerPassphrase: string): Promise<BackupManifest> {
      const destination = path.resolve(config.backup.destination);
      fs.mkdirSync(destination, { recursive: true });
      const manifest = await createEncryptedBackup(db, destination, ownerPassphrase);
      await eventBus.publish({
        type: 'backup.completed',
        payload: { backupId: manifest.id, destination },
        identityId: undefined,
        cycleId: undefined,
        timestamp: Date.now(),
        causationId: undefined,
        correlationId: undefined,
        version: 1,
      });
      return manifest;
    },

    start,
    stop,
    isRunning: () => running,
    get bootReport() {
      return bootReport;
    },
  };
}
