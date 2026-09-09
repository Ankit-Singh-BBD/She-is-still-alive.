/**
 * Server-Sent Events as the way she talks to the browser, and why not WebSocket.
 *
 * ## The decision
 *
 * `ws` is not a dependency of this repository, and the mandate says to avoid
 * unnecessary ones. The two alternatives to taking it were hand-rolling RFC 6455
 * — masking, fragmentation, continuation frames, close codes, ping/pong, three
 * payload-length encodings — or using the streaming primitive HTTP already has.
 *
 * SSE wins on the merits here, not just on the dependency count:
 *
 *  - What flows down this channel is a low-rate stream of JSON domain events
 *    that `RealtimeFlow` has already coalesced. That is exactly SSE's shape.
 *  - Reconnection is in the browser. `EventSource` retries on its own and
 *    echoes `Last-Event-ID`, which maps onto `EventBus.replay(seq, limit)` with
 *    no client-side bookkeeping. A WebSocket client has to write that reconnect
 *    loop by hand, and get the backoff right. (`replayTo` is the obvious-looking
 *    call and the wrong one — it runs each handler under a 100ms deadline that
 *    resolves whether or not the write landed. `server/http/routes/presence.ts`
 *    awaits each frame itself.)
 *  - It is a plain HTTP response, so it goes through the same authentication
 *    middleware, the same cookie, and the same error envelope as every other
 *    route. A WebSocket upgrade bypasses Express middleware and would need its
 *    own copy of the auth path — a second place to get `authenticateSessionToken`
 *    right.
 *
 * What SSE cannot do is carry binary upstream, which is what live microphone
 * audio needs. That is task 9's problem and task 9's decision: a duplex binary
 * channel is a different requirement from a state feed, and would want its own
 * transport even if `ws` were already here. Building this one on SSE does not
 * pre-empt that.
 *
 * ## The two things that break SSE quietly
 *
 * Compression buffers. `compression` will happily gzip `text/event-stream` and
 * then hold each event in its buffer until enough bytes accumulate, so the
 * stream works perfectly in a test and appears dead in a browser. It is filtered
 * out in `server/http/server.ts`, and `Content-Encoding: identity` is set here
 * as well so a proxy in between is told the same thing.
 *
 * Idle connections get reaped. A stream with nothing to say for a minute looks
 * to an intermediary exactly like one that has hung, so `HEARTBEAT_MS` sends a
 * comment line — legal SSE that `EventSource` discards without dispatching. It
 * also gives `res.write` something to fail on, which is how a client that
 * vanished without a `close` event is discovered.
 */

import type { Response } from 'express';

import type { BroadcastMessage, Subscriber } from '@server/realtime/types.js';

/**
 * How often a comment line is written to prove the stream is alive.
 *
 * Fifteen seconds is under every default idle timeout worth naming (nginx's
 * `proxy_read_timeout` is 60s, most cloud load balancers 60s or more) with room
 * for one to be missed.
 */
export const HEARTBEAT_MS = 15_000;

/** What SSE calls a retry hint, in ms. The browser waits this long before reconnecting. */
export const RECONNECT_HINT_MS = 2_000;

/**
 * One connected browser, as `RealtimeFlow` sees it.
 *
 * `send` returns a promise that resolves when the socket has accepted the bytes,
 * which is what makes `RealtimeFlow`'s coalescing do something useful: a client
 * on a slow link stops draining, its queue collapses by `coalesceKey`, and it
 * receives the newest state rather than a backlog of stale ones. Returning
 * immediately would turn that queue into an unbounded buffer.
 */
export class SseSubscriber implements Subscriber {
  readonly id: string;
  private readonly res: Response;
  private heartbeat: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(id: string, res: Response) {
    this.id = id;
    this.res = res;
  }

  /**
   * Sends the headers and holds the connection open.
   *
   * `flushHeaders` matters: without it Express waits for the first body write,
   * so a stream that has nothing to say yet would not even be established, and
   * the client could not tell "connected and quiet" from "still connecting".
   */
  open(): void {
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // `no-transform` is the half that matters: it tells intermediaries not to
    // re-encode, which is the same buffering problem compression causes.
    this.res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('Content-Encoding', 'identity');
    // nginx honours this; without it a reverse proxy buffers the whole stream.
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();

    // Nagle's algorithm holds a small write back waiting for company. For a
    // stream of small writes that is exactly wrong.
    this.res.socket?.setNoDelay(true);
    // The socket must not be reaped for being idle; the heartbeat is what
    // proves liveness, and 0 disables Node's own timeout.
    this.res.socket?.setTimeout(0);

    this.res.write(`retry: ${RECONNECT_HINT_MS}\n\n`);

    this.heartbeat = setInterval(() => {
      // A comment line. `EventSource` ignores it, the socket does not.
      this.write(':\n\n');
    }, HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /**
   * Writes one event.
   *
   * `id` is the event's sequence number, which is what the browser echoes back
   * as `Last-Event-ID` on reconnect — so a reconnecting client can be replayed
   * from exactly where it stopped rather than from the beginning or from now.
   */
  send(message: BroadcastMessage): Promise<void> {
    const frame =
      `id: ${message.seq}\n` +
      `event: ${message.type}\n` +
      `data: ${serialise(message)}\n\n`;
    return this.write(frame);
  }

  /**
   * Sends a named frame that is not a domain event.
   *
   * Used for the initial `state` snapshot, so a client that has just connected
   * does not have to make a second request to find out what is true. Its event
   * name is distinct from every `DomainEventType`, so a listener cannot confuse
   * a full state for an increment.
   */
  sendNamed(event: string, data: unknown): Promise<void> {
    return this.write(`event: ${event}\ndata: ${JSON.stringify(data) ?? 'null'}\n\n`);
  }

  /** Stops the heartbeat and ends the response. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.res.end();
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Writes and waits for the socket to accept it.
   *
   * Resolves rather than rejects when the write fails, and marks the subscriber
   * closed. A failed write means the client is gone, which is not an error the
   * broadcaster should hear about — `RealtimeFlow.drainQueue` would log it once
   * per queued message for a browser that simply closed its tab.
   */
  private write(chunk: string): Promise<void> {
    if (this.closed || this.res.writableEnded) {
      this.closed = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.res.write(chunk, (error) => {
        if (error) this.closed = true;
        resolve();
      });
    });
  }
}

/**
 * The message as one JSON line.
 *
 * SSE fields are newline-delimited, so a raw newline inside the payload would
 * end the `data:` field early and the remainder would be parsed as another field
 * or silently dropped. `JSON.stringify` escapes every CR and LF it encounters
 * inside a string and emits no literal line break of its own, so its output is
 * always exactly one line. That property is the reason the payload is
 * serialised here rather than interpolated into the frame by the caller.
 */
function serialise(message: BroadcastMessage): string {
  return JSON.stringify({
    seq: message.seq,
    type: message.type,
    payload: message.payload,
    timestamp: message.timestamp,
  });
}
