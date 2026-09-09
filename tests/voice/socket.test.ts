// @vitest-environment jsdom

/**
 * The browser's half of her voice socket.
 *
 * `src/lib/voice.ts` is the only thing in the client that talks to her, and it owns
 * three decisions no server test can reach: which close codes are worth retrying,
 * how long to wait before retrying them, and what to do with a frame that arrives
 * while the socket is backed up. `tests/http/ws.test.ts` drives the real gateway over
 * a real socket and can see none of it — by the time a client is reconnecting, the
 * server has already forgotten the socket that closed.
 *
 * Each of those three fails quietly in a way a person would misread as her being
 * broken rather than the transport:
 *
 *  - a 4401 that gets retried is an infinite reconnect loop against a server that
 *    will keep saying no, which reads on screen as "connecting" forever;
 *  - a backoff that never resets turns one bad minute into an eight-second wait for
 *    the rest of the session;
 *  - audio that is buffered instead of dropped arrives late and is transcribed as one
 *    long garbled turn, which reaches her cognition as something he actually said.
 *
 * ## The socket is fake and the clock is fake; nothing else is
 *
 * A `FakeSocket` stands in for `WebSocket` because a real one needs a server, and
 * this file is about what the client does *after* a socket closes. `vi.useFakeTimers`
 * for the same reason a real timer would make the backoff tests eight seconds long
 * each. Everything else is the shipped module: the real dispatch table, the real
 * `ClientMessage` JSON, the real close-code constants imported from `server/`.
 *
 * ## Delays are asserted as a band, not a number
 *
 * `backoffFor` jitters every delay by ±25%, deliberately, so that a server that
 * dropped a thousand sockets does not get them all back in the same millisecond.
 * So a test cannot assert "reconnects at 1000ms" without either freezing
 * `Math.random` — which asserts the jitter away — or accepting a flake. These
 * advance the clock to just inside the band's floor and assert *nothing* happened,
 * then past its ceiling and assert it did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHENTICATED,
  MAX_SAY_LENGTH,
} from '@server/voice/live/wire.js';

import {
  MAX_BUFFERED_BYTES,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  openVoiceSocket,
  type VoiceHandlers,
  type VoiceReady,
  type VoiceStatus,
} from '../../src/lib/voice.js';

/**
 * `WebSocket`, reduced to the seven members the module touches.
 *
 * The static `OPEN` matters as much as the instance members: `sendJson` compares
 * `socket.readyState` against `WebSocket.OPEN` read off the *global*, so a fake
 * without it would report every socket closed and every `say` would silently fail.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket the module has constructed, in order, including retries. */
  static readonly built: FakeSocket[] = [];

  readyState: number = FakeSocket.CONNECTING;
  /** Left at the platform default, so the module has to be the one to change it. */
  binaryType = 'blob';
  bufferedAmount = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: unknown = () => {};
  readonly sent: string[] = [];
  readonly sentBytes: Uint8Array[] = [];
  closedWith: { code: number; reason: string } | undefined;

  constructor(readonly url: string) {
    FakeSocket.built.push(this);
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sent.push(data);
    else this.sentBytes.push(new Uint8Array(data));
  }

  close(code = 1000, reason = ''): void {
    this.closedWith = { code, reason };
    this.readyState = FakeSocket.CLOSED;
  }

  // ── The server's side of it ───────────────────────────────────────────────

  /** The handshake completed. There is no `onopen`: `ready` is the signal. */
  accept(): this {
    this.readyState = FakeSocket.OPEN;
    return this;
  }

  deliver(message: object): void {
    this.text(JSON.stringify(message));
  }

  text(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  /** One binary frame, as `binaryType = 'arraybuffer'` would produce it. */
  audio(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }

  hangUp(code: number, reason = 'from the server'): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

/**
 * Every handler call, in order.
 *
 * The status *list* is the point rather than the final status: `onStatus` is what the
 * interface reads to decide between "connecting", "she cannot be reached" and "say
 * something", so a transition that fires twice or arrives out of order is a visible
 * defect even when the value it settles on is right.
 */
class Log {
  readonly statuses: VoiceStatus[] = [];
  readonly ready: VoiceReady[] = [];
  readonly states: string[] = [];
  readonly heard: { text: string; final: boolean }[] = [];
  readonly said: { text: string; cycleId: string }[] = [];
  readonly silent: string[] = [];
  readonly audio: Uint8Array[] = [];
  readonly flushed: string[] = [];
  readonly errors: { code: string; message: string; fatal: boolean }[] = [];
  turnEnds = 0;

  readonly handlers: VoiceHandlers = {
    onStatus: (status) => {
      this.statuses.push(status);
    },
    onReady: (ready) => {
      this.ready.push(ready);
    },
    onState: (state, reason) => {
      this.states.push(`${state}:${reason}`);
    },
    onHeard: (text, final) => {
      this.heard.push({ text, final });
    },
    onSaid: (text, cycleId) => {
      this.said.push({ text, cycleId });
    },
    onSilent: (cycleId) => {
      this.silent.push(cycleId);
    },
    onAudio: (bytes) => {
      this.audio.push(bytes);
    },
    onFlush: (reason) => {
      this.flushed.push(reason);
    },
    onTurnEnd: () => {
      this.turnEnds += 1;
    },
    onError: (code, message, fatal) => {
      this.errors.push({ code, message, fatal });
    },
  };
}

/** `globalThis`, narrowed to the one member these tests replace. */
const runtime = globalThis as unknown as { WebSocket?: unknown };
const realWebSocket = runtime.WebSocket;

/** The socket the module built most recently — the live one, or the newest retry. */
const latest = (): FakeSocket => {
  const socket = FakeSocket.built[FakeSocket.built.length - 1];
  if (socket === undefined) throw new Error('the module built no socket at all');
  return socket;
};

/** A socket that has completed its handshake and sent `ready`. */
const live = (log: Log, over: Partial<VoiceReady> = {}): FakeSocket => {
  const before = log.ready.length;
  const socket = latest().accept();
  socket.deliver({
    t: 'ready',
    state: 'listening',
    inputSampleRate: 16_000,
    outputSampleRate: 24_000,
    canHear: true,
    conversationId: 'conv_test',
    ...over,
  });
  expect(log.ready, 'the module did not report `ready`').toHaveLength(before + 1);
  return socket;
};

/**
 * Advances the clock across one backoff band and asserts the retry landed inside it.
 *
 * `base` is the un-jittered delay. Nothing may happen before the band's floor
 * (`0.75 × base`) and a socket must exist by its ceiling (`1.25 × base`) — the
 * strongest claim available about a deliberately jittered number without freezing
 * `Math.random` and asserting the jitter away.
 */
const retryWithin = (base: number): FakeSocket => {
  const before = FakeSocket.built.length;
  vi.advanceTimersByTime(Math.floor(base * 0.75) - 1);
  expect(FakeSocket.built, `retried below the floor of the ${base}ms band`).toHaveLength(before);
  vi.advanceTimersByTime(Math.ceil(base * 0.5) + 1);
  expect(FakeSocket.built, `no retry by the ceiling of the ${base}ms band`).toHaveLength(before + 1);
  return latest();
};

/** The `ClientMessage` tags this socket put on the wire, in order. */
const tagsOn = (socket: FakeSocket): string[] =>
  socket.sent.map((raw) => (JSON.parse(raw) as { t: string }).t);

describe('The browser end of the voice socket (src/lib/voice.ts)', () => {
  let log: Log;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.built.length = 0;
    runtime.WebSocket = FakeSocket;
    log = new Log();
  });

  afterEach(() => {
    // Real timers first: `useRealTimers` discards the fake queue, so a pending
    // backoff from a test that ended mid-reconnect cannot fire into the next one.
    vi.useRealTimers();
    runtime.WebSocket = realWebSocket;
  });

  describe('opening', () => {
    it('opens ws:// at the gateway path on the page’s own origin', () => {
      openVoiceSocket(log.handlers);

      // jsdom serves the document over `http:`, so the scheme has to be `ws:`. A
      // hard-coded `wss:` — the obvious way to write this line — would pass every
      // deployed run and fail every localhost one.
      expect(latest().url).toBe(`ws://${location.host}/api/voice`);
    });

    it('asks for ArrayBuffer frames before any frame can arrive', () => {
      openVoiceSocket(log.handlers);

      // Set during construction, not on `ready`: a `Blob` is read asynchronously, so
      // two chunks of her voice landing in one tick would decode in whichever order
      // their reads resolved and come out with two syllables swapped.
      expect(latest().binaryType).toBe('arraybuffer');
    });

    it('is not live until `ready`, and hands over everything in it', () => {
      const handle = openVoiceSocket(log.handlers);

      // An open socket is not a live one. The gateway can still refuse after the
      // handshake — 4403 arrives on an open socket — so anything sent here is lost.
      latest().accept();
      expect(handle.status).toBe('connecting');
      expect(log.statuses).toEqual([]);

      live(log);

      expect(handle.status).toBe('live');
      // `'connecting'` is the handle's initial value, so it is read rather than
      // announced; the first thing the interface is *told* is that she is reachable.
      expect(log.statuses).toEqual(['live']);
      expect(log.ready[0]).toEqual({
        state: 'listening',
        inputSampleRate: 16_000,
        outputSampleRate: 24_000,
        canHear: true,
        conversationId: 'conv_test',
      });
    });

    it('degrades to an inert handle where there is no WebSocket', () => {
      delete runtime.WebSocket;

      const handle = openVoiceSocket(log.handlers);

      // No throw, no rejection, and `say` answers `false` — which is the truth:
      // nothing was sent. A caller's code is identical in jsdom and in a browser.
      expect(handle.status).toBe('unavailable');
      expect(log.statuses).toEqual(['unavailable']);
      expect(handle.say('hello')).toBe(false);
      expect(() => {
        handle.listen();
        handle.hush();
        handle.cancel();
        handle.sendAudio(new Int16Array(2));
        handle.close();
      }).not.toThrow();
      expect(FakeSocket.built).toHaveLength(0);
    });
  });

  describe('frames coming in', () => {
    it('hands binary frames straight through, in order', () => {
      openVoiceSocket(log.handlers);
      const socket = live(log);

      socket.audio(new Uint8Array([1, 2, 3]));
      socket.audio(new Uint8Array([4, 5]));

      // Order is the assertion. These are consecutive slices of one sentence, and
      // playback concatenates them in arrival order — swapped, they are a stutter.
      expect(log.audio.map((bytes) => [...bytes])).toEqual([
        [1, 2, 3],
        [4, 5],
      ]);
      expect(log.audio[0]).toBeInstanceOf(Uint8Array);
    });

    it('ignores a malformed frame without tearing the socket down', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = live(log);

      socket.text('{"t":"said"');

      expect(log.errors).toEqual([]);
      expect(handle.status).toBe('live');
      // The load-bearing half: a frame that arrives *after* the bad one still
      // dispatches. Asserting only that nothing threw would pass against a `catch`
      // that closed the socket, which would drop her mid-sentence over one bad byte.
      socket.deliver({ t: 'turn_end' });
      expect(log.turnEnds).toBe(1);
    });

    it('routes every server frame to its own handler', () => {
      openVoiceSocket(log.handlers);
      const socket = live(log);

      // One frame per remaining `ServerMessage` variant. A missing `case` in the
      // dispatch table is not a crash — it is a message silently thrown away, which
      // on screen is her failing to answer.
      socket.deliver({ t: 'state', state: 'thinking', reason: 'heard him' });
      socket.deliver({ t: 'heard', text: 'kaisi', final: false });
      socket.deliver({ t: 'heard', text: 'kaisi ho', final: true });
      socket.deliver({ t: 'said', text: 'theek hoon', cycleId: 'cyc_1' });
      socket.deliver({ t: 'silent', cycleId: 'cyc_2' });
      socket.deliver({ t: 'flush', reason: 'interrupted' });
      socket.deliver({ t: 'turn_end' });
      socket.deliver({ t: 'error', code: 'invalid_request', message: 'no', fatal: false });

      expect(log.states).toEqual(['thinking:heard him']);
      expect(log.heard).toEqual([
        { text: 'kaisi', final: false },
        { text: 'kaisi ho', final: true },
      ]);
      expect(log.said).toEqual([{ text: 'theek hoon', cycleId: 'cyc_1' }]);
      expect(log.silent).toEqual(['cyc_2']);
      expect(log.flushed).toEqual(['interrupted']);
      expect(log.turnEnds).toBe(1);
      expect(log.errors).toEqual([{ code: 'invalid_request', message: 'no', fatal: false }]);
    });
  });

  describe('frames going out', () => {
    it('puts one tagged frame on the wire per control', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = live(log);

      handle.listen();
      handle.hush();
      handle.cancel();

      // A misspelled tag is refused by the gateway's `.strict()` schema, which means
      // her ear never opens and the only symptom is that she does not answer.
      expect(tagsOn(socket)).toEqual(['listen', 'hush', 'cancel']);
    });

    it('refuses to send anything before the socket is live', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = latest();

      // Mid-handshake. `say` reporting `true` here would have a composer clear itself
      // over a turn that was never sent.
      expect(handle.say('kuch bolo')).toBe(false);
      handle.listen();
      expect(socket.sent).toEqual([]);
    });

    it('sends a trimmed `say`, and answers false for the three it will not send', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = live(log);

      expect(handle.say('  theek hoon  ')).toBe(true);
      expect(socket.sent).toEqual([JSON.stringify({ t: 'say', text: 'theek hoon' })]);

      expect(handle.say('   ')).toBe(false);
      // The boundary is inclusive: exactly `MAX_SAY_LENGTH` is a sentence the gateway
      // accepts, so refusing it here would be the client inventing a stricter limit.
      expect(handle.say('x'.repeat(MAX_SAY_LENGTH))).toBe(true);
      expect(handle.say('x'.repeat(MAX_SAY_LENGTH + 1))).toBe(false);

      expect(socket.sent).toHaveLength(2);
    });

    it('drops and counts audio once the socket is backed up', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = live(log);

      // One byte over. `send` would queue this in memory without complaint, and the
      // backlog would be transcribed later as one long garbled turn — which reaches
      // her cognition as something he actually said.
      socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      handle.sendAudio(new Int16Array([1, 2]));
      expect(socket.sentBytes).toEqual([]);
      expect(handle.droppedFrames).toBe(1);

      // Exactly at the ceiling is not over it.
      socket.bufferedAmount = MAX_BUFFERED_BYTES;
      handle.sendAudio(new Int16Array([1, 2]));
      expect(socket.sentBytes).toHaveLength(1);
      expect(handle.droppedFrames).toBe(1);
    });

    it('sends the frame’s own bytes and not its backing buffer', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = live(log);

      // A view into the middle of a larger buffer, the shape pooling would produce.
      // `send(view.buffer)` ignores the offset and length, so it would ship all
      // sixteen poison bytes: silence and noise around two real samples.
      const backing = new ArrayBuffer(16);
      new Int16Array(backing).fill(-1);
      const frame = new Int16Array(backing, 4, 2);
      frame[0] = 7;
      frame[1] = 9;

      handle.sendAudio(frame);

      // PCM16 little-endian, as the wire format declares.
      expect([...(socket.sentBytes[0] ?? [])]).toEqual([7, 0, 9, 0]);
    });
  });

  describe('when the socket drops', () => {
    it.each([
      [CLOSE_UNAUTHENTICATED, 'unauthenticated' as VoiceStatus],
      [CLOSE_FORBIDDEN, 'forbidden' as VoiceStatus],
    ])('never retries %i, because it is a settled fact', (code, expected) => {
      const handle = openVoiceSocket(log.handlers);
      live(log).hangUp(code);

      expect(handle.status).toBe(expected);
      expect(log.statuses).toEqual(['live', expected]);

      // The whole point. Both codes are answers about *who is asking*, so a retry is
      // an infinite loop against a server that will keep saying no — which on screen
      // reads as "connecting" forever rather than as "she will not talk to you".
      vi.advanceTimersByTime(RETRY_MAX_MS * 10);
      expect(FakeSocket.built).toHaveLength(1);
    });

    it('doubles the wait to the ceiling and stays there', () => {
      const handle = openVoiceSocket(log.handlers);
      live(log).hangUp(1006);

      expect(handle.status).toBe('connecting');

      // 1s, 2s, 4s, 8s, then 8s again — `Math.min` against `RETRY_MAX_MS` is what
      // keeps a server that has been down for an hour from being retried next week.
      retryWithin(RETRY_BASE_MS).hangUp(1006);
      retryWithin(RETRY_BASE_MS * 2).hangUp(1006);
      retryWithin(RETRY_BASE_MS * 4).hangUp(1006);
      retryWithin(RETRY_MAX_MS).hangUp(1006);
      retryWithin(RETRY_MAX_MS);

      // One announcement across five attempts: the interface is told she is
      // connecting, not told again on every rung.
      expect(log.statuses).toEqual(['live', 'connecting']);
    });

    it('waits out a 4429 at the ceiling without spending a rung', () => {
      const handle = openVoiceSocket(log.handlers);
      live(log).hangUp(CLOSE_RATE_LIMITED);

      // Said plainly, because it is the one refusal a person can wait out.
      expect(handle.status).toBe('rate_limited');
      expect(log.statuses).toEqual(['live', 'rate_limited']);

      // Exact, not a band: this delay is deliberately un-jittered, because the server
      // asked for time rather than the client guessing at it.
      vi.advanceTimersByTime(RETRY_MAX_MS - 1);
      expect(FakeSocket.built).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.built).toHaveLength(2);

      // And it did not climb the ladder on the way: the next ordinary close is still
      // the first rung. Otherwise one rate limit would leave the rest of the session
      // reconnecting eight seconds at a time.
      latest().hangUp(1006);
      retryWithin(RETRY_BASE_MS);
    });

    it('starts the ladder over once she has answered again', () => {
      openVoiceSocket(log.handlers);
      live(log).hangUp(1006);
      retryWithin(RETRY_BASE_MS);

      // A socket that opens and is closed two frames later has not succeeded at
      // anything, so the reset hangs off `ready` rather than off `onopen`.
      live(log).hangUp(1006);

      // Back to the 1s band. Had the counter kept climbing, the 2s band could not
      // produce a socket before 1500ms and this line would find none by 1250ms.
      retryWithin(RETRY_BASE_MS);
    });
  });

  describe('closing', () => {
    it('says goodbye before it hangs up, and only once', () => {
      const handle = openVoiceSocket(log.handlers);
      const socket = live(log);

      handle.close();

      // `bye` first, then the close frame — WebSocket delivers in order, so the
      // gateway finalises the transcript before it sees the socket go. The order is
      // provable from these two facts together: `sendJson` requires an OPEN socket
      // and `close()` sets CLOSED, so a `bye` sent afterwards would not be here.
      expect(tagsOn(socket)).toEqual(['bye']);
      expect(socket.closedWith).toEqual({ code: CLOSE_GOING_AWAY, reason: 'client closed' });
      expect(handle.status).toBe('closed');
      expect(log.statuses).toEqual(['live', 'closed']);

      // Idempotent: an interface that unmounts twice must not send a second `bye`
      // into a socket the gateway has already forgotten.
      handle.close();
      expect(tagsOn(socket)).toEqual(['bye']);

      // And the server-side close that follows ours is not a reason to come back.
      socket.hangUp(CLOSE_GOING_AWAY);
      vi.advanceTimersByTime(RETRY_MAX_MS * 10);
      expect(FakeSocket.built).toHaveLength(1);
      expect(log.statuses).toEqual(['live', 'closed']);
    });

    it('cancels a reconnect that was already waiting', () => {
      const handle = openVoiceSocket(log.handlers);
      live(log).hangUp(1006);
      expect(vi.getTimerCount(), 'no backoff was pending to begin with').toBe(1);

      // Closed during the backoff, which is the ordinary case: he navigated away
      // while she was reconnecting. The timer is cleared rather than left to fire
      // into a `shut` flag — a page that is unmounting should not hold a pending
      // callback into a closure it has finished with.
      handle.close();
      expect(vi.getTimerCount()).toBe(0);

      vi.advanceTimersByTime(RETRY_MAX_MS * 10);
      expect(FakeSocket.built).toHaveLength(1);
      expect(handle.status).toBe('closed');
    });
  });




});




