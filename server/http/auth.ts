/**
 * Turning a request into a caller, and the four things that has to get right.
 *
 * ## 1. Only one function may authenticate
 *
 * `IdentityRepository` has two lookups that both take a string and both return
 * a session, and only one of them is safe on the wire. `validateSession(id)`
 * takes the *non-secret* record handle — its own comment says it "must never be
 * reached from a transport with a caller-supplied value", because the handle
 * appears in audit rows and logs, so anyone who has read one could present it
 * as a credential. `authenticateSessionToken(token)` hashes what it is given and
 * matches against `session.token_hash`; it is "the only function that turns a
 * credential into a session". This file calls that one and never the other.
 *
 * ## 2. `authz.check` does not look at status
 *
 * `server/authz/index.ts` reasons only from `caller.permissions` and
 * `caller.kind`. It never reads `caller.status` — so a revoked identity holding
 * a session that has not yet expired would pass every permission check it
 * passed yesterday. `ToolExecutor.resolveCaller` handles this by re-reading the
 * identity from the database and throwing when it is not `active`, and the
 * transport needs exactly the same guard for exactly the same reason: a session
 * proves who asked, not that they are still allowed to ask.
 *
 * That is also why this file re-reads the identity rather than trusting anything
 * it was handed. `authenticateSessionToken` returns a `Session`, not an
 * `Identity`; the second read is not redundant, it is the point.
 *
 * ## 3. The attempt that trips the lock still says `wrong_credential`
 *
 * Pinned by `tests/p03/bootstrap.test.ts`: four failures leave
 * `getAuthLockout` null; the fifth reports `reason: 'wrong_credential'` **and**
 * carries a future `lockedUntil`; only the sixth and later report
 * `reason: 'locked_out'`. A transport that switched on `reason` alone would
 * answer the fifth attempt with a plain 401 and no retry window, and the owner
 * would sit there typing into a lock nobody told them about. `mapAuthFailure`
 * reads `lockedUntil` first and `reason` second.
 *
 * ## 4. A cookie is a credential the browser sends without being asked
 *
 * Which is the whole convenience of it and the whole danger: any page on the
 * internet can make the browser POST here with the cookie attached. There is no
 * CSRF helper anywhere in `server/`, so `assertNotCrossSite` is it — modern
 * `Sec-Fetch-Site` first, `Origin`-versus-`Host` as the fallback, and a refusal
 * when a cookie-authenticated write carries neither. Bearer tokens skip the
 * check because a cross-origin page cannot set `Authorization` on a request we
 * never granted CORS to.
 */

import type { Request, Response } from 'express';

import type { Identity, IdentityKind, Session } from '@server/identity/types.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { SameSite } from '@server/config/env.js';

import { HttpError } from './errors.js';

/** How the credential arrived, which decides whether CSRF applies. */
export type CredentialSource = 'bearer' | 'cookie';

/** A request that has been through `authenticate`. */
export interface Caller {
  readonly identity: Identity;
  readonly session: Session;
  readonly via: CredentialSource;
}

/** Methods that do not change anything, and so cannot be abused cross-site. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads one cookie out of the `Cookie` header.
 *
 * Hand-rolled rather than `cookie-parser`, which would be a dependency for
 * fifteen lines. It splits on `;`, takes the first `=` only (a session token is
 * base64url, which has no `=` except as padding — but a value that did would be
 * truncated by a naive split), trims, and URL-decodes.
 *
 * Returns `undefined` for a missing header, a missing name, or an empty value.
 * An empty cookie is treated as absent rather than as a wrong credential,
 * because a browser clearing a cookie leaves `name=` behind and that is not an
 * authentication failure worth counting.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (raw === '') return undefined;
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not a credential.
      return undefined;
    }
  }
  return undefined;
}

/**
 * The credential on this request, if there is one.
 *
 * `Authorization: Bearer` wins over the cookie when both are present. A client
 * that went to the trouble of setting the header meant that token, and letting a
 * stale cookie shadow it would make "log in as someone else" silently not work.
 */
export function readCredential(
  req: Request,
  cookieName: string,
): { token: string; via: CredentialSource } | undefined {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
    const token = match?.[1]?.trim();
    if (token !== undefined && token !== '') return { token, via: 'bearer' };
  }
  const cookie = readCookie(req.headers.cookie, cookieName);
  if (cookie !== undefined) return { token: cookie, via: 'cookie' };
  return undefined;
}

