// @vitest-environment jsdom

/**
 * The browser's half of her pulse.
 *
 * `src/lib/stream.ts` is the only reader of `GET /api/stream`, and it owns one
 * decision that decides whether a committed cycle appears on screen at all: which
 * frames mean "rows exist now that did not exist before". Nothing on the server can
 * check it. `tests/http/state.test.ts` proves the route *writes* those frames; this
 * file is about what the client does with them once they arrive.
 *
 * ## The defect that made this file necessary
 *
 * The module's header records it: reading the triggering event off the state frame's
 * `lastMutation` cannot work, because `RealtimeFlow` coalesces by event type and the
 * adapter sends the snapshot read at *send* time — so in a burst, every trailing
 * state frame names the newest event and `cycle.completed` never appears in one.
 * That was found on a live run, not by a test, because this module had no test. The
 * replacement — four terminal events subscribed by name — is exactly the kind of
 * thing that rots silently: a fifth cycle outcome added to stage 12, or one of these
 * four renamed, and her reply simply stops arriving until someone reloads the page.
 *
 * So the assertions here are about the listener set and the signal, not about a
 * payload: all four names report, `cycle.started` does not, and the handler is
 * called with a name and nothing else.
 *
 * ## The `EventSource` is fake because jsdom has none
 *
 * There is no `EventSource` in jsdom at all, which is also why the module's
 * unavailable path is real rather than theoretical. `FakeEventSource` supplies the
 * four members the module touches plus the static `CLOSED` it reads off the global.
 * Everything else is the shipped module.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RuntimeState } from '../../src/lib/api.js';
import {
  openPresenceStream,
  type StreamHandlers,
  type StreamStatus,
} from '../../src/lib/stream.js';

/**
 * `EventSource`, reduced to what the module touches.
 *
 * The static `CLOSED` is load-bearing: the module compares `source.readyState`
 * against `EventSource.CLOSED` read off the *global*, and that comparison is the
 * whole difference between "she is unreachable" and "reconnecting".
 */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  /** Every source the module has constructed. A retry builds none: see `drop`. */
  static readonly built: FakeEventSource[] = [];

  readyState: number = FakeEventSource.CONNECTING;
  closes = 0;
  private readonly listeners = new Map<string, ((event: { data: string }) => void)[]>();

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.built.push(this);
  }

  addEventListener(name: string, fn: (event: { data: string }) => void): void {
    const existing = this.listeners.get(name);
    if (existing === undefined) this.listeners.set(name, [fn]);
    else existing.push(fn);
  }

  close(): void {
    this.closes += 1;
    this.readyState = FakeEventSource.CLOSED;
  }

  // ── The server's side of it ───────────────────────────────────────────────

  /** Every frame name this stream is listening for. */
  get subscribed(): string[] {
    return [...this.listeners.keys()].sort();
  }

  /** One frame. `data` is deliberately free-form: some frames carry none. */
  emit(name: string, data = ''): void {
    for (const fn of this.listeners.get(name) ?? []) fn({ data });
  }

  /** A drop `EventSource` retries by itself, on the same object. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.emit('error');
  }

  /** A refusal it will not retry: a non-200, or a content type the parser rejected. */
  refuse(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.emit('error');
  }
}

/** Every handler call, in order. */
class Log {
  readonly statuses: StreamStatus[] = [];
  readonly states: RuntimeState[] = [];
  readonly committed: string[] = [];
  /** The same calls in one sequence, for the assertions that are about ordering. */
  readonly calls: string[] = [];

  readonly handlers: StreamHandlers = {
    onStatus: (status) => {
      this.statuses.push(status);
      this.calls.push(`status:${status}`);
    },
    onState: (state) => {
      this.states.push(state);
      this.calls.push('state');
    },
    onCycleCommitted: (type) => {
      this.committed.push(type);
      this.calls.push(`committed:${type}`);
    },
  };

  get status(): StreamStatus | undefined {
    return this.statuses[this.statuses.length - 1];
  }
}

/** `globalThis`, narrowed to the one member these tests replace. */
const runtime = globalThis as unknown as { EventSource?: unknown };
const realEventSource = runtime.EventSource;

/**
 * A minimal state frame.
 *
 * Not a full `RuntimeState`, and the cast says so: the module parses this frame and
 * passes it straight through without validating a field, because the server built it
 * from its own projector and a second opinion here would be the second source of
 * truth the module's header exists to refuse.
 */
const FRAME = {
  presence: { activeActor: 'id_owner' },
  cognitive: { cycleId: 'cyc_9' },
} as unknown as RuntimeState;

const sourceFor = (): FakeEventSource => {
  const source = FakeEventSource.built[FakeEventSource.built.length - 1];
  if (source === undefined) throw new Error('the module opened no stream');
  return source;
};

