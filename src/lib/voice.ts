/**
 * The one socket she is heard on, and the only thing in the browser that talks to her.
 *
 * ## What this file is not
 *
 * It is not the microphone and it is not the speaker. `./audio/capture.ts` decides
 * when speech started; `./audio/playback.ts` decides when a chunk is heard. This is
 * transport: it opens `/api/voice`, turns eight `ServerMessage` variants into eight
 * handler calls, and puts five `ClientMessage` variants back on the wire. The split
 * is what makes it testable — a fake `WebSocket` in jsdom exercises every branch
 * here with no `AudioContext` anywhere.
 *
 * ## Why the types come from the server
 *
 * `ServerMessage` is imported, not redeclared. It is a `type`, so
 * `verbatimModuleSyntax` erases the import and nothing from `server/` reaches the
 * bundle — but the compiler now fails here the moment the server adds a variant or
 * renames a field. A hand-copied union would instead keep compiling and start
 * silently ignoring a message. The seven wire constants come from
 * `server/voice/live/wire.ts` for the same reason, which is an import-free module
 * precisely so that they can.
 *
 * ## `binaryType` is not a preference
 *
 * A `WebSocket` defaults to handing binary frames over as a `Blob`, which is read
 * asynchronously. Two chunks of her voice arriving in the same tick would then be
 * decoded in whatever order their reads resolved, and her sentence would come out
 * with two syllables swapped — intermittently, and only under load. `arraybuffer`
 * is synchronous and ordered.
 *
 * ## Reconnection, and the two codes that must never be retried
 *
 * `WebSocket` has no built-in retry, so unlike `openPresenceStream` this file owns
 * the backoff. 4401 and 4403 are settled facts about who is asking rather than
 * conditions that pass on a retry: reconnecting after either is an infinite loop
 * against a server that will keep saying no. 4429 is the opposite — it will pass,
 * but only if the client waits, so it starts at the top of the backoff instead of
 * the bottom.
 *
 * ## Why frames are dropped rather than buffered
 *
 * `send` on a stalled socket queues in memory without complaint. Left alone, a
 * network hiccup turns into seconds of backlog that is delivered late and
 * transcribed as one long garbled turn — worse than a gap, because a gap is
 * recoverable and a scrambled turn reaches her cognition as fact. So when
 * `bufferedAmount` passes `MAX_BUFFERED_BYTES` the frame is dropped and counted:
 * recent audio is worth more than complete audio, and `droppedFrames` is how the
 * interface can say so out loud.
 */

import type { ServerMessage } from '@server/voice/live/protocol.js';
import type { SessionState } from '@server/voice/session.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHENTICATED,
  MAX_SAY_LENGTH,
} from '@server/voice/live/wire.js';

/**
 * Where the gateway listens. Mirrors `VOICE_PATH` in `server/http/ws.ts`.
 *
 * The three tuning numbers below it are exported for the same reason the wire
 * constants are imported rather than copied: a test that hardcoded `1_000` would
 * keep passing after the backoff was retuned, and start asserting a delay this file
 * no longer uses.
 */
const VOICE_PATH = '/api/voice';

/** First retry delay, doubling per attempt. */
export const RETRY_BASE_MS = 1_000;

/** The ceiling on that doubling, and where a 4429 starts. */
export const RETRY_MAX_MS = 8_000;

/**
 * How much unsent audio may sit in the socket before frames start being dropped.
 *
 * 32 kB is one second at 16 kHz mono PCM16. Past that the backlog is longer than
 * the pause she would answer in anyway, so sending it is spending bandwidth to make
 * the reply later.
 */
export const MAX_BUFFERED_BYTES = 32 * 1024;

export type VoiceStatus =
  /** Opening, or waiting out a backoff before trying again. */
  | 'connecting'
  /** `ready` has arrived. The only status in which anything may be sent. */
  | 'live'
  /** Closed by us, via `close()`. Not retried. */
  | 'closed'
  /** No `WebSocket` in this runtime. Not retried, because it cannot change. */
  | 'unavailable'
  /** 4401. There is no session cookie, or it expired. Not retried. */
  | 'unauthenticated'
  /** 4403. `voice:participate` was denied — a guest. Not retried, ever. */
  | 'forbidden'
  /** 4429. Too many sockets. Retried, slowly. */
  | 'rate_limited';

