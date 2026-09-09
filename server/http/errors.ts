/**
 * One shape for every failure the transport reports, and one reason for it.
 *
 * A browser cannot act on a stack trace, and an attacker can act on one rather
 * well: "no such column: token_hash" tells them the schema, and
 * `ENOENT /Users/ankitsingh/...` tells them the filesystem. So the wire carries
 * a stable machine-readable `code`, a sentence a person can read, and nothing
 * else. The detail goes to the event bus and the audit log, which are inside.
 *
 * ## Why the codes are a closed union
 *
 * The presence UI has to branch on failures — an expired session means "show
 * the passphrase screen", a lockout means "show the countdown", a 500 means
 * "say something went wrong". Branching on `message` would make every reworded
 * sentence a breaking change, and branching on the status alone cannot tell
 * `no_owner` from `wrong_credential` (both 401 in spirit, entirely different
 * screens). `ErrorCode` is that contract, written down once.
 *
 * ## Why `unexpected` exists
 *
 * Every route is wrapped by `asyncRoute`, so a bug throws rather than hanging
 * the request forever. What the client then gets is `unexpected` and a 500 —
 * never the thrown value. `asyncRoute` hands the real error to a reporter so it
 * still reaches `publishError`, because a failure nobody records is a failure
 * that happens again.
 */

import type { Request, RequestHandler, Response } from 'express';

/**
 * The failures the client is allowed to know about, by name.
 *
 * Each maps to exactly one HTTP status in `STATUS`, so a route picks the
 * meaning and never the number — that is what keeps a 403 from being reported
 * as a 401 somewhere down the line.
 */
export type ErrorCode =
  /** No `Authorization` header and no session cookie. */
  | 'no_credential'
  /** A credential was presented and is not valid, expired, or was revoked. */
  | 'bad_credential'
  /** The owner's passphrase was wrong. Deliberately distinct from `bad_credential`. */
  | 'wrong_passphrase'
  /** Too many failed passphrase attempts. Carries `retryAfterMs`. */
  | 'locked_out'
  /** Authenticated, but the identity is dormant or revoked. */
  | 'identity_inactive'
  /** Authenticated and active, but `authz.check` said no. */
  | 'forbidden'
  /** The body or query failed validation. Carries `issues`. */
  | 'invalid_request'
  /** A cookie-authenticated write arrived from another site. */
  | 'bad_origin'
  /** No owner exists yet; the instance has not been bootstrapped. */
  | 'no_owner'
  /** An owner already exists; bootstrap is a one-time operation. */
  | 'already_bootstrapped'
  /** The route or resource does not exist. */
  | 'not_found'
  /** Rate limit. Carries `retryAfterMs`. */
  | 'too_many_requests'
  /** A subsystem this route needs is switched off in this configuration. */
  | 'not_available'
  /** A bug. The client learns nothing more than this. */
  | 'unexpected';

const STATUS: Record<ErrorCode, number> = {
  no_credential: 401,
  bad_credential: 401,
  wrong_passphrase: 401,
  locked_out: 429,
  identity_inactive: 403,
  forbidden: 403,
  invalid_request: 400,
  bad_origin: 403,
  no_owner: 409,
  already_bootstrapped: 409,
  not_found: 404,
  too_many_requests: 429,
  not_available: 503,
  unexpected: 500,
};

/** Extra fields a client can act on. Never free-form, never internal detail. */
export interface ErrorDetail {
  /** How long until a retry can succeed, for `locked_out` and `too_many_requests`. */
  retryAfterMs?: number;
  /** Human-readable validation problems, for `invalid_request`. */
  issues?: readonly string[];
}

/**
 * A failure a route means to report, as opposed to one it suffered.
 *
 * Thrown rather than returned so a helper three calls deep can refuse a request
 * without every caller in between having to check and forward a result. The
 * `code` is what fixes the status, so no route ever writes a number.
 */
export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: ErrorDetail;

  constructor(code: ErrorCode, message: string, detail: ErrorDetail = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}

/** The body every failure produces. Exported so the tests assert on the shape. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string } & ErrorDetail;
}

/**
 * Writes the failure, unless the response has already begun.
 *
 * The guard matters for `GET /api/stream`: an SSE response has sent its headers
 * long before it can fail, and calling `res.status()` after that throws a
 * second error on top of the first. A stream that has started can only be
 * ended, so that is what happens.
 */
export function sendError(res: Response, error: HttpError): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error.detail.retryAfterMs !== undefined) {
    // Seconds, per RFC 9110 — the millisecond figure stays in the body, where a
    // countdown can use it without rounding a 1.4s wait up to 2s.
    res.setHeader('Retry-After', String(Math.ceil(error.detail.retryAfterMs / 1000)));
  }
  const body: ErrorBody = {
    error: { code: error.code, message: error.message, ...error.detail },
  };
  res.status(error.status).json(body);
}

/** Where an unexpected throw is reported, so it is not merely swallowed. */
export type ErrorReporter = (what: string, error: unknown) => void;

/**
 * Wraps a handler so a rejected promise becomes a response instead of a hang.
 *
 * Express 4 does not await handlers: an `async` handler that rejects produces
 * an unhandled rejection and a request that never answers. `server/main.ts`
 * treats an unhandled rejection as fatal and shuts the process down, so without
 * this one bad request would take her offline.
 */
export function asyncRoute(
  what: string,
  report: ErrorReporter,
  handler: (req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      try {
        await handler(req, res);
      } catch (error) {
        if (error instanceof HttpError) {
          sendError(res, error);
          return;
        }
        report(what, error);
        sendError(res, new HttpError('unexpected', 'Something went wrong on her side.'));
      }
      // `next` is deliberately never called on the success path: these are leaf
      // handlers, and calling it would fall through to the 404.
      void next;
    })();
  };
}
