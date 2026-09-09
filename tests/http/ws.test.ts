/**
 * The gate in front of her voice socket.
 *
 * `server/http/ws.ts` is the only file in `server/` that answers an HTTP `upgrade`,
 * and until this one it had no test at all. `tests/http/transport.test.ts` drives
 * every route over a real port and never upgrades; `tests/http/state.test.ts` builds
 * a `VoiceSession` directly, with a fake channel and no socket under it. So the whole
 * of the gate — four refusals, two caps, a frame ceiling — was reachable only by hand.
 *
 * That is the wrong place to have no tests, because every claim the gate makes fails
 * *open*. A cross-site check that stopped working leaves a working socket. A session
 * cap that stopped counting leaves a working socket. An unknown path that hangs
 * instead of answering leaves a socket that looks like it is still connecting. None
 * of those produce a visible failure until somebody unwelcome is on the other end.
 *
 * ## Refusals are read as HTTP, not as close codes
 *
 * `rejectUpgrade` writes a real status line and destroys the socket, so a refused
 * upgrade never becomes a WebSocket at all — the `ws` client reports it through
 * `unexpected-response`, not `close`. Hence `status === 401` below and not
 * `code === 4401`: the 4401/4403 numbers are what the *client* closes with, to mark
 * a failure it must not retry.
 *
 * ## The ear is fake; everything under it is production
 *
 * A `Mouth` stands in for Gemini Live, because this suite has to run with no
 * `GOOGLE_API_KEY` and no network. The rest is real: a bound port, a real handshake,
 * `attachVoiceGateway` on the real `upgrade` event, a cookie out of
 * `POST /api/bootstrap`, and twelve real cognitive stages behind a `say`.
 */

import { resolve } from 'node:path';

import { WebSocket, type RawData } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type MadhuritaApp } from '@server/app.js';
import { loadConfig } from '@server/config/env.js';
import { createHttpServer, type RunningHttpServer } from '@server/http/index.js';
import {
  MAX_FRAME_BYTES,
  MAX_SESSIONS_PER_IDENTITY,
  VOICE_PATH,
  attachVoiceGateway,
  type VoiceGateway,
} from '@server/http/ws.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import {
  CLOSE_GOING_AWAY,
  INPUT_SAMPLE_RATE,
  MAX_AUDIO_FRAME_BYTES,
  OUTPUT_SAMPLE_RATE,
  type ClientMessage,
  type LiveTransport,
  type ServerMessage,
  type VoiceEar,
} from '@server/voice/live/index.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');
const PASSPHRASE = 'a passphrase long enough to pass';

/**
 * Gemini Live, reduced to what the gate can be held to.
 *
 * `heard` is the base64 the provider hop was handed, which is the only place a
 * microphone frame can be observed *arriving* — everything before it is a socket
 * and everything after it is somebody else's API.
 */
class Mouth implements LiveTransport {
  readonly heard: string[] = [];
  readonly rendered: string[] = [];
  readonly activity: string[] = [];
  closes = 0;

  sendAudio(base64Pcm16: string): void {
    this.heard.push(base64Pcm16);
  }

  activityStart(): void {
    this.activity.push('start');
  }

  activityEnd(): void {
    this.activity.push('end');
  }

  render(text: string): void {
    this.rendered.push(text);
  }

  close(): void {
    this.closes += 1;
  }
}

/** The ear the gateway is built with, and the handle this file keeps on it. */
function earFor(mouth: Mouth): VoiceEar {
  return {
    config: { model: 'fake-live', systemInstruction: 'read the line', temperature: 0 },
    connect: () => Promise.resolve(mouth),
  };
}

/** Fails loudly rather than hanging when a frame never arrives. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Waits for something no frame announces.
 *
 * The provider side of the gateway has no event to await — `mouth.heard` growing is
 * the *absence* of a message on the socket. Polling is honest here in a way that a
 * fixed sleep is not: a sleep asserts a duration, this asserts the condition.
 */
async function eventually(ready: () => boolean, what: string, ms = 4_000): Promise<void> {
  if (ready()) return;
  let poll: NodeJS.Timeout | undefined;
  try {
    await withTimeout(
      new Promise<void>((done) => {
        poll = setInterval(() => {
          if (ready()) done();
        }, 5);
      }),
      ms,
      what,
    );
  } finally {
    if (poll !== undefined) clearInterval(poll);
  }
}

