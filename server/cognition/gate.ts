/**
 * CycleGate — one cycle at a time per identity, and the thing that makes
 * interruption real.
 *
 * Build Book VII.3 says the runtime "may run cycles concurrently for *different*
 * identities, but never concurrently for the same identity (single-threaded per
 * identity to preserve causal order)", and VII.5 says a new PERCEIVE for the same
 * identity interrupts the current cycle rather than queueing behind it. Neither
 * existed. Nothing enforced VII.3 at all, and `CycleStatus`'s `'interrupted'` was
 * a value no code path ever wrote.
 *
 * ## Why this is not inside CognitiveRuntime
 *
 * `App.runtimeFor` builds a *fresh* `CognitiveRuntime` per request — same
 * collaborators, only `identity` varying — so a lock held in runtime instance
 * state would be a lock per request, which is no lock. The gate is one long-lived
 * object shared by every runtime the app hands out, and the lane key is the
 * identity id rather than the runtime.
 *
 * ## Why it did not matter until now, and does now
 *
 * `runCycle` has had exactly one non-test caller (`http/routes/conversation.ts`),
 * so overlap needed two requests racing for one identity — real but rare. The
 * moment she can start a cycle on her own initiative, an unprompted cycle
 * overlapping his turn stops being a race and becomes the normal case, several
 * times an hour.
 *
 * ## The two natures of an arriving stimulus
 *
 * The book was written when every PERCEIVE was somebody speaking, so VII.5 reads
 * as though all stimuli interrupt. They must not. If an autonomic tick could
 * interrupt, her own background thinking would cut him off mid-answer — the exact
 * inversion of what unprompted thought is for. So there are two ways to take the
 * lane, and the caller says which:
 *
 *   - `claim` — he is speaking. Whatever she was doing is now answering a question
 *     that has been superseded, so it is interrupted and this waits for it to wind
 *     down. Never refuses; somebody is waiting for an answer.
 *   - `tryClaim` — nobody is waiting. Declines outright if a cycle is running or
 *     queued for that identity, and nothing is written, because nothing happened.
 *
 * `CognitiveRuntime.runCycle` uses the first and `runIfIdle` the second, which is
 * what keeps the choice out of reach of any individual call site.
 *
 * ## What a lease guarantees, and what it does not
 *
 * Holding a lease means no other cycle for that identity is between stages.
 * Cancellation is cooperative — this is one thread, and a stage already running
 * cannot be preempted — so `signal` is checked at stage boundaries. That is also
 * exactly what VII.5 requires: an in-flight stage 7 (ACT) is allowed to finish,
 * and its verification and persistence still run.
 *
 * A lease that is never released blocks its lane forever rather than timing out.
 * A watchdog that force-released would permit two concurrent cycles, which is the
 * one thing this file exists to prevent — so instead the stall stays visible:
 * `inFlight()` reports how long the holder has held it, which is something
 * interoception can read and she can notice about herself.
 */

import { ulid } from '@server/persistence/ids.js';

import type { RawStimulus } from './types.js';

/** Why a cycle was asked to stop. Recorded, never inferred. */
export interface InterruptionCause {
  /** The cycle that displaced it, so the two records point at each other. */
  readonly byCycleId: string;
  readonly bySource: RawStimulus['source'];
  readonly at: number;
}

export interface CycleLease {
  /**
   * The cycle's id, minted here rather than in the runtime: whoever holds the
   * lane owns the identifier, so an interrupting cycle can name the cycle it
   * displaced and be named by it.
   */
  readonly cycleId: string;
  readonly identityId: string;
  readonly source: RawStimulus['source'];
  readonly startedAt: number;
  /** Aborted when a later stimulus for this identity displaces this cycle. */
  readonly signal: AbortSignal;
  /** Set exactly when this cycle was displaced; the runtime records it. */
  interruptedBy(): InterruptionCause | undefined;
  /**
   * Hands the lane to the next waiter. Idempotent, and must run in a `finally`:
   * an un-released lane never opens again.
   */
  release(): void;
}

/** What is running right now, for diagnosis rather than for control. */
export interface InFlightCycle {
  readonly cycleId: string;
  readonly identityId: string;
  readonly source: RawStimulus['source'];
  readonly startedAt: number;
  readonly interrupted: boolean;
}

export type CycleAdmission =
  | { readonly kind: 'admitted'; readonly lease: CycleLease }
  /**
   * Nothing ran and nothing was written. Only `tryClaim` ever returns this.
   *
   * `heldBy` is absent when the lane is blocked by a queue rather than by a
   * running cycle — there is a cycle about to start and no honest summary of it
   * yet, and inventing one is how a diagnostic starts lying.
   */
  | {
      readonly kind: 'declined';
      readonly reason: string;
      readonly heldBy?: InFlightCycle | undefined;
    };

/** A promise plus its resolver, so the lane's tail exists before anyone waits on it. */
interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One identity's lane: who holds it, and the queue of who is waiting. */
interface Lane {
  /** Resolves when everyone admitted so far has released. */
  tail: Promise<void>;
  holder: Holder | undefined;
  /** Admitted-and-not-yet-released count, including the holder. */
  depth: number;
}

interface Holder {
  readonly cycleId: string;
  readonly identityId: string;
  readonly source: RawStimulus['source'];
  readonly startedAt: number;
  readonly controller: AbortController;
  cause: InterruptionCause | undefined;
}

