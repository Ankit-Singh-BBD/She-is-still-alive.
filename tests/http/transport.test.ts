/**
 * The HTTP transport, driven over a real socket.
 *
 * These tests bind a port with `listen(0)` and use `fetch`, rather than mounting
 * the Express app in-process with a request-shaped object. That costs a few
 * milliseconds per test and buys the things that only a socket can prove:
 *
 *  - that `compression` does not touch `text/event-stream` — the whole failure is
 *    that a buffered stream looks perfect to an in-process assertion and dead to
 *    a client;
 *  - that a `Set-Cookie` written by `setSessionCookie` survives as a `Cookie`
 *    header the next request actually sends;
 *  - that `stop()` returns with a stream still open, which is the one thing
 *    `closeAllConnections` exists for and cannot be observed without a real
 *    connection;
 *  - that a malformed body produces the JSON envelope rather than Express's HTML
 *    error page, which is decided by middleware ordering the app object hides.
 *
 * There is no `supertest`, for the reason the rest of this repository has no
 * dependency it can do without: `fetch` is in the runtime.
 *
 * The language model is absent throughout. That is not a limitation of the test —
 * it is the configuration the transport has to be honest about, and
 * `POST /api/chat` asserting a `status` of `completed` *or* `degraded` is the
 * point: the route reports what the cycle did, and a cycle whose stages fell back
 * to their deterministic paths is allowed to say so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { createHttpServer, type RunningHttpServer } from '@server/http/index.js';
import { STATE_EVENT } from '@server/http/routes/presence.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { WeatherObservation, WeatherProvider } from '@server/environment/index.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');
const CLIENT_INDEX = resolve(process.cwd(), 'dist/client/index.html');

const PASSPHRASE = 'a passphrase long enough to pass';

/**
 * A sky that never needs the network.
 *
 * `POST /api/location` awaits a refresh, so without this the test would make a
 * real request to Open-Meteo — slow, flaky, and a test that fails when the
 * machine is offline is testing the wrong thing.
 */
const STILL_SKY: WeatherProvider = {
  observe: (): Promise<WeatherObservation> =>
    Promise.resolve({
      condition: 'clear',
      temperature: 21,
      observedAt: Date.now(),
      sunrise: undefined,
      sunset: undefined,
      isDay: true,
      timeZone: 'Asia/Kolkata',
    }),
};

/** Fails loudly rather than hanging when a frame never arrives. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One SSE frame, parsed into the three fields this transport writes. */
interface Frame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
  readonly raw: string;
}

function parseFrame(raw: string): Frame {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) id = line.slice(4);
    else if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data.push(line.slice(6));
  }
  return { id, event, data: data.join('\n'), raw };
}

/**
 * Reads frames off an open stream until `count` have arrived.
 *
 * Heartbeat comments are skipped — `EventSource` discards them and so should a
 * test, or a slow assertion would consume one as if it were an event.
 */
class FrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly pending: Frame[] = [];

  constructor(body: ReadableStream<Uint8Array>) {
    this.reader = body.getReader();
  }

  async take(count: number, ms = 5_000): Promise<Frame[]> {
    const taken: Frame[] = [];
    while (taken.length < count) {
      const ready = this.pending.shift();
      if (ready !== undefined) {
        taken.push(ready);
        continue;
      }
      const chunk = await withTimeout(this.reader.read(), ms, `SSE frame ${taken.length + 1}`);
      if (chunk.done) throw new Error('the stream ended before enough frames arrived');
      this.buffer += this.decoder.decode(chunk.value, { stream: true });
      let boundary = this.buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        // A comment line is a heartbeat, not an event.
        if (raw !== '' && !raw.startsWith(':')) this.pending.push(parseFrame(raw));
        boundary = this.buffer.indexOf('\n\n');
      }
    }
    return taken;
  }

  cancel(): void {
    void this.reader.cancel().catch(() => {
      // The socket is being dropped on purpose; a rejection here is the drop.
    });
  }
}

