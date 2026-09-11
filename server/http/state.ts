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
 * `cycle.started`. So each group of fields is refreshed only by the events that
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
 * - `memory.lastConsolidationAt` is `0` until dream consolidation runs.
 *   `memory.consolidated` is published by `server/advanced/dream.ts` when
 *   duplicates are folded. `0` means "never", which is true before the first run.
 * - `cognitive` is empty (`cycleId: ''`, `cycleStartedAt: 0`) until the first
 *   cycle runs, and after that follows her through one: `cycle.started` names the
 *   cycle she is in, `cycle.stage.completed` moves it stage by stage, and the
 *   terminal event closes it. That is what `src/visual/mood.ts` reads to give her
 *   thinking an energy and what `doingWords` reads to say which of the twelve she
 *   is on, so a constant here is a UI that describes every thought identically.
 *
 *   It used to be pushed in by `CognitiveRuntime`'s `onCycle` observer, and that
 *   was off by one whole cycle. The observer fires after the lease is released,
 *   which is after stage 12 published the terminal event — and the terminal event
 *   is the last thing a cycle emits. So the projector held the finished record
 *   while `getSnapshot()` still held the state built before it, and the fold
 *   waited for some *later*, unrelated event. `/api/state` reported the previous
 *   cycle, and after the very first one it reported that she had never had a
 *   thought while she was mid-answer. Projected from events, the version and the
 *   fields advance together or not at all — the same reason `voice` is.
 *
 * ## What `voice` is, now that there is a session to project
 *
 * `voice` was `disconnected` with four zeroed fields under a comment saying "the
 * adapters exist and the wiring does not". The wiring exists: `VoiceSession`
 * publishes `voice.state` on every transition and `session.connected` /
 * `session.disconnected` around the socket, and `noteVoice` folds all three.
 *
 * It is projected from those events rather than pushed in by the session, so
 * `GET /api/state` and the stream cannot drift apart — the event log is the only
 * input either has. The energy and frequency fields are gone rather than zeroed;
 * see `VoiceState` in `server/realtime/types.ts` for why the browser is the only
 * place that data can honestly come from.
 */

import type { Database } from '@server/persistence/db.js';
import type { EnvironmentService } from '@server/environment/index.js';
import type { PersistedDomainEvent, DomainEventType } from '@server/events/types.js';
import type { Identity } from '@server/identity/types.js';
import type { IdentityRepository } from '@server/identity/repository.js';
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
  readonly voice?: true;
  readonly cognitive?: true;
}

const MEMORY: Touches = { memory: true };
const TASKS: Touches = { tasks: true };
const LOOPS: Touches = { loops: true };
const LOOP_TASK: Touches = { loops: true, tasks: true };
const IDENTITY: Touches = { identity: true };
const VOICE: Touches = { voice: true };
const COGNITION: Touches = { cognitive: true };
/** A cycle ending both closes the thought and may have written what it learned. */
const MEMORY_COGNITION: Touches = { memory: true, cognitive: true };

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
  // A correction supersedes one row and writes another, so the counts and what
  // the UI would show for that key both change.
  'memory.corrected': MEMORY,
  'task.scheduled': TASKS,
  'task.claimed': TASKS,
  'task.completed': TASKS,
  'task.failed': TASKS,
  'task.cancelled': TASKS,
  'task.retry_scheduled': TASKS,
  'task.reconciled': TASKS,
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
  'cycle.started': COGNITION,
  'cycle.stage.completed': COGNITION,
  'cycle.decided': {},
  'cycle.action': {},
  'cycle.responded': {},
  'cycle.learned': MEMORY,
  'cycle.updated': MEMORY,
  'cycle.completed': MEMORY_COGNITION,
  'cycle.degraded': MEMORY_COGNITION,
  'cycle.failed': COGNITION,
  // For the same reason `cycle.completed` is: an interruption can land after
  // stage 10/11 already committed what she learned, so the cycle that did not
  // finish may still have changed the memory counts.
  'cycle.interrupted': MEMORY_COGNITION,
  'session.connected': VOICE,
  'session.disconnected': VOICE,
  'environment.changed': {},
  'voice.state': VOICE,
  'voice.transcript': {},
  'proactive.decision': {},
  'proactive.delivered': {},
  'proactive.deferred': TASKS,
  'proactive.suppressed': {},
};

