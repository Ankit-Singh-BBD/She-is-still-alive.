/**
 * The one place a `RuntimeState` is actually built from what is true.
 *
 * `RuntimeState` has existed since P20 and was constructed in exactly three
 * places, all of them test files. Nothing in `server/` ever made one, which
 * means `RealtimeFlow` — the component whose whole job is to hold and broadcast
 * it — had only ever held a literal somebody typed. This file is what makes it
 * a projection.
 *
 * ## The bug this replaces
 *
 * `RealtimeFlow._applyEventToState` sets `version` and `lastMutation` and
 * nothing else, under a comment reading *"Applies the event to the local
 * RuntimeState copy"*. It does not: `memory`, `tasks`, `loops`, `presence`,
 * `cognitive` and `environment` keep whatever values the initial state was born
 * with, forever. A UI bound to `getSnapshot()` would show six zeroes after a
 * thousand memories were written, and would be *told* by the version number
 * that it was up to date. That is the honesty family of bug the codebase names
 * out loud: a verdict the code reports that the code does not honour.
 *
 * `RealtimeFlow` is still not the thing that reads the database — it is a
 * fan-out component and should stay one. It gained an optional `project` hook,
 * and this is what fills it.
 *
 * ## Why the fields are refreshed selectively
 *
 * `project` runs once per domain event, and events arrive in bursts. Re-reading
 * everything each time would put six `COUNT(*)` queries on the path of every
 * `audio.frame`. So each group of fields is refreshed only by the events that
 * could have changed it, and `EVENT_TOUCHES` is that mapping — written as a
 * table rather than a chain of `startsWith` calls so an event type that nobody
 * mapped is visibly unmapped.
 *
 * `environment` is the exception: it is refreshed on every event because
 * `EnvironmentService.snapshot()` is a synchronous field read with no query
 * behind it, and because `timeOfDay` changes on a clock rather than an event.
 *
 * ## What is honestly empty
 *
 * - `memory.lastConsolidationAt` is `0`. There is no consolidation module in
 *   `server/memory/` — `memory.consolidated` is a declared event type with no
 *   emitter. `0` means "never", which is true.
 * - `voice` is `disconnected` with zero energy and no `voiceId`. Nothing has
 *   opened a live session yet; the adapters exist and the wiring does not.
 * - `pendingActions` is `[]`, and here that is not a placeholder: `ActionPipeline.execute`
 *   resolves before the cycle that called it returns, so there is no instant
 *   between two requests at which an action is in flight. If a queue is ever put
 *   in front of the pipeline this field stops being trivially true and needs a
 *   real reader.
 * - `cognitive` is empty (`cycleId: ''`, `cycleStartedAt: 0`) until the first
 *   cycle runs, and after that reports the last one. It is not live *during* a
 *   cycle, because `cycle.stage.completed` is declared and never published — so
 *   there is no event that could move it stage by stage. `noteCycle` records
 *   what the finished cycle actually did rather than guessing at what it is
 *   doing now.
 */

import type { Database } from '@server/persistence/db.js';
import type { EnvironmentService } from '@server/environment/index.js';
import type { PersistedDomainEvent, DomainEventType } from '@server/events/types.js';
import type { Identity } from '@server/identity/types.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { CycleRecord } from '@server/cognition/types.js';
import type {
  CognitiveState,
  CognitiveStageName,
  LoopSummary,
  MemorySummary,
  MutationRecord,
  PresenceState,
  RuntimeState,
  TaskSummary,
  VoiceState,
} from '@server/realtime/types.js';

/** How many recent speakers `presence.recentActors` keeps. */
export const RECENT_ACTOR_LIMIT = 8;

/** Which groups of fields an event can invalidate. */
interface Touches {
  readonly memory?: true;
  readonly tasks?: true;
  readonly loops?: true;
  readonly identity?: true;
}

const MEMORY: Touches = { memory: true };
const TASKS: Touches = { tasks: true };
const LOOPS: Touches = { loops: true };
const LOOP_TASK: Touches = { loops: true, tasks: true };
const IDENTITY: Touches = { identity: true };

/**
 * What each event type could have changed, and nothing more.
 *
 * Every `DomainEventType` is listed, including the ones that touch nothing, so
 * that a new event type is a compile error here rather than a field that
 * silently stops updating. `Record<DomainEventType, Touches>` is what enforces
 * that — the empty object is a deliberate entry, not an omission.
 */
