/**
 * The transport's public surface.
 *
 * `server/app.ts` builds the `RouteDeps` and `server/main.ts` starts the
 * listener; between them they need exactly what is re-exported here. Everything
 * else under `server/http/` — the projector's internals, the cookie writers, the
 * SSE frame format, the Zod schemas — is reachable only by its own module path,
 * so a future route cannot casually depend on a detail this barrel does not name.
 *
 * `policy.ts` is missing from `server/security/index.ts` for the opposite reason
 * (an oversight, recorded in the authoritative doc). This one is deliberate.
 */

export { createHttpServer, devOrigins } from './server.js';
export type {
  Attachment,
  HttpServerHandle,
  HttpServerOptions,
  RunningHttpServer,
} from './server.js';

export { attachVoiceGateway, VOICE_PATH } from './ws.js';
export type { VoiceGateway, VoiceGatewayOptions } from './ws.js';

export type { RouteDeps } from './deps.js';

export { HttpError, sendError, asyncRoute } from './errors.js';
export type { ErrorBody, ErrorCode, ErrorDetail, ErrorReporter } from './errors.js';

export { RateLimiter } from './rate-limit.js';
export type { RateLimitRule, RateLimitVerdict } from './rate-limit.js';

export { RuntimeStateProjector } from './state.js';

export { publicIdentity } from './routes/identity.js';
export type { PublicIdentity } from './routes/identity.js';
