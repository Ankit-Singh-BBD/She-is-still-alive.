/**
 * The only place in `src/` that speaks HTTP.
 *
 * ## Why this is one file and not a hook
 *
 * Every route in `server/http/` answers failure in exactly one shape —
 * `{ error: { code, message, ...detail } }` — and the detail fields (`issues`,
 * `retryAfterMs`) are *spread onto* `error` rather than nested under it. That is
 * a contract worth decoding once. A component that did its own `fetch` would
 * eventually read `error.detail.issues`, find `undefined`, and render "something
 * went wrong" over a server that had said precisely what was wrong.
 *
 * ## Where these types come from
 *
 * Wire shapes the server *exports* are imported, type-only, from the module that
 * defines them — `RuntimeState`, `PublicIdentity`, `ConversationRow`,
 * `ConversationTurn`. `import type` is erased before the bundler sees it, so no
 * server code is pulled into the client; what it buys is that renaming a field in
 * `server/` breaks the build here rather than producing `undefined` on screen.
 *
 * The rest — `Hello`, `ChatReply`, `ActionSummary` — are declared below because
 * their routes build the body inline and export no type to import. Those three
 * are the hand-copied contracts, and the only ones a server change can silently
 * break.
 *
 * ## The token is deliberately dropped
 *
 * `POST /api/bootstrap` and `POST /api/session` return a 30-day bearer token
 * beside the `Set-Cookie`. It exists for `curl` and for tests. Storing it here
 * would put a long-lived credential into JavaScript's reach and undo the
 * `HttpOnly` that is the entire reason the cookie exists, so this client never
 * reads the field. The browser holds the session; we hold nothing.
 *
 * ## No CSRF token, and why that is not an omission
 *
 * `assertNotCrossSite` in `server/http/guard.ts` refuses a cookie-authenticated
 * write whose `Sec-Fetch-Site` is not `same-origin` (or whose `Origin` is not in
 * the allow-list). The browser sets that header and a page cannot forge it, so
 * the check is already complete. We must not try to set it either — it is a
 * forbidden header name, and an attempt would be silently dropped.
 */

import type { ConversationTurn } from '@server/conversations/messages.js';
import type { ConversationRow } from '@server/conversations/repository.js';
import type { PublicIdentity } from '@server/http/routes/identity.js';
import type { CycleRecord } from '@server/cognition/types.js';
import type { RuntimeState } from '@server/realtime/types.js';

export type { ConversationRow, ConversationTurn, PublicIdentity, RuntimeState };

/** The machine-readable half of a refusal. Mirrors `ErrorCode` in `server/http/errors.ts`. */
export type ApiErrorCode =
  | 'no_credential'
  | 'bad_credential'
  | 'wrong_passphrase'
  | 'locked_out'
  | 'identity_inactive'
  | 'forbidden'
  | 'invalid_request'
  | 'bad_origin'
  | 'no_owner'
  | 'already_bootstrapped'
  | 'not_found'
  | 'too_many_requests'
  | 'not_available'
  | 'unexpected'
  /** Not from the server: the request never arrived or never came back. */
  | 'offline';

/**
 * A refusal the server described, or a transport failure described as one.
 *
 * `message` is safe to show a person — every route builds it from an
 * `AuthOutcome`'s counters or from Zod field *names*, never from a credential.
 */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** Field-level validation messages, when the refusal was a bad body. */
  readonly issues: readonly string[];
  /** How long to wait, when the refusal was a rate limit or a lockout. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    detail: { issues?: readonly string[]; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = status;
    this.issues = detail.issues ?? [];
    this.retryAfterMs = detail.retryAfterMs;
  }

  /** True when the session is the problem, so the client should fall back to the door. */
  get isAuth(): boolean {
    return (
      this.code === 'no_credential' ||
      this.code === 'bad_credential' ||
      this.code === 'identity_inactive'
    );
  }
}

/* ------------------------------------------------------------------ wire types */

/** `GET /api/hello`. Built inline by the route; no server type to import. */
export interface Hello {
  readonly name: string;
  readonly ownerEnrolled: boolean;
  readonly realtime: boolean;
  readonly voice: boolean;
  /**
   * What `start()` found missing. Named for boot because that is when it was
   * read: two of its lines go stale the moment an owner is enrolled, and the
   * live answer to both is `ownerEnrolled` beside it.
   */
  readonly absentAtBoot: readonly string[];
}

export interface SessionInfo {
  readonly id: string;
  readonly expiresAt: number;
}

/** What a successful bootstrap or login gives us, minus the token we refuse to keep. */
export interface Session {
  readonly identity: PublicIdentity;
  readonly session: SessionInfo;
}

/** One action, as `POST /api/chat` reports it. Declared inline by the route. */
export interface ActionSummary {
  readonly toolId: string;
  /** The call returned. Not a claim that anything changed. */
  readonly success: boolean;
  /** A re-read of authoritative state confirmed the change. Only stage 8 sets this. */
  readonly verified: boolean;
  readonly error: string | undefined;
}