/** The `ready` frame, minus its tag. Everything the client needs to set up audio. */
export interface VoiceReady {
  readonly state: SessionState;
  readonly inputSampleRate: number;
  readonly outputSampleRate: number;
  /** Whether an ear and a mouth exist. `false` is the text-only configuration. */
  readonly canHear: boolean;
  readonly conversationId: string;
}

export interface VoiceHandlers {
  onStatus: (status: VoiceStatus) => void;
  /** Once per successful connection, including every reconnection. */
  onReady: (ready: VoiceReady) => void;
  onState: (state: SessionState, reason: string) => void;
  /** A transcript of what she heard: partial as words arrive, then `final`. */
  onHeard: (text: string, final: boolean) => void;
  /** Stage 9's authorized line, before any audio of it. */
  onSaid: (text: string, cycleId: string) => void;
  /** She thought and chose not to speak. */
  onSilent: (cycleId: string) => void;
  /** PCM16 little-endian at `outputSampleRate`, straight off a binary frame. */
  onAudio: (bytes: Uint8Array) => void;
  /** Drop queued audio: barge-in, a cancel, or a rendering that drifted. */
  onFlush: (reason: 'cancelled' | 'drifted' | 'interrupted') => void;
  onTurnEnd: () => void;
  onError: (code: string, message: string, fatal: boolean) => void;
}

export interface VoiceSocket {
  readonly status: VoiceStatus;
  /** How many audio frames were dropped for backpressure, this socket's lifetime. */
  readonly droppedFrames: number;
  /** Speech started. Opens her ear. */
  listen: () => void;
  /** Speech ended. Closes her ear and starts the twelve stages. */
  hush: () => void;
  /**
   * A typed turn, through the same conversation and the same twelve stages.
   *
   * Returns `false` when it was not sent — over `MAX_SAY_LENGTH`, empty after
   * trimming, or the socket is not live. A boolean rather than a throw because a
   * composer needs to know whether to clear itself, and every one of those is a
   * thing a person can do rather than a bug.
   */
  say: (text: string) => boolean;
  /** Barge-in. Stop speaking now. */
  cancel: () => void;
  /** One frame of captured PCM16 at `inputSampleRate`. */
  sendAudio: (pcm16: Int16Array) => void;
  /** Says `bye` so the transcript is finalised, then closes. Idempotent. */
  close: () => void;
}

/**
 * Opens the voice socket and keeps it open.
 *
 * Never rejects and never throws: a runtime with no `WebSocket` reports
 * `'unavailable'` and returns a handle whose methods do nothing, the same way
 * `openPresenceStream` degrades without `EventSource`. A caller that had to
 * `try`/`catch` a transport would end up with two error paths for one condition.
 */