describe('The browser end of the presence stream (src/lib/stream.ts)', () => {
  let log: Log;

  beforeEach(() => {
    FakeEventSource.built.length = 0;
    runtime.EventSource = FakeEventSource;
    log = new Log();
  });

  afterEach(() => {
    runtime.EventSource = realEventSource;
  });

  describe('opening', () => {
    it('opens the same-origin stream and sends no credentials flag', () => {
      openPresenceStream(log.handlers);

      // Relative, so the cookie rides on the request because it is same-origin.
      // `withCredentials` is for cross-origin streams; passing it here would be a
      // lie about what this request is.
      expect(sourceFor().url).toBe('/api/stream');
      expect(sourceFor().init).toBeUndefined();
      expect(log.statuses).toEqual(['connecting']);
    });

    it('listens for the four terminal cycle events and nothing else', () => {
      openPresenceStream(log.handlers);

      // The listener set *is* the contract, because `EventSource` has no wildcard.
      // A fifth outcome added to stage 12 has to be added here too, and this is the
      // line that will say so — the alternative is her reply quietly never arriving
      // on that outcome, which reads as her having ignored him.
      expect(sourceFor().subscribed).toEqual([
        'cycle.completed',
        'cycle.degraded',
        'cycle.failed',
        'cycle.interrupted',
        'error',
        'state',
      ]);
    });

    it('reports unavailable where there is no EventSource', () => {
      delete runtime.EventSource;

      const handle = openPresenceStream(log.handlers);

      // jsdom's own condition, and a real browser's when the stream is blocked.
      // Reported rather than thrown: a test that mounts the shell should see the
      // honest degraded path.
      expect(log.statuses).toEqual(['unavailable']);
      expect(() => handle.close()).not.toThrow();
      expect(FakeEventSource.built).toHaveLength(0);
    });
  });

  describe('frames', () => {
    it('goes live on a state frame and passes the snapshot straight through', () => {
      openPresenceStream(log.handlers);

      sourceFor().emit('state', JSON.stringify(FRAME));

      // 'live' is announced before the state is handed over, so an interface that
      // renders inside `onState` is never painting while the status still says
      // "connecting".
      expect(log.calls).toEqual(['status:connecting', 'status:live', 'state']);
      expect(log.states).toEqual([FRAME]);
    });

    it('ignores a malformed state frame and keeps the stream', () => {
      openPresenceStream(log.handlers);
      const source = sourceFor();

      source.emit('state', '{"presence":');

      expect(log.states).toEqual([]);
      // The load-bearing half: the next frame still arrives. Asserting only that
      // nothing threw would pass against a `catch` that closed the stream, which
      // would freeze the room on one bad byte until somebody reloaded.
      source.emit('state', JSON.stringify(FRAME));
      expect(log.states).toEqual([FRAME]);
      expect(source.closes).toBe(0);
    });

    it('reports every one of the four cycle outcomes, by name', () => {
      openPresenceStream(log.handlers);
      const source = sourceFor();

      // All four commit. `degraded` answered with a stage broken on the way,
      // `interrupted` was abandoned for a newer stimulus, `failed` did not answer at
      // all — and every one of them still ran the transaction that writes turns. A
      // set holding only `cycle.completed` drops her reply on a cycle that limped.
      for (const name of ['cycle.completed', 'cycle.degraded', 'cycle.interrupted', 'cycle.failed'])
        source.emit(name, '{ this frame is not parsed');

      expect(log.committed).toEqual([
        'cycle.completed',
        'cycle.degraded',
        'cycle.interrupted',
        'cycle.failed',
      ]);
      // The unparseable data is the assertion: the signal carries a name and nothing
      // else, so a client cannot start believing a second version of what changed.
      expect(log.states).toEqual([]);
    });

    it('does not report a cycle that has only started', () => {
      openPresenceStream(log.handlers);

      // `cycle.started` is on the same wire and commits nothing. Re-reading the
      // transcript on it would fetch the turn *before* the one he is waiting for and
      // then never fetch again, which looks exactly like her answering the previous
      // question.
      sourceFor().emit('cycle.started', '');

      expect(log.committed).toEqual([]);
    });

    it('works for a caller that does not want the cycle signal', () => {
      const statuses: StreamStatus[] = [];

      // `onCycleCommitted` is optional, and the presence hook is not the only
      // caller. An unguarded call here would throw inside a frame handler.
      openPresenceStream({
        onStatus: (status) => {
          statuses.push(status);
        },
        onState: () => {},
      });

      expect(() => sourceFor().emit('cycle.completed', '')).not.toThrow();
      expect(statuses).toEqual(['connecting']);
    });
  });

  describe('when it drops', () => {
    it('waits out a drop the browser will retry by itself', () => {
      openPresenceStream(log.handlers);
      const source = sourceFor();
      source.emit('state', JSON.stringify(FRAME));

      source.drop();

      // The server opens every stream with `retry: 2000`, so `EventSource` reconnects
      // on its own object with its own cursor. This file must not close it, must not
      // open a second one, and must say "connecting" rather than "unavailable" —
      // announcing a refusal here would send the interface to its unreachable state
      // over a reconnect that is already in flight.
      expect(log.status).toBe('connecting');
      expect(source.closes).toBe(0);
      expect(FakeEventSource.built).toHaveLength(1);
    });

    it('reports unavailable when the server refused', () => {
      openPresenceStream(log.handlers);

      // `readyState === CLOSED` after an error is how `503 not_available` arrives:
      // realtime switched off, or no owner enrolled yet. `EventSource` will not retry
      // it, so neither does this — a refusal is an answer.
      sourceFor().refuse();

      expect(log.statuses).toEqual(['connecting', 'unavailable']);
      expect(FakeEventSource.built).toHaveLength(1);
    });

    it('says nothing more once it has been closed', () => {
      openPresenceStream(log.handlers).close();
      const source = sourceFor();

      expect(log.statuses).toEqual(['connecting', 'closed']);
      expect(source.closes).toBe(1);

      // `close()` on an `EventSource` fires an error event on some browsers. Reported,
      // it would leave the interface saying she is unreachable seconds after the
      // person deliberately walked away from her.
      source.refuse();
      expect(log.statuses).toEqual(['connecting', 'closed']);
    });

    it('closes once however many times it is asked', () => {
      const handle = openPresenceStream(log.handlers);

      handle.close();
      handle.close();

      // An interface that unmounts twice — a strict-mode double effect, say — must
      // not report `closed` twice or close a stream the browser has already released.
      expect(sourceFor().closes).toBe(1);
      expect(log.statuses).toEqual(['connecting', 'closed']);
    });
  });


});



