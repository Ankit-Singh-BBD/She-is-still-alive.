/**
 * Saying something to her, and reading back what was said.
 *
 * ## `POST /api/chat` is the whole application in one request
 *
 * It runs `CognitiveRuntime.runCycle`, which is the twelve stages: perceive,
 * identify, recall, understand, reason, decide, act, verify, respond, learn,
 * update, persist. Everything else in `server/` is reached through it. So this
 * route is thin on purpose — it turns a body into a `RawStimulus`, runs the cycle,
 * and reports what the cycle actually did.
 *
 * ## Reporting what the cycle *did*, not what it hoped to
 *
 * `CycleRecord.status` distinguishes `completed` (no stage threw) from `degraded`
 * (ran to the end, but at least one stage threw and used its documented fallback)
 * from `failed` (PERSIST itself threw). The wire carries all three, plus the names
 * of the stages that fell back, because a client that renders `degraded` and
 * `completed` identically has erased the distinction the cycle went to trouble to
 * make. She is allowed to have had a bad turn; she is not allowed to hide it.
 *
 * A `failed` cycle is still a 200 with a body. It is not a transport failure —
 * the request was understood, she ran, and the honest answer is what happened.
 * A 500 would tell the client to retry, which is exactly wrong for a cycle that
 * already persisted its trace.
 *
 * ## Why `verified` is reported separately from `success`
 *
 * `ActionResult.success` means the tool call returned. `verified` means a re-read
 * of authoritative state confirmed the world changed. Stage 8 sets `verified` and
 * nothing else may. A UI that showed "reminder set" off `success` alone would be
 * making the claim the codebase's postcondition verifiers exist to stop it from
 * making, so both fields go over the wire under their own names.
 */

import type { Router } from 'express';

import type { ActionResult, AuthorizedResponse, CycleRecord } from '@server/cognition/types.js';

import type { RouteDeps } from '../deps.js';
import { asyncRoute, HttpError } from '../errors.js';
import { requireCaller } from '../guard.js';
import {
  ChatBodySchema,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  parseBody,
  readLimit,
} from '../validate.js';

/** One action, as a client is allowed to see it. */
interface ActionSummary {
  readonly toolId: string;
  readonly success: boolean;
  /** Set only by stage 8, only from a re-read. See the header. */
  readonly verified: boolean;
  readonly error: string | undefined;
}

/** What `POST /api/chat` answers. */
interface ChatBody {
  readonly conversationId: string;
  readonly cycleId: string;
  readonly status: CycleRecord['status'];
  readonly text: string;
  readonly voiceEnabled: boolean;
  readonly redacted: boolean;
  readonly disclosures: readonly string[];
  /** The stages that threw and used a fallback. Empty on a clean cycle. */
  readonly fellBackAt: readonly string[];
  readonly actions: readonly ActionSummary[];
  readonly startedAt: number;
  readonly completedAt: number | undefined;
}