export function openVoiceSocket(handlers: VoiceHandlers): VoiceSocket {
  if (typeof WebSocket === 'undefined') {
    handlers.onStatus('unavailable');
    return inert('unavailable');
  }

  let socket: WebSocket | undefined;
  let status: VoiceStatus = 'connecting';
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let shut = false;
  let droppedFrames = 0;

  const setStatus = (next: VoiceStatus): void => {
    if (status === next) return;
    status = next;
    handlers.onStatus(next);
  };

  const sendJson = (message: object): boolean => {
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  /**
   * Decides whether the close that just happened deserves another attempt.
   *
   * Returns the delay, or `undefined` for the four terminal cases. The attempt
   * counter is what makes a flapping server back off; a 4429 skips straight to the
   * ceiling because it is the one code that is explicitly asking for time.
   */
  const backoffFor = (code: number): number | undefined => {
    if (shut) return undefined;
    if (code === CLOSE_UNAUTHENTICATED || code === CLOSE_FORBIDDEN) return undefined;
    if (code === CLOSE_RATE_LIMITED) return RETRY_MAX_MS;
    attempt += 1;
    // Jittered, so a server that dropped every socket at once does not get all of
    // them back in the same millisecond.
    const base = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    return base * (0.75 + Math.random() * 0.5);
  };

  const connect = (): void => {
    if (shut) return;
    setStatus('connecting');

    // Same origin, so the scheme has to follow the page's: a `ws://` socket from an
    // `https://` document is blocked as mixed content, and a hard-coded `wss://`
    // fails on every localhost run.
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${location.host}${VOICE_PATH}`);
    ws.binaryType = 'arraybuffer';
    socket = ws;

    ws.onmessage = (event: MessageEvent<unknown>): void => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        handlers.onAudio(new Uint8Array(data));
        return;
      }
      if (typeof data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(data) as ServerMessage;
      } catch {
        // A malformed frame is a bug on the wire, not a reason to tear down a
        // working socket mid-conversation.
        return;
      }
      dispatch(message);
    };

    ws.onclose = (event: CloseEvent): void => {
      if (socket === ws) socket = undefined;
      if (shut) {
        setStatus('closed');
        return;
      }
      const delay = backoffFor(event.code);
      if (delay === undefined) {
        setStatus(terminalStatus(event.code));
        return;
      }
      if (event.code === CLOSE_RATE_LIMITED) setStatus('rate_limited');
      else setStatus('connecting');
      retry = setTimeout(connect, delay);
    };

    // `onerror` carries nothing usable — the spec deliberately withholds the reason
    // so a page cannot probe the network. `onclose` always follows it, and that is
    // where the code is, so there is nothing for this handler to do that is not done
    // better a few lines up.
    ws.onerror = null;
  };

  const dispatch = (message: ServerMessage): void => {
    switch (message.t) {
      case 'ready':
        // Reset here rather than in `onopen`: a socket that opens and is closed by
        // the server two frames later has not succeeded at anything, and treating
        // it as a success is how a backoff stops backing off.
        attempt = 0;
        setStatus('live');
        handlers.onReady({
          state: message.state,
          inputSampleRate: message.inputSampleRate,
          outputSampleRate: message.outputSampleRate,
          canHear: message.canHear,
          conversationId: message.conversationId,
        });
        return;
      case 'state':
        handlers.onState(message.state, message.reason);
        return;
      case 'heard':
        handlers.onHeard(message.text, message.final);
        return;
      case 'said':
        handlers.onSaid(message.text, message.cycleId);
        return;
      case 'silent':
        handlers.onSilent(message.cycleId);
        return;
      case 'flush':
        handlers.onFlush(message.reason);
        return;
      case 'turn_end':
        handlers.onTurnEnd();
        return;
      case 'error':
        handlers.onError(message.code, message.message, message.fatal);
        return;
    }
  };

  connect();

  return {
    get status() {
      return status;
    },
    get droppedFrames() {
      return droppedFrames;
    },

    listen(): void {
      sendJson({ t: 'listen' });
    },

    hush(): void {
      sendJson({ t: 'hush' });
    },

    say(text: string): boolean {
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_SAY_LENGTH) return false;
      return sendJson({ t: 'say', text: trimmed });
    },

    cancel(): void {
      sendJson({ t: 'cancel' });
    },

    sendAudio(pcm16: Int16Array): void {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        droppedFrames += 1;
        return;
      }
      // The exact bytes of this frame and no more. A `Int16Array` from `toPcm16`
      // owns its buffer, but `send(view.buffer)` would ignore a view's offset and
      // length if it ever did not — which is the kind of thing that is true until
      // somebody adds pooling.
      socket.send(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength));
    },

    close(): void {
      if (shut) return;
      shut = true;
      if (retry !== undefined) clearTimeout(retry);
      // `bye` first, then the close frame. WebSocket delivers frames in order, so
      // the server finalises the transcript before it sees the socket go — without
      // it a turn that was mid-flight is left open in the conversation.
      sendJson({ t: 'bye' });
      socket?.close(CLOSE_GOING_AWAY, 'client closed');
      socket = undefined;
      setStatus('closed');
    },
  };
}

/** Which permanent status a terminal close code means. */
function terminalStatus(code: number): VoiceStatus {
  if (code === CLOSE_UNAUTHENTICATED) return 'unauthenticated';
  if (code === CLOSE_FORBIDDEN) return 'forbidden';
  return 'closed';
}

/**
 * The handle returned where there is no `WebSocket` at all.
 *
 * Every method is a no-op and `say` reports `false`, which is the truth: nothing
 * was sent. Returning this rather than throwing keeps the caller's code identical
 * between jsdom and a browser, and `status` says plainly that she cannot be reached.
 */
function inert(status: VoiceStatus): VoiceSocket {
  return {
    status,
    droppedFrames: 0,
    listen: () => {},
    hush: () => {},
    say: () => false,
    cancel: () => {},
    sendAudio: () => {},
    close: () => {},
  };
}