/** What `rejectUpgrade` writes: a status line and the same envelope every route uses. */
interface Refusal {
  readonly status: number;
  readonly code: string;
  /**
   * Kept because it is the only thing that says *who* refused.
   *
   * The gateway and Express both answer an unserved path 404 `not_found`, and the
   * two are a different guarantee: one is the gate turning a socket away, the other
   * is there being no socket at that path at all. Only the sentence tells them apart.
   */
  readonly message: string;
}

/** `RawData` is a `Buffer`, an `ArrayBuffer`, or a list of `Buffer`s. */
const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/**
 * The browser's side of the socket.
 *
 * `settled` is the whole reason this class exists: a refused upgrade and an accepted
 * one are different *events* on the `ws` client, and a test that only awaited `open`
 * would hang for its timeout on every refusal rather than reading the status.
 */
class Socket {
  readonly frames: ServerMessage[] = [];
  readonly audio: Buffer[] = [];
  /** Resolves to the refusal, or to `undefined` once the handshake succeeded. */
  readonly settled: Promise<Refusal | undefined>;
  private readonly ws: WebSocket;
  private readonly wake: (() => void)[] = [];
  private ending: { code: number; reason: string } | undefined;

  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers });
    this.settled = new Promise<Refusal | undefined>((done, fail) => {
      let over = false;
      const once = (run: () => void): void => {
        if (over) return;
        over = true;
        run();
      };
      this.ws.on('open', () => once(() => done(undefined)));
      this.ws.on('unexpected-response', (req, res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        // `close` rather than `end`: the server destroys the socket immediately
        // after writing, so an aborted response would never reach `end` and the
        // status — which did arrive — would be lost to a timeout.
        res.on('close', () => {
          req.destroy();
          once(() => done(refusalFrom(res.statusCode ?? 0, Buffer.concat(chunks).toString())));
        });
      });
      this.ws.on('error', (error) => once(() => fail(error)));
    });
    this.listen();
  }

  private listen(): void {
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) this.audio.push(toBuffer(data));
      else this.frames.push(JSON.parse(toBuffer(data).toString()) as ServerMessage);
      this.notify();
    });
    this.ws.on('close', (code: number, reason: Buffer) => {
      this.ending = { code, reason: reason.toString() };
      this.notify();
    });
  }

  private notify(): void {
    for (const run of this.wake.splice(0)) run();
  }

  /** Every `state` frame in arrival order — the FSM as the browser saw it. */
  get states(): string[] {
    return this.frames.flatMap((frame) => (frame.t === 'state' ? [frame.state] : []));
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private until(ready: () => boolean, what: string, ms = 8_000): Promise<void> {
    return withTimeout(
      new Promise<void>((done, fail) => {
        const check = (): void => {
          if (ready()) return done();
          // A closed socket will never produce the frame, so say so now rather
          // than in eight seconds with nothing but a timeout to read.
          if (this.ending !== undefined) {
            return fail(new Error(`socket closed ${this.ending.code} while waiting for ${what}`));
          }
          this.wake.push(check);
        };
        check();
      }),
      ms,
      what,
    );
  }

  async waitFor<T extends ServerMessage['t']>(t: T): Promise<Extract<ServerMessage, { t: T }>> {
    const found = (): Extract<ServerMessage, { t: T }> | undefined =>
      this.frames.find((frame): frame is Extract<ServerMessage, { t: T }> => frame.t === t);
    await this.until(() => found() !== undefined, `a '${t}' frame`);
    const frame = found();
    if (frame === undefined) throw new Error(`'${t}' vanished between wait and read`);
    return frame;
  }

  /** Waits for a count of frames of one type, for the ones that repeat. */
  async waitForCount(t: ServerMessage['t'], count: number): Promise<void> {
    await this.until(
      () => this.frames.filter((frame) => frame.t === t).length >= count,
      `${count} '${t}' frames`,
    );
  }

  async ended(): Promise<{ code: number; reason: string }> {
    await this.until(() => this.ending !== undefined, 'the socket to close');
    if (this.ending === undefined) throw new Error('unreachable');
    return this.ending;
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Not-JSON, and anything else no schema would accept. */
  sendRaw(text: string): void {
    this.ws.send(text);
  }

  sendFrame(bytes: Uint8Array): void {
    this.ws.send(bytes, { binary: true });
  }

  close(): void {
    this.ws.close();
  }
}

function refusalFrom(status: number, body: string): Refusal {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string } };
    return { status, code: parsed.error?.code ?? '', message: parsed.error?.message ?? '' };
  } catch {
    return { status, code: '', message: body };
  }
}

