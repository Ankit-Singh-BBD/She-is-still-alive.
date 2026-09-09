/**
 * The state the interface is told about, against what is actually true.
 *
 * `server/http/state.ts` is the only place in `server/` where a `RuntimeState` is
 * built from what is in the database, and until this file it had no test of its own:
 * `tests/http/transport.test.ts` reads `GET /api/state` twice and checks that a few
 * fields are numbers, and `tests/autonomic/loop.test.ts` checks that a cycle she
 * started herself reaches `noteCycle`. Neither one touches the projection.
 *
 * That is a bad place to have no tests, because the whole file exists to fix a bug of
 * exactly the kind a missing test hides. `RealtimeFlow` used to advance `version` and
 * `lastMutation` and nothing else, so an interface could be shown six zeroes and be
 * told by the version number that it was up to date. Every claim below is that kind
 * of claim: one that still looks true after it breaks.
 *
 * ## Driven through the real flow, not through `project` directly
 *
 * `state.ts`'s own header says `GET /api/state` and the stream cannot drift apart,
 * because the event log is the only input either has. A test that called
 * `projector.project(previous, event)` itself would assert the projector and leave
 * that claim untested — so these publish on the real `EventBus`, let `RealtimeFlow`
 * call the hook, and read `flow.getSnapshot()`, which is the exact expression both
 * the route and every stream frame evaluate.
 *
 * Her voice is driven by a real `VoiceSession` for the same reason: the payloads are
 * the ones production writes, so a field renamed in the session fails here rather
 * than quietly stopping the projection.
 */

import { resolve } from 'node:path';

import { ulid } from '@server/persistence/ids.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type MadhuritaApp } from '@server/app.js';
import { loadConfig } from '@server/config/env.js';
import type { DomainEventType, PersistedDomainEvent } from '@server/events/types.js';
import { NO_MUTATION, RECENT_ACTOR_LIMIT } from '@server/http/state.js';
import type { Identity } from '@server/identity/types.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import type { RealtimeFlow } from '@server/realtime/flow.js';
import type { CognitiveStageName, RuntimeState } from '@server/realtime/types.js';
import {
  CLOSE_GOING_AWAY,
  VoiceSession,
  type LiveTransport,
  type ServerMessage,
  type VoiceClientChannel,
  type VoiceEar,
} from '@server/voice/live/index.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

/**
 * The browser's side of the socket, kept only for the states it was told.
 *
 * One FSM transition is written out twice — `client.send({ t: 'state' })` and
 * `publish('voice.state')`, both from the same listener in `VoiceSession`'s
 * constructor. A test that read only one of them could not see them disagree, and
 * they disagreeing is precisely a UI showing a session that is not there.
 */
class Client implements VoiceClientChannel {
  readonly states: string[] = [];

  send(message: ServerMessage): void {
    if (message.t === 'state') this.states.push(message.state);
  }

  sendAudio(): void {}

  close(): void {}
}

/** A provider that connects and renders, which is all `canHear` claims of one. */
class Mouth implements LiveTransport {
  readonly rendered: string[] = [];
  closes = 0;

  sendAudio(): void {}

  activityStart(): void {}

  activityEnd(): void {}

  render(text: string): void {
    this.rendered.push(text);
  }

  close(): void {
    this.closes += 1;
  }
}

/** The ear a session is handed, and the handle this file keeps on it. */
function earFor(mouth: Mouth): VoiceEar {
  return {
    config: { model: 'fake-live', systemInstruction: 'read the line', temperature: 0 },
    connect: () => Promise.resolve(mouth),
  };
}

/**
 * Let a fire-and-forget publish reach the projection.
 *
 * `VoiceSession.publish` is `void this.publishAndWait(...)`: a state transition must
 * not wait on a row being written, so the event lands a microtask or two after the
 * call that caused it. An event this file publishes itself needs none of this —
 * `EventBus.publish` awaits its handlers — but one a session publishes does.
 */
async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done, 20));
}