/**
 * Refuses a cookie-authenticated write that came from another site.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be set by the page, so when
 * it is present it is the answer: `same-origin` is us, `none` is a typed URL or
 * a bookmark, and `same-site` or `cross-site` is somebody else's page. When it
 * is absent — a non-browser client, or something very old — `Origin` is compared
 * against `Host`, which works through a reverse proxy that preserves `Host` and
 * behind Vite's dev proxy, where the browser sees one origin for both.
 *
 * A cookie-authenticated write with neither header is refused. Every browser
 * that can send a cookie on a cross-origin POST also sends `Origin` on it, so
 * the only thing this rejects is a hand-written client that chose the cookie
 * over the header it could have used instead.
 */
export function assertNotCrossSite(
  req: Request,
  via: CredentialSource,
  allowedOrigins: readonly string[],
): void {
  if (via === 'bearer') return;
  if (SAFE_METHODS.has(req.method)) return;

  const fetchSite = req.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite !== '') {
    if (fetchSite === 'same-origin' || fetchSite === 'none') return;
    throw new HttpError('bad_origin', 'That request came from another site.');
  }

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') {
    throw new HttpError(
      'bad_origin',
      'A cookie-authenticated write needs an Origin header, or use a bearer token.',
    );
  }
  if (allowedOrigins.includes(origin)) return;

  const host = req.headers.host;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError('bad_origin', 'That Origin is not a URL.');
  }
  if (typeof host === 'string' && host !== '' && originHost === host) return;

  throw new HttpError('bad_origin', 'That request came from another site.');
}

export interface AuthenticatorOptions {
  readonly identityRepo: IdentityRepository;
  readonly cookieName: string;
  /**
   * Origins allowed to make cookie-authenticated writes, beyond same-host.
   *
   * Empty in production unless an operator sets it. It exists for the dev
   * server, where the browser's origin and the API's `Host` genuinely differ if
   * the proxy is bypassed.
   */
  readonly allowedOrigins: readonly string[];
}

/**
 * Turns a request into a caller, or throws the reason it cannot.
 *
 * Every refusal is one of a small set of codes so the UI can tell "you were
 * never logged in" from "your session ended" from "you are locked out" — three
 * different screens that a bare 401 collapses into one.
 */
export function authenticate(req: Request, options: AuthenticatorOptions): Caller {
  const credential = readCredential(req, options.cookieName);
  if (credential === undefined) {
    throw new HttpError('no_credential', 'This needs a session.');
  }

  assertNotCrossSite(req, credential.via, options.allowedOrigins);

  // The only function that turns a credential into a session. It returns null
  // for empty, unknown, expired and revoked alike, and deliberately does not
  // say which — telling a caller that a token *used* to be valid is telling them
  // a token existed.
  const session = options.identityRepo.authenticateSessionToken(credential.token);
  if (session === null) {
    throw new HttpError('bad_credential', 'That session is not valid any more.');
  }

  // Re-read, because a session says who asked and not whether they may still
  // ask. `authz.check` never looks at status, so this is the only place a
  // revoked identity is stopped.
  const identity = options.identityRepo.getIdentity(session.identityId);
  if (identity === null) {
    // A session whose identity is gone. The foreign key makes this unreachable
    // by ordinary means, which is exactly why it must not be treated as a valid
    // caller if it ever happens.
    throw new HttpError('bad_credential', 'That session is not valid any more.');
  }
  if (identity.status !== 'active') {
    throw new HttpError(
      'identity_inactive',
      identity.status === 'revoked'
        ? 'That identity has been revoked.'
        : 'That identity is dormant.',
    );
  }

  return { identity, session, via: credential.via };
}

/**
 * Refuses a caller who is not of one of the given kinds.
 *
 * Used where `authz.check` has nothing to say because the action is not one of
 * its `AuthzAction`s — enrolling someone, reading the boot report, taking a
 * backup. Where `check` does cover the action, that is what runs instead; this
 * is not a second permission system, it is a coarse gate in front of routes the
 * permission model does not name.
 */
export function requireKind(caller: Caller, ...kinds: readonly IdentityKind[]): void {
  if (kinds.includes(caller.identity.kind)) return;
  throw new HttpError('forbidden', 'This is not yours to do.');
}

/** The failure half of an `AuthOutcome`, which is all `mapAuthFailure` needs. */
export interface AuthFailure {
  readonly reason: 'no_owner' | 'no_credential' | 'wrong_credential' | 'locked_out';
  readonly failedCount?: number | undefined;
  readonly lockedUntil?: number | undefined;
}

