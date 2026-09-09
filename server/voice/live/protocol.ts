/**
 * The protocol on the socket between the browser and her.
 *
 * ## Why audio is binary and everything else is JSON
 *
 * A microphone at 16 kHz produces 32 kB of PCM16 per second, in frames every
 * 64 ms. Wrapping each frame in base64 inside a JSON object costs a third more
 * bytes and a `JSON.parse` per frame, on the one message type that arrives twenty
 * times a second in both directions. So audio travels as a raw binary frame — the
 * whole payload *is* the samples — and control messages travel as JSON text
 * frames. `ws` reports which kind arrived, so there is no tag to get wrong.
 *
 * Base64 still exists, once, on the provider hop: the Gemini Live API takes
 * base64. That conversion belongs in `server/voice/live/session.ts` where the
 * provider is, not in the browser.
 *
 * ## Why the ear is opened and closed by the client
 *
 * `listen` and `hush` are the browser saying "speech started" and "speech ended".
 * The browser holds the microphone: it can see the waveform with no network hop,
 * and it can keep silence off the wire entirely instead of paying to stream it.
 * The server turns those into `activityStart` / `activityEnd` — see the header of
 * `./transport.ts` for why that judgement is not the model's to make.
 *
 * ## `say` is here on purpose
 *
 * A typed turn can be sent over this same socket, and it runs the same twelve
 * stages the spoken one does. That is what makes the socket degrade honestly:
 * with no `GOOGLE_API_KEY` there is no ear and no mouth, and `say` still works —
 * she reads and answers in text, in the same conversation, with the same memory.
 * A voice channel that died entirely without a key would make the whole feature
 * an all-or-nothing, and this application's rule is that missing configuration
 * degrades her rather than stopping her.
 *
 * Every inbound schema is `.strict()`, for the reason `server/http/validate.ts`
 * gives: a client sending a key we do not read should hear about it rather than
 * be told 200 and wonder why nothing happened.
 */

import { z } from 'zod';

import type { SessionState } from '../session.js';
import { MAX_SAY_LENGTH } from './wire.js';

/**
 * The wire's shared constants, re-exported.
 *
 * They live in `./wire.ts`, an import-free module, so the browser can hold the same
 * seven numbers without pulling Zod and the session machine in behind them — see
 * that file's header. Re-exported here because this is where a reader looking for
 * "the protocol" will go, and a contract split across two files should still read as
 * one.
 */
export {
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  CLOSE_INTERNAL,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHENTICATED,
  MAX_AUDIO_FRAME_BYTES,
  MAX_SAY_LENGTH,
} from './wire.js';

/** Client → server, as JSON text frames. */
export const ClientMessageSchema = z.discriminatedUnion('t', [
  /** Speech has started: open the ear. */
  z.object({ t: z.literal('listen') }).strict(),
  /** Speech has ended: close the ear, and think about what was heard. */
  z.object({ t: z.literal('hush') }).strict(),
  /** A typed turn, through the same conversation as a spoken one. */
  z
    .object({
      t: z.literal('say'),
      text: z.string().trim().min(1, 'must not be empty').max(MAX_SAY_LENGTH),
    })
    .strict(),
  /** Barge-in: stop speaking now and drop whatever audio is queued. */
  z.object({ t: z.literal('cancel') }).strict(),
  /** Close the session politely, so the transcript is not left mid-turn. */
  z.object({ t: z.literal('bye') }).strict(),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/**
 * Server → client, as JSON text frames. Audio goes as binary frames alongside.
 *
 * A plain discriminated union rather than a Zod schema: nothing validates it on
 * the way out, the compiler does. The client parses it with the matching type in
 * `src/lib/voice.ts`.
 */
export type ServerMessage =
  /** Sent once, immediately after the socket authenticates. */
  | {
      readonly t: 'ready';
      readonly state: SessionState;
      /** What the browser must capture at, in Hz. */
      readonly inputSampleRate: number;
      /** What the browser must play back at, in Hz. */
      readonly outputSampleRate: number;
      /**
       * Whether the ear and the mouth exist at all.
       *
       * `false` with no `GOOGLE_API_KEY`: `say` still works and no audio will
       * ever arrive. The client shows a text composer rather than a microphone
       * that would fail on the first press.
       */
      readonly canHear: boolean;
      readonly conversationId: string;
    }
  /** A lifecycle transition, from `LiveSessionStateMachine`. */
  | { readonly t: 'state'; readonly state: SessionState; readonly reason: string }
  /** What she heard. Partial as the words arrive, then once with `final`. */
  | { readonly t: 'heard'; readonly text: string; readonly final: boolean }
  /**
   * What she is about to say, sent before the audio of it.
   *
   * The text is stage 9's authorized line, and it reaches the transcript whether
   * or not synthesis then succeeds — so a UI never waits on a voice to show a
   * sentence, and a drifted or interrupted rendering still leaves the true words
   * on screen.
   */
  | { readonly t: 'said'; readonly text: string; readonly cycleId: string }
  /** She thought and chose not to speak. A decision, not a failure. */
  | { readonly t: 'silent'; readonly cycleId: string }
  /** Drop every queued audio chunk: barge-in, or a rendering that drifted. */
  | { readonly t: 'flush'; readonly reason: 'cancelled' | 'drifted' | 'interrupted' }
  /** No more audio is coming for the current turn. */
  | { readonly t: 'turn_end' }
  /** Something failed. `fatal` means the socket is closing. */
  | {
      readonly t: 'error';
      readonly code: string;
      readonly message: string;
      readonly fatal: boolean;
    };
