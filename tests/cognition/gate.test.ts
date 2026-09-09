/**
 * CycleGate — per-identity serialization and interruption (Build Book VII.3,
 * VII.5, VII.6).
 *
 * VII.6 asks for one test by name: "An integration test asserts that two
 * interleaved cycles for the same identity are serialized." That is the second
 * half of this file. The first half exercises the lane on its own, because what
 * can go wrong here is timing, and timing is far easier to pin down without
 * twelve stages and a database in the way.
 *
 * Nothing here sleeps. Every wait is on a promise that something else resolves,
 * so a failure means the gate is wrong rather than the machine slow.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { CycleGate, CycleInterrupted } from '@server/cognition/gate.js';
import type { RawStimulus, UnderstandingProposal } from '@server/cognition/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

/** A promise plus its resolver: the test's handle on when a stage may finish. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets every queued microtask and immediate callback run, and nothing more. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const stim = (
  identityId: string,
  text: string,
  source: RawStimulus['source'] = 'text',
): RawStimulus => ({
  source,
  payload: { text },
  receivedAt: 1_700_000_000_000,
  identityId,
  conversationId: `conv-${identityId}`,
});

describe('CycleGate: one cycle at a time per identity (VII.3)', () => {
  it('holds a second claim for the same identity until the first releases', async () => {
    const gate = new CycleGate();

    const first = await gate.claim(stim('a', 'first'));
    let admitted = false;
    const secondP = gate.claim(stim('a', 'second')).then((lease) => {
      admitted = true;
      return lease;
    });

    await settle();
    expect(admitted).toBe(false);
    expect(gate.depth('a')).toBe(2);
    expect(gate.inFlight('a')?.cycleId).toBe(first.cycleId);

    first.release();
    const second = await secondP;
    expect(admitted).toBe(true);
    expect(second.cycleId).not.toBe(first.cycleId);
    expect(gate.inFlight('a')?.cycleId).toBe(second.cycleId);

    second.release();
    expect(gate.depth('a')).toBe(0);
    expect(gate.inFlight()).toEqual([]);
  });

  it('does not make one identity wait for another', async () => {
    const gate = new CycleGate();
    const a = await gate.claim(stim('a', 'hers'));
    // Resolves without `a.release()`: the lanes are independent, which is the
    // half of VII.3 that says cycles for *different* identities may overlap.
    const b = await gate.claim(stim('b', 'his'));

    expect(b.identityId).toBe('b');
    expect(a.signal.aborted).toBe(false);
    expect(gate.inFlight()).toHaveLength(2);

    a.release();
    b.release();
  });

  it('interrupts the holder, and the two cycles name each other (VII.5)', async () => {
    const gate = new CycleGate();
    const held = await gate.claim(stim('a', 'first'));

    const nextP = gate.claim(stim('a', 'second', 'audio'));
    // Aborted at once, before anyone waits: the holder is somewhere between
    // stages and should notice at its next boundary, not at ours.
    expect(held.signal.aborted).toBe(true);
    expect(held.signal.reason).toBeInstanceOf(CycleInterrupted);

    const cause = held.interruptedBy();
    expect(cause?.bySource).toBe('audio');
    expect(gate.inFlight('a')?.interrupted).toBe(true);

    held.release();
    const next = await nextP;
    expect(cause?.byCycleId).toBe(next.cycleId);
    expect(next.signal.aborted).toBe(false);
    expect(gate.inFlight('a')?.interrupted).toBe(false);

    next.release();
  });

  it('never interrupts on tryClaim, and reports who holds the lane', async () => {
    let now = 1_000;
    const gate = new CycleGate({ now: () => now });
    const held = await gate.claim(stim('a', 'his question'));

    now = 3_500;
    const admission = await gate.tryClaim(stim('a', 'her own thought', 'proactive'));

    expect(admission.kind).toBe('declined');
    if (admission.kind !== 'declined') throw new Error('unreachable');
    expect(admission.heldBy?.cycleId).toBe(held.cycleId);
    expect(admission.reason).toContain('text');
    expect(admission.reason).toContain('2500ms');

    // The point of the whole distinction: her own thinking yields to him.
    expect(held.signal.aborted).toBe(false);
    expect(held.interruptedBy()).toBeUndefined();
    // And it did not join the queue either, so nothing is owed a turn.
    expect(gate.depth('a')).toBe(1);

    held.release();
  });

  it('declines behind a queue rather than inventing a holder to blame', async () => {
    const gate = new CycleGate();
    const held = await gate.claim(stim('a', 'first'));
    const queuedP = gate.claim(stim('a', 'second'));

    // The window where the lane has no holder but is already owed to someone:
    // `tryClaim` reads it synchronously, before the queued claim wakes up.
    held.release();
    const admission = await gate.tryClaim(stim('a', 'her own thought', 'proactive'));

    expect(admission.kind).toBe('declined');
    if (admission.kind !== 'declined') throw new Error('unreachable');
    expect(admission.reason).toContain('queued');
    // Absent on purpose: there is no honest summary of a cycle that has not
    // started, and a fabricated one is how a diagnostic starts lying.
    expect(admission.heldBy).toBeUndefined();

    (await queuedP).release();
    expect(gate.depth('a')).toBe(0);
  });

  it('admits an unprompted cycle when the lane is free', async () => {
    const gate = new CycleGate();
    const admission = await gate.tryClaim(stim('a', 'her own thought', 'proactive'));

    expect(admission.kind).toBe('admitted');
    if (admission.kind !== 'admitted') throw new Error('unreachable');
    expect(admission.lease.source).toBe('proactive');
    admission.lease.release();
  });

  it('survives a double release without handing the lane away twice', async () => {
    const gate = new CycleGate();
    const first = await gate.claim(stim('a', 'first'));
    first.release();
    // Without idempotence this drives depth to -1 and frees a lane nobody left.
    first.release();
    expect(gate.depth('a')).toBe(0);

    const second = await gate.claim(stim('a', 'second'));
    expect(gate.depth('a')).toBe(1);
    second.release();
    expect(gate.inFlight()).toEqual([]);
  });
});

describe('CognitiveRuntime under the gate (VII.6)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    db.raw
      .prepare(
        `INSERT INTO identity (id, kind, display_name, status) VALUES ('a', 'guest', 'Guest', 'active')`,
      )
      .run();
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-a', 'a')`).run();
  });

  const understanding: UnderstandingProposal = {
    intent: 'respond',
    confidence: 0.9,
    disambiguationNeeded: false,
    clarifyingQuestions: [],
    entities: {},
  };

  /**
   * A runtime whose UNDERSTAND stage the test can hold open.
   *
   * Stage 4 is a convenient place to stop a cycle mid-flight: far enough in that
   * the cycle record exists, and the last stage before anything is decided.
   * `marks` records every entry and exit, so overlap would show up as `enter-2`
   * landing before `exit-1`.
   */
  function blockable(gate: CycleGate) {
    const marks: string[] = [];
    const entered = deferred();
    const mayFinish = deferred();
    let calls = 0;
    const runtime = new CognitiveRuntime({
      db,
      gate,
      understand: {
        llm: {
          proposeUnderstanding: async () => {
            const n = ++calls;
            marks.push(`enter-${n}`);
            if (n === 1) {
              entered.resolve();
              await mayFinish.promise;
            }
            marks.push(`exit-${n}`);
            return understanding;
          },
        },
      },
    });
    return { runtime, marks, entered, mayFinish };
  }

  it('serializes two interleaved cycles for the same identity', async () => {
    const gate = new CycleGate();
    const { runtime, marks, entered, mayFinish } = blockable(gate);

    const first = runtime.runCycle(stim('a', 'first question'));
    await entered.promise;

    const second = runtime.runCycle(stim('a', 'second question'));
    await settle();

    // Two cycles admitted, one running: the second has entered no stage at all.
    expect(gate.depth('a')).toBe(2);
    expect(marks).toEqual(['enter-1']);
    expect(gate.inFlight('a')?.interrupted).toBe(true);

    mayFinish.resolve();
    const [c1, c2] = await Promise.all([first, second]);

    // The assertion VII.6 asks for: no interleaving, in either direction.
    expect(marks).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
    expect(c1.completedAt ?? 0).toBeLessThanOrEqual(c2.startedAt);
    expect(c2.status).toBe('completed');
    expect(gate.depth('a')).toBe(0);
  });

  it('records the displaced cycle as interrupted, once, naming what displaced it', async () => {
    const gate = new CycleGate();
    const { runtime, entered, mayFinish } = blockable(gate);

    const first = runtime.runCycle(stim('a', 'first question'));
    await entered.promise;
    const second = runtime.runCycle(stim('a', 'second question'));
    mayFinish.resolve();
    const [c1, c2] = await Promise.all([first, second]);

    // Stopped at the first boundary after the interruption arrived, and still
    // committed: VII.5 requires the cancellation be recorded, never dropped.
    expect(c1.status).toBe('interrupted');
    expect(c1.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4, 12]);
    expect(c1.error).toContain('Interrupted after 4 stage(s)');
    expect(c1.error).toContain(c2.id);

    const row = db.raw.prepare(`SELECT status FROM cycle_record WHERE id = ?`).get(c1.id) as {
      status: string;
    };
    expect(row.status).toBe('interrupted');
  });

  it('publishes exactly one cycle.interrupted carrying the cause', async () => {
    const gate = new CycleGate();
    const { runtime, entered, mayFinish } = blockable(gate);

    const first = runtime.runCycle(stim('a', 'first question'));
    await entered.promise;
    const second = runtime.runCycle(stim('a', 'second question'));
    mayFinish.resolve();
    const [c1, c2] = await Promise.all([first, second]);

    const events = db.raw
      .prepare(
        `SELECT payload_json FROM domain_event WHERE cycle_id = ? AND type = 'cycle.interrupted'`,
      )
      .all(c1.id) as { payload_json: string }[];

    // One. A cycle has one outcome, so it emits one terminal event — the cause
    // rides on that event rather than on a second one of the same type, which
    // would make one interrupted cycle replay as two interruptions.
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload_json) as {
      status: string;
      interruptedBy: { byCycleId: string; bySource: string };
      stagesCompleted: number;
    };
    expect(payload.status).toBe('interrupted');
    expect(payload.interruptedBy.byCycleId).toBe(c2.id);
    expect(payload.interruptedBy.bySource).toBe('text');
    expect(payload.stagesCompleted).toBe(4);
  });

  it('declines an unprompted cycle mid-conversation and writes nothing', async () => {
    const gate = new CycleGate();
    const { runtime, entered, mayFinish } = blockable(gate);

    const first = runtime.runCycle(stim('a', 'his question'));
    await entered.promise;

    const cycleRows = () =>
      (db.raw.prepare(`SELECT COUNT(*) AS n FROM cycle_record`).get() as { n: number }).n;
    const before = cycleRows();

    const declined = await runtime.runIfIdle(stim('a', 'something she noticed', 'proactive'));

    // Null rather than a degraded record: nothing ran, so nothing happened, so
    // there is nothing to report and no row to explain later.
    expect(declined).toBeNull();
    expect(cycleRows()).toBe(before);
    expect(gate.inFlight('a')?.interrupted).toBe(false);

    mayFinish.resolve();
    // And his cycle finished untouched, which is the whole point of yielding.
    expect((await first).status).toBe('completed');
  });

  it('refuses a proactive stimulus through runCycle rather than interrupting', async () => {
    const gate = new CycleGate();
    const runtime = new CognitiveRuntime({ db, gate });

    // Loud, not silently redirected: `runCycle` is the interrupting door, and a
    // caller that reached for it with an unprompted stimulus has a bug.
    await expect(runtime.runCycle(stim('a', 'her own thought', 'proactive'))).rejects.toThrow(
      /runIfIdle/,
    );
    expect(gate.depth('a')).toBe(0);
  });

  it('runs a full unprompted cycle when she is idle', async () => {
    const gate = new CycleGate();
    const runtime = new CognitiveRuntime({ db, gate });

    const cycle = await runtime.runIfIdle(stim('a', 'something she noticed', 'proactive'));

    expect(cycle).not.toBeNull();
    expect(cycle?.status).toBe('completed');
    expect(cycle?.stages).toHaveLength(12);
    expect(gate.depth('a')).toBe(0);
  });
});