export function mountConversationRoutes(router: Router, deps: RouteDeps): void {
  /**
   * `POST /api/chat` — one turn.
   *
   * Rate-limited on the cycle window rather than the general one, because a cycle
   * is the expensive request: it can call a language model, execute a tool and
   * write memories. The authenticated limiter has already counted it once inside
   * `requireCaller`; this is the second, tighter gate.
   */
  router.post(
    '/chat',
    asyncRoute('POST /api/chat', deps.report, async (req, res) => {
      const caller = requireCaller(req, deps);
      if (!deps.config.flags.cognition) {
        throw new HttpError(
          'not_available',
          'Her cognitive cycle is switched off in this configuration.',
        );
      }

      const verdict = deps.limits.cycle.check(caller.identity.id);
      if (!verdict.allowed) {
        throw new HttpError('too_many_requests', 'Give her a moment to finish thinking.', {
          retryAfterMs: verdict.retryAfterMs,
        });
      }

      const body = parseBody(ChatBodySchema, req.body);

      // `ConversationRepository.ensure` throws when the named conversation
      // belongs to someone else, which is what stops a caller from continuing
      // another identity's exchange by guessing a ULID. Translated here rather
      // than left to `asyncRoute`, which would report it as an internal error.
      let record: CycleRecord;
      try {
        record = await deps.runtimeFor(caller.identity).runCycle({
          source: 'text',
          payload: { text: body.text },
          receivedAt: Date.now(),
          identityId: caller.identity.id,
          ...(body.conversationId !== undefined ? { conversationId: body.conversationId } : {}),
          sessionId: caller.session.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('belongs to another identity')) {
          throw new HttpError('forbidden', message);
        }
        throw error;
      }

      // The projector holds who spoke last and what her last cycle did, because
      // neither is cheaply queryable. This route is the only place both are known
      // at once. It does not broadcast — the cycle published its own events, and
      // the next projection folds this in.
      deps.projector.noteCycle(record);

      res.json(chatBody(record));
    }),
  );

  /**
   * `GET /api/conversations` — the caller's own conversations, newest first.
   *
   * `listForIdentity` filters by identity in SQL, so there is no shape of request
   * that returns somebody else's. Ended ones are included only when asked for,
   * because the common case is "what was I in the middle of".
   */
  router.get(
    '/conversations',
    asyncRoute('GET /api/conversations', deps.report, (req, res) => {
      const caller = requireCaller(req, deps);
      const includeEnded = req.query['includeEnded'] === 'true';
      res.json({
        conversations: deps.conversations.listForIdentity(caller.identity.id, includeEnded),
      });
    }),
  );

  /**
   * `GET /api/conversations/:id/messages` — the transcript, oldest first.
   *
   * `recentForCaller` joins on `conversation.identity_id`, so a caller asking for
   * a conversation that is not theirs gets an empty list from the query itself
   * rather than from a check this route remembered to write. The 404 below is for
   * a conversation that does not exist *or* is not theirs — deliberately the same
   * answer, because distinguishing them would confirm that a guessed id is real.
   */
  router.get(
    '/conversations/:id/messages',
    asyncRoute('GET /api/conversations/:id/messages', deps.report, (req, res) => {
      const caller = requireCaller(req, deps);
      const id = req.params['id'] ?? '';
      const conversation = deps.conversations.get(id);
      if (conversation === null || conversation.identityId !== caller.identity.id) {
        throw new HttpError('not_found', 'There is no such conversation.');
      }
      const limit = readLimit(req.query['limit'], HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT);
      res.json({
        conversation,
        total: deps.messages.countFor(id),
        turns: deps.messages.recentForCaller(id, caller.identity.id, limit),
      });
    }),
  );
}

/**
 * The cycle record as a client may see it.
 *
 * `CycleRecord.response` and `.actionResults` are typed `unknown` — the record is
 * a trace, and its stage outputs are only as well-typed as the stage that wrote
 * them. So they are narrowed here rather than cast: a record whose stage 9 threw
 * has no `response` at all, and the honest thing to put on the wire for that is
 * the sentence she falls back to, not `undefined` dressed up as speech.
 */
function chatBody(record: CycleRecord): ChatBody {
  const response = asResponse(record.response);
  return {
    conversationId: record.conversationId,
    cycleId: record.id,
    status: record.status,
    text: response?.text ?? 'She could not put that into words this time.',
    voiceEnabled: response?.voiceEnabled ?? false,
    redacted: response?.redacted ?? false,
    disclosures: response?.disclosuresApplied ?? [],
    fellBackAt: record.stages
      .filter((stage) => stage.error !== undefined)
      .map((stage) => stage.stageName),
    actions: asActions(record.actionResults),
    startedAt: record.startedAt,
    completedAt: record.completedAt,
  };
}

function asResponse(value: unknown): AuthorizedResponse | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<AuthorizedResponse>;
  if (typeof candidate.text !== 'string') return undefined;
  return {
    text: candidate.text,
    voiceEnabled: candidate.voiceEnabled === true,
    disclosuresApplied: Array.isArray(candidate.disclosuresApplied)
      ? candidate.disclosuresApplied.filter((item): item is string => typeof item === 'string')
      : [],
    redacted: candidate.redacted === true,
  };
}

function asActions(value: unknown): readonly ActionSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: ActionSummary[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Partial<ActionResult>;
    if (typeof candidate.toolId !== 'string') continue;
    summaries.push({
      toolId: candidate.toolId,
      success: candidate.success === true,
      // Never inferred from `success`. Only stage 8 may say an action is proven,
      // so an absent flag reports as unproven rather than as probably fine.
      verified: candidate.verified === true,
      error: typeof candidate.error === 'string' ? candidate.error : undefined,
    });
  }
  return summaries;
}
