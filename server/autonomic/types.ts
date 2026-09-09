/**
 * What she can notice on her own, and what happens when she does.
 *
 * The autonomic layer is the answer to a gap the rest of the system left open:
 * every path into cognition began with somebody typing. `ProactiveEngine` could
 * judge whether an unprompted thought was worth saying, and `runIfIdle` could run
 * a cycle for one — but nothing ever *proposed* a thought, and no authorized
 * `emit` ever became speech. `ProactiveEngine.runCycle` had exactly one caller in
 * the repository and it was a test.
 *
 * ## The division of labour
 *
 *  - `Noticing` (this subsystem) reads real state and produces candidates. It
 *    invents nothing: every notice cites a row that exists — a task past its
 *    `due_at`, a loop whose `last_progress_at` has gone quiet, a task that
 *    exhausted its attempts.
 *  - `ProactiveEngine` decides whether the moment is right. Quiet hours, topic
 *    rate limits, urgency and interruption cost are its business and stay there.
 *  - `CognitiveRuntime.runIfIdle` decides whether she is free, and yields if she
 *    is not.
 *  - The twelve stages decide *what she actually says*.
 *
 * That last line is the important one. A candidate carries a `seed` — the fact she
 * noticed, in plain words — and the seed is never what reaches him. It enters the
 * cycle as a stimulus and comes out of stage 9 as an utterance shaped by her
 * memory of him, the transcript, where she is, and what time it is. The decision
 * tree scores the *topic* (how urgent, how novel, how costly to interrupt) and
 * those are properties of the fact, not of the wording, so re-generating the
 * wording with full context is not a second opinion — it is the only place the
 * wording was ever supposed to come from.
 *
 * It is also the difference between an entity and a notification system. A
 * templated string would make her a cron job with a personality file; the same
 * fact spoken differently at 7am on a Tuesday than at 11pm on a Sunday is what
 * "kisi tarah ke predefined prompt pe nahi chalti" actually requires of the code.
 *
 * ## Why a due reminder is not a sensor
 *
 * It is the obvious first sensor and it is the wrong one. `TaskExecutor` already
 * polls for due tasks and *claims* each one with a conditional `UPDATE ... WHERE
 * status = 'pending'`; a sensor that polled `getPendingTasks` for the same rows
 * would be a second reader with no claim, racing the executor's cycle and free to
 * speak a reminder the executor is about to speak again.
 *
 * So reminders arrive through `TaskExecutorHandlers.onReminder` — the hook the
 * executor already calls inside the claim, whose boolean return decides whether
 * the row completes or retries. They then share this subsystem's utterance path
 * (a `proactive` stimulus through `runIfIdle`, worded by the twelve stages) while
 * bypassing the decision tree entirely: a reminder he asked for, at a time he
 * chose, is his standing instruction and not her initiative. Scoring it for
 * novelty would be absurd, and deferring it out of quiet hours would break the
 * one promise the feature makes.
 */

import type { ProactiveCandidate } from '@server/proactive/types.js';

/**
 * One thing she noticed, before the decision tree has had an opinion.
 *
 * A superset of `ProactiveCandidate` rather than a separate shape: the engine
 * consumes candidates, and a translation layer between "what she noticed" and
 * "what the tree scores" would be two vocabularies for one idea. The extra
 * fields are the ones only the noticer knows.
 */
export interface Notice extends ProactiveCandidate {
  /**
   * The fact, in plain words, as the stimulus that opens her cycle.
   *
   * Not the utterance. See the header: this is what she noticed, and stage 9
   * decides how — and whether — to say it.
   */
  readonly seed: string;
  /** Which sensor produced this, for the trace and for the loop's own report. */
  readonly sensor: SensorId;
  /**
   * The row this notice is *about*, when it is about one.
   *
   * Carried so the loop can act on the underlying record after she speaks — mark
   * the reminder delivered, stop re-noticing the same silent loop. A notice with
   * no subject is about the world rather than a row.
   */
  readonly subject?: { readonly kind: 'task' | 'loop'; readonly id: string } | undefined;
}

/** The sensors, named so a boot report and a trace can say which one spoke. */
export type SensorId =
  /** A task that used up every attempt and never succeeded. */
  | 'task.exhausted'
  /** An open loop that has had no progress for long enough to be worth raising. */
  | 'loop.stalled';

/**
 * What one tick of the loop did, in full.
 *
 * Returned rather than logged so a test can assert on it and so the loop has no
 * opinion about where its narration goes. Every field is a count of something
 * that happened, not of something attempted.
 */
export interface TickReport {
  readonly at: number;
  /** Notices the sensors produced. */
  readonly noticed: number;
  /** Of those, the ones the decision tree authorized. */
  readonly authorized: number;
  /** Of those, the ones that became an utterance she actually committed. */
  readonly spoken: number;
  /**
   * Authorized notices that found her mid-conversation and were dropped.
   *
   * Not an error: yielding is the whole point of `runIfIdle`. Counted because a
   * number that is always high means her sensors are firing at the wrong moments.
   */
  readonly yielded: number;
  /** Sensors that threw. A failed sensor must not silence the others. */
  readonly sensorErrors: readonly string[];
}
