/**
 * Request bodies, parsed once, at the edge.
 *
 * `server/security/validation.ts` already has `validateInput`, and it throws a
 * plain `Error` whose message concatenates every Zod issue. That is right for an
 * internal boundary — a tool input that fails validation is a bug and a 500 is
 * the honest answer. It is wrong for a transport: a malformed body is the
 * *client's* mistake, it deserves a 400, and `asyncRoute` turns any plain `Error`
 * into a 500 with no detail at all. So the same Zod schemas are parsed here into
 * an `HttpError` that carries the issues where a form can show them.
 *
 * Every schema in this file is `.strict()`. An unknown key is refused rather than
 * stripped, because the alternative is a client sending `passphrase` to a route
 * that expected `passPhrase`, being told 200, and never learning why nothing
 * happened.
 */

import { z } from 'zod';

import { HttpError } from './errors.js';

/**
 * Parses a body against a schema, or refuses the request with the reasons.
 *
 * `express.json()` leaves `req.body` as `undefined` when there was no body and
 * as `{}` when the body was `{}`; both reach a schema that will name the missing
 * fields, which is a better message than "no body".
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issues = result.error.errors.map((issue) => {
    const path = issue.path.join('.');
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  throw new HttpError('invalid_request', 'That request was not in the expected shape.', {
    issues,
  });
}

/**
 * The longest a single passphrase or recovery code may be.
 *
 * Not a security limit — it is a cost limit. `scrypt` with `N = 16384` is
 * deliberately expensive, and the cost is per byte of input as well as per
 * iteration, so an unbounded field is a way to make one request occupy the
 * process for a long time. 512 is far past any passphrase a person will type.
 */
const MAX_CREDENTIAL_LENGTH = 512;

/** A passphrase as it arrives on the wire: present, non-empty, bounded. */
const CredentialField = z
  .string()
  .min(1, 'must not be empty')
  .max(MAX_CREDENTIAL_LENGTH, `must be at most ${MAX_CREDENTIAL_LENGTH} characters`);

/**
 * `POST /api/bootstrap`.
 *
 * The 8-character minimum is `executeBootstrap`'s, repeated here so the client
 * hears it as a field-level validation issue rather than as a generic 409 after
 * a round trip. `executeBootstrap` still enforces it — this is the friendlier
 * copy, not the authority.
 */
export const BootstrapBodySchema = z
  .object({
    displayName: z.string().trim().min(1, 'is required').max(120),
    preferredName: z.string().trim().min(1).max(120).optional(),
    passphrase: CredentialField.min(8, 'must be at least 8 characters'),
    recoveryCode: CredentialField.optional(),
  })
  .strict();

/**
 * `POST /api/session`.
 *
 * One field or the other, never both — `verifyOwnerPassphrase` and
 * `verifyRecoveryCode` count failures under *separate* scopes by design, and a
 * body carrying both would make it ambiguous which counter an attempt belongs
 * to.
 */
export const LoginBodySchema = z
  .object({
    passphrase: CredentialField.optional(),
    recoveryCode: CredentialField.optional(),
  })
  .strict()
  .refine(
    (body) => (body.passphrase === undefined) !== (body.recoveryCode === undefined),
    { message: 'Send exactly one of passphrase or recoveryCode.' },
  );

/**
 * `POST /api/location`.
 *
 * The ranges are checked here *and* in `EnvironmentService.setClientLocation`,
 * which returns false rather than clamping. Two checks because they answer
 * different questions: this one tells a client its body was wrong, and the
 * service's protects every other caller it has.
 */
export const LocationBodySchema = z
  .object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  })
  .strict();

/**
 * The longest thing she will accept as one turn.
 *
 * A cycle embeds the stimulus into a prompt, a `cycle_record`, and a `message`
 * row. There is no truncation anywhere in that path, so the bound belongs at the
 * edge where it can still be reported as a refusal rather than discovered as a
 * silently shortened memory.
 */
export const MAX_MESSAGE_LENGTH = 8_000;

/**
 * `POST /api/chat`.
 *
 * `conversationId` is optional and *not* trusted: `ConversationRepository.ensure`
 * throws when the named conversation belongs to another identity, which is what
 * stops a caller from continuing someone else's exchange by guessing a ULID.
 */
export const ChatBodySchema = z
  .object({
    text: z.string().trim().min(1, 'must not be empty').max(MAX_MESSAGE_LENGTH),
    conversationId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

/** `GET /api/conversations/:id/messages` — how many turns to return. */
export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;

/**
 * Reads a bounded positive integer out of a query string.
 *
 * Returns the fallback for absent, empty, non-numeric and out-of-range values
 * rather than refusing: a `?limit=` typo should not turn a history read into an
 * error page, and there is no security decision resting on it.
 */
export function readLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'string' || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}