/**
 * `POST /api/chat`. Declared inline by the route.
 *
 * `status` and `fellBackAt` are the honest pair: `degraded` means she answered
 * but a stage threw on the way, and `fellBackAt` names which. A client that drew
 * `degraded` and `completed` identically would erase the distinction the cycle
 * went to trouble to make.
 */
export interface ChatReply {
  readonly conversationId: string;
  readonly cycleId: string;
  readonly status: CycleRecord['status'];
  readonly text: string;
  readonly voiceEnabled: boolean;
  readonly redacted: boolean;
  readonly disclosures: readonly string[];
  readonly fellBackAt: readonly string[];
  readonly actions: readonly ActionSummary[];
  readonly startedAt: number;
  readonly completedAt: number | undefined;
}

export interface Transcript {
  readonly conversation: ConversationRow;
  readonly total: number;
  readonly turns: readonly ConversationTurn[];
}

/** `GET /api/state`. `live` says whether `GET /api/stream` would keep this fresh. */
export interface StateReply {
  readonly live: boolean;
  readonly state: RuntimeState;
}

/* ------------------------------------------------------------------ the client */

/** Same origin in production; Vite proxies `/api` to the server in development. */
const BASE = '/api';

interface RawFailure {
  error?: {
    code?: unknown;
    message?: unknown;
    issues?: unknown;
    retryAfterMs?: unknown;
  };
}

const KNOWN_CODES: ReadonlySet<string> = new Set<ApiErrorCode>([
  'no_credential',
  'bad_credential',
  'wrong_passphrase',
  'locked_out',
  'identity_inactive',
  'forbidden',
  'invalid_request',
  'bad_origin',
  'no_owner',
  'already_bootstrapped',
  'not_found',
  'too_many_requests',
  'not_available',
  'unexpected',
]);

async function toFailure(res: Response): Promise<ApiFailure> {
  let body: RawFailure = {};
  try {
    body = (await res.json()) as RawFailure;
  } catch {
    // A refusal that is not JSON is a proxy or a crash, not a route. Fall through
    // to the generic message rather than pretending we parsed something.
  }
  const raw = body.error ?? {};
  const code =
    typeof raw.code === 'string' && KNOWN_CODES.has(raw.code)
      ? (raw.code as ApiErrorCode)
      : 'unexpected';
  const message =
    typeof raw.message === 'string' && raw.message.length > 0
      ? raw.message
      : `The server refused with ${res.status}.`;
  const issues = Array.isArray(raw.issues)
    ? raw.issues.filter((item): item is string => typeof item === 'string')
    : undefined;
  const retryAfterMs = typeof raw.retryAfterMs === 'number' ? raw.retryAfterMs : undefined;

  return new ApiFailure(code, message, res.status, {
    ...(issues !== undefined ? { issues } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      // The session cookie is the credential; without this it never leaves.
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    // No status, no envelope — the request never completed. Reported under its
    // own code so the UI can say "cannot be reached" instead of guessing 500.
    throw new ApiFailure('offline', 'She cannot be reached right now.', 0);
  }

  if (!res.ok) throw await toFailure(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  /** The one unauthenticated read. Decides which screen a fresh client shows. */
  hello: (): Promise<Hello> => request<Hello>('/hello'),

  /** Who the caller is, right now in the database. 401 when nobody. */
  me: (): Promise<Session & { via: 'cookie' | 'bearer' }> =>
    request<Session & { via: 'cookie' | 'bearer' }>('/me'),

  /** Enrol the owner. Succeeds once per instance, and logs them in. */
  bootstrap: (body: {
    displayName: string;
    preferredName?: string;
    passphrase: string;
    recoveryCode?: string;
  }): Promise<Session> => request<Session>('/bootstrap', json(body)),

  /** Log in with exactly one of the two credentials — the server refuses both. */
  login: (body: { passphrase: string } | { recoveryCode: string }): Promise<Session> =>
    request<Session>('/session', json(body)),

  /** Revoke this session only. A laptop logging out must not log out the phone. */
  logout: (): Promise<void> => request<void>('/session', { method: 'DELETE' }),

  /** One authoritative read, for the moment before the stream opens. */
  state: (): Promise<StateReply> => request<StateReply>('/state'),

  /** One turn: the whole twelve-stage cycle behind one request. */
  chat: (body: { text: string; conversationId?: string }): Promise<ChatReply> =>
    request<ChatReply>('/chat', json(body)),

  conversations: (): Promise<{ conversations: readonly ConversationRow[] }> =>
    request<{ conversations: readonly ConversationRow[] }>('/conversations'),

  transcript: (id: string, limit = 50): Promise<Transcript> =>
    request<Transcript>(`/conversations/${encodeURIComponent(id)}/messages?limit=${limit}`),

  /** Tell her where she is, so the sky in the room is the sky outside. */
  place: (coords: { lat: number; lng: number }): Promise<unknown> =>
    request<unknown>('/location', json(coords)),
};
