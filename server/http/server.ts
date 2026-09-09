/**
 * The listener, and the five decisions that are easy to get wrong once.
 *
 * ## 1. `compression` must not touch the stream
 *
 * `compression` will gzip `text/event-stream` and then hold each event in its
 * buffer until enough bytes accumulate to be worth flushing. The stream works in
 * a test that reads the raw socket and appears dead in a browser. The filter
 * below is the fix, and it is the reason `sse.ts` also sets
 * `Content-Encoding: identity` and `X-Accel-Buffering: no` — one for the
 * middleware in this process, the others for whatever proxy sits in front.
 *
 * ## 2. `trust proxy` stays off
 *
 * With it on, `req.ip` is read from `X-Forwarded-For`, which any client can
 * write. The rate limiter is keyed by `req.ip`, so trusting that header would
 * turn the limiter into a way to fill a `Map` with attacker-chosen keys. Off, it
 * is the socket address. An operator who really is behind a proxy has to say so
 * deliberately.
 *
 * ## 3. A malformed body is a 400, not a 500
 *
 * `express.json()` throws a `SyntaxError` *before* any route runs, so
 * `asyncRoute` never sees it and the default Express handler would answer with an
 * HTML error page. The error middleware at the bottom translates it into the same
 * envelope as every other failure, because a client that has to parse two
 * different error formats will only ever handle one of them.
 *
 * ## 4. `closeAllConnections` is not optional
 *
 * An SSE response is a socket that never ends. `server.close()` waits for
 * in-flight requests, so with one browser connected it waits forever and
 * `app.stop()` never returns — a test suite hangs and a `SIGINT` does nothing.
 *
 * ## 5. The client may not be built
 *
 * `dist/client` exists only after `npm run build`. Serving nothing and returning
 * 404 for `/` would look like a broken server; the fallback says what is actually
 * wrong and what to run. The API is mounted first either way, so a missing client
 * never affects it.
 */

import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import compression from 'compression';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';

import type { RouteDeps } from './deps.js';
import { HttpError, sendError } from './errors.js';
import { mountConversationRoutes } from './routes/conversation.js';
import { mountIdentityRoutes } from './routes/identity.js';
import { mountPresenceRoutes } from './routes/presence.js';

/** Where `vite build` puts the client, per `vite.config.ts`'s `outDir`. */
const CLIENT_DIR = fileURLToPath(new URL('../../dist/client', import.meta.url));

/**
 * The largest request body accepted.
 *
 * A chat turn is capped at 8,000 characters by `ChatBodySchema`, and no other
 * route takes anything longer. 64kb leaves room for multi-byte text and headers
 * without letting an unauthenticated `POST /api/session` hand the process a
 * megabyte to parse.
 */
const BODY_LIMIT = '64kb';

/** Vite's dev server port, from `vite.config.ts`. */
const DEV_CLIENT_PORT = 5173;

export interface HttpServerOptions {
  readonly deps: RouteDeps;
  /** Overrides `config.server.port`. `0` asks the OS for a free one. */
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  /**
   * Anything that needs the `http.Server` itself rather than the Express app.
   *
   * There is exactly one such thing — the WebSocket gateway, which listens for
   * `upgrade` — and this is how it gets there without `server.ts` importing `ws`.
   * A closure rather than a value because the server does not exist until
   * `start()`, and the returned handle is closed *before* the listener in `stop()`:
   * a live socket is an open connection, and `server.close()` waits for those.
   */
  readonly attach?: ((server: Server) => Attachment) | undefined;
}

/** Something holding sockets that must be let go before the listener closes. */
export interface Attachment {
  close(): Promise<void>;
}

export interface RunningHttpServer {
  readonly app: Express;
  /** The port actually bound, which differs from the requested one when it was `0`. */
  readonly port: number;
  readonly host: string;
  readonly url: string;
  stop(): Promise<void>;
}

export interface HttpServerHandle {
  readonly app: Express;
  start(): Promise<RunningHttpServer>;
}

/**
 * Origins allowed to make cookie-authenticated writes beyond same-host.
 *
 * In development the browser is on Vite's port and the API is on its own, and
 * `changeOrigin: true` in the proxy config rewrites `Host` — so the
 * `Origin`-versus-`Host` fallback in `assertNotCrossSite` cannot match. Modern
 * browsers send `Sec-Fetch-Site: same-origin` through the proxy and never reach
 * that fallback, so this list is what keeps a client without that header working
 * in development. It is empty in production, where the two are the same origin.
 */
export function devOrigins(isProduction: boolean): readonly string[] {
  if (isProduction) return [];
  return [`http://localhost:${DEV_CLIENT_PORT}`, `http://127.0.0.1:${DEV_CLIENT_PORT}`];
}

