/**
 * Who she is talking to: enrolment, login, logout, and the one honest thing an
 * anonymous caller is allowed to ask.
 *
 * ## `GET /api/hello` is deliberately the only unauthenticated read
 *
 * A client that has just loaded has to choose between two screens — "set her up"
 * and "let me in" — and it cannot make that choice without knowing whether an
 * owner exists. So that one bit is public. Nothing else is: not the owner's name,
 * not how many identities there are, not whether a passphrase attempt is
 * currently locked out. `hasOwner()` is a boolean an attacker learns by trying to
 * bootstrap anyway.
 *
 * ## Bootstrap is not a login, and then it is
 *
 * `executeBootstrap` creates the owner and their credential and returns the
 * `Identity`. It does not issue a session, because it is a repository-level
 * operation with no transport in it. But a person who has just typed a passphrase
 * twice should not then be asked to type it a third time to log in, so this route
 * issues the session itself — from the identity `executeBootstrap` returned, not
 * by re-verifying the passphrase it was just handed.
 *
 * ## Why the passphrase never reaches the audit log
 *
 * `report` is `publishError`, which writes the message into a `domain_event` row
 * and an `audit_log` row. So a route must never hand it a value derived from a
 * credential — and none of these do: every failure below is either an
 * `HttpError` built from an `AuthOutcome` (which carries counters, never the
 * attempt) or a Zod issue list built from field *names*.
 */

import type { Response, Router } from 'express';

import { executeBootstrap } from '@server/identity/bootstrap.js';
import type { Identity } from '@server/identity/types.js';

import type { Caller } from '../auth.js';
import { clearSessionCookie, mapAuthFailure, setSessionCookie } from '../auth.js';
import type { RouteDeps } from '../deps.js';
import { asyncRoute, HttpError } from '../errors.js';
import { clientKey, enforceLimit, requireCaller } from '../guard.js';
import { BootstrapBodySchema, LoginBodySchema, parseBody } from '../validate.js';

/**
 * The identity as a client is allowed to see it.
 *
 * `Identity` is already free of credentials — the hash lives in
 * `identity_credential` and never joins onto it — so this is a shape decision
 * rather than a redaction: it pins what the UI may depend on, so adding a column
 * to `identity` does not silently start publishing it.
 */
export interface PublicIdentity {
  readonly id: string;
  readonly kind: Identity['kind'];
  readonly displayName: string;
  readonly preferredName: string | undefined;
  readonly relationshipToOwner: Identity['relationshipToOwner'];
  readonly status: Identity['status'];
  readonly enrolledAt: number;
  readonly lastSeenAt: number;
  readonly permissions: Identity['permissions'];
}

export function publicIdentity(identity: Identity): PublicIdentity {
  return {
    id: identity.id,
    kind: identity.kind,
    displayName: identity.displayName,
    preferredName: identity.preferredName,
    relationshipToOwner: identity.relationshipToOwner,
    status: identity.status,
    enrolledAt: identity.enrolledAt,
    lastSeenAt: identity.lastSeenAt,
    permissions: identity.permissions,
  };
}

/** What a successful bootstrap or login returns. */
interface SessionBody {
  readonly identity: PublicIdentity;
  readonly session: { readonly id: string; readonly expiresAt: number };
  /**
   * The credential, returned once.
   *
   * The cookie is what a browser should use, and `src/` deliberately ignores this
   * field: putting a 30-day token into `localStorage` would undo the `HttpOnly`
   * that is the entire reason the cookie exists. It is here for a client that
   * cannot hold cookies — `curl`, a test, a CLI — which otherwise has no way to
   * authenticate at all.
   */
  readonly token: string;
}