const EVENT_TOUCHES: Record<DomainEventType, Touches> = {
  'memory.appended': MEMORY,
  'memory.consolidated': MEMORY,
  'task.scheduled': TASKS,
  'task.claimed': TASKS,
  'task.completed': TASKS,
  'task.failed': TASKS,
  'task.cancelled': TASKS,
  'task.retry_scheduled': TASKS,
  'loop.opened': LOOPS,
  'loop.closed': LOOPS,
  'loop.paused': LOOPS,
  'loop.resumed': LOOPS,
  'loop.evaluated': LOOPS,
  'loop.task_created': LOOP_TASK,
  // A tool that wrote a memory or scheduled a reminder publishes its own event
  // too, but `action.executed` arrives first and the summary should not lag a
  // whole event behind what the caller was just told succeeded.
  'action.executed': { memory: true, tasks: true, loops: true },
  'action.failed': {},
  'identity.enrolled': IDENTITY,
  'identity.revoked': IDENTITY,
  'boot.completed': {},
  'config.changed': {},
  'backup.completed': {},
  'error.raised': {},
  'cycle.started': {},
  'cycle.stage.completed': {},
  'cycle.decided': {},
  'cycle.action': {},
  'cycle.responded': {},
  'cycle.learned': MEMORY,
  'cycle.updated': MEMORY,
  'cycle.completed': MEMORY,
  'cycle.degraded': MEMORY,
  'cycle.failed': {},
  'cycle.interrupted': {},
  'session.connected': {},
  'session.disconnected': {},
  'audio.frame': {},
  'environment.changed': {},
  'voice.state': {},
  'voice.transcript': {},
  'proactive.decision': {},
  'proactive.delivered': {},
  'proactive.deferred': TASKS,
  'proactive.suppressed': {},
};

/** Nothing has spoken yet. Distinguishable from a cycle that ran. */
const NO_CYCLE: CognitiveState = {
  currentStage: 'PERCEIVE',
  cycleId: '',
  cycleStartedAt: 0,
  lastCompletedStage: 'PERSIST',
  attention: {},
};

/** No live session. See the note at the top of this file. */
const NO_VOICE: VoiceState = {
  live: 'disconnected',
  energy: 0,
  ttsEnergy: 0,
  frequencyBands: [],
  voiceId: '',
};

export const NO_MUTATION: MutationRecord = { eventId: '', type: '', timestamp: 0 };

export interface RuntimeStateProjectorOptions {
  readonly db: Database;
  readonly identityRepo: IdentityRepository;
  readonly environment: EnvironmentService;
  readonly now?: (() => number) | undefined;
}

/**
 * Holds the parts of `RuntimeState` that only this process knows, and reads the
 * rest.
 *
 * The projector-local parts are `presence` and `cognitive`: who spoke last and
 * what the last cycle did. Neither is in the database in a form that can be
 * queried cheaply — `cycle_record` has every cycle ever, and the *latest* is a
 * sort over a growing table on the path of every event. Holding them here costs
 * a restart's worth of amnesia about who was last talking, which is the correct
 * amount: after a restart nobody is talking.
 */
export class RuntimeStateProjector {
  private readonly db: Database;
  private readonly identityRepo: IdentityRepository;
  private readonly environment: EnvironmentService;
  private readonly now: () => number;

  private presence: PresenceState;
  private cognitive: CognitiveState = NO_CYCLE;

  constructor(options: RuntimeStateProjectorOptions) {
    this.db = options.db;
    this.identityRepo = options.identityRepo;
    this.environment = options.environment;
    this.now = options.now ?? Date.now;
    this.presence = { activeActor: null, recentActors: [], sessionStartedAt: this.now() };
  }

  /**
   * The first state, read in full.
   *
   * Takes the owner rather than looking one up, because the caller already had
   * to find one: there is no `RuntimeState` before bootstrap, and inventing an
   * identity to fill the field would be the `{ lat: 0, lng: 0 }` mistake in a
   * different column.
   */
  buildInitial(owner: Identity): RuntimeState {
    return {
      version: 0,
      identity: owner,
      presence: this.presence,
      environment: this.environment.snapshot(),
      cognitive: this.cognitive,
      voice: NO_VOICE,
      memory: this.readMemory(),
      loops: this.readLoops(),
      tasks: this.readTasks(),
      pendingActions: [],
      lastMutation: NO_MUTATION,
    };
  }

  /**
   * `RealtimeFlow`'s projection hook: the fields this event could have changed.
   *
   * `version` and `lastMutation` are the flow's own business and are already set
   * on `previous` by the time this runs, so they are carried through untouched.
   */
  project(previous: RuntimeState, event: PersistedDomainEvent): RuntimeState {
    const touches = EVENT_TOUCHES[event.type] ?? {};
    return {
      ...previous,
      identity: touches.identity === true ? this.rereadIdentity(previous.identity) : previous.identity,
      presence: this.presence,
      // Free, and `timeOfDay` moves on a clock rather than on an event.
      environment: this.environment.snapshot(),
      cognitive: this.cognitive,
      memory: touches.memory === true ? this.readMemory() : previous.memory,
      loops: touches.loops === true ? this.readLoops() : previous.loops,
      tasks: touches.tasks === true ? this.readTasks() : previous.tasks,
    };
  }