/**
 * Nothing has spoken yet. Distinguishable from a cycle that ran, and this is the
 * one field where that distinction had been lost: `lastCompletedStage` used to read
 * `'PERSIST'` here, so a process that had never run a single stage reported having
 * finished all twelve, and the Ledger showed "Stage reached: PERSIST" over an empty
 * cycle id. `undefined` is the only honest value for "no stage has completed".
 */
const NO_CYCLE: CognitiveState = {
  currentStage: 'PERCEIVE',
  cycleId: '',
  cycleStartedAt: 0,
  lastCompletedStage: undefined,
};

/** Nobody is on the voice socket. Distinguishable from a session that is quiet. */
const NO_VOICE: VoiceState = {
  live: 'disconnected',
  reason: '',
  canHear: false,
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
  private voice: VoiceState = NO_VOICE;
  /** The id of the last event folded into the three above. See `observe`. */
  private folded = '';

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
      voice: this.voice,
      memory: this.readMemory(),
      loops: this.readLoops(),
      tasks: this.readTasks(),
      lastMutation: NO_MUTATION,
    };
  }

  /**
   * Folds one event into the three fields this projector keeps itself —
   * `presence`, `voice` and `cognitive`. The rest of a `RuntimeState` is read
   * from tables when it is asked for; these three exist nowhere but here.
   *
   * Subscribed to the bus by `server/app.ts` *and* called by `project`, which is
   * why it is idempotent per event id. The subscription is what makes the fold
   * true when nobody is streaming: `GET /api/state` falls back to `buildInitial`
   * when the flow is absent (realtime off, or before an owner exists), and its
   * own doc promises the state is still real in that configuration. Driven only
   * from `project`, `cognitive` would have sat at `cycleId: ''` for the whole life
   * of such a process — the same lie in a different place.
   *
   * Whichever of the two arrives first does the work; the second sees the id it
   * already folded and returns. Ordering between two subscribers of one bus is
   * not something to depend on.
   */
  observe(event: PersistedDomainEvent): void {
    if (event.id === this.folded) return;
    this.folded = event.id;
    const touches = EVENT_TOUCHES[event.type] ?? {};
    if (touches.voice === true) this.noteVoice(event);
    if (touches.cognitive === true) this.noteCognition(event);
  }

  /**
   * Rebuilds `presence`, `voice` and `cognitive` from the event log at boot —
   * Book VI.6, *"the authoritative durable state is reconstructed from the
   * `domain_event` log"* and *"no application code may depend on in-memory state
   * that is not in the durable event log."*
   *
   * Nothing called this before, so these three fields were reconstructed from
   * nothing: a restart in the middle of a conversation served `cycleId: ''` and
   * `lastCompletedStage: undefined` from `GET /api/state` and the stream, which
   * reads as *she has never thought about anything* rather than *she is not
   * thinking right now*. Those are different claims and only the second is true.
   *
   * ## The two corrections, and why a bare replay would be worse
   *
   * A replay reconstructs what the log says. The log says a socket was open and
   * a cycle was in flight, because it is the log of a process that is gone. So
   * the fold is followed by the two facts *this* process can prove:
   *
   *  - **No socket is open.** `voice` goes back to `NO_VOICE` whatever the last
   *    `session.connected` claimed. Restoring `canHear: true` on a boot with no
   *    socket would be the same lie this method exists to remove, pointed the
   *    other way.
   *  - **Nobody is connected yet.** `activeActor` clears for the same reason.
   *    `recentActors` is genuine history — who has been here is not a claim
   *    about now — so it survives, which is the part that was being thrown away.
   *
   * `cognitive` needs no correction and is left exactly as the log folds it. A
   * cycle that finished folds to `currentStage: 'PERSIST'`, which already means
   * "not thinking"; a cycle the crash interrupted keeps the stage it reached,
   * which is a true statement about how far she got. What makes the second safe
   * is that a `cycle_record` left `running` is reconciled at boot — see
   * `closeAbandonedCycles` in `server/app.ts`, which publishes the terminal
   * event this fold then reads.
   *
   * @returns how many events were folded, for the boot report.
   */
  restore(events: Iterable<PersistedDomainEvent>): number {
    let folded = 0;
    for (const event of events) {
      this.observe(event);
      folded += 1;
    }
    this.voice = NO_VOICE;
    this.presence = { ...this.presence, activeActor: null };
    return folded;
  }

  /**
   * `RealtimeFlow`'s projection hook: the fields this event could have changed.
   *
   * `version` and `lastMutation` are the flow's own business and are already set
   * on `previous` by the time this runs, so they are carried through untouched.
   */
  project(previous: RuntimeState, event: PersistedDomainEvent): RuntimeState {
    const touches = EVENT_TOUCHES[event.type] ?? {};
    this.observe(event);
    return {
      ...previous,
      identity: touches.identity === true ? this.rereadIdentity(previous.identity) : previous.identity,
      presence: this.presence,
      // Free, and `timeOfDay` moves on a clock rather than on an event.
      environment: this.environment.snapshot(),
      cognitive: this.cognitive,
      voice: this.voice,
      memory: touches.memory === true ? this.readMemory() : previous.memory,
      loops: touches.loops === true ? this.readLoops() : previous.loops,
      tasks: touches.tasks === true ? this.readTasks() : previous.tasks,
    };
  }

  /**
   * Follows her through a cycle, from the cycle's own events.
   *
   * Three shapes arrive here. `cycle.started` names the cycle and the moment it
   * began, and is also where `presence.activeActor` comes from: whoever this cycle
   * is about is the person she is dealing with *now*, not when it finishes.
   * `cycle.stage.completed` moves the pair of stage fields along — published for
   * stages 1 to 11, because stage 12 announces itself by publishing the terminal
   * event at all. The terminal event (`completed`, `degraded`, `failed`,
   * `interrupted`) says she is no longer in a stage, so both fields name the one it
   * ended on rather than `PERCEIVE`, which would read as a cycle starting over.
   *
   * It takes an event and not a `CycleRecord` for the reason `noteVoice` does: the
   * projector must give `GET /api/state` the same answer the stream gives, and the
   * stream's only input is the event log. A record pushed in by an observer is a
   * second path to these fields, and it was one that arrived after the last event
   * of the cycle — so the snapshot kept the previous cycle until something
   * unrelated happened to it.
   */
  private noteCognition(event: PersistedDomainEvent): void {
    const payload = event.payload as Record<string, unknown>;

    if (event.type === 'cycle.started') {
      const announced = payload['cycleId'];
      this.cognitive = {
        // Where a cycle that has just been admitted actually is.
        currentStage: 'PERCEIVE',
        cycleId: typeof announced === 'string' ? announced : (event.cycleId ?? ''),
        // The publisher passes the lease's `startedAt` as the event timestamp, so
        // this is when she began thinking and not when the row was written.
        cycleStartedAt: event.timestamp,
        // The last stage that finished is still the last stage that finished. A
        // new cycle starting does not un-complete it.
        lastCompletedStage: this.cognitive.lastCompletedStage,
      };
      if (event.identityId !== undefined) this.noteActor(event.identityId);
      return;
    }

    if (event.type === 'cycle.stage.completed') {
      const done = stageName(payload['stage']);
      // A payload whose stage the union does not name cannot be projected: the
      // reader would be told a different stage finished than the one that did. Same
      // rule as `isLiveState` — a stale answer beats a wrong one.
      if (done === undefined) return;
      this.cognitive = {
        ...this.cognitive,
        // The stage the runtime runs next, which is what the interface should be
        // showing between two announcements. The terminal event corrects it if the
        // cycle stopped here instead.
        currentStage: nextStage(done),
        lastCompletedStage: done,
      };
      return;
    }

    // A terminal event is normally proof PERSIST ran: stage 12 publishes inside
    // `persist`'s transaction, so holding one means the transaction committed —
    // whatever the cycle's outcome was. That is why this needs nothing else from the
    // payload: `endedAtStage` used to be sent, was the constant `'PERSIST'` in the one
    // place that wrote it, and a field that is always a constant is not state.
    //
    // `currentStage` matches, because between cycles the stage she last completed is
    // also the furthest she has got.
    //
    // There is exactly one other publisher, and it is why `abandoned` is read here:
    // `closeAbandonedCycles` in `server/app.ts` closes a cycle whose process died
    // mid-thought, and that cycle demonstrably did *not* reach PERSIST. Folding its
    // event the ordinary way would have her report completing the stage she was
    // killed before — a restart would rewrite a death at REASON into a clean finish.
    // Her furthest stage stays wherever the log actually left it, and `currentStage`
    // follows it, because the cycle is over either way.
    if (payload['abandoned'] === true) {
      this.cognitive = {
        ...this.cognitive,
        currentStage: this.cognitive.lastCompletedStage ?? 'PERCEIVE',
      };
      return;
    }
    this.cognitive = { ...this.cognitive, currentStage: 'PERSIST', lastCompletedStage: 'PERSIST' };
  }

  /**
   * Records where her voice session is, from the events the session publishes.
   *
   * Called by `RealtimeFlow`'s `project` rather than by `VoiceSession` directly,
   * which is why it takes an event and not a state: the projector must give the
   * same answer to `GET /api/state` as the stream gives, and the stream's only
   * input is the event log. A `VoiceSession` reaching in here would be a second
   * path to the same field, and the two would eventually disagree — which is the
   * bug the top of this file is about.
   *
   * `session.disconnected` resets rather than recording, because a socket that
   * closed leaves nothing true to say about energy, reasons or hearing — but only
   * the voice socket's close gets to do it. Both event types are published by two
   * transports: `VoiceSession`, which sets `channel: 'voice'`, and `GET /api/stream`
   * (`server/http/routes/presence.ts`), which sets `transport: 'sse'` and no
   * channel at all. The reset used to be unguarded, and an `EventSource` goes away
   * on every proxy idle timeout, every laptop that slept and every page
   * navigation — so a reconnect reported her as disconnected and unable to hear in
   * the middle of a sentence she was still speaking, with `GET /api/state` agreeing
   * because the two read this one projection.
   */
  private noteVoice(event: PersistedDomainEvent): void {
    const payload = event.payload as Record<string, unknown>;
    // The one guard both session events need: the socket that closed is the one
    // that gets to say what closed.
    if (event.type === 'session.connected' || event.type === 'session.disconnected') {
      if (payload['channel'] !== 'voice') return;
    }
    if (event.type === 'session.disconnected') {
      this.voice = NO_VOICE;
      return;
    }
    if (event.type === 'session.connected') {
      this.voice = {
        ...this.voice,
        canHear: payload['canHear'] === true,
      };
      return;
    }
    const state = payload['state'];
    this.voice = {
      live: isLiveState(state) ? state : this.voice.live,
      reason: typeof payload['reason'] === 'string' ? payload['reason'] : '',
      canHear: this.voice.canHear,
    };
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

  /**
   * The memory counts, meaning *what she can retrieve* — not what rows exist.
   *
   * The difference is `lifecycle_status = 'consolidated'`, and it is the whole
   * reason this method has a comment. `MemoryRepository.listEpisodic` excludes
   * consolidated rows from its default view: a duplicate folded by
   * `server/advanced/dream.ts` is intact on disk and no longer retrieved as a
   * separate recollection. `episodicCount` counted `deleted_at IS NULL` alone, so
   * it kept counting folded rows — the interface would have reported eleven
   * recollections while she could reach ten, and nothing in the count would have
   * hinted at the gap. One filter, honoured in both places.
   *
   * The other five tables have a `lifecycle_status` column and no way to leave
   * `'active'` except deletion, because `markEpisodicConsolidated` is the only
   * method that writes `'consolidated'` and it writes it to one table. They are
   * counted by `deleted_at` alone because that is genuinely all there is.
   */
  private readMemory(): MemorySummary {
    const row = this.db.raw
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM episodic_memory
             WHERE deleted_at IS NULL AND lifecycle_status != 'consolidated') AS episodic,
           (SELECT COUNT(*) FROM semantic_memory WHERE deleted_at IS NULL)  AS semantic,
           (SELECT COUNT(*) FROM preference     WHERE deleted_at IS NULL)  AS preference,
           (SELECT COUNT(*) FROM habit          WHERE deleted_at IS NULL)  AS habit,
           (SELECT COUNT(*) FROM relationship   WHERE deleted_at IS NULL)  AS relationship,
           (SELECT COUNT(*) FROM learned_pattern WHERE deleted_at IS NULL) AS learned,
           (SELECT MAX(updated_at) FROM episodic_memory
             WHERE lifecycle_status = 'consolidated' AND deleted_at IS NULL) AS folded_at`,
      )
      .get() as Record<string, number | string | null> | undefined;
    const foldedAt = row?.['folded_at'];
    return {
      episodicCount: numberAt(row, 'episodic'),
      semanticCount: numberAt(row, 'semantic'),
      preferenceCount: numberAt(row, 'preference'),
      habitCount: numberAt(row, 'habit'),
      relationshipCount: numberAt(row, 'relationship'),
      learnedPatternCount: numberAt(row, 'learned'),
      // When she last folded a recollection that is still folded. Read from the
      // rows rather than from the `memory.consolidated` event, because the dream
      // module runs with or without an event bus and the rows move either way —
      // and because every other field here is a snapshot of the tables as they
      // are, not a history of what happened to them. `0` means never, and is now
      // a fact about the database instead of a placeholder: it was hard-coded to
      // `0` under a comment reading "nothing consolidates yet", which stopped
      // being true the day `server/advanced/dream.ts` began folding rows.
      lastConsolidationAt: typeof foldedAt === 'string' ? Date.parse(foldedAt) || 0 : 0,
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
 * Narrows a `cycle.stage.completed` payload's `stage` field.
 *
 * The payload went through JSON on its way into the event table, so this is a
 * narrowing and not a cast. It answers `undefined` for anything the union does not
 * name, rather than a stage of its own choosing: this value is what the interface
 * prints as the stage she reached, and the old fallback was `'PERSIST'` — so a payload
 * that came back wrong claimed the whole cycle had finished.
 */
function stageName(raw: unknown): CognitiveStageName | undefined {
  if (typeof raw !== 'string') return undefined;
  return STAGE_NAMES.find((name) => name === raw);
}

/**
 * The stage the runtime runs after this one, or this one at the end.
 *
 * `PERSIST` has nothing after it, and returning it unchanged is the honest answer:
 * the terminal event is what says the cycle is over, and it arrives immediately
 * after.
 */
function nextStage(completed: CognitiveStageName): CognitiveStageName {
  const at = STAGE_NAMES.indexOf(completed);
  return STAGE_NAMES[at + 1] ?? completed;
}

/** The five session states, for the same reason `STAGE_NAMES` exists. */
const LIVE_STATES: readonly VoiceState['live'][] = [
  'disconnected',
  'connecting',
  'listening',
  'thinking',
  'speaking',
];

/**
 * Narrows a `voice.state` payload's `state` field.
 *
 * The payload is `unknown` by the time it comes back out of the event table —
 * it went through JSON — so a state the union does not name must be rejected
 * rather than trusted. An unrecognised value leaves `live` as it was, which is a
 * stale answer; writing it through would be a wrong one.
 */
function isLiveState(value: unknown): value is VoiceState['live'] {
  return typeof value === 'string' && LIVE_STATES.some((state) => state === value);
}

/**
 * One count out of an aggregate row.
 *
 * `readMemory` selects a timestamp alongside six counts, so the row's value type
 * is no longer `number` and `?? 0` would let a string through into a field typed
 * `number`. A count that came back as anything but a number is a query that
 * changed shape, and reporting `0` for it is the same wrong answer as reporting
 * the string — but it is at least the wrong answer the field's type allows.
 */
function numberAt(row: Record<string, number | string | null> | undefined, key: string): number {
  const value = row?.[key];
  return typeof value === 'number' ? value : 0;
}