/**
 * Builds the Express application and the `listen` around it.
 *
 * Construction is separate from listening for the same reason it is in
 * `server/app.ts`: a test can mount the routes and drive them without binding a
 * port, and `start()` is the only thing that has an outside.
 */
export function createHttpServer(options: HttpServerOptions): HttpServerHandle {
  const { deps } = options;
  const app = express();

  // Left off deliberately. See decision 2 in the header.
  app.set('trust proxy', false);
  // Announcing the framework and version helps nobody but somebody looking for a
  // known Express bug.
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(
    compression({
      filter(req: Request, res: Response) {
        const type = res.getHeader('Content-Type');
        if (typeof type === 'string' && type.includes('text/event-stream')) return false;
        return compression.filter(req, res);
      },
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT }));

  const api = express.Router();
  mountIdentityRoutes(api, deps);
  mountPresenceRoutes(api, deps);
  mountConversationRoutes(api, deps);
  app.use('/api', api);

  // Anything under /api that no route claimed is a 404 in the JSON envelope, not
  // the SPA fallback below. A client that asked for a mistyped endpoint and got
  // `index.html` back with a 200 would report it as a parse error.
  app.use('/api', (_req: Request, res: Response) => {
    sendError(res, new HttpError('not_found', 'No such endpoint.'));
  });

  mountClient(app);

  app.use(errorEnvelope(deps));

  return {
    app,
    async start(): Promise<RunningHttpServer> {
      const port = options.port ?? deps.config.server.port;
      const host = options.host ?? deps.config.server.host;
      const server = createServer(app);
      const attachment = options.attach?.(server);
      const bound = await listen(server, port, host);
      return {
        app,
        port: bound,
        host,
        url: `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${bound}`,
        stop: async () => {
          // Attachment first. A WebSocket is a connection `server.close()` waits
          // for, so closing in the other order is the hang described in decision 4.
          await attachment?.close();
          await close(server);
        },
      };
    },
  };
}

/**
 * Headers that cost nothing and close off a class of problem each.
 *
 * Hand-written rather than `helmet`, which would be a dependency for six
 * `setHeader` calls and would also set several headers this application has no
 * use for. The CSP is the only interesting one: `'unsafe-inline'` is allowed for
 * styles because React sets element styles directly and the visual layer animates
 * them per frame, but *not* for scripts, which is where it would matter.
 * `blob:` is allowed for workers and images because the service worker and any
 * canvas readback need it.
 */
function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  next();
}

/**
 * Serves the built client, or explains why it cannot.
 *
 * The static handler is registered whether or not the directory exists, because
 * it might be built while the process is running — `express.static` checks the
 * filesystem per request, so a build that finishes at 3pm starts being served at
 * 3pm without a restart.
 */
function mountClient(app: Express): void {
  app.use(
    express.static(CLIENT_DIR, {
      // `index.html` must not be cached: it is the file that names the hashed
      // asset bundles, so a stale copy points at bundles that no longer exist.
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'index.html') {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.get('*', (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) {
      next();
      return;
    }
    const entry = path.join(CLIENT_DIR, 'index.html');
    if (fs.existsSync(entry)) {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(entry);
      return;
    }
    res
      .status(503)
      .type('text/plain')
      .send(
        'She is running, but her face has not been built yet.\n\n' +
          'Run `npm run build` to build the client, or `npm run dev` to serve it\n' +
          'from Vite on port ' +
          String(DEV_CLIENT_PORT) +
          ' with /api proxied here.\n\n' +
          'The API is live at /api/hello.\n',
      );
  });
}

/**
 * The last handler, for failures that happened before any route did.
 *
 * `express.json()`'s `SyntaxError` is the one that actually occurs; the rest is
 * there so a middleware added later cannot produce an HTML error page. The
 * four-argument signature is what marks it as an error handler to Express — a
 * three-argument function here would silently never run.
 */
function errorEnvelope(deps: RouteDeps) {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof HttpError) {
      sendError(res, error);
      return;
    }
    if (error instanceof SyntaxError) {
      sendError(res, new HttpError('invalid_request', 'That body was not valid JSON.'));
      return;
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { type?: unknown }).type === 'entity.too.large'
    ) {
      sendError(res, new HttpError('invalid_request', `That body is larger than ${BODY_LIMIT}.`));
      return;
    }
    deps.report('http middleware', error);
    sendError(res, new HttpError('unexpected', 'Something went wrong on her side.'));
  };
}

/** Binds the port and reports which one, so `listen(0)` is usable. */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Stops listening and drops the connections that would never end on their own.
 *
 * See decision 4 in the header: without `closeAllConnections` a single open SSE
 * stream makes this promise never settle.
 */
function close(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}