  /**
   * Records who just spoke and what her last cycle did.
   *
   * Called by the route that ran the cycle, because that is the only place both
   * facts are known at once. It does not broadcast: the cycle publishes its own
   * events, and the next `project` folds this in.
   */
  noteCycle(record: CycleRecord): void {
    const stages = record.stages;
    const last = stages.length > 0 ? stages[stages.length - 1] : undefined;
    const lastName = stageName(last?.stageName);
    this.cognitive = {
      // A finished cycle is not *in* a stage. Reporting the one it ended on is
      // the true statement; reporting `PERCEIVE` would imply it is starting over.
      currentStage: lastName,
      cycleId: record.id,
      cycleStartedAt: record.startedAt,
      lastCompletedStage: lastName,
      attention: {},
    };
    this.noteActor(record.identityId);
  }

  /** Records a caller as present without a cycle — a stream that just opened. */
  noteActor(identityId: string): void {
    const recent = [identityId, ...this.presence.recentActors.filter((id) => id !== identityId)];
    this.presence = {
      activeActor: identityId,
      recentActors: recent.slice(0, RECENT_ACTOR_LIMIT),
      sessionStartedAt: this.presence.sessionStartedAt,
    };
  }

  /** What she currently believes about who is here. */
  currentPresence(): PresenceState {
    return this.presence;
  }

  private rereadIdentity(fallback: Identity): Identity {
    // An `identity.revoked` event about the owner must be reflected, and a
    // failed read must not blank the field — the previous value is stale, not
    // wrong.
    return this.identityRepo.getIdentity(fallback.id) ?? fallback;
  }

  private readMemory(): MemorySummary {
    const row = this.db.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM episodic_memory WHERE deleted_at IS NULL) AS episodic,
           (SELECT COUNT(*) FROM semantic_memory WHERE deleted_at IS NULL)  AS semantic,
           (SELECT COUNT(*) FROM preference     WHERE deleted_at IS NULL)  AS preference,
           (SELECT COUNT(*) FROM habit          WHERE deleted_at IS NULL)  AS habit,
           (SELECT COUNT(*) FROM relationship   WHERE deleted_at IS NULL)  AS relationship,
           (SELECT COUNT(*) FROM learned_pattern WHERE deleted_at IS NULL) AS learned`,
      )
      .get() as Record<string, number> | undefined;
    return {
      episodicCount: row?.['episodic'] ?? 0,
      semanticCount: row?.['semantic'] ?? 0,
      preferenceCount: row?.['preference'] ?? 0,
      habitCount: row?.['habit'] ?? 0,
      relationshipCount: row?.['relationship'] ?? 0,
      learnedPatternCount: row?.['learned'] ?? 0,
      // Nothing consolidates yet. `0` is "never", which is the truth.
      lastConsolidationAt: 0,
    };
  }

  private readTasks(): TaskSummary {
    const row = this.db.raw
      .prepare(
        `SELECT
           SUM(status = 'pending') AS pending,
           SUM(status = 'running') AS running,
           SUM(status = 'failed')  AS failed
         FROM task`,
      )
      .get() as Record<string, number | null> | undefined;
    return {
      pendingCount: row?.['pending'] ?? 0,
      runningCount: row?.['running'] ?? 0,
      failedCount: row?.['failed'] ?? 0,
    };
  }

  private readLoops(): LoopSummary {
    // `open_loop.status` defaults to 'open' in the schema but `LoopManager`
    // always writes 'active' explicitly, so the default is unreachable and
    // counting 'active' is counting every open loop.
    const row = this.db.raw
      .prepare(
        `SELECT
           SUM(status = 'active') AS active,
           SUM(status = 'paused') AS paused
         FROM open_loop`,
      )
      .get() as Record<string, number | null> | undefined;
    return { activeCount: row?.['active'] ?? 0, pausedCount: row?.['paused'] ?? 0 };
  }
}

/** The twelve stage names, so a trace can be read back into the union. */
const STAGE_NAMES: readonly CognitiveStageName[] = [
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
];

/**
 * A stage trace's name as a `CognitiveStageName`, or `PERSIST` when it is not one.
 *
 * `StageTrace.stageName` is a plain `string`, so this is a narrowing and not a
 * cast: an unrecognised value would otherwise be handed to a UI that switches on
 * the twelve and falls through to nothing.
 */
function stageName(raw: string | undefined): CognitiveStageName {
  const found = STAGE_NAMES.find((name) => name === raw);
  return found ?? 'PERSIST';
}
