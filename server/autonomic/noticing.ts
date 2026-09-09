/**
 * The sensors. What she can notice about her own state, without being asked.
 *
 * This is the half of the autonomic layer that reads and never speaks. Each
 * sensor turns rows that already exist into a `Notice`; nothing here decides
 * whether the moment is right (that is `ProactiveEngine`), whether she is free
 * (`CognitiveRuntime.runIfIdle`), or what words come out (stages 1-12).
 *
 * ## Events and conditions are swept differently
 *
 * The distinction runs through the whole file:
 *
 *  - `task.exhausted` is an **event**. A task gave up at a particular instant.
 *    Reporting it twice is reporting a second failure that never happened, so
 *    this sensor reports each task id exactly once and bounds how far back it
 *    looks.
 *  - `loop.stalled` is a **condition**. A loop that has been quiet for eight
 *    hours is still quiet at hour nine; there is no instant to report once. So
 *    this sensor reports the condition whenever it holds, and the engine's
 *    per-topic rate limit is what stops her mentioning it every minute.
 *
 * Because the topic strings carry the subject's id (`loop.stalled:<loopId>`, not
 * `loop.stalled`), that rate limit is per loop rather than per class — one silent
 * loop cannot mask another.
 *
 * ## Why "once" is keyed by id rather than by a timestamp watermark
 *
 * The obvious implementation is a high-water mark: remember the instant of the
 * last sweep, ask for failures newer than it. It does not work against this
 * schema. `task.updated_at` is TEXT holding two formats, and the one the schema
 * default writes — `datetime('now')` — has **second** resolution. Two tasks that
 * fail in the same second are indistinguishable to a watermark, so any cutoff
 * placed inside that second either repeats one of them or loses the other. Ids
 * have no resolution to run out of.
 *
 * ## The scores are tuned against the real thresholds
 *
 * `DEFAULT_PROACTIVE_OPTIONS` emits immediately at `urgency >= 0.8`, bypassing
 * quiet hours, novelty and interruption cost. Nothing this file produces is
 * allowed to reach that: a job that failed is worth saying, and it is not worth
 * waking him at 3am. Every urgency below is deliberately under the bypass, so
 * every notice in this file is subject to every gate the tree has.
 */

import type { LoopManager, OpenLoopRow } from '@server/loops/manager.js';
import type { TaskExecutor, TaskPayload } from '@server/tasks/executor.js';

import type { Notice, SensorId } from './types.js';

/** How long an open loop may go without progress before it is worth raising. */
export const DEFAULT_STALL_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * How far back the failure sensor looks.
 *
 * Two things at once, and they agree: it is the window a fresh process reports
 * failures from (so a crash that happened while she was down is not lost), and
 * the horizon past which a failure stops being news at all. Without it, the first
 * sweep after every restart would greet him with every failure the database has
 * ever held.
 */
export const DEFAULT_FAILURE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Per-sensor scores, in one place so they can be read against each other. */
const SCORES = {
  'task.exhausted': {
    // Under the 0.8 bypass on purpose. See the header.
    urgency: 0.7,
    novelty: 0.9,
    interruptionCost: 0.3,
    contextCompatibility: 0.8,
  },
  'loop.stalled': {
    urgency: 0.4,
    novelty: 0.7,
    interruptionCost: 0.35,
    contextCompatibility: 0.7,
  },
} as const satisfies Record<SensorId, Omit<Notice, 'identityId' | 'topic' | 'decision' | 'seed' | 'sensor'>>;

export interface NoticingOptions {
  readonly stallAfterMs?: number;
  readonly failureLookbackMs?: number;
}

export interface NoticingDeps {
  readonly tasks: TaskExecutor;
  readonly loops: LoopManager;
  readonly options?: NoticingOptions;
}

/**
 * What one pass of the sensors found.
 *
 * `errors` is a list rather than a thrown exception because a sensor that throws
 * must not silence the ones that would have worked. One broken reader is a gap in
 * what she can notice; it is not a reason for her to go mute.
 */
export interface SensorSweep {
  readonly notices: readonly Notice[];
  readonly errors: readonly string[];
}

export class Noticing {
  private readonly tasks: TaskExecutor;
  private readonly loops: LoopManager;
  private readonly stallAfterMs: number;
  private readonly failureLookbackMs: number;

  /**
   * Task ids already reported, against the `updatedAt` they were reported at.
   *
   * Per-process and deliberately not persisted: a restart should re-report a
   * failure that happened while she was down, which is the same behaviour the
   * lookback window is for. The value is kept so entries can be pruned as they
   * fall out of that window, which is what bounds this map — it can never hold
   * more ids than there were failures in the last `failureLookbackMs`.
   */
  private readonly reported = new Map<string, number>();

  constructor(deps: NoticingDeps) {
    this.tasks = deps.tasks;
    this.loops = deps.loops;
    this.stallAfterMs = deps.options?.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.failureLookbackMs = deps.options?.failureLookbackMs ?? DEFAULT_FAILURE_LOOKBACK_MS;
  }

  /**
   * Run every sensor once, for one identity.
   *
   * A notice being produced here says nothing about whether she will say it. The
   * tree may suppress it, defer it into its own queue, or authorize it and then
   * find her mid-conversation — and this sensor has already marked the failure
   * reported by then. That is deliberate: "have I looked at this row" and "did she
   * end up speaking" are different questions, and the engine owns the second. A
   * deferred candidate is replayed by `processDeferred`; a yielded one is counted
   * in `TickReport.yielded`, so a number that is always high reads as sensors
   * firing at the wrong moments rather than as nothing happening.
   */
  sweep(identityId: string, now: number = Date.now()): SensorSweep {
    const notices: Notice[] = [];
    const errors: string[] = [];
    const horizon = now - this.failureLookbackMs;

    for (const [id, at] of this.reported) {
      if (at < horizon) this.reported.delete(id);
    }

    try {
      notices.push(...this.exhaustedTasks(identityId, horizon));
    } catch (error) {
      errors.push(`task.exhausted: ${message(error)}`);
    }

    try {
      notices.push(...this.stalledLoops(identityId, now));
    } catch (error) {
      errors.push(`loop.stalled: ${message(error)}`);
    }

    return { notices, errors };
  }

