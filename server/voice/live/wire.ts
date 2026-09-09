/**
 * The numbers on the wire, in the one module both halves can hold.
 *
 * Every constant here is part of the socket's contract rather than one side's
 * implementation detail: the client has to know the frame ceiling to stay under it,
 * the length ceiling to refuse a paste before sending it, and the close codes to
 * tell "sign in" from "wait" from "never again".
 *
 * Split out of `./protocol.ts` rather than left there, and the reason is the browser
 * bundle. `protocol.ts` imports `zod` for the inbound schemas and `SessionState`
 * from `../session.ts`; these are needed as *values*, so importing them from there
 * would pull Zod and the session module into the browser for the sake of seven
 * numbers.
 *
 * Redeclaring them client-side was the other option and is worse: they are a
 * contract, and two copies of a contract drift silently. This file has no imports at
 * all, so `src/lib/voice.ts` holds exactly what the server enforces and the compiler
 * stays the thing that keeps them equal.
 */

/**
 * The longest typed turn accepted on the socket.
 *
 * The same bound `ChatBodySchema` uses, and for the same reason: nothing between
 * here and the `message` row truncates, so the limit belongs where it can still
 * be reported as a refusal.
 */
export const MAX_SAY_LENGTH = 8_000;

/**
 * The largest binary frame accepted as audio.
 *
 * 64 ms of 16 kHz mono PCM16 is 2,048 bytes. 16 kB leaves room for a client that
 * batches a few frames and refuses one that has decided to send a megabyte of
 * anything. Enforced on the socket, before the bytes are base64'd and forwarded.
 */
export const MAX_AUDIO_FRAME_BYTES = 16 * 1024;

/**
 * Close codes this server uses, above the 4000 range WebSocket reserves for
 * applications.
 *
 * Distinct codes rather than one, because the client's correct behaviour differs:
 * a client that was never authenticated must send the user to the door, and a
 * client that hit a rate limit must wait rather than reconnect in a loop.
 */
export const CLOSE_UNAUTHENTICATED = 4401;

/**
 * Authenticated, and still not allowed to be here.
 *
 * A guest has `mayBeHeardInVoice: false`, so `check(identity,
 * 'voice:participate')` denies the socket. That is a settled fact about who they
 * are, not a condition that will pass on a retry — which is exactly why it must
 * not share a code with 4401 or 4429. A client that reconnects after this one is
 * looping forever.
 */
export const CLOSE_FORBIDDEN = 4403;

export const CLOSE_RATE_LIMITED = 4429;

export const CLOSE_GOING_AWAY = 4000;

export const CLOSE_INTERNAL = 4500;
