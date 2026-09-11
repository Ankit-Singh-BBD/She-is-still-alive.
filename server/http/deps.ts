/**
 * What every route needs, in one place, so no route reaches for a global.
 *
 * `server/app.ts` is the composition root and this is the slice of it the
 * transport is allowed to see. It is deliberately narrower than `MadhuritaApp`:
 * a route can run a cognitive cycle and read the environment, and it cannot take
 * a backup, close the database, or re-register a tool. Passing the whole app
 * would make every one of those one typo away from a route.
 *
 * `report` is here rather than imported because reporting is the one thing that
 * differs between a booted process and a test: in the process it goes to
 * `publishError`, which writes an `error.raised` event and an audit row. A route
 * that swallowed its own failures would be the honesty bug in its purest form.
 */

import type { Config } from '@server/config/env.js';
import type { Database } from '@server/persistence/db.js';
import type { EnvironmentService } from '@server/environment/index.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { CognitiveRuntime } from '@server/cognition/runtime.js';
import type { Identity } from '@server/identity/types.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { ConversationRepository } from '@server/conversations/repository.js';
import type { MessageRepository } from '@server/conversations/messages.js';
import type { OriginSeedReport } from '@server/origin/index.js';
import type { RealtimeFlow } from '@server/realtime/flow.js';
import type { BootReport } from '@server/app.js';

import type { ErrorReporter } from './errors.js';
import type { RuntimeStateProjector } from './state.js';
import type { RateLimiter } from './rate-limit.js';
import type { WorkRepository } from '@server/work/repository.js';
import type { WorkCoordinator } from '@server/work/coordinator.js';

export interface RouteDeps {
  readonly config: Config;
  readonly db: Database;
  readonly eventBus: EventBus;
  readonly identityRepo: IdentityRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly environment: EnvironmentService;
  readonly projector: RuntimeStateProjector;
  /**
   * The realtime fan-out, or `undefined` when `FLAG_REALTIME` is off or no owner
   * has been enrolled.
   *
   * A function rather than a value because both of those can change while the
   * process runs: bootstrap creates the first owner, and the flow is started at
   * that moment. A captured `undefined` would mean the stream stayed dead for
   * the life of the process after the very request that should have woken it.
   */
  realtime(): RealtimeFlow | undefined;
  /** Builds the per-caller cognitive runtime. See `MadhuritaApp.runtimeFor`. */
  runtimeFor(identity: Identity): CognitiveRuntime;
  /**
   * Writes whatever of her origin story is missing, and answers what it wrote.
   *
   * A function on `RouteDeps` for the same reason `realtime` is one: it cannot run until
   * an owner exists, and the request that creates the owner is the first moment it can.
   * It is idempotent, so calling it on a database that already has the story writes
   * nothing — which is what makes it safe to call from a route at all.
   */
  rememberOrigin(owner: Identity): OriginSeedReport;
  /**
   * What the app decided at boot, or `undefined` before `start()`.
   *
   * `GET /api/hello` publishes its `absent` list, because a UI that renders "she
   * is thinking" over a configuration with no language model is lying on her
   * behalf. A function for the same reason `realtime` is one: it does not exist
   * yet at the moment the routes are mounted.
   */
  bootReport(): BootReport | undefined;
  readonly report: ErrorReporter;
  readonly limits: {
    /** Guards the credential routes, keyed by remote address. */
    readonly credential: RateLimiter;
    /** Guards everything authenticated, keyed by identity id. */
    readonly authenticated: RateLimiter;
    /** Guards the cognitive cycle, which is the expensive one. */
    readonly cycle: RateLimiter;
  };
  /** B04/B07 — durable work wiring (optional until B03/B04 wired). */
  readonly workRepo?: WorkRepository;
  readonly workCoordinator?: WorkCoordinator;
  /** Origins allowed to make cookie-authenticated writes beyond same-host. */
  readonly allowedOrigins: readonly string[];
}
