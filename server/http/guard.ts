/**
 * The two things every guarded route does before it does anything else.
 *
 * ## Why this is not middleware
 *
 * Express middleware would have to put the caller somewhere for the handler to
 * find it — `req.caller`, a module-level `WeakMap`, `res.locals`. All three make
 * the caller's *presence* untyped: a handler reading `req.caller!` compiles
 * whether or not the middleware that sets it was actually mounted on that route,
 * and the failure mode is an authenticated handler running for an anonymous
 * request. Calling `requireCaller(req, deps)` as the first line of a handler
 * returns a `Caller` or throws, and there is no third possibility for a later
 * edit to introduce.
 *
 * ## Why `updateLastSeen` is here
 *
 * `lastSeenAt` is on `Identity` and was written only by `createIdentity`, so
 * every enrolled identity reported the moment it was enrolled as the last time
 * she saw them, forever. This is the only place in the process that knows a
 * caller just arrived.
 */

import type { Request } from 'express';

import type { Caller } from './auth.js';
import { authenticate } from './auth.js';
import type { RouteDeps } from './deps.js';
import { HttpError } from './errors.js';
import type { RateLimiter } from './rate-limit.js';

/**
 * The key an unauthenticated request is counted under.
 *
 * `req.ip` honours Express's `trust proxy` setting, which is left at its default
 * of `false` in `server/http/server.ts` — so this is the socket's address and
 * *not* anything a client wrote in `X-Forwarded-For`. That matters: a
 * spoofable key is not a rate limit, it is a way to exhaust the map. An operator
 * who really is behind a proxy has to enable `trust proxy` deliberately.
 */
export function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * Counts one request and throws when the window is full.
 *
 * `retryAfterMs` is carried through so the client can wait exactly as long as it
 * needs to rather than guessing, and `sendError` turns it into `Retry-After`.
 */
export function enforceLimit(limiter: RateLimiter, key: string, what: string): void {
  const verdict = limiter.check(key);
  if (verdict.allowed) return;
  throw new HttpError('too_many_requests', `Too many ${what} requests. Slow down a moment.`, {
    retryAfterMs: verdict.retryAfterMs,
  });
}

/**
 * Authenticates the request, counts it, and records that she saw this caller.
 *
 * The order is deliberate. Authentication first, because the authenticated
 * limiter is keyed by identity and there is no identity before it runs — keying
 * it by IP instead would let one person's burst throttle everyone behind the same
 * address. `updateLastSeen` last, so a refused request does not update it.
 *
 * A failed `updateLastSeen` is not allowed to fail the request: it is a
 * courtesy write, and refusing to answer because a timestamp could not be
 * updated would be the tail wagging the dog.
 */
export function requireCaller(req: Request, deps: RouteDeps): Caller {
  const caller = authenticate(req, {
    identityRepo: deps.identityRepo,
    cookieName: deps.config.session.cookieName,
    allowedOrigins: deps.allowedOrigins,
  });

  enforceLimit(deps.limits.authenticated, caller.identity.id, 'API');

  try {
    deps.identityRepo.updateLastSeen(caller.identity.id);
  } catch (error) {
    deps.report('updateLastSeen', error);
  }

  return caller;
}