export function mountIdentityRoutes(router: Router, deps: RouteDeps): void {
  const cookie = deps.config.session;

  /**
   * Issues a session and sets the cookie. Shared by bootstrap and login so the
   * two cannot drift into disagreeing about the lifetime or the attributes.
   */
  function beginSession(res: Response, identity: Identity): SessionBody {
    const issued = deps.identityRepo.createSession(identity.id, Date.now() + cookie.maxAgeMs);
    setSessionCookie(res, issued.token, issued.expiresAt, cookie);
    return {
      identity: publicIdentity(identity),
      session: { id: issued.id, expiresAt: issued.expiresAt },
      token: issued.token,
    };
  }

  /**
   * `GET /api/hello` — the one bit an anonymous client needs.
   *
   * Also reports which faculties are absent, because a UI that says "she is
   * thinking" over a configuration with no language model is lying on her
   * behalf. The boot report is `undefined` before `start()`, which is a state a
   * test can be in and a running process cannot.
   *
   * The list is named `absentAtBoot` rather than `absent` because that is what it
   * is: a record of what `start()` decided, which does not change afterwards even
   * when the world does. Two of its lines go stale the moment an owner is
   * enrolled — the missing owner, and the realtime fan-out that was waiting for
   * one — so the live answer to both sits beside it in `ownerEnrolled`. Calling
   * the field `absent` would have made a boot-time snapshot look like a current
   * reading, which is the same class of untruth as a version number nobody
   * maintains.
   */
  router.get(
    '/hello',
    asyncRoute('GET /api/hello', deps.report, (_req, res) => {
      res.json({
        name: 'Madhurita',
        ownerEnrolled: deps.identityRepo.hasOwner(),
        realtime: deps.config.flags.realtime,
        voice: deps.config.flags.voice,
        absentAtBoot: deps.bootReport()?.absent ?? [],
      });
    }),
  );

  /**
   * `POST /api/bootstrap` — enrol the owner, once.
   *
   * Rate-limited on the credential window because it takes a passphrase and
   * therefore costs a `scrypt` hash. The `hasOwner()` check here is a courtesy:
   * `executeBootstrap` refuses again inside the repository, which is where the
   * check has to be to be race-free.
   */
  router.post(
    '/bootstrap',
    asyncRoute('POST /api/bootstrap', deps.report, async (req, res) => {
      enforceLimit(deps.limits.credential, clientKey(req), 'bootstrap');

      const body = parseBody(BootstrapBodySchema, req.body);
      if (deps.identityRepo.hasOwner()) {
        throw new HttpError(
          'already_bootstrapped',
          'She already knows who she belongs to. Log in instead.',
        );
      }

      const result = await executeBootstrap(deps.identityRepo, {
        displayName: body.displayName,
        ...(body.preferredName !== undefined ? { preferredName: body.preferredName } : {}),
        passphrase: body.passphrase,
        ...(body.recoveryCode !== undefined ? { recoveryCode: body.recoveryCode } : {}),
      });
      if (!result.success || result.owner === undefined) {
        // `executeBootstrap`'s three failures are all about the *request* — an
        // owner already exists, the passphrase is too short, the name is empty —
        // so they are reportable to the client as-is. None of them contains a
        // credential.
        throw new HttpError(
          result.error === 'Instance is already bootstrapped; an owner exists.'
            ? 'already_bootstrapped'
            : 'invalid_request',
          result.error ?? 'She could not be set up.',
        );
      }

      // Enrolling the owner is the moment the realtime fan-out becomes possible:
      // before it there was no identity to build a `RuntimeState` around. Asking
      // for it here starts it, so the very first stream request does not find a
      // flow that was decided to be impossible at boot.
      deps.realtime();

      // The same moment, for the same reason, is the first one at which she can be told
      // who made her — the story is stored under his identity and names him from it, so
      // there was nowhere to put it until this row existed. Deliberately not guarded by a
      // try/catch: it writes to the database that just accepted the owner, through the
      // same repository the rest of the request used, and a failure here means something
      // is wrong that a 201 would hide.
      deps.rememberOrigin(result.owner);

      deps.limits.credential.forget(clientKey(req));
      res.status(201).json(beginSession(res, result.owner));
    }),
  );

  /**
   * `POST /api/session` — log in with the passphrase or the recovery code.
   *
   * The two go to different repository methods with *separate* failure counters,
   * which is why the body schema refuses to carry both: an attempt has to belong
   * to exactly one counter.
   *
   * The success path forgets the IP's window. The failure path does not — the
   * whole point is that failures accumulate.
   */
  router.post(
    '/session',
    asyncRoute('POST /api/session', deps.report, async (req, res) => {
      const ip = clientKey(req);
      enforceLimit(deps.limits.credential, ip, 'login');

      const body = parseBody(LoginBodySchema, req.body);
      if (!deps.identityRepo.hasOwner()) {
        throw new HttpError('no_owner', 'Nobody has been enrolled yet.');
      }

      const outcome =
        body.passphrase !== undefined
          ? await deps.identityRepo.verifyOwnerPassphrase(body.passphrase)
          : await deps.identityRepo.verifyRecoveryCode(body.recoveryCode ?? '');

      if (!outcome.ok) {
        // `mapAuthFailure` reads `lockedUntil` before `reason`, because the
        // attempt that trips the lock still reports `wrong_credential` and
        // carries the window. See its doc comment.
        throw mapAuthFailure(outcome);
      }

      // A revoked or dormant owner must not be handed a session even with the
      // right passphrase. `verifyOwnerPassphrase` checks the credential, not the
      // standing — the same split that makes `authenticate` re-read the identity.
      if (outcome.identity.status !== 'active') {
        throw new HttpError(
          'identity_inactive',
          outcome.identity.status === 'revoked'
            ? 'That identity has been revoked.'
            : 'That identity is dormant.',
        );
      }

      deps.limits.credential.forget(ip);
      deps.realtime();
      res.json(beginSession(res, outcome.identity));
    }),
  );

  /**
   * `DELETE /api/session` — log out.
   *
   * Revokes the session that authenticated *this* request, by its non-secret
   * `session.id`. Not `revokeAllSessions`: logging out of a laptop should not
   * log out the phone, and there is no evidence here that the credential was
   * compromised.
   *
   * The cookie is cleared whether or not the revoke found anything, because the
   * client's intent was to stop holding a credential.
   */
  router.delete(
    '/session',
    asyncRoute('DELETE /api/session', deps.report, (req, res) => {
      let caller: Caller | undefined;
      try {
        caller = requireCaller(req, deps);
      } catch (error) {
        // A logout with an already-dead session is a success from the client's
        // point of view: it wanted to not be logged in, and it is not. Only a
        // cross-site or rate-limit refusal is worth reporting, because those say
        // the *request* was wrong rather than the credential.
        if (
          error instanceof HttpError &&
          (error.code === 'bad_origin' || error.code === 'too_many_requests')
        ) {
          throw error;
        }
      }
      if (caller !== undefined) {
        deps.identityRepo.revokeSession(caller.session.id);
      }
      clearSessionCookie(res, cookie);
      res.status(204).end();
    }),
  );

  /** `GET /api/me` — the caller, as they are right now in the database. */
  router.get(
    '/me',
    asyncRoute('GET /api/me', deps.report, (req, res) => {
      const caller = requireCaller(req, deps);
      res.json({
        identity: publicIdentity(caller.identity),
        session: { id: caller.session.id, expiresAt: caller.session.expiresAt },
        via: caller.via,
      });
    }),
  );
}
