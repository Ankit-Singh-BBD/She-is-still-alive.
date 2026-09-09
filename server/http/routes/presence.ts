/**
 * What is true right now, as a snapshot and as a stream.
 *
 * ## The stream is a state feed, not an event log
 *
 * This is the decision the whole file turns on. `RealtimeFlow` *coalesces*: a
 * subscriber that stops draining has its queue collapsed by `coalesceKey`, so
 * intermediate messages are deliberately dropped and the newest one survives.
 * That is the right behaviour for a slow client, and it means the sequence of
 * frames a client receives can never be a complete event log — so a client must
 * not try to maintain `RuntimeState` by applying frames to it. It would drift,
 * and nothing would tell it that it had.
 *
 * So every event frame is followed by a full `state` frame read from the flow at
 * send time. Coalescing then costs nothing: each pair is self-sufficient, a
 * client three events behind receives the *newest* state rather than a stale one,
 * and a frame lost to a collapsed queue heals on the next event rather than
 * leaving a permanent lie on screen.
 *
 * ## The gate
 *
 * The subscription is registered *before* the initial snapshot is written, so no
 * event can slip through the gap between reading the state and starting to
 * listen. That inverts the ordering problem — a live frame could now be written
 * before the snapshot it precedes — so the adapter's `send` awaits a gate that is
 * released only once the snapshot and the replay have gone out. `RealtimeFlow`
 * awaits `send`, which is exactly the backpressure it was built for: the queue
 * keeps coalescing while the gate is shut and drains in order once it opens.
 *
 * ## `Last-Event-ID`
 *
 * `EventSource` echoes the `id:` of the last frame it saw, and `EventBus` can
 * read events by `seq`, so a reconnecting client is replayed the event frames it
 * missed — bounded by `REPLAY_LIMIT`, and *only* the event frames. The state does
 * not need replaying: the snapshot sent first is already authoritative. Replay is
 * for the log a client shows, not for the state a client trusts.
 *
 * `EventBus.replayTo` is not used, deliberately. It runs each handler under
 * `runWithDeadline`, which resolves after 100ms whether or not the handler
 * finished — fine for a fire-and-forget subscriber, wrong for a socket write,
 * because it would move on while the frame was still unwritten and reorder the
 * replay against itself. `replay()` returns the rows and this file awaits each
 * write itself.
 */

import type { Router } from 'express';
import { ulid } from 'ulid';

import type { RuntimeState, Subscriber } from '@server/realtime/types.js';

import type { RouteDeps } from '../deps.js';
import { asyncRoute, HttpError } from '../errors.js';
import { requireCaller } from '../guard.js';
import { SseSubscriber } from '../sse.js';
import { LocationBodySchema, parseBody } from '../validate.js';

/**
 * The most event frames one reconnect will be replayed.
 *
 * A client that was away for a day would otherwise be handed every event of that
 * day before its first live frame, on a connection it opened to find out what is
 * happening now. The snapshot already tells it that; the replay is a courtesy and
 * is bounded like one.
 */
export const REPLAY_LIMIT = 200;

/** The `event:` name of a full-state frame. Not a `DomainEventType`, by design. */
export const STATE_EVENT = 'state';

