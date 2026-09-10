/**
 * The WebSocket door, and the five things it has to get right before a socket
 * exists.
 *
 * This is the only file in the process that imports `ws`. Everything the voice
 * feature actually does is behind `VoiceClientChannel`, so the orchestrator, the
 * drift check and the drop rule are all tested without a socket, a key or a
 * network — and this file is thin enough to read in one sitting, which is what a
 * security boundary should be.
 *
 * ## 1. An upgrade that fails must answer in HTTP, not in WebSocket
 *
 * Before the handshake completes there is no WebSocket to close, so a 401 has to
 * be written onto the raw socket as an HTTP response. A client that gets a close
 * frame instead cannot tell "your session expired" from "the server restarted",
 * and `fetch`-based error handling in the browser never sees it at all.
 *
 * ## 2. Owning `upgrade` means owning every path
 *
 * Node destroys an upgrade nobody listens for. Add one listener and that stops:
 * an upgrade to a path this gateway does not serve would hang the socket open
 * until a timeout. So an unknown path is refused explicitly, with a 404.
 *
 * ## 3. Cross-site WebSocket hijacking
 *
 * See `authenticateUpgrade` in `./auth.ts`. A WebSocket upgrade is a GET, the
 * CSRF guard early-returns on GET, and a socket that streams a microphone is not
 * a safe request. That function closes it; this one calls that function and never
 * `authenticate` directly.
 *
 * ## 4. A live session costs money and a microphone
 *
 * Each accepted socket opens a Gemini Live session. `MAX_SESSIONS_PER_IDENTITY`
 * and `MAX_SESSIONS` are what stop a client with a valid cookie and a reconnect
 * loop from opening them without end. The refusal uses `CLOSE_RATE_LIMITED` so
 * the client waits instead of retrying immediately.
 *
 * ## 5. A dead socket looks exactly like a quiet one
 *
 * A browser that loses its network sends no close frame, so without a heartbeat
 * the provider session behind it stays open, billing, until the process ends.
 * `ping` every `HEARTBEAT_MS` and terminate the ones that stopped answering.
 */

import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, WebSocket, type RawData } from 'ws';

import {
  ClientMessageSchema,
  CLOSE_GOING_AWAY,
  CLOSE_INTERNAL,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHENTICATED,
  MAX_AUDIO_FRAME_BYTES,
  VoiceSession,
  type VoiceClientChannel,
  type VoiceEar,
  type ServerMessage,
} from '@server/voice/live/index.js';

import { authenticateUpgrade, type Caller } from './auth.js';
import type { RouteDeps } from './deps.js';
import { HttpError } from './errors.js';

/** The one path this gateway serves. */
export const VOICE_PATH = '/api/voice';

/** How often a socket is asked whether it is still there. */
export const HEARTBEAT_MS = 30_000;

export const MAX_SESSIONS = 8;
export const MAX_SESSIONS_PER_IDENTITY = 2;

/**
 * The frame ceiling `ws` enforces before a byte reaches us.
 *
 * `MAX_AUDIO_FRAME_BYTES` plus room for the largest legal JSON control frame,
 * which is a `say` at `MAX_SAY_LENGTH`. Enforced here as well as in the session
 * because a payload limit that is only checked after buffering is not a limit.
 */
export const MAX_FRAME_BYTES = MAX_AUDIO_FRAME_BYTES + 16 * 1024;

export interface VoiceGatewayOptions {
  readonly deps: RouteDeps;
  /** The ear and the mouth, or `undefined` with no `GOOGLE_API_KEY`. */
  readonly ear: VoiceEar | undefined;
}

export interface VoiceGateway {
  /** How many sockets are open. Read by the boot report and by tests. */
  readonly openSessions: number;
  close(): Promise<void>;
}