describe('HTTP transport (server/http)', () => {
  let db: Database;
  let app: MadhuritaApp;
  let http: RunningHttpServer;
  /** Set by `bootstrap()` / `login()`, and sent by `api` from then on. */
  let cookie: string | undefined;

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({
      // Sweeps off: this suite asserts on request/response, and a task poll
      // firing mid-assertion would add events the stream tests have to tolerate.
      config: loadConfig({ FLAG_TASKS: 'false', FLAG_PROACTIVITY: 'false' }),
      db,
      installGlobalDatabase: false,
      weatherProvider: STILL_SKY,
    });
    await app.start();
    // Port 0: the OS picks, so the suite cannot collide with a dev server or
    // with itself under `--pool=threads`.
    http = await createHttpServer({ deps: app.routeDeps, port: 0, host: '127.0.0.1' }).start();
    cookie = undefined;
  });

  afterEach(async () => {
    await http.stop();
    await app.stop();
    db.close();
    closeDatabase();
  });

  /** One request, carrying whatever cookie the last login produced. */
  const api = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== undefined && !headers.has('cookie')) headers.set('cookie', cookie);
    // A browser sends this on every same-origin request; `assertNotCrossSite`
    // reads it first, so omitting it here would test a path real clients do not
    // take. The cross-site tests set it themselves.
    if (!headers.has('sec-fetch-site')) headers.set('sec-fetch-site', 'same-origin');
    return fetch(`${http.url}${path}`, { ...init, headers });
  };

  const postJson = (path: string, body: unknown, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    return api(path, { ...init, method: 'POST', headers, body: JSON.stringify(body) });
  };

  /** Remembers the session cookie the way a browser would. */
  function rememberCookie(res: Response): void {
    const header = res.headers.get('set-cookie');
    if (header === null) return;
    const first = header.split(';')[0] ?? '';
    cookie = first.endsWith('=') ? undefined : first;
  }

  interface SessionShape {
    token: string;
    identity: { id: string; kind: string; displayName: string };
    session: { id: string; expiresAt: number };
  }

  async function bootstrap(): Promise<SessionShape> {
    const res = await postJson('/api/bootstrap', {
      displayName: 'Ankit',
      preferredName: 'Ankit',
      passphrase: PASSPHRASE,
    });
    expect(res.status).toBe(201);
    rememberCookie(res);
    return (await res.json()) as SessionShape;
  }

  // ── The public edge ────────────────────────────────────────────────────────

  describe('GET /api/hello', () => {
    it('is the only route that answers without a credential', async () => {
      const res = await api('/api/hello');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        name: string;
        ownerEnrolled: boolean;
        realtime: boolean;
        absentAtBoot: string[];
      };
      expect(body.name).toBe('Madhurita');
      expect(body.ownerEnrolled).toBe(false);
      expect(body.realtime).toBe(true);
    });

    it('reports what boot decided, including the faculty that is not there', async () => {
      const body = (await (await api('/api/hello')).json()) as { absentAtBoot: string[] };
      expect(body.absentAtBoot.some((line) => line.startsWith('language faculty'))).toBe(true);
      // No owner at boot, so the fan-out could not have a first state yet.
      expect(body.absentAtBoot.some((line) => line.startsWith('realtime'))).toBe(true);
    });

    it('says nothing about who she belongs to', async () => {
      await bootstrap();
      const raw = await (await api('/api/hello')).text();
      expect(raw).not.toContain('Ankit');
      expect(raw).not.toContain(PASSPHRASE);
    });

    it('does not announce the framework', async () => {
      const res = await api('/api/hello');
      expect(res.headers.get('x-powered-by')).toBeNull();
    });

    it('carries the security headers on every response', async () => {
      const res = await api('/api/hello');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      // The one that matters: inline styles are allowed, inline scripts are not.
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    });
  });

  describe('everything else', () => {
    it('refuses without a credential, in the JSON envelope', async () => {
      for (const path of ['/api/me', '/api/state', '/api/stream', '/api/conversations']) {
        const res = await api(path);
        expect(res.status, path).toBe(401);
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code, path).toBe('no_credential');
        expect(typeof body.error.message).toBe('string');
      }
    });

    it('answers an unknown /api path with the envelope, not the client', async () => {
      const res = await api('/api/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    });

    it('rejects a malformed body as the client mistake it is', async () => {
      const res = await api('/api/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"displayName": ',
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    });

    it('refuses a body larger than the limit without parsing it', async () => {
      const res = await postJson('/api/bootstrap', {
        displayName: 'x'.repeat(200_000),
        passphrase: PASSPHRASE,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('invalid_request');
      expect(body.error.message).toContain('64kb');
    });

    it('refuses an unknown field rather than silently dropping it', async () => {
      const res = await postJson('/api/bootstrap', {
        displayName: 'Ankit',
        passPhrase: PASSPHRASE,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; issues?: string[] } };
      expect(body.error.code).toBe('invalid_request');
      // `.strict()`, so `passPhrase` is refused rather than stripped — the whole
      // point being that a client typing the field name wrong hears about it.
      expect(body.error.issues?.length ?? 0).toBeGreaterThan(0);
    });
  });

  // ── Bootstrap and session ─────────────────────────────────────────────────

  describe('POST /api/bootstrap', () => {
    it('enrols the owner and hands back a session in one request', async () => {
      const body = await bootstrap();
      expect(body.identity.kind).toBe('owner');
      expect(body.identity.displayName).toBe('Ankit');
      expect(body.session.expiresAt).toBeGreaterThan(Date.now());
      expect(body.token.length).toBeGreaterThanOrEqual(43);
      // The record handle is not the credential.
      expect(body.token).not.toBe(body.session.id);
    });

    it('sets an HttpOnly cookie a script cannot read', async () => {
      const res = await postJson('/api/bootstrap', {
        displayName: 'Ankit',
        passphrase: PASSPHRASE,
      });
      const header = res.headers.get('set-cookie') ?? '';
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Path=/');
      expect(header).toContain('SameSite=Lax');
      expect(header).toMatch(/Max-Age=\d+/);
    });

    it('refuses the second one', async () => {
      await bootstrap();
      const res = await postJson('/api/bootstrap', {
        displayName: 'Someone else',
        passphrase: 'another passphrase entirely',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('already_bootstrapped');
    });

    it('refuses a passphrase shorter than the repository would accept', async () => {
      const res = await postJson('/api/bootstrap', { displayName: 'Ankit', passphrase: 'short' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { issues?: string[] } };
      expect((body.error.issues ?? []).join(' ')).toContain('8 characters');
    });

    it('never echoes the passphrase, in any answer', async () => {
      const good = await (await postJson('/api/bootstrap', {
        displayName: 'Ankit',
        passphrase: PASSPHRASE,
      })).text();
      const bad = await (await postJson('/api/session', { passphrase: 'wrong one entirely' })).text();
      expect(good).not.toContain(PASSPHRASE);
      expect(bad).not.toContain('wrong one entirely');
    });
  });

  describe('POST /api/session', () => {
    it('says there is nobody to log in as before bootstrap', async () => {
      const res = await postJson('/api/session', { passphrase: PASSPHRASE });
      // 409 and not 404: the route exists and the request was well formed; what
      // is missing is a precondition of the instance.
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('no_owner');
    });

    it('accepts the right passphrase and refuses the wrong one', async () => {
      await bootstrap();
      cookie = undefined;

      const wrong = await postJson('/api/session', { passphrase: 'not the passphrase' });
      expect(wrong.status).toBe(401);

      const right = await postJson('/api/session', { passphrase: PASSPHRASE });
      expect(right.status).toBe(200);
      rememberCookie(right);
      expect(cookie).toBeDefined();
    });

    it('refuses to carry both credentials at once', async () => {
      await bootstrap();
      const res = await postJson('/api/session', {
        passphrase: PASSPHRASE,
        recoveryCode: 'something',
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { issues?: string[] } };
      expect((body.error.issues ?? []).join(' ')).toContain('exactly one');
    });

    it('tells the fifth wrong attempt how long the lock lasts', async () => {
      await bootstrap();
      let last: Response | undefined;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        last = await postJson('/api/session', { passphrase: `wrong ${attempt}` });
      }
      expect(last).toBeDefined();
      // 429 and not 401: `mapAuthFailure` reads `lockedUntil` before `reason`,
      // because the attempt that trips the lock still reports `wrong_credential`.
      expect(last?.status).toBe(429);
      expect(Number(last?.headers.get('retry-after') ?? '0')).toBeGreaterThan(0);
    });
  });

  describe('GET /api/me', () => {
    it('answers for a cookie and reports how the credential arrived', async () => {
      await bootstrap();
      const res = await api('/api/me');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { via: string; identity: { kind: string } };
      expect(body.via).toBe('cookie');
      expect(body.identity.kind).toBe('owner');
    });

    it('answers for a bearer token with no cookie at all', async () => {
      const session = await bootstrap();
      cookie = undefined;
      const res = await api('/api/me', {
        headers: { authorization: `Bearer ${session.token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { via: string };
      expect(body.via).toBe('bearer');
    });

    it('refuses the session id presented as if it were the token', async () => {
      const session = await bootstrap();
      cookie = undefined;
      const res = await api('/api/me', {
        headers: { authorization: `Bearer ${session.session.id}` },
      });
      expect(res.status).toBe(401);
    });

    it('never returns the passphrase hash or the token', async () => {
      const session = await bootstrap();
      const raw = await (await api('/api/me')).text();
      expect(raw).not.toContain(session.token);
      expect(raw).not.toContain('token_hash');
      expect(raw).not.toContain('passphrase');
    });
  });

  describe('DELETE /api/session', () => {
    it('revokes the session it was called with', async () => {
      await bootstrap();
      const out = await api('/api/session', { method: 'DELETE' });
      expect(out.status).toBe(204);
      // The cookie is cleared, and the token behind it is dead server-side.
      expect(out.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
      const after = await api('/api/me');
      expect(after.status).toBe(401);
    });

    it('treats a logout with no session as the success it is', async () => {
      const res = await api('/api/session', { method: 'DELETE' });
      expect(res.status).toBe(204);
    });

    it('leaves the other session alone', async () => {
      const first = await bootstrap();
      const second = await postJson('/api/session', { passphrase: PASSPHRASE });
      const secondBody = (await second.json()) as SessionShape;

      await api('/api/session', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${first.token}` },
      });

      cookie = undefined;
      const still = await api('/api/me', {
        headers: { authorization: `Bearer ${secondBody.token}` },
      });
      expect(still.status).toBe(200);
    });
  });

  // ── CSRF ──────────────────────────────────────────────────────────────────

  describe('cross-site writes', () => {
    it('refuses a cookie-authenticated POST that says it is cross-site', async () => {
      await bootstrap();
      const res = await postJson('/api/chat', { text: 'hello' }, {
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('bad_origin');
    });

    it('refuses a cookie POST from a foreign Origin even with no Sec-Fetch-Site', async () => {
      await bootstrap();
      const headers = new Headers({
        'content-type': 'application/json',
        origin: 'https://evil.example',
      });
      if (cookie !== undefined) headers.set('cookie', cookie);
      const res = await fetch(`${http.url}/api/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(403);
    });

    it('allows a bearer POST from anywhere, because a cookie is not what was used', async () => {
      const session = await bootstrap();
      cookie = undefined;
      const res = await postJson('/api/chat', { text: 'hello' }, {
        headers: {
          authorization: `Bearer ${session.token}`,
          'sec-fetch-site': 'cross-site',
          origin: 'https://someone-elses-tool.example',
        },
      });
      expect(res.status).toBe(200);
    });

    it('does not apply the check to reads', async () => {
      await bootstrap();
      const res = await api('/api/me', {
        headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' },
      });
      expect(res.status).toBe(200);
    });
  });

  // ── The cycle ─────────────────────────────────────────────────────────────

  describe('POST /api/chat', () => {
    it('runs a cycle and reports what it actually did', async () => {
      await bootstrap();
      const res = await postJson('/api/chat', { text: 'Are you there?' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        conversationId: string;
        cycleId: string;
        status: string;
        text: string;
        fellBackAt: string[];
        actions: { toolId: string; success: boolean; verified: boolean }[];
        startedAt: number;
      };
      expect(body.conversationId).not.toBe('');
      expect(body.conversationId).not.toBe('unknown');
      expect(body.cycleId).not.toBe('');
      // With no language model the honest answers are `completed` (every stage
      // took its documented fallback without throwing) or `degraded` (one threw
      // and used it). `failed` would mean PERSIST itself broke.
      expect(['completed', 'degraded']).toContain(body.status);
      expect(body.text.length).toBeGreaterThan(0);
      expect(Array.isArray(body.fellBackAt)).toBe(true);
      expect(body.startedAt).toBeGreaterThan(0);
    });

    it('reports a degraded cycle as degraded, and names the stages', async () => {
      await bootstrap();
      const body = (await (await postJson('/api/chat', { text: 'hello' })).json()) as {
        status: string;
        fellBackAt: string[];
      };
      // The contract, not the outcome: `degraded` and a named stage go together,
      // and `completed` means the list is empty. Either is a passing run; a
      // `degraded` with nothing named would be the dishonesty.
      if (body.status === 'degraded') expect(body.fellBackAt.length).toBeGreaterThan(0);
      else expect(body.fellBackAt).toEqual([]);
    });

    it('keeps the conversation when handed its id back', async () => {
      await bootstrap();
      const first = (await (await postJson('/api/chat', { text: 'first' })).json()) as {
        conversationId: string;
      };
      const second = (await (await postJson('/api/chat', {
        text: 'second',
        conversationId: first.conversationId,
      })).json()) as { conversationId: string };
      expect(second.conversationId).toBe(first.conversationId);
    });

    it('refuses an empty turn before running anything', async () => {
      await bootstrap();
      const res = await postJson('/api/chat', { text: '   ' });
      expect(res.status).toBe(400);
      const rows = db.raw.prepare(`SELECT COUNT(*) AS n FROM cycle_record`).get() as { n: number };
      expect(rows.n).toBe(0);
    });

    it('refuses to continue somebody else\'s conversation', async () => {
      await bootstrap();
      const other = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Someone else',
        permissions: DEFAULT_PERMISSIONS.person,
      });
      const theirs = app.conversations.open(other.id, 'text');

      const res = await postJson('/api/chat', { text: 'hello', conversationId: theirs.id });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('forbidden');
      expect(body.error.message).toContain('belongs to another identity');
    });
  });

  describe('the transcript', () => {
    it('reads back what was said, oldest first', async () => {
      await bootstrap();
      const turn = (await (await postJson('/api/chat', { text: 'remember this' })).json()) as {
        conversationId: string;
      };

      const res = await api(`/api/conversations/${turn.conversationId}/messages`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        total: number;
        turns: { role: string; text: string }[];
      };
      expect(body.total).toBeGreaterThan(0);
      expect(body.turns[0]?.role).toBe('user');
      expect(body.turns[0]?.text).toContain('remember this');
    });

    it('lists the caller\'s own conversations', async () => {
      await bootstrap();
      await postJson('/api/chat', { text: 'one' });
      const body = (await (await api('/api/conversations')).json()) as {
        conversations: { id: string; identityId: string }[];
      };
      expect(body.conversations.length).toBe(1);
    });

    it('answers 404 for a conversation that is not the caller\'s, same as for one that does not exist', async () => {
      await bootstrap();
      const other = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Someone else',
        permissions: DEFAULT_PERMISSIONS.person,
      });
      const theirs = app.conversations.open(other.id, 'text');

      const mine = await api(`/api/conversations/${theirs.id}/messages`);
      const nothing = await api('/api/conversations/01JQNOTAREALULIDATALL00/messages');
      expect(mine.status).toBe(404);
      expect(nothing.status).toBe(404);
      // Deliberately indistinguishable: a different answer would confirm the id.
      expect(await mine.text()).toBe(await nothing.text());
    });
  });

  // ── State and stream ──────────────────────────────────────────────────────

  describe('GET /api/state', () => {
    it('is live once an owner exists, and says so', async () => {
      await bootstrap();
      const res = await api('/api/state');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        live: boolean;
        state: { version: number; identity: { kind: string }; environment: { timeOfDay: string } };
      };
      expect(body.live).toBe(true);
      expect(body.state.identity.kind).toBe('owner');
      expect(['night', 'sunrise', 'day', 'sunset']).toContain(body.state.environment.timeOfDay);
    });

    it('reports the counts it actually read', async () => {
      await bootstrap();
      await postJson('/api/chat', { text: 'something worth keeping' });
      const body = (await (await api('/api/state')).json()) as {
        state: { memory: Record<string, number>; version: number };
      };
      expect(body.state.version).toBeGreaterThan(0);
      for (const key of ['episodicCount', 'semanticCount', 'preferenceCount']) {
        expect(typeof body.state.memory[key]).toBe('number');
      }
    });
  });

  describe('GET /api/stream', () => {
    it('sends the retry hint and a full state before anything else', async () => {
      await bootstrap();
      const res = await api('/api/stream', { headers: { accept: 'text/event-stream' } });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      // The two halves of the anti-buffering fix.
      expect(res.headers.get('content-encoding')).toBe('identity');
      expect(res.headers.get('x-accel-buffering')).toBe('no');

      const body = res.body;
      expect(body).not.toBeNull();
      if (body === null) return;
      const reader = new FrameReader(body);
      const [retry, first] = await reader.take(2);
      expect(retry?.raw).toContain('retry:');
      expect(first?.event).toBe('state');
      const state = JSON.parse(first?.data ?? '{}') as { identity?: { kind?: string } };
      expect(state.identity?.kind).toBe('owner');
      reader.cancel();
    });

    it('is not compressed even when the client offers to accept gzip', async () => {
      await bootstrap();
      const res = await api('/api/stream', {
        headers: { accept: 'text/event-stream', 'accept-encoding': 'gzip, deflate, br' },
      });
      // `compression`'s filter said no, so the stream is bytes on the wire the
      // moment they are written rather than bytes in a buffer waiting for more.
      expect(res.headers.get('content-encoding')).toBe('identity');
      res.body?.cancel().catch(() => undefined);
    });

    it('follows every event frame with a state frame', async () => {
      await bootstrap();
      const stream = await api('/api/stream', { headers: { accept: 'text/event-stream' } });
      const body = stream.body;
      expect(body).not.toBeNull();
      if (body === null) return;
      const reader = new FrameReader(body);
      await reader.take(2); // retry, then the opening snapshot

      await postJson('/api/chat', { text: 'say something to the stream' });

      // One cycle publishes several events; `RealtimeFlow` coalesces by type, so
      // the count is not predictable — the pairing is.
      const frames = await reader.take(4);
      for (let index = 0; index + 1 < frames.length; index += 2) {
        const event = frames[index];
        const state = frames[index + 1];
        expect(event?.event).not.toBe('state');
        // Event frames carry the sequence number the browser echoes back.
        expect(event?.id).toMatch(/^\d+$/);
        expect(state?.event).toBe('state');
      }
      reader.cancel();
    });

    it('never sends a version that goes backwards, or an id a replay cannot use', async () => {
      await bootstrap();
      const stream = await api('/api/stream', { headers: { accept: 'text/event-stream' } });
      const body = stream.body;
      if (body === null) throw new Error('no stream body');
      const reader = new FrameReader(body);
      const opening = await reader.take(2);

      await postJson('/api/chat', { text: 'a whole cycle, and its twelve stages' });
      const frames = [...opening, ...(await reader.take(6))];
      reader.cancel();

      // Stage 12 writes its own `domain_event` rows inside the cycle's
      // transaction and then re-dispatches them in process. It used to invent
      // `seq: -1` for that dispatch, which drove `RuntimeState.version` to -1 on
      // every single cycle and put an `id:` on the wire that `Last-Event-ID`
      // replay reads as "no cursor" and silently ignores. Both are asserted here
      // because both look like working code.
      let previous = -Infinity;
      let sawState = false;
      for (const frame of frames) {
        if (frame.event === STATE_EVENT) {
          const state = JSON.parse(frame.data) as { version: number };
          expect(Number.isInteger(state.version)).toBe(true);
          expect(state.version).toBeGreaterThanOrEqual(0);
          expect(state.version).toBeGreaterThanOrEqual(previous);
          previous = state.version;
          sawState = true;
          continue;
        }
        if (frame.id === undefined) continue;
        expect(Number(frame.id)).toBeGreaterThan(0);
      }
      expect(sawState).toBe(true);
      // And the last version she reported is a row that exists.
      const top = (
        db.raw.prepare(`SELECT MAX(seq) AS seq FROM domain_event`).get() as { seq: number }
      ).seq;
      expect(previous).toBeLessThanOrEqual(top);
    });

    it('publishes session.connected for the subscriber', async () => {
      await bootstrap();
      const stream = await api('/api/stream', { headers: { accept: 'text/event-stream' } });
      const body = stream.body;
      if (body === null) throw new Error('no stream body');
      const reader = new FrameReader(body);
      await reader.take(2);
      // The publish is awaited after the gate opens, so one more frame is enough
      // to know it has been written.
      await reader.take(2);
      const rows = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM domain_event WHERE type = 'session.connected'`)
        .get() as { n: number };
      expect(rows.n).toBe(1);
      reader.cancel();
    });

    it('replays only the events a reconnecting client missed', async () => {
      await bootstrap();
      await postJson('/api/chat', { text: 'before the reconnect' });

      const seq = (
        db.raw.prepare(`SELECT MAX(seq) AS seq FROM domain_event`).get() as { seq: number }
      ).seq;

      const stream = await api('/api/stream', {
        headers: { accept: 'text/event-stream', 'last-event-id': String(seq - 2) },
      });
      const body = stream.body;
      if (body === null) throw new Error('no stream body');
      const reader = new FrameReader(body);
      const frames = await reader.take(4);
      expect(frames[0]?.raw).toContain('retry:');
      // The snapshot comes first: it is already authoritative, so replay is for
      // the log a client shows and not the state a client trusts.
      expect(frames[1]?.event).toBe('state');
      const replayed = frames.slice(2).filter((frame) => frame.event !== 'state');
      for (const frame of replayed) expect(Number(frame.id)).toBeGreaterThan(seq - 3);
      reader.cancel();
    });

    it('ignores a Last-Event-ID that is not a number', async () => {
      await bootstrap();
      const res = await api('/api/stream', {
        headers: { accept: 'text/event-stream', 'last-event-id': 'not-a-number' },
      });
      expect(res.status).toBe(200);
      res.body?.cancel().catch(() => undefined);
    });

    it('refuses rather than hanging when realtime is off', async () => {
      await http.stop();
      await app.stop();
      db.close();

      db = new Database({ path: ':memory:' });
      runMigrations(db, MIGRATIONS);
      app = createApp({
        config: loadConfig({
          FLAG_REALTIME: 'false',
          FLAG_TASKS: 'false',
          FLAG_PROACTIVITY: 'false',
        }),
        db,
        installGlobalDatabase: false,
        weatherProvider: STILL_SKY,
      });
      await app.start();
      http = await createHttpServer({ deps: app.routeDeps, port: 0, host: '127.0.0.1' }).start();
      cookie = undefined;
      await bootstrap();

      const res = await api('/api/stream', { headers: { accept: 'text/event-stream' } });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('not_available');
      expect(body.error.message).toContain('switched off');

      // And the one-shot read still works, honestly labelled.
      const state = (await (await api('/api/state')).json()) as {
        live: boolean;
        state: { version: number };
      };
      expect(state.live).toBe(false);
      expect(state.state.version).toBe(0);
    });

    it('lets the server stop with a stream still open', async () => {
      await bootstrap();
      const stream = await api('/api/stream', { headers: { accept: 'text/event-stream' } });
      const body = stream.body;
      if (body === null) throw new Error('no stream body');
      const reader = new FrameReader(body);
      await reader.take(2);

      // Without `closeAllConnections` this is where the suite would hang: an SSE
      // response is a request that never finishes, and `server.close()` waits.
      await withTimeout(http.stop(), 3_000, 'the listener to close with an open stream');
      reader.cancel();

      // Stopping twice is not an error, and `stop()` in `afterEach` will do it.
      await expect(http.stop()).resolves.toBeUndefined();
    });
  });

  // ── Location ──────────────────────────────────────────────────────────────

  describe('POST /api/location', () => {
    it('takes the client\'s coordinates over the configured ones and looks again', async () => {
      await bootstrap();
      const res = await postJson('/api/location', { lat: 26.8467, lng: 80.9462 });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        locationSource: string;
        state: { weather: { condition: string } };
        stale: boolean;
      };
      expect(body.locationSource).toBe('client');
      // The stubbed sky, observed rather than assumed.
      expect(body.state.weather.condition).toBe('clear');
      expect(body.stale).toBe(false);
    });

    it('refuses coordinates that are not on Earth', async () => {
      await bootstrap();
      for (const bad of [{ lat: 91, lng: 0 }, { lat: 0, lng: 181 }]) {
        const res = await postJson('/api/location', bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
      }
    });

    it('refuses a latitude that is not a number at all', async () => {
      await bootstrap();
      const res = await postJson('/api/location', { lat: 'north', lng: 0 });
      expect(res.status).toBe(400);
    });
  });

  // ── Rate limits ───────────────────────────────────────────────────────────

  describe('rate limits', () => {
    it('throttles credential attempts by socket address, with a retry window', async () => {
      let limited: Response | undefined;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const res = await postJson('/api/session', { passphrase: `guess ${attempt}` });
        if (res.status === 429) {
          limited = res;
          break;
        }
      }
      expect(limited).toBeDefined();
      const body = (await limited?.json()) as { error: { code: string } } | undefined;
      expect(body?.error.code).toBe('too_many_requests');
      expect(Number(limited?.headers.get('retry-after') ?? '0')).toBeGreaterThan(0);
    });

    it('forgets a successful login, so a mistype costs nothing later', async () => {
      await bootstrap();
      cookie = undefined;
      await postJson('/api/session', { passphrase: 'wrong once' });
      await postJson('/api/session', { passphrase: 'wrong twice' });
      const good = await postJson('/api/session', { passphrase: PASSPHRASE });
      expect(good.status).toBe(200);
      // The counter was cleared, so the next few attempts are not near a limit.
      const again = await postJson('/api/session', { passphrase: PASSPHRASE });
      expect(again.status).toBe(200);
    });
  });

  // ── The client ────────────────────────────────────────────────────────────

  describe('the client', () => {
    it('says what is wrong rather than 404ing when it has not been built', async () => {
      const res = await api('/');
      if (existsSync(CLIENT_INDEX)) {
        // Built: the SPA entry is served, and never cached.
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toContain('no-cache');
        return;
      }
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain('npm run build');
      expect(text).toContain('/api/hello');
    });

    it('does not answer a client route with the API 404', async () => {
      const res = await api('/some/deep/client/route');
      expect(res.status).not.toBe(404);
      expect(res.headers.get('content-type') ?? '').not.toContain('application/json');
    });
  });
});