describe('the gate in front of her voice socket', () => {
  let db: Database;
  let app: MadhuritaApp;
  let http: RunningHttpServer;
  let gateway: VoiceGateway;
  let mouth: Mouth;
  /** Every `error.raised` the gateway reported, read off the bus rather than a console. */
  let raised: string[];
  let cookie: string;
  let bearer: string;
  let sockets: Socket[];

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({
      // Sweeps off: a task poll or a proactive tick mid-turn would add events and
      // cycles this suite would have to tolerate on the socket.
      config: loadConfig({ FLAG_TASKS: 'false', FLAG_PROACTIVITY: 'false' }),
      db,
      installGlobalDatabase: false,
    });
    await app.start();
    mouth = new Mouth();
    raised = [];
    // `deps.report` is deliberately left alone. Its production path publishes
    // `error.raised`, so subscribing here asserts the auditable event the operator
    // would actually see — a stubbed `report` would assert a function call instead.
    app.eventBus.subscribe((event) => {
      const payload = event.payload as { where?: string; message?: string };
      raised.push(`${payload.where ?? ''}: ${payload.message ?? ''}`);
    }, ['error.raised']);
    sockets = [];

    http = await createHttpServer({
      deps: app.routeDeps,
      port: 0,
      host: '127.0.0.1',
      // Exactly how `server/main.ts:96` attaches it, which is the point: the
      // gateway must reach the `upgrade` event without `server.ts` importing `ws`.
      attach: (server) => {
        gateway = attachVoiceGateway(server, { deps: app.routeDeps, ear: earFor(mouth) });
        return gateway;
      },
    }).start();

    const res = await fetch(`${http.url}/api/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ displayName: 'Ankit', preferredName: 'Ankit', passphrase: PASSPHRASE }),
    });
    expect(res.status).toBe(201);
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    bearer = ((await res.json()) as { token: string }).token;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    await gateway.close();
    await http.stop();
    await app.stop();
    db.close();
    closeDatabase();
  });

  /**
   * One upgrade attempt, with the two headers a browser always sends.
   *
   * `ws` sends neither `Origin` nor `sec-fetch-site`, so a socket built without
   * these would be refused 403 by `assertNotCrossSite` — which would make the
   * cross-site tests below pass for the wrong reason.
   */
  const connect = (path = VOICE_PATH, headers: Record<string, string> = {}): Socket => {
    const merged = { cookie, origin: http.url, 'sec-fetch-site': 'same-origin', ...headers };
    // `''` means "send this header not at all", so a test can drop the cookie or
    // the fetch metadata without a second helper.
    const sent = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== ''));
    const socket = new Socket(`${http.url.replace('http', 'ws')}${path}`, sent);
    sockets.push(socket);
    return socket;
  };

  /** An upgrade that got as far as a live session, with her first frames read. */
  const connected = async (headers: Record<string, string> = {}): Promise<Socket> => {
    const socket = connect(VOICE_PATH, headers);
    expect(await socket.settled).toBeUndefined();
    await socket.waitFor('ready');
    return socket;
  };

  describe('who is let in', () => {
    it('answers an unknown path in HTTP rather than leaving the socket hanging', async () => {
      // Owning `upgrade` means owning every path: `ws` gets the event for
      // `/api/nowhere` too, and a gateway that simply ignored it would leave the
      // client's handshake open until a timeout somewhere else gave up.
      const refusal = await connect('/api/nowhere').settled;

      // The sentence is the assertion. Express answers an unrouted path with the
      // same 404 `not_found`, so `status` alone could not tell a gate that refused
      // from a gate that was never consulted — and the second of those is what a
      // removed `upgrade` listener looks like.
      expect(refusal).toEqual({ status: 404, code: 'not_found', message: 'No such socket.' });
      expect(gateway.openSessions).toBe(0);
    });

    it('refuses an upgrade carrying no credential at all', async () => {
      const refusal = await connect(VOICE_PATH, { cookie: '' }).settled;

      // 401 in HTTP, not a 4401 close frame: `rejectUpgrade` answers before any
      // WebSocket exists, so there is nothing to close. The 4401 the client knows
      // is the one *it* closes with to mark a failure not worth retrying.
      expect(refusal).toMatchObject({ status: 401, code: 'no_credential' });
      expect(gateway.openSessions).toBe(0);
    });

    it('closes the door on a socket another site opened with his cookie', async () => {
      // Cross-Site WebSocket Hijacking. The browser attaches her session cookie to
      // an upgrade from any origin and the same-origin policy does not apply to
      // WebSockets, so without this check any page he had open could hold a live
      // duplex channel into her — read his transcript, and speak as him.
      const refusal = await connect(VOICE_PATH, { 'sec-fetch-site': 'cross-site' }).settled;

      expect(refusal).toMatchObject({ status: 403, code: 'bad_origin' });
      expect(gateway.openSessions).toBe(0);
    });

    it('refuses a foreign Origin even from a client that sends no fetch metadata', async () => {
      // `sec-fetch-site` is the first thing `assertNotCrossSite` reads, and an
      // attacker's tooling simply does not send it. So `Origin` has to be checked
      // on its own, and it has to be *required* rather than treated as absent-means-fine.
      const refusal = await connect(VOICE_PATH, {
        origin: 'https://not-his-machine.example',
        'sec-fetch-site': '',
      }).settled;

      expect(refusal).toMatchObject({ status: 403, code: 'bad_origin' });
    });

    it('lets a bearer token in from anywhere, because the guard is about ambient credentials', async () => {
      // The cross-site check exists because a browser sends cookies it was not
      // asked to send. A bearer token is one a client had to be given and had to
      // attach, so no other page can borrow it — which is why `assertNotCrossSite`
      // returns immediately for `via === 'bearer'`. A native app or a CLI has no
      // origin to present and must still be able to talk to her.
      const socket = connect(VOICE_PATH, {
        cookie: '',
        authorization: `Bearer ${bearer}`,
        origin: 'https://some-other-tool.example',
        'sec-fetch-site': 'cross-site',
      });

      expect(await socket.settled).toBeUndefined();
      expect((await socket.waitFor('ready')).canHear).toBe(true);
    });
  });

  describe('how many she will hold', () => {
    it('holds two sockets for one identity and refuses the third', async () => {
      // A valid cookie plus a reconnect loop is a client that opens a Gemini Live
      // session every few seconds, each one billed and each one holding a model
      // connection. Two is a phone and a laptop; the third is a bug or an attack.
      await connected();
      await connected();
      expect(gateway.openSessions).toBe(MAX_SESSIONS_PER_IDENTITY);

      const refusal = await connect().settled;

      // The same status as the rate limiter and the global cap, which all three
      // reach through `rejectUpgrade(429)` — `MAX_SESSIONS` itself would need four
      // enrolled identities to observe and shares this path exactly.
      expect(refusal).toMatchObject({ status: 429, code: 'too_many_requests' });
      expect(gateway.openSessions).toBe(MAX_SESSIONS_PER_IDENTITY);
    });

    it('gives the slot back when a socket goes away', async () => {
      const first = await connected();
      await connected();

      first.close();
      await first.ended();
      // The count is decremented by the socket's own `close` handler, so a closed
      // tab must free a slot without any explicit `bye`. Without `forget`, two
      // reloads would lock him out of his own voice until a restart.
      await eventually(
        () => gateway.openSessions < MAX_SESSIONS_PER_IDENTITY,
        'the slot to be freed',
      );

      const third = await connected();
      expect(third.open).toBe(true);
    });
  });

  describe('a turn over the wire', () => {
    it('opens with the two sample rates the browser has to configure itself for', async () => {
      const ready = await (await connected()).waitFor('ready');

      // The browser cannot guess these: it has to resample the microphone to
      // `INPUT_SAMPLE_RATE` and play her back at `OUTPUT_SAMPLE_RATE`, and they are
      // not the same number. A `ready` that omitted them would leave the client
      // hardcoding two constants that live in `server/voice/live/wire.ts`.
      expect(ready.inputSampleRate).toBe(INPUT_SAMPLE_RATE);
      expect(ready.outputSampleRate).toBe(OUTPUT_SAMPLE_RATE);
      expect(ready.state).toBe('listening');
      expect(ready.canHear).toBe(true);
      expect(ready.conversationId).not.toBe('');
      expect(gateway.openSessions).toBe(1);
    });

    it('answers a typed turn with words of her own, over the same socket', async () => {
      const socket = await connected();

      socket.send({ t: 'say', text: 'kaisi ho' });
      const said = await socket.waitFor('said');

      // A real cycle ran: `cycleId` is the record's id, and with no language
      // faculty configured the words are stage 9's deterministic draft — which is
      // the configuration this suite runs in and the one the socket has to be
      // honest about.
      expect(said.cycleId).not.toBe('');
      expect(said.text.trim()).not.toBe('');
      // And the same words went to the mouth, because a `said` the provider never
      // received is a caption for audio nobody will hear.
      expect(mouth.rendered.join(' ')).toContain(said.text.trim().slice(0, 12));
      expect(socket.states).toEqual(['connecting', 'listening', 'thinking', 'speaking']);
      expect(raised).toEqual([]);
    });

    it('rejects a frame that is not JSON without dropping the socket', async () => {
      const socket = await connected();

      socket.sendRaw('{not json at all');
      const error = await socket.waitFor('error');

      // Non-fatal on purpose: one corrupt frame is a client bug, and closing the
      // socket over it would take her whole conversation down with the frame.
      expect(error.code).toBe('invalid_request');
      expect(error.fatal).toBe(false);
      expect(socket.open).toBe(true);
    });

    it('carries a microphone frame to the provider only once speech has been declared', async () => {
      const socket = await connected();
      const pcm = new Uint8Array(640).fill(7);

      // A stray frame before `listen`. Frames are handled strictly in order, so
      // waiting for the `listen` that follows it proves the queue has already run
      // past it — no sleep, and no chance of asserting before it was handled.
      socket.sendFrame(pcm);
      socket.send({ t: 'listen' });
      await eventually(() => mouth.activity.includes('start'), 'the ear to open');

      // Dropped in silence, not answered: a client whose voice detection is
      // misbehaving would otherwise get twenty error frames a second.
      expect(mouth.heard).toEqual([]);
      expect(socket.frames.some((frame) => frame.t === 'error')).toBe(false);

      socket.sendFrame(pcm);
      await eventually(() => mouth.heard.length === 1, 'a frame at the provider');

      // Base64 on the provider hop and nowhere else, and the samples survive it.
      expect(Buffer.from(mouth.heard[0] ?? '', 'base64')).toEqual(Buffer.from(pcm));

      socket.send({ t: 'hush' });
      await eventually(() => mouth.activity.includes('end'), 'the ear to close');
      expect(mouth.activity).toEqual(['start', 'end']);
    });

    it('answers one oversized frame rather than forwarding it', async () => {
      const socket = await connected();
      socket.send({ t: 'listen' });
      await eventually(() => mouth.activity.includes('start'), 'the ear to open');

      socket.sendFrame(new Uint8Array(MAX_AUDIO_FRAME_BYTES + 1));
      const error = await socket.waitFor('error');

      // Non-fatal: a frame twice the expected size is a resampler bug in the
      // browser, and the turn is still recoverable. What must not happen is the
      // frame reaching a billed provider connection.
      expect(error.code).toBe('frame_too_large');
      expect(error.fatal).toBe(false);
      expect(mouth.heard).toEqual([]);
      expect(socket.open).toBe(true);
    });

    it('closes the socket rather than buffering a frame past the wire ceiling', async () => {
      const socket = await connected();

      socket.sendFrame(new Uint8Array(MAX_FRAME_BYTES + 1));

      // `maxPayload` on the `WebSocketServer`, which is the only limit that can
      // refuse a frame *before* it is in memory: a ceiling checked inside
      // `handleAudioFrame` has already paid for the allocation. 1009 is the
      // protocol's own "message too big".
      expect((await socket.ended()).code).toBe(1009);
      // And it is reported rather than swallowed, so a client doing this on a loop
      // leaves a trail an operator can find.
      expect(raised.join('\n')).toContain('voice socket');
    });
  });

  describe('shutting down', () => {
    it('closes her provider session before the listener goes', async () => {
      const socket = await connected();
      expect(gateway.openSessions).toBe(1);

      await gateway.close();

      // The reason this is `await`ed in `server/http/server.ts` before
      // `server.close()`: an evening of live audio must not outlive the process
      // that authorized it, and a provider session nobody closed keeps billing.
      expect(mouth.closes).toBe(1);
      expect(gateway.openSessions).toBe(0);
      expect((await socket.ended()).code).toBe(CLOSE_GOING_AWAY);
    });

    it('stops being a socket at all once it has been closed', async () => {
      await gateway.close();

      const refusal = await connect().settled;

      // Not the 503 the `closing` guard writes — that branch covers only an upgrade
      // already in flight, because `close()` removes the listener in the same
      // synchronous breath as it sets the flag. With no `upgrade` listener left,
      // Node hands the request to the ordinary request handler, so Express answers
      // it: `No such endpoint.`, from `server/http/server.ts:163`. Which is the
      // honest answer — after the close there is no socket there to upgrade to.
      expect(refusal).toEqual({ status: 404, code: 'not_found', message: 'No such endpoint.' });
      expect(gateway.openSessions).toBe(0);
    });
  });
});
