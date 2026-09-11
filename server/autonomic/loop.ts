/**
 * The heartbeat. This is where she gets a turn nobody asked her to take.
 *
 * Everything the autonomic layer needs already existed and was never connected:
 * `ProactiveEngine.runCycle` had one caller and it was a test, `runIfIdle` had
 * none, and `TaskExecutor` completed reminders by dropping them. This file is the
 * caller. One tick:
 *
 *   1. `processDeferred` — replay anything whose window has opened. First,
 *      because a candidate that has already waited nine hours should not queue
 *      behind a notice made a millisecond ago.
 *   2. `sweep` — ask the sensors what is true now.
 *   3. `evaluate` — the decision tree's verdict on each, one at a time.
 *   4. For every `emit`: `runIfIdle` a `proactive` stimulus carrying the seed,
 *      and if she was free, `markDelivered`.
 *
 * ## The two doors, and why they are different
 *
 * A notice goes through the decision tree. A due reminder does not — it arrives
 * through `onReminder` and skips straight to step 4. See the header of
 * `./types.ts`: a reminder he asked for at a time he chose is his instruction,
 * and scoring it for novelty or deferring it out of quiet hours would break the
 * only promise the feature makes. Both doors share the utterance path, because
 * the wording must come from the twelve stages either way.
 *
 * ## Nothing here writes words
 *
 * `speak()` builds a `RawStimulus` with `source: 'proactive'` and hands it to
 * `runIfIdle`. What reaches him is `record.response.text` — stage 9's output,
 * shaped by her memory of him, the transcript, the weather and the hour. The seed
 * is the fact; the sentence is hers. That distinction is the difference between
 * this and a cron job with a personality file, and it is worth restating in the
 * file that would be easiest to shortcut.
 *
 * With no language faculty wired the two collapse: stage 9's deterministic draft
 * speaks the seed itself, because the greeting it used to fall back on said nothing
 * about what she had noticed. That is why the seeds in this file and in
 * `./noticing.ts` are written as sentences addressed to him rather than as notes
 * about him — on the fallback path they are the utterance, and a seed reading
 * "a reminder he set has come due" would be her talking about him to nobody.
 *
 * ## Delivery needs no new transport
 *
 * A committed proactive cycle writes its turn into `message` like any other, and
 * `markDelivered` publishes `proactive.delivered`, which the projector folds into
 * the next `state` frame. What actually puts her words on his screen is one step
 * earlier and more general: stage 12's terminal cycle event goes out as its own SSE
 * frame, and the client re-reads the transcript whenever one arrives — for any
 * cycle, including the ones it did not start. So an unprompted utterance travels
 * over the wire that already exists. No new event type, no new frame, no second
 * history.
 */

import type { CycleRecord } from '@server/cognition/types.js';
import type { CognitiveRuntime } from '@server/cognition/runtime.js';
import type { Identity } from '@server/identity/types.js';
import type { ProactiveEngine } from '@server/proactive/engine.js';

import type { Noticing } from './noticing.js';
import type { Notice, TickReport } from './types.js';

/** How often she looks, when nothing tells her to. */
export const DEFAULT_TICK_MS = 60_000;

export interface AutonomicLoopDeps {
  /** The sensors. */
  readonly noticing: Noticing;
  /** The decision tree and its deferral queue. */
  readonly proactive: ProactiveEngine;
  /**
   * Whose state she is watching, resolved per tick rather than held.
   *
   * A loop that captured an `Identity` at construction would keep speaking to a
   * revoked or suspended owner, and on a fresh database there is no owner to
   * capture at all. Returning `null` is a normal answer and means "not yet".
   */
  readonly owner: () => Identity | null;
  /**
   * A runtime scoped to the identity she is about to speak to.
   *
   * The same `runtimeFor` the HTTP layer uses, so an unprompted cycle runs
   * through the identical twelve stages under the identical per-identity gate. A
   * private runtime here would be a second lane, and two lanes for one identity
   * is exactly what the gate exists to prevent.
   */
  readonly runtimeFor: (identity: Identity) => CognitiveRuntime;
  /** Reports a throw that must not stop the heartbeat. */
  readonly report: (where: string, error: unknown) => void;
  readonly tickMs?: number;
}

/**
 * Her unprompted half.
 *
 * Started by `MadhuritaApp.start()` and stopped by `stop()`. Tail-rescheduled
 * rather than run on an interval, for the reason every other sweep in this
 * codebase is: a tick that outlives its period must not stack up behind itself,
 * and a cycle can take seconds.
 */
export class AutonomicLoop {
  private readonly deps: AutonomicLoopDeps;
  private readonly tickMs: number;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private lastReport: TickReport | undefined;