  /** A proposer for `ProactiveEngine.runCycle`, bound to one identity. */
  proposerFor(identityId: string): () => Notice[] {
    return () => [...this.sweep(identityId).notices];
  }

  // ── Sensors ──

  /**
   * Tasks that used up every attempt and never succeeded, reported once each.
   *
   * `TaskExecutor.failedTasks` owns the meaning of "permanently failed" — the
   * `attempt >= max_attempts` term that separates a dead task from one the retry
   * backoff is still working through. Asking it rather than writing the query
   * here keeps that in one place.
   */
  private exhaustedTasks(identityId: string, horizon: number): Notice[] {
    return this.tasks
      .failedTasks(horizon, identityId)
      .filter((task) => !this.reported.has(task.id))
      .map((task) => {
        this.reported.set(task.id, task.updatedAt);
        return this.notice({
          identityId,
          sensor: 'task.exhausted',
          subjectId: task.id,
          subject: { kind: 'task', id: task.id },
          seed:
            `Something you asked me to do has failed for good: ${describeTask(task.payload)}. ` +
            `I tried it ${task.attempt} time${task.attempt === 1 ? '' : 's'} and it never went through` +
            `${task.lastError ? `; the error it gave was "${task.lastError}"` : ''}.`,
        });
      });
  }

  /**
   * Open loops that have gone quiet.
   *
   * `lastProgressAt` rather than `lastEvaluatedAt`: the loop manager evaluates
   * every active loop on its own sweep, so `lastEvaluatedAt` is never stale and a
   * stall measured against it could never fire. Progress is the thing that stops
   * happening.
   */
  private stalledLoops(identityId: string, now: number): Notice[] {
    return this.loops
      .getActiveLoops(identityId)
      .filter((loop) => now - loop.lastProgressAt >= this.stallAfterMs)
      .map((loop) =>
        this.notice({
          identityId,
          sensor: 'loop.stalled',
          subjectId: loop.id,
          subject: { kind: 'loop', id: loop.id },
          seed:
            `Something you left open has not moved in ${describeGap(now - loop.lastProgressAt)}: ` +
            `${describeLoop(loop)}.`,
        }),
      );
  }

  // ── Internals ──

  /**
   * Assemble a `Notice` from the part a sensor knows and the part the file decides.
   *
   * ## `decision.text` is not what she says
   *
   * It is set to the seed because `ProactiveDecision` has nowhere else to put a
   * string, and keeping it identical rather than blank means a reader of the
   * `proactive_decision` row can still see what the notice was about. Nothing reads
   * it as output: the loop feeds `seed` into a cycle as a stimulus and speaks the
   * text stage 9 authorized.
   *
   * ## Why the seeds are written as sentences addressed to him
   *
   * With a language faculty wired, a seed is raw material — stage 9 redrafts it and
   * almost none of the phrasing here survives. With no faculty wired, stage 9's
   * deterministic draft speaks the seed as it stands (`respondDraft` in
   * `server/cognition/stages/9.ts`), because the greeting it used to fall back on
   * said nothing about the thing she had noticed. So each seed is written as a
   * sentence she could say out loud: second person, no narrating him in the third.
   * "Something he asked for has failed" was unspeakable on exactly the path that
   * has no model available to fix it.
   */
  private notice(input: {
    identityId: string;
    sensor: SensorId;
    subjectId: string;
    subject: Notice['subject'];
    seed: string;
  }): Notice {
    const scores = SCORES[input.sensor];
    return {
      identityId: input.identityId,
      topic: `${input.sensor}:${input.subjectId}`,
      decision: {
        kind: 'speak',
        channel: 'text',
        priority: scores.urgency >= 0.7 ? 'normal' : 'low',
        text: input.seed,
      },
      urgency: scores.urgency,
      novelty: scores.novelty,
      interruptionCost: scores.interruptionCost,
      contextCompatibility: scores.contextCompatibility,
      reasoning: `${input.sensor} sensor, subject ${input.subjectId}`,
      seed: input.seed,
      sensor: input.sensor,
      subject: input.subject,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A task payload in plain words.
 *
 * Exhaustive over `TaskPayload` so a new task kind is a compile error here rather
 * than a notice that says "something" and cites nothing.
 */
function describeTask(payload: TaskPayload): string {
  switch (payload.kind) {
    case 'reminder':
      return `the reminder "${payload.message}"`;
    case 'recurring':
      return `the repeating job that runs ${payload.toolId}`;
    case 'one_shot':
      return `the one-off job that runs ${payload.toolId}`;
    case 'background':
      return `the background job that runs ${payload.toolId}`;
  }
}

/** A loop in plain words, preferring its own summary over its topic slug. */
function describeLoop(loop: OpenLoopRow): string {
  const summary = loop.summary?.trim();
  return summary !== undefined && summary !== '' ? summary : loop.topic;
}

/**
 * A duration as a person would say it.
 *
 * Coarse on purpose: the sensor fires at a six-hour granularity, so "9 hours" is
 * the honest resolution and "9 hours 14 minutes" would be false precision about
 * when something stopped moving.
 */
function describeGap(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