export interface CycleGateOptions {
  /** Injected so tests can drive the clock; defaults to the wall clock. */
  now?: (() => number) | undefined;
}

export class CycleGate {
  private readonly lanes = new Map<string, Lane>();
  private readonly now: () => number;

  constructor(options: CycleGateOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Takes the identity's lane, interrupting whoever holds it.
   *
   * Resolves once the displaced holder has wound down, so the caller is
   * guaranteed to be alone. Never refuses: this is what an arriving message does,
   * and there is somebody waiting for an answer to it.
   */
  async claim(stimulus: RawStimulus): Promise<CycleLease> {
    const lane = this.laneFor(stimulus.identityId);
    const cycleId = ulid();

    if (lane.holder) {
      // Told to stop *now*, before we start waiting: the holder is between stages
      // somewhere and should notice at its next boundary rather than at ours.
      //
      // Only the current holder is signalled. If two messages arrive in quick
      // succession the second interrupts the first and then waits for it, and the
      // first still gets its full cycle — it is real input that was already being
      // answered. Superseding queued waiters too would need a generation counter
      // and would mean answering neither of two fast messages.
      const cause: InterruptionCause = {
        byCycleId: cycleId,
        bySource: stimulus.source,
        at: this.now(),
      };
      lane.holder.cause = cause;
      lane.holder.controller.abort(new CycleInterrupted(cause));
    }

    return this.enqueue(lane, stimulus, cycleId);
  }

  /**
   * Takes the identity's lane only if it is free, and never interrupts.
   *
   * This is how an unprompted cycle asks. Her own background thinking must yield
   * to him rather than cut him off, so when he is mid-exchange the answer is
   * simply no — and nothing is written, because nothing happened.
   */
  async tryClaim(stimulus: RawStimulus): Promise<CycleAdmission> {
    const lane = this.laneFor(stimulus.identityId);

    if (lane.holder) {
      const holder = lane.holder;
      return {
        kind: 'declined',
        reason:
          `A ${holder.source} cycle for this identity started ` +
          `${this.now() - holder.startedAt}ms ago and has not finished.`,
        heldBy: summarize(holder),
      };
    }
    // Also decline behind a queue: `depth > 0` with no holder means somebody has
    // been admitted and is about to take the lane. Waiting for it would make an
    // unprompted cycle sit in line ahead of the next thing he says.
    if (lane.depth > 0) {
      return {
        kind: 'declined',
        reason: `${lane.depth} cycle(s) are queued for this identity.`,
      };
    }

    const lease = await this.enqueue(lane, stimulus, ulid());
    return { kind: 'admitted', lease };
  }

  /** Joins the lane's queue and resolves when it is this cycle's turn. */
  private async enqueue(lane: Lane, stimulus: RawStimulus, cycleId: string): Promise<CycleLease> {
    const gateOpen = lane.tail;
    const mine = deferred();
    // Chained before awaiting, so a concurrent claim queues behind this one even
    // while this one is still waiting for its predecessor.
    lane.tail = gateOpen.then(() => mine.promise);
    lane.depth += 1;

    await gateOpen;

    const holder: Holder = {
      cycleId,
      identityId: stimulus.identityId,
      source: stimulus.source,
      startedAt: this.now(),
      controller: new AbortController(),
      cause: undefined,
    };
    lane.holder = holder;

    let released = false;
    return {
      cycleId,
      identityId: stimulus.identityId,
      source: stimulus.source,
      startedAt: holder.startedAt,
      signal: holder.controller.signal,
      interruptedBy: () => holder.cause,
      release: () => {
        if (released) return;
        released = true;
        if (lane.holder === holder) lane.holder = undefined;
        lane.depth -= 1;
        if (lane.depth <= 0) this.lanes.delete(stimulus.identityId);
        mine.resolve();
      },
    };
  }

  /** What is running for this identity, or for every identity. For diagnosis. */
  inFlight(identityId: string): InFlightCycle | undefined;
  inFlight(): InFlightCycle[];
  inFlight(identityId?: string): InFlightCycle | undefined | InFlightCycle[] {
    if (identityId !== undefined) {
      const holder = this.lanes.get(identityId)?.holder;
      return holder ? summarize(holder) : undefined;
    }
    const all: InFlightCycle[] = [];
    for (const lane of this.lanes.values()) {
      if (lane.holder) all.push(summarize(lane.holder));
    }
    return all;
  }

  /** How many cycles are admitted but not yet finished, holder included. */
  depth(identityId: string): number {
    return this.lanes.get(identityId)?.depth ?? 0;
  }

  private laneFor(identityId: string): Lane {
    const existing = this.lanes.get(identityId);
    if (existing) return existing;
    const lane: Lane = { tail: Promise.resolve(), holder: undefined, depth: 0 };
    this.lanes.set(identityId, lane);
    return lane;
  }
}

function summarize(holder: Holder): InFlightCycle {
  return {
    cycleId: holder.cycleId,
    identityId: holder.identityId,
    source: holder.source,
    startedAt: holder.startedAt,
    interrupted: holder.cause !== undefined,
  };
}

/**
 * The abort reason. Carried on the signal so the runtime can record *what*
 * displaced the cycle rather than only that something did.
 */
export class CycleInterrupted extends Error {
  readonly interruption: InterruptionCause;

  constructor(interruption: InterruptionCause) {
    super(`Interrupted by ${interruption.bySource} cycle ${interruption.byCycleId}`);
    this.name = 'CycleInterrupted';
    this.interruption = interruption;
  }
}
