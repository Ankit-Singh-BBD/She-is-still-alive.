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
import { IdentityRepository } from '@server/identity/repository.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
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
} from '@server/tools/index.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { TaskExecutor } from '@server/tasks/executor.js';
import { LoopManager } from '@server/loops/manager.js';
import { ProactiveEngine } from '@server/proactive/engine.js';
import { PersonalityRegistry } from '@server/personality/registry.js';
import { PersonalityEngine } from '@server/personality/engine.js';
import { LearningPipeline } from '@server/learning/pipeline.js';
import { createLearningExtractor, knownMemoryLookupFrom } from '@server/learning/extractor.js';
import { createLanguageFaculties } from '@server/llm/index.js';
import type { LanguageFaculties, LanguageModel } from '@server/llm/index.js';
import { createEncryptedBackup } from '@server/backup/backup.js';
import type { BackupManifest } from '@server/backup/backup.js';
import type { Identity } from '@server/identity/types.js';
import { RealtimeFlow } from '@server/realtime/flow.js';
import { RuntimeStateProjector } from '@server/http/state.js';
import { RateLimiter } from '@server/http/rate-limit.js';
import { devOrigins } from '@server/http/server.js';
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
  readonly personality: PersonalityEngine;
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
   * The language faculty, or `undefined` when none is configured.
   *
   * `undefined` is a supported way to run, not a broken one: stages 4-6, 9 and
   * 10 each carry a deterministic fallback, and the boot report says which
   * configuration this is.
   */
  readonly faculties: LanguageFaculties | undefined;

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

  // ── Personality ──────────────────────────────────────────────────────────
  const personality = new PersonalityEngine(new PersonalityRegistry());

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
  const faculties = createLanguageFaculties({
    config,
    toolIds: () => registry.list().map((tool) => tool.id),
    ...(options.languageModel ? { model: options.languageModel } : {}),
  });

  // ── Out-of-band learning ─────────────────────────────────────────────────
  //
  // Stages 10 and 11 already learn *inside* a cycle. This is the other path: it
  // takes a stored `cycle_record` and its conversation, and is what would run
  // over cycles that completed without the learn stage, or in a later
  // consolidation pass. It refuses by default to process a cycle that already
  // wrote memories of its own, so having both wired cannot double-write.
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

  let running = false;
  let deferralTimer: ReturnType<typeof setTimeout> | undefined;
  let deferralSweepInFlight = false;
  let weatherTimer: ReturnType<typeof setTimeout> | undefined;
  let bootReport: BootReport | undefined;

  // ── The transport's dependencies ─────────────────────────────────────────
  //
  // Built here and nowhere else. `server/main.ts` starts a listener over these;
  // a test can mount the same routes on the same deps with no listener at all.

  const projector = new RuntimeStateProjector({ db, identityRepo, environment });

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
    return new CognitiveRuntime({
      db,
      identityRepo,
      eventBus,
      memoryRetrieval,
      conversations,
      transcript: messages,
      identity,
      understand: llm,
      reason: llm,
      decide: llm,
      // Stage 7 dispatches through the pipeline; stage 8 re-reads authoritative
      // state through the same registry the pipeline verified against.
      act: { executor: toolExecutor, clearanceFor },
      verify: { verifiers },
      respond: llm,
      // `memoryRepo` is passed whether or not a model is wired: stage 10's
      // deduplication is application logic, and without the repository it was
      // silently trusting within-candidate dedup alone.
      learn: { ...llm, memoryRepo },
    });
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
   * The deferral sweep.
   *
   * `ProactiveEngine.processDeferred()` exists and is tested, but until now
   * nothing outside a test ever called it — which meant a candidate held back
   * for quiet hours was deferred forever. This is the caller: it wakes on the
   * configured interval, asks the database for deferrals that have come due,
   * and re-evaluates each against the world as it is now.
   *
   * No `UserContext` is passed on purpose. The engine already knows the
   * configured quiet-hours window and reads the wall clock itself, so passing
   * a second opinion here would create two places that decide whether it is
   * night — and eventually they would disagree.
   */
  async function sweepDeferrals(): Promise<void> {
    if (deferralSweepInFlight) return;
    deferralSweepInFlight = true;
    try {
      await proactive.processDeferred();
    } catch (error) {
      // A sweep that throws must not kill the timer: she would go quiet for
      // the rest of the process's life and nothing would say why.
      await publishError('proactive deferral sweep', error);
    } finally {
      deferralSweepInFlight = false;
      if (running) {
        deferralTimer = setTimeout(() => {
          void sweepDeferrals();
        }, config.intervals.proactiveSweepMs);
      }
    }
  }

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

    if (config.flags.proactivity && config.proactivity.enabled) {
      deferralTimer = setTimeout(() => {
        void sweepDeferrals();
      }, config.intervals.proactiveSweepMs);
      started.push(`proactive deferral sweep (every ${config.intervals.proactiveSweepMs}ms)`);
    } else {
      absent.push(
        'proactivity — deferred candidates will not be re-evaluated while it is off',
      );
    }

    const ownerEnrolled = identityRepo.hasOwner();

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
    if (tools.length === 0) {
      absent.push('tools — none registered; stage 7 has nothing it can execute');
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

    bootReport = { auditRowsChained, tools, ownerEnrolled, started, absent };

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

    if (deferralTimer) {
      clearTimeout(deferralTimer);
      deferralTimer = undefined;
    }
    if (weatherTimer) {
      clearTimeout(weatherTimer);
      weatherTimer = undefined;
    }
    loopManager.stop();
    taskExecutor.stop();

    // Before the database closes, and deliberately so. `RealtimeFlow` projects
    // through `RuntimeStateProjector`, which runs six `COUNT(*)` subselects on
    // every event — against a closed handle that throws inside an event handler,
    // which is the hardest kind of failure to read. Unsubscribing first means the
    // last thing the flow can do has already happened.
    if (flow !== undefined) {
      flow.stop();
      flow = undefined;
    }

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
    conversations,
    messages,
    registry,
    pipeline,
    verifiers,
    toolExecutor,
    taskExecutor,
    loopManager,
    proactive,
    personality,
    environment,
    learning,
    faculties,
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