/**
 * The right status for a failed passphrase check.
 *
 * `lockedUntil` is read *before* `reason` because of the contract pinned in
 * `tests/p03/bootstrap.test.ts`: the attempt that trips the lock reports
 * `wrong_credential` and carries the window. Switching on `reason` first would
 * answer that attempt with a 401 and no `Retry-After`, and the owner would keep
 * typing into a door that is already bolted.
 */
export function mapAuthFailure(failure: AuthFailure, now: number = Date.now()): HttpError {
  const lockedUntil = failure.lockedUntil;
  if (lockedUntil !== undefined && lockedUntil > now) {
    const retryAfterMs = lockedUntil - now;
    return new HttpError(
      'locked_out',
      'Too many wrong attempts. She will listen again shortly.',
      { retryAfterMs },
    );
  }
  switch (failure.reason) {
    case 'no_owner':
      return new HttpError('no_owner', 'Nobody has been enrolled yet.');
    case 'no_credential':
      return new HttpError('invalid_request', 'A passphrase is required.');
    case 'locked_out':
      // Reported without a future window: the lock has expired between the
      // repository's read and ours. Treat it as the wrong passphrase it was.
      return new HttpError('wrong_passphrase', 'That passphrase is not right.');
    case 'wrong_credential':
      return new HttpError('wrong_passphrase', 'That passphrase is not right.');
  }
}

// ── The cookie half ────────────────────────────────────────────────────────

/** What `config.session` already held, and nothing used until now. */
export interface SessionCookieConfig {
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly cookieSameSite: SameSite;
  readonly maxAgeMs: number;
}

/**
 * Sets the session cookie, and the four attributes that make it worth having.
 *
 * `HttpOnly` is the reason a cookie is used at all rather than `localStorage`:
 * script cannot read it, so one XSS does not hand an attacker a 30-day
 * credential they can keep. `SameSite` and the `Origin` check in
 * `assertNotCrossSite` are the two halves of the CSRF defence — `lax` alone
 * still permits a top-level cross-site POST in some browsers, which is exactly
 * the case the header check catches. `Secure` comes from config and defaults
 * false, because `http://localhost` is how this is developed and a cookie marked
 * `Secure` would simply never be sent there.
 *
 * `Max-Age` is set from `config.session.maxAgeMs` and clamped to the session's
 * real expiry, so the browser never holds a cookie the server would refuse:
 * a cookie that outlives its session produces a `bad_credential` on every
 * request and looks to the user like being logged out at random.
 */
export function setSessionCookie(
  res: Response,
  token: string,
  expiresAt: number,
  cookie: SessionCookieConfig,
  now: number = Date.now(),
): void {
  const remainingMs = Math.max(0, expiresAt - now);
  const maxAgeSeconds = Math.floor(Math.min(cookie.maxAgeMs, remainingMs) / 1000);
  const parts = [
    `${cookie.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSiteLabel(cookie.cookieSameSite)}`,
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookie.cookieSecure) parts.push('Secure');
  // `SameSite=None` without `Secure` is rejected outright by every current
  // browser, so the combination would silently mean "no cookie at all".
  else if (cookie.cookieSameSite === 'none') parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

/**
 * Clears the cookie by expiring it.
 *
 * The attributes have to match the ones it was set with — a browser treats a
 * cookie with a different `Path` as a different cookie, so a mismatch leaves the
 * old one in place and the user stays logged in on the next request.
 */
export function clearSessionCookie(res: Response, cookie: SessionCookieConfig): void {
  const parts = [
    `${cookie.cookieName}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSiteLabel(cookie.cookieSameSite)}`,
    'Max-Age=0',
  ];
  if (cookie.cookieSecure || cookie.cookieSameSite === 'none') parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

function sameSiteLabel(value: SameSite): string {
  return value === 'lax' ? 'Lax' : value === 'strict' ? 'Strict' : 'None';
}

/**
 * Adds one `Set-Cookie` without discarding any already there.
 *
 * `res.setHeader` replaces, and `Set-Cookie` is the one header where replacing
 * loses data. Nothing else sets a cookie today; writing it this way means the
 * second thing that does is not a bug in this one.
 */
function appendSetCookie(res: Response, value: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) {
    res.setHeader('Set-Cookie', value);
    return;
  }
  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader('Set-Cookie', [...list, value]);
}