describe('the runtime state she reports', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;
  let flow: RealtimeFlow;
  let client: Client;
  let mouth: Mouth;
  let reports: { what: string; error: unknown }[];

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
    client = new Client();
    mouth = new Mouth();
    reports = [];

    // Built here, before anything is published, because `realtime()` is lazy
    // (`server/app.ts:651`) and reads its first state when it is called: a flow built
    // after an event would have missed the event *and* started from a state that
    // already contained it, which is a difference no assertion could see.
    const built = app.realtime();
    expect(built, 'realtime is on by default and an owner exists').toBeDefined();
    flow = built as RealtimeFlow;
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  /** What `GET /api/state` returns and what every stream frame is read from. */
  const state = (): RuntimeState => flow.getSnapshot();

  /** One event, exactly as a publisher in `server/` writes it. */
  const publish = (type: DomainEventType, payload: object): Promise<PersistedDomainEvent> =>
    app.eventBus.publish({ type, payload });

  /** A session wired as `server/http/ws.ts` wires one, with or without an ear. */
  const sessionFor = (hasEar = true): VoiceSession =>
    new VoiceSession({
      identity: owner,
      sessionId: 'session-under-test',
      client,
      runtime: app.runtimeFor(owner),
      conversations: app.conversations,
      eventBus: app.eventBus,
      report: (what, error) => reports.push({ what, error }),
      ear: hasEar ? earFor(mouth) : undefined,
      transcriptGraceMs: 5,
    });

  describe('the first read', () => {
    it('says nothing it has not looked up', () => {
      const first = app.projector.buildInitial(owner);

      expect(first.identity.id).toBe(owner.id);
      // Zero and empty because nothing is counting events for a one-shot read.
      // `GET /api/state` reports `live: false` beside them rather than a version
      // number no subscription is maintaining.
      expect(first.version).toBe(0);
      expect(first.lastMutation).toEqual(NO_MUTATION);
      expect(first.voice).toEqual({ live: 'disconnected', reason: '', canHear: false });
      // Distinguishable from a cycle that ran, which is the whole point of `''`.
      expect(first.cognitive.cycleId).toBe('');
      expect(first.cognitive.cycleStartedAt).toBe(0);
      expect(first.presence.activeActor).toBeNull();
      // The other half of "no cycle has run": `currentStage` is `PERCEIVE` here and
      // `PERCEIVE` mid-cycle too, so `lastCompletedStage` is the only field that can
      // say no stage has finished. It reads `undefined` rather than naming one.
      expect(first.cognitive.lastCompletedStage).toBeUndefined();
      // "Never", and true: there is no consolidation module for it to be lying about.
      expect(first.memory.lastConsolidationAt).toBe(0);
      expect(first.memory.episodicCount).toBe(0);
      // `SUM(status = 'pending')` over an empty table is SQL `NULL`, not `0`, so
      // these two are what says the coalescing is there.
      expect(first.tasks.pendingCount).toBe(0);
      expect(first.loops.activeCount).toBe(0);
    });
  });

  describe('what an event refreshes', () => {
    /** A row written behind the projection's back, so a count can be caught stale. */
    const writeMemory = (summary: string): void => {
      db.raw
        .prepare(`INSERT INTO episodic_memory (id, identity_id, summary) VALUES (?, ?, ?)`)
        .run(ulid(), owner.id, summary);
    };

    it('stamps the version and the mutation from the event itself', async () => {
      const event = await publish('cycle.failed', { why: 'nothing at all' });

      // Set by the flow *before* the projection runs, and the projection has to
      // carry them through. A hook that spread the wrong object would reset the
      // version to zero and every stream client would replay from the beginning.
      expect(state().version).toBe(event.seq);
      expect(state().lastMutation).toEqual({
        eventId: event.id,
        type: 'cycle.failed',
        timestamp: event.timestamp,
      });
    });

    it('re-reads a count only for an event that could have changed it', async () => {
      writeMemory('the first thing she was told');

      // `cycle.responded` maps to `{}` in `EVENT_TOUCHES`, and events arrive in
      // bursts — eleven stage events per cycle: advancing the version must not cost
      // six `COUNT(*)` queries apiece. A row nobody announced is therefore invisible
      // for now, which is the trade the table makes.
      await publish('cycle.responded', { redacted: false, disclosuresApplied: [] });
      expect(state().memory.episodicCount).toBe(0);

      // And the staleness is not permanent. The next event that *is* about memory
      // re-reads everything, including the row that arrived unannounced — so the
      // selective refresh can lag by an event and cannot lie indefinitely.
      await publish('memory.appended', { memoryId: ulid() });
      expect(state().memory.episodicCount).toBe(1);
    });

    it('re-reads who she belongs to only when an identity event says to', async () => {
      const permissions = owner.permissions;
      if (permissions === undefined) throw new Error('an enrolled owner has a permission row');
      app.identityRepo.updatePermissions(owner.id, { ...permissions, mayBeHeardInVoice: false });

      // The projection is event-driven, not polled: a permission changed out of band
      // is not visible until something says an identity changed.
      await publish('cycle.responded', {});
      expect(state().identity.permissions?.mayBeHeardInVoice).toBe(true);

      await publish('identity.enrolled', { identityId: owner.id });
      expect(state().identity.permissions?.mayBeHeardInVoice).toBe(false);
    });

    it('keeps the identity it has when the row cannot be read at all', async () => {
      // `rereadIdentity` falls back to the previous value rather than blanking the
      // field, and the difference matters: a stale identity is wrong about
      // permissions, while a missing one is a `RuntimeState` with no `identity` —
      // which the type forbids and the interface has nothing to render.
      //
      // The projector is called directly here, unlike everywhere else in this file,
      // because the identity that has to be missing is the one the state was built
      // from — and the owner cannot be missing from the database this flow is
      // reading. So the previous state names somebody who was never enrolled at all.
      const ghost: Identity = { ...owner, id: 'an-identity-that-was-never-enrolled' };
      const event = await publish('identity.enrolled', { identityId: ghost.id });
      const after = app.projector.project(app.projector.buildInitial(ghost), event);

      expect(after.identity.id).toBe(ghost.id);
      expect(after.identity.displayName).toBe('Ankit');
    });
  });

  describe('her voice, as the interface sees it', () => {
    it('records that she can hear from the moment the socket says so', async () => {
      const session = sessionFor();
      await session.open();
      await settle();

      expect(state().voice).toEqual({ live: 'listening', reason: 'connected', canHear: true });
      // The two writes out of one transition, and the assertion that they agree.
      expect(client.states).toEqual(['connecting', 'listening']);
      expect(client.states[client.states.length - 1]).toBe(state().voice.live);
      expect(reports).toEqual([]);
    });

    it('says she cannot hear when there is no model behind the socket', async () => {
      const session = sessionFor(false);
      await session.open();
      await settle();

      // The text-only configuration `VoiceState.canHear` documents: the socket is up,
      // all twelve stages run, and there is no ear. `listening` with `canHear: false`
      // is the honest pair — reporting `disconnected` would tell the interface to
      // stop rendering a session that is open and working.
      expect(state().voice).toEqual({ live: 'listening', reason: 'connected', canHear: false });
    });

    it('follows her through thinking and speaking', async () => {
      const session = sessionFor();
      await session.open();
      await session.handle({ t: 'say', text: 'kya kar rahi ho' });
      await settle();

      expect(client.states).toEqual(['connecting', 'listening', 'thinking', 'speaking']);
      expect(state().voice.live).toBe('speaking');
      expect(state().voice.reason).toBe('tts_start');
      expect(state().voice.canHear).toBe(true);
      expect(mouth.rendered).toHaveLength(1);
      expect(reports).toEqual([]);
    });

    it('refuses a state the union does not name rather than writing it through', async () => {
      const session = sessionFor();
      await session.open();
      await settle();

      // The payload comes back out of the event table through JSON, so it is
      // `unknown` by the time `noteVoice` sees it. An unrecognised value leaves
      // `live` where it was: stale is a poor answer, and a value a UI switching on
      // the six would fall through is a worse one.
      await publish('voice.state', { state: 'levitating', reason: 'a field that drifted' });
      expect(state().voice.live).toBe('listening');
      expect(state().voice.reason).toBe('a field that drifted');
    });

    it('forgets everything about her voice when her own socket closes', async () => {
      const session = sessionFor();
      await session.open();
      await settle();
      await session.close(CLOSE_GOING_AWAY, 'bye');
      await settle();

      // Reset rather than recorded: a socket that closed leaves nothing true to say
      // about reasons or hearing. `reason` is `''` because `session.disconnected`
      // lands after the FSM's own `stop` transition and clears it.
      expect(state().voice).toEqual({ live: 'disconnected', reason: '', canHear: false });
      expect(mouth.closes).toBe(1);
    });

    it('does not mistake a page’s event stream for an ear', async () => {
      // What `GET /api/stream` publishes: `{ subscriberId, transport: 'sse' }`, with
      // no `channel` at all — `server/http/routes/presence.ts:140`. Both transports
      // publish these same two event types, and only one of them is about hearing.
      await publish('session.connected', { subscriberId: ulid(), transport: 'sse' });

      expect(state().voice).toEqual({ live: 'disconnected', reason: '', canHear: false });
    });

    it('keeps her voice session live when a page’s event stream goes away', async () => {
      const session = sessionFor();
      await session.open();
      await settle();
      expect(state().voice.canHear).toBe(true);

      // An `EventSource` reconnects on every network hiccup, every proxy idle
      // timeout and every laptop that slept, and the route publishes
      // `session.disconnected` each time one goes. If that reset her voice, the
      // interface would show her as disconnected in the middle of a sentence she is
      // still speaking — and `GET /api/state` would agree with it, because the two
      // read the same projection. The socket that closed is the one that gets to say
      // so, which is what the `channel` field is for.
      await publish('session.disconnected', { subscriberId: ulid(), transport: 'sse' });

      expect(state().voice).toEqual({ live: 'listening', reason: 'connected', canHear: true });
    });
  });

  describe('the cycle she is in', () => {
    /** One real cycle, all twelve stages, through the runtime a route would use. */
    const think = (text: string) =>
      app.runtimeFor(owner).runCycle({
        source: 'text',
        payload: { text },
        receivedAt: Date.now(),
        identityId: owner.id,
      });

    it('follows her stage by stage while she is still thinking', async () => {
      // Sampled from a bus subscriber, because during a cycle that is the only
      // vantage point there is: `runCycle` does not return until stage 12 has
      // committed. `RealtimeFlow` subscribed first — in `beforeEach`, before this
      // one — and folds synchronously, so each sample is taken after the fold.
      const seen: {
        cycleId: string;
        at: CognitiveStageName;
        done: CognitiveStageName | undefined;
      }[] = [];
      const stop = app.eventBus.subscribe(
        () => {
          const c = state().cognitive;
          seen.push({ cycleId: c.cycleId, at: c.currentStage, done: c.lastCompletedStage });
        },
        ['cycle.started', 'cycle.stage.completed'],
      );

      const record = await think('yaad rakhna');
      stop();

      // Every sample names *this* cycle, from the first event onward. Before the
      // fix there were no samples to take: nothing published `cycle.started` or
      // `cycle.stage.completed` at all, and the fields were pushed in once the
      // cycle was already over.
      expect(seen.every((s) => s.cycleId === record.id)).toBe(true);
      expect(seen[0]?.at).toBe('PERCEIVE');
      expect(seen.length).toBeGreaterThan(5);

      // `currentStage` is the one after the one that finished, so a UI asking
      // "what is she doing" gets the stage she is in rather than the stage she
      // left. Only the last sample may say `PERSIST`, and when it does she is in
      // stage 12 — which is true, and is why stage 12 publishes no stage event of
      // its own.
      expect(seen.slice(0, -1).every((s) => s.at !== 'PERSIST')).toBe(true);
      expect(seen[seen.length - 1]?.at).toBe('PERSIST');
    });

    it('reports the one that finished, and the stage it ended on', async () => {
      const record = await think('yaad rakhna');
      await settle();

      const cognitive = state().cognitive;
      expect(cognitive.cycleId).toBe(record.id);
      expect(cognitive.cycleStartedAt).toBe(record.startedAt);
      // A finished cycle is not *in* a stage, so both fields name the one it ended
      // on. `PERCEIVE` would read as a cycle starting over that nothing started.
      expect(cognitive.currentStage).toBe(cognitive.lastCompletedStage);
      expect(cognitive.currentStage).toBe('PERSIST');
      // From `cycle.started`, which carries the identity the cycle is about — so
      // her own unprompted thinking marks her owner present too, without any route
      // being involved.
      expect(state().presence.activeActor).toBe(owner.id);
    });

    it('names the cycle that just finished, not the one before it', async () => {
      const first = await think('pehla sawaal');
      await settle();
      // The assertion that used to fail on the *first* cycle: the snapshot said
      // `cycleId: ''`, which reads as "she has never had a thought", while she was
      // mid-answer.
      expect(state().cognitive.cycleId).toBe(first.id);

      const second = await think('doosra sawaal');
      await settle();
      // And on every cycle after: the observer that used to feed these fields fired
      // after the cycle's own last event, so the fold waited for something later and
      // unrelated, and the snapshot held the cycle before this one.
      expect(state().cognitive.cycleId).toBe(second.id);
      expect(state().cognitive.cycleStartedAt).toBe(second.startedAt);
    });
  });

  describe('who is here', () => {
    it('lists the last few speakers newest first, and no more than that', () => {
      for (let i = 0; i < RECENT_ACTOR_LIMIT + 2; i += 1) app.projector.noteActor(`id-${i}`);

      const presence = app.projector.currentPresence();
      const newest = `id-${RECENT_ACTOR_LIMIT + 1}`;
      expect(presence.recentActors).toHaveLength(RECENT_ACTOR_LIMIT);
      expect(presence.recentActors[0]).toBe(newest);
      expect(presence.activeActor).toBe(newest);
      // Bounded, so a long-running process cannot grow this list forever.
      expect(presence.recentActors).not.toContain('id-0');
    });

    it('moves someone who comes back to the front instead of listing them twice', () => {
      app.projector.noteActor('a');
      app.projector.noteActor('b');
      app.projector.noteActor('a');

      expect(app.projector.currentPresence().recentActors).toEqual(['a', 'b']);
    });

    it('does not restart the session clock when somebody arrives', () => {
      const started = app.projector.currentPresence().sessionStartedAt;
      app.projector.noteActor('a');

      // `sessionStartedAt` is how long *she* has been up, not how long the last
      // speaker has been talking.
      expect(app.projector.currentPresence().sessionStartedAt).toBe(started);
    });
  });
});