  constructor(deps: AutonomicLoopDeps) {
    this.deps = deps;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The last tick's report, for `/api/state` and for an operator asking. */
  report(): TickReport | undefined {
    return this.lastReport;
  }

  /**
   * One pass. Public so a test can drive it without waiting a minute, and so an
   * operator can force one.
   *
   * Never throws: a heartbeat that dies on a bad tick leaves her permanently
   * mute with nothing in the log to say why. Every failure is reported and
   * counted instead, and the report is returned so the caller can see what a
   * tick actually did rather than what it attempted.
   */
  async tick(now: number = Date.now()): Promise<TickReport> {
    const errors: string[] = [];
    let noticed = 0;
    let authorized = 0;
    let spoken = 0;
    let yielded = 0;

    const owner = this.safely('autonomic owner lookup', errors, () => this.deps.owner()) ?? null;

    if (owner !== null) {
      // Deferrals first, and evaluated as candidates in their own right: the
      // engine re-runs the whole tree on replay, so a candidate whose recipient
      // lost permission during its wait is refused now rather than delivered on
      // a nine-hour-old verdict.
      const replayed =
        (await this.safelyAsync('autonomic deferral replay', errors, () =>
          this.deps.proactive.processDeferred(undefined, now),
        )) ?? [];

      const swept = await this.safelyAsync('autonomic sensor sweep', errors, () =>
        this.deps.noticing.sweep(owner.id, now),
      );
      if (swept) errors.push(...swept.errors);

      const fresh = (swept?.notices ?? []).map((notice) =>
        this.safely(`autonomic evaluate ${notice.topic}`, errors, () =>
          this.deps.proactive.evaluate(notice, undefined),
        ),
      );

      noticed = (swept?.notices.length ?? 0) + replayed.length;

      for (const result of [...replayed, ...fresh]) {
        if (result === undefined || result.outcome.action !== 'emit') continue;
        authorized += 1;
        const seed = seedOf(result.candidate);
        if (seed === undefined) {
          // An emit with nothing to say. Counted as authorized and not spoken,
          // which is the honest reading: the tree said yes to a candidate that
          // carried no fact.
          errors.push(`authorized candidate ${result.decisionId} carried no seed`);
          continue;
        }
        const record = await this.safelyAsync(`autonomic cycle ${result.decisionId}`, errors, () =>
          this.speak(owner, seed),
        );
        if (record === undefined) continue;
        if (record === null) {
          yielded += 1;
          continue;
        }
        spoken += 1;
        await this.safelyAsync(`autonomic markDelivered ${result.decisionId}`, errors, () =>
          this.deps.proactive.markDelivered(result.decisionId, 'text'),
        );
      }
    }

    const report: TickReport = {
      at: now,
      noticed,
      authorized,
      spoken,
      yielded,
      sensorErrors: errors,
    };
    this.lastReport = report;
    return report;
  }

  /**
   * A due reminder, spoken in her own words.
   *
   * Wired as `TaskExecutorHandlers.onReminder`, which the executor calls inside
   * the claim it already took on the row — so this is the one place a reminder
   * can be spoken without racing the executor's own sweep.
   *
   * The boolean return is load-bearing: the executor completes the task on `true`
   * and retries with backoff on `false`. So `false` here means "she was
   * mid-conversation and did not say it", and the retry is the reminder arriving a
   * few seconds later rather than being lost — which is exactly the behaviour a
   * reminder should have and the reason this returns the truth instead of `true`.
   */
  async deliverReminder(identityId: string, message: string): Promise<boolean> {
    const owner = this.deps.owner();
    if (owner === null || owner.id !== identityId) return false;
    const record = await this.speak(owner, `You asked me to remind you: "${message}".`);
    return record !== null;
  }

  // ── Internals ──

  /**
   * Run one proactive cycle for a fact, and return what it committed.
   *
   * `runIfIdle`, never `runCycle`: `runCycle` throws on a `proactive` stimulus by
   * design, because interrupting him with something she thought of is the one
   * thing the gate exists to prevent. `null` means she was busy and yielded.
   */
  private async speak(owner: Identity, seed: string): Promise<CycleRecord | null> {
    return this.deps.runtimeFor(owner).runIfIdle({
      source: 'proactive',
      payload: { text: seed },
      receivedAt: Date.now(),
      identityId: owner.id,
    });
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inFlight) {
        this.schedule();
        return;
      }
      this.inFlight = true;
      void this.tick()
        .catch((error: unknown) => {
          // `tick` is written not to throw; this is the belt on top of the braces.
          this.deps.report('autonomic tick', error);
        })
        .finally(() => {
          this.inFlight = false;
          this.schedule();
        });
    }, this.tickMs);
    // A heartbeat must not be the reason the process refuses to exit.
    this.timer.unref?.();
  }

  private safely<T>(where: string, errors: string[], fn: () => T): T | undefined {
    try {
      return fn();
    } catch (error) {
      errors.push(`${where}: ${describe(error)}`);
      this.deps.report(where, error);
      return undefined;
    }
  }

  private async safelyAsync<T>(
    where: string,
    errors: string[],
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      errors.push(`${where}: ${describe(error)}`);
      this.deps.report(where, error);
      return undefined;
    }
  }
}

/**
 * The fact a candidate carries, whether it came from a sensor or off the queue.
 *
 * A fresh `Notice` has `seed`. A replayed candidate was rebuilt from
 * `proactive_decision.candidate_json` and is only a `ProactiveCandidate`, so the
 * seed survives the round trip only if it was serialized — and where it was not,
 * `decision.text` holds the same string by construction (see `Noticing.notice`).
 * Falling back to it is not a guess about the wording: both fields were written
 * from one value.
 */
function seedOf(candidate: Notice | { seed?: unknown; decision: { kind: string } }): string | undefined {
  const seed = (candidate as { seed?: unknown }).seed;
  if (typeof seed === 'string' && seed.trim() !== '') return seed;
  const decision = candidate.decision as { kind: string; text?: unknown };
  if (decision.kind === 'speak' && typeof decision.text === 'string' && decision.text.trim() !== '') {
    return decision.text;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