export function mountPresenceRoutes(router: Router, deps: RouteDeps): void {
  /**
   * `GET /api/state` — one authoritative read, for a client that cannot stream.
   *
   * `live` says whether a `GET /api/stream` would keep this fresh. When the flow
   * is absent the state is still real — the projector reads the same tables — but
   * `version` is `0` and `lastMutation` is empty, because nothing is counting
   * events for this response. Reporting a version nobody maintains would be the
   * dishonesty the projector exists to remove.
   */
  router.get(
    '/state',
    asyncRoute('GET /api/state', deps.report, (req, res) => {
      const caller = requireCaller(req, deps);
      const flow = deps.realtime();
      const state: RuntimeState = flow?.getSnapshot() ?? deps.projector.buildInitial(caller.identity);
      res.json({ live: flow !== undefined, state });
    }),
  );

  /**
   * `GET /api/stream` — she talks, over SSE.
   *
   * 503 rather than an empty stream when the flow is absent: a client holding an
   * open connection that can never deliver anything is worse off than one told
   * plainly that realtime is switched off in this configuration.
   */
  router.get(
    '/stream',
    asyncRoute('GET /api/stream', deps.report, async (req, res) => {
      const caller = requireCaller(req, deps);
      const flow = deps.realtime();
      if (flow === undefined) {
        throw new HttpError(
          'not_available',
          deps.config.flags.realtime
            ? 'She is not ready to stream yet.'
            : 'Realtime is switched off in this configuration.',
        );
      }

      const subscriberId = ulid();
      const sse = new SseSubscriber(subscriberId, res);

      // The gate. Live frames may be queued from the moment `subscribe` is
      // called, and must not be *written* until the snapshot has gone out.
      let openGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      const adapter: Subscriber = {
        id: subscriberId,
        async send(message) {
          await gate;
          if (sse.isClosed()) return;
          await sse.send(message);
          // Read at send time, not at broadcast time: a client that is behind
          // should be caught up, not walked forward one stale step.
          await sse.sendNamed(STATE_EVENT, flow.getSnapshot());
        },
      };

      let closed = false;
      const publishSession = async (
        type: 'session.connected' | 'session.disconnected',
      ): Promise<void> => {
        try {
          await deps.eventBus.publish({
            type,
            payload: { subscriberId, transport: 'sse' },
            identityId: caller.identity.id,
            cycleId: undefined,
            timestamp: Date.now(),
            causationId: undefined,
            correlationId: undefined,
            version: 1,
          });
        } catch (error) {
          // A stream that is up must not be torn down because its bookkeeping
          // event could not be written.
          deps.report(`publish ${type}`, error);
        }
      };

      const finish = (): void => {
        if (closed) return;
        closed = true;
        // Release first: a `send` parked on the gate would otherwise stay parked
        // and hold `drainQueue`'s loop open for the life of the process.
        openGate();
        flow.unsubscribe(subscriberId);
        sse.close();
        void publishSession('session.disconnected');
      };
      // Both, because they do not always both fire: `req`'s `close` is the
      // client going away mid-request, `res`'s is the response ending for any
      // reason at all. `finish` is idempotent, so hearing it twice is free.
      req.on('close', finish);
      req.on('error', finish);
      res.on('close', finish);

      sse.open();
      // Someone is here. Folded into the next projection rather than broadcast,
      // because `session.connected` below is what broadcasts.
      deps.projector.noteActor(caller.identity.id);
      flow.subscribe(adapter);

      try {
        await sse.sendNamed(STATE_EVENT, flow.getSnapshot());
        await replayMissed(req.headers['last-event-id'], flow.getSnapshot().version, sse, deps);
      } finally {
        openGate();
      }

      if (!closed) await publishSession('session.connected');
    }),
  );

  /**
   * `POST /api/location` — a browser that was granted geolocation says where she is.
   *
   * This is the only way `EnvironmentService.setClientLocation` can be reached
   * from outside the process, and therefore the only way the `client → config →
   * nothing` precedence it implements ever gets used.
   *
   * The refresh is awaited. `OpenMeteoProvider` carries its own request timeout
   * and turns every failure into an unknown or stale reading rather than a throw,
   * so the wait is bounded and the answer is a reading either way — and a client
   * that just reported a new place is asking about that place's sky, so returning
   * before looking would answer with the old one.
   */
  router.post(
    '/location',
    asyncRoute('POST /api/location', deps.report, async (req, res) => {
      requireCaller(req, deps);
      const body = parseBody(LocationBodySchema, req.body);

      // Checked by Zod above and again here, because `setClientLocation` refuses
      // rather than clamps and a silent disagreement between the two would be a
      // location she narrates weather for that nobody is standing in.
      if (!deps.environment.setClientLocation({ lat: body.lat, lng: body.lng })) {
        throw new HttpError('invalid_request', 'Those coordinates are not on Earth.');
      }

      await deps.environment.refresh();
      res.json(deps.environment.report());
    }),
  );
}

/**
 * Writes the event frames a reconnecting client missed, if it says which.
 *
 * A header that is absent, empty, non-numeric, negative or already at or past the
 * snapshot is not an error — it is a first connection, or a client that is
 * already current. In every one of those cases the snapshot already sent is the
 * whole answer and there is nothing to replay.
 */
async function replayMissed(
  header: string | string[] | undefined,
  throughSeq: number,
  sse: SseSubscriber,
  deps: RouteDeps,
): Promise<void> {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw === '') return;
  const from = Number.parseInt(raw, 10);
  if (!Number.isFinite(from) || from < 0 || from >= throughSeq) return;

  try {
    for (const event of deps.eventBus.replay(from, REPLAY_LIMIT)) {
      if (sse.isClosed() || event.seq > throughSeq) break;
      await sse.send({
        seq: event.seq,
        type: event.type,
        payload: event.payload,
        timestamp: event.timestamp,
      });
    }
  } catch (error) {
    // A replay that fails must not fail the stream: the snapshot is already out,
    // and the client is better off live-but-without-history than disconnected.
    deps.report('SSE replay', error);
  }
}