export function attachVoiceGateway(server: Server, options: VoiceGatewayOptions): VoiceGateway {
  const { deps, ear } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sessions = new Map<WebSocket, VoiceSession>();
  const perIdentity = new Map<string, number>();
  let closing = false;

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const alive = (socket as WebSocket & { isAlive?: boolean }).isAlive;
      if (alive === false) {
        socket.terminate();
        continue;
      }
      (socket as WebSocket & { isAlive?: boolean }).isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  // A timer that keeps the process alive after `stop()` is the bug the weather
  // sweep in `server/app.ts` had to avoid too.
  heartbeat.unref();

  const onUpgrade = (req: Parameters<Parameters<Server['on']>[1]>[0], socket: Duplex, head: Buffer): void => {
    void handleUpgrade(req as never, socket, head);
  };

  async function handleUpgrade(
    req: { url?: string | undefined; headers: Record<string, string | string[] | undefined> },
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (closing) {
      rejectUpgrade(socket, 503, 'unavailable', 'The server is shutting down.');
      return;
    }

    // `req.url` on an upgrade is the request target, which may carry a query.
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path !== VOICE_PATH) {
      rejectUpgrade(socket, 404, 'not_found', 'No such socket.');
      return;
    }

    let caller: Caller;
    try {
      caller = authenticateUpgrade(req, {
        identityRepo: deps.identityRepo,
        cookieName: deps.config.session.cookieName,
        allowedOrigins: deps.allowedOrigins,
      });
    } catch (error) {
      const http = error instanceof HttpError ? error : undefined;
      if (http === undefined) deps.report('voice upgrade', error);
      rejectUpgrade(
        socket,
        http?.status ?? 500,
        http?.code ?? 'unexpected',
        http?.message ?? 'That did not work.',
      );
      return;
    }

    const verdict = deps.limits.authenticated.check(`ws:${caller.identity.id}`);
    if (!verdict.allowed) {
      rejectUpgrade(socket, 429, 'too_many_requests', 'Too many connections. Wait a moment.');
      return;
    }

    if (sessions.size >= MAX_SESSIONS) {
      rejectUpgrade(socket, 429, 'too_many_requests', 'She is already in as many conversations as she can hold.');
      return;
    }
    if ((perIdentity.get(caller.identity.id) ?? 0) >= MAX_SESSIONS_PER_IDENTITY) {
      rejectUpgrade(socket, 429, 'too_many_requests', 'This identity already has a voice session open.');
      return;
    }

    wss.handleUpgrade(req as never, socket, head, (ws) => {
      void accept(ws, caller);
    });
  }

  async function accept(ws: WebSocket, caller: Caller): Promise<void> {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    ws.on('pong', () => {
      (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
    });

    const session = new VoiceSession({
      identity: caller.identity,
      sessionId: caller.session.id,
      client: channelFor(ws),
      runtime: deps.runtimeFor(caller.identity),
      conversations: deps.conversations,
      eventBus: deps.eventBus,
      report: deps.report,
      ear,
      mayThink: () => deps.limits.cycle.check(`ws:${caller.identity.id}`),
    });

    sessions.set(ws, session);
    perIdentity.set(caller.identity.id, (perIdentity.get(caller.identity.id) ?? 0) + 1);

    const forget = (): void => {
      sessions.delete(ws);
      const left = (perIdentity.get(caller.identity.id) ?? 1) - 1;
      if (left <= 0) perIdentity.delete(caller.identity.id);
      else perIdentity.set(caller.identity.id, left);
    };

    ws.on('close', () => {
      forget();
      void session.close(CLOSE_GOING_AWAY, 'socket closed');
    });
    ws.on('error', (error) => {
      deps.report('voice socket', error);
    });

    // Frames are handled strictly in order. Without the chain, a `say` whose
    // cycle takes two seconds would be overtaken by the `cancel` that came after
    // it, and the cancel would find nothing to cancel.
    let queue: Promise<void> = Promise.resolve();
    ws.on('message', (data: RawData, isBinary: boolean) => {
      queue = queue
        .then(() => (isBinary ? session.handleAudioFrame(toBytes(data)) : receive(session, ws, data)))
        .catch((error: unknown) => deps.report('voice frame', error));
    });

    try {
      await session.open();
    } catch (error) {
      deps.report('voice session open', error);
      forget();
      ws.close(CLOSE_INTERNAL, 'could not open');
    }
  }

  async function receive(session: VoiceSession, ws: WebSocket, data: RawData): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(toBytes(data).toString());
    } catch {
      send(ws, {
        t: 'error',
        code: 'invalid_request',
        message: 'That frame was not JSON.',
        fatal: false,
      });
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      send(ws, {
        t: 'error',
        code: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'That message is not one she understands.',
        fatal: false,
      });
      return;
    }
    await session.handle(parsed.data);
  }

  server.on('upgrade', onUpgrade);

  return {
    get openSessions() {
      return sessions.size;
    },
    async close(): Promise<void> {
      closing = true;
      clearInterval(heartbeat);
      server.removeListener('upgrade', onUpgrade);
      const open = [...sessions.values()];
      sessions.clear();
      perIdentity.clear();
      // Every provider session is closed before the listener goes, so an evening
      // of live audio does not outlive the process that authorized it.
      await Promise.all(
        open.map((session) =>
          session.close(CLOSE_GOING_AWAY, 'server stopping').catch((error: unknown) => {
            deps.report('voice session close', error);
          }),
        ),
      );
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

/** The three methods `VoiceSession` needs, over one `ws` socket. */
function channelFor(ws: WebSocket): VoiceClientChannel {
  return {
    send: (message) => send(ws, message),
    sendAudio: (pcm16) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(pcm16, { binary: true });
    },
    close: (code, reason) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    },
  };
}

/** Visible for tests: wraps a `VoiceClientChannel` to expose `onFlush` barrier timing. */
export function _channelForTest(ws: WebSocket): VoiceClientChannel {
  return channelFor(ws);
}

/**
 * Sends, or does not.
 *
 * A closed socket is not an error worth reporting: the common case is a browser
 * tab that went away mid-turn, and the session's own `close` handler is already
 * cleaning up after it.
 */
function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(message));
}

/** `RawData` is a `Buffer`, an `ArrayBuffer`, or a list of `Buffer`s. */
function toBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Refuses an upgrade with a real HTTP response.
 *
 * Same envelope as every other failure — `{ error: { code, message } }` — so a
 * client has one error shape to handle rather than two.
 */
function rejectUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 429:
      return 'Too Many Requests';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Internal Server Error';
  }
}

export { CLOSE_RATE_LIMITED, CLOSE_UNAUTHENTICATED };
