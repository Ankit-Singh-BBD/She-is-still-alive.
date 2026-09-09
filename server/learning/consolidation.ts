/**
 * The out-of-band learner's caller.
 *
 * `LearningPipeline.processCycle(cycle, messages)` was built in P16, constructed
 * at boot in `server/app.ts`, named in the boot banner — and called from nowhere
 * but its own tests. The banner told the operator that "out-of-band learning
 * keeps only what was literally said" while, out of band, nothing ran at all.
 * `server/conversations/messages.ts` records why it stayed that way: until that
 * module existed, the `messages` argument had no production source, so the caller
 * could not have been written. It has one now. This is the caller.
 *
 * ## Why a sweep and not a hook on the cycle
 *
 * Stages 10 (LEARN) and 11 (UPDATE) already learn *inside* every cycle, and with
 * a language faculty wired stage 10 asks the model on every turn. Calling the
 * pipeline from the cycle as well would be a second model call about the same
 * sentence, which is why `processCycle` refuses by default to touch a cycle that
 * already wrote memories of its own.
 *
 * So this is not the primary learner and must not behave like one. It is the pass
 * that picks up what the in-cycle path could not:
 *
 *   - a cycle that finished `degraded`, where the learn stage was the stage that
 *     threw;
 *   - a cycle that ran before a rule existed, once one does;
 *   - a cycle whose learn stage had no faculty and no rule for what was said.
 *
 * Everything it touches is a cycle that is already over. It adds nothing to the
 * interactive path: he is never waiting on this.
 *
 * ## Bounded, resumable, and safe to run twice
 *
 * A cursor in `app_meta` remembers how far consolidation has read. It advances
 * past every cycle the pass considered, whether or not anything was learned, so
 * the cost of the whole mechanism is at most one extraction per cycle for the
 * life of the database — never a growing re-read of history.
 *
 * The cursor is an optimisation, not the safety mechanism. Lose it, corrupt it,
 * or roll it back and the worst that happens is wasted work: the pipeline's own
 * step 0 counts the memory rows a cycle has already written — including the ones
 * *this* sweep wrote, since it stamps `provenance.sourceCycleId` too — and
 * refuses to be the second writer. That is what makes a re-read cheap rather than
 * duplicative, and it is why this file does not need a transaction of its own.
 *
 * ## What reaches the extractor
 *
 * One cycle's own turns, selected by `metadata_json.$.cycleId`, which
 * `server/cognition/runtime.ts` writes on both of them. Not the surrounding
 * conversation: `processCycle` means "learn from this cycle", and handing it the
 * whole thread would re-propose every earlier turn on every pass and leave the
 * dedupe engine to clean up after it.
 *
 * A proactive cycle contributes no incoming turn at all and a system trigger
 * writes one with `role: 'system'` (`runtime.incomingRole`), while both
 * extractors read only `role === 'user'`. So she cannot learn a fact from her own
 * noticing here — the same guarantee `server/cognition/intent/recognizer.ts`
 * makes for tools, arrived at structurally rather than by a second filter.
 *
 * ## What the row carries beside the turns
 *
 * The cycle's own verdict — what she decided and what she answered — read from
 * `cycle_record.decision_json` and `cycle_record.output_json`. Until
 * `0013_cycle_verdict.sql` there was no decision column at all and `output_json`
 * was written by nothing, so this file reconstructed a `CycleRecord` with both
 * fields absent and the model-backed extractor asked what was worth learning from
 * a transcript with the cycle's verdict missing beside it. `describeDecision` and
 * `describeAnswer` in `server/learning/extractor.ts` render those two fields; both
 * returned `undefined` on every stored cycle, which is why they were reachable
 * only from a hand-built row in a test.
 */

import { sqliteTimeToMillis } from '@server/conversations/repository.js';

import type { Database } from '@server/persistence/db.js';
import type { CycleRecord, LearningResult, Message } from './types.js';

/** How often the pass runs when there is no backlog behind it. */
export const DEFAULT_CONSOLIDATION_MS = 300_000;

/**
 * How soon the next pass runs when the last one filled its batch.
 *
 * A first boot against a database with history has every cycle ever run behind
 * the cursor. At the idle cadence that backlog would drain over hours, so a pass
 * that came back full says "there is more" and the next one follows shortly. Once
 * a pass comes back short the sweep settles back to `DEFAULT_CONSOLIDATION_MS`.
 */
export const BACKLOG_CONSOLIDATION_MS = 15_000;

/**
 * Cycles per pass.
 *
 * Small on purpose. With a model-backed extractor each one is a network call, and
 * a sweep that fired twenty of them in a burst would compete with the turn she is
 * having. Draining is the backlog cadence's job, not the batch size's.
 */
export const DEFAULT_CYCLES_PER_PASS = 5;

/** Where the cursor lives, in the durable KV table migration 0001 established. */
const CURSOR_KEY = 'learning.consolidatedThrough';

/**
 * How far consolidation has read.
 *
 * `(completedAt, cycleId)` rather than `cycleId` alone, and the reason is in
 * `0012_cycle_consolidation_index.sql`: ids are minted when a cycle starts, so a
 * long cycle can finish after a short one that started later, and a cursor on the
 * id would step over it while it was still running and never return.
 * `completedAt` is written at commit.
 */
export interface ConsolidationCursor {
  /** `cycle_record.completed_at`, exactly as stored: an ISO-8601 UTC string. */
  readonly completedAt: string;
  readonly cycleId: string;
}

/**
 * What one pass did — the five outcomes kept apart, because they mean different
 * things about her and only one of them is a problem.
 */
export interface ConsolidationPassReport {
  readonly at: number;
  /** Cycles read from behind the cursor. */
  readonly considered: number;
  /** Cycles the pipeline learned at least one memory from. */
  readonly learnedFrom: number;
  /** Memory rows written across the pass. */
  readonly memories: number;
  /**
   * Cycles the pipeline declined because they had already written memories.
   *
   * The healthy majority, and the number that says the in-cycle path is doing its
   * job. A pass that is all `alreadyLearned` is the sweep finding nothing to
   * repair, which is what it is for.
   */
  readonly alreadyLearned: number;
  /** Cycles with no turn a person said — proactive wake-ups, system triggers. */
  readonly nothingSaid: number;
  /** Anything that threw, named and counted rather than propagated. */
  readonly errors: string[];
  /** Where the cursor stands now, or `undefined` if nothing has been read yet. */
  readonly cursor: ConsolidationCursor | undefined;
  /** The pass filled its batch, so more is waiting behind the cursor. */
  readonly backlog: boolean;
}

/** The slice of `LearningPipeline` this sweep uses, so a test can hand it a fake. */
export interface OutOfBandLearner {
  processCycle(cycleRecord: CycleRecord, messages: Message[]): Promise<LearningResult>;
}

export interface ConsolidationSweepDeps {
  readonly db: Database;
  readonly learning: OutOfBandLearner;
  /** Reports a throw that must not stop the sweep. */
  readonly report: (where: string, error: unknown) => void;
  readonly intervalMs?: number | undefined;
  readonly backlogIntervalMs?: number | undefined;
  readonly cyclesPerPass?: number | undefined;
}

/** A candidate cycle, plus the stored text its cursor entry needs. */
interface Candidate {
  readonly record: CycleRecord;
  readonly completedAtText: string;
}

interface CycleRow {
  id: string;
  conversation_id: string;
  identity_id: string;
  status: string;
  started_at: string;
  completed_at: string;
  output_json: string | null;
  decision_json: string | null;
}

/**
 * The stored verdict, or nothing.
 *
 * A malformed column must not stop a sweep: this pass exists to read *old* rows, so
 * it is the one place most likely to meet a shape written by a version that no longer
 * exists. An unparseable verdict costs the prompt one line; a throw here would leave
 * the cursor where it was and the same row would fail again on every future pass.
 */
function decisionOf(json: string | null): { authorizedDecision?: unknown } {
  if (json === null || json.trim() === '') return {};
  try {
    return { authorizedDecision: JSON.parse(json) };
  } catch {
    return {};
  }
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  text: string;
  timestamp: string;
}

/**
 * Her slow half of learning.
 *
 * Started by `MadhuritaApp.start()` under `FLAG_LEARNING` and stopped by
 * `stop()`. Tail-rescheduled rather than run on an interval, for the reason every
 * other sweep in this codebase is: a pass that outlives its period must not stack
 * up behind itself, and a pass with a model behind it can take seconds.
 */
export class ConsolidationSweep {
  private readonly deps: ConsolidationSweepDeps;
  private readonly intervalMs: number;
  private readonly backlogIntervalMs: number;
  private readonly cyclesPerPass: number;

  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private lastReport: ConsolidationPassReport | undefined;

  constructor(deps: ConsolidationSweepDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? DEFAULT_CONSOLIDATION_MS;
    this.backlogIntervalMs = deps.backlogIntervalMs ?? BACKLOG_CONSOLIDATION_MS;
    this.cyclesPerPass = deps.cyclesPerPass ?? DEFAULT_CYCLES_PER_PASS;
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

  /** The last pass's report, for an operator asking what consolidation is doing. */
  report(): ConsolidationPassReport | undefined {
    return this.lastReport;
  }

  /** How far consolidation has read, straight from the durable cursor. */
  cursor(): ConsolidationCursor | undefined {
    return this.readCursor([]);
  }

  /**
   * One pass. Public so a test can drive it without waiting five minutes, and so
   * an operator can force one.
   *
   * Never throws. A sweep that dies on a bad cycle would stop consolidating every
   * cycle after it, and the symptom — memories that quietly stop appearing — is
   * one nobody would notice for weeks. Every failure is named, counted into the
   * report and reported through `deps.report` instead.
   *
   * The cursor advances after each cycle rather than once at the end, so a crash
   * mid-pass costs at most the cycle it was on.
   */
  async pass(now: number = Date.now()): Promise<ConsolidationPassReport> {
    const errors: string[] = [];
    let cursor = this.readCursor(errors);

    const candidates =
      this.safely('learning consolidation candidates', errors, () => this.candidates(cursor)) ?? [];

    let learnedFrom = 0;
    let memories = 0;
    let alreadyLearned = 0;
    let nothingSaid = 0;

    for (const candidate of candidates) {
      const where = `learning consolidation cycle ${candidate.record.id}`;
      const messages =
        this.safely(where, errors, () => this.transcriptOf(candidate.record)) ?? [];

      // Nothing a person said is nothing to learn from, and it is not an error:
      // a proactive cycle is her own turn and a system trigger is the clock's.
      // Skipping before the call is what keeps the model out of it.
      if (!messages.some((message) => message.role === 'user')) {
        nothingSaid += 1;
      } else {
        const result = await this.safelyAsync(where, errors, () =>
          this.deps.learning.processCycle(candidate.record, messages),
        );
        if (result !== undefined) {
          if (result.skipped !== undefined) alreadyLearned += 1;
          else {
            memories += result.count;
            if (result.learned) learnedFrom += 1;
          }
        }
      }

      // Advanced whatever happened above, including on the error path. A cycle
      // that threw once will throw again on the same stored row, and a cursor
      // that refused to pass it would turn one bad cycle into a permanently
      // stuck sweep — the failure this method's own docstring exists to avoid.
      cursor = { completedAt: candidate.completedAtText, cycleId: candidate.record.id };
      const written = cursor;
      this.safely(`learning consolidation cursor`, errors, () => this.writeCursor(written));
    }

    const report: ConsolidationPassReport = {
      at: now,
      considered: candidates.length,
      learnedFrom,
      memories,
      alreadyLearned,
      nothingSaid,
      errors,
      cursor,
      backlog: candidates.length >= this.cyclesPerPass,
    };
    this.lastReport = report;
    return report;
  }

  // ── Internals ──

  /**
   * The next few finished cycles after the cursor.
   *
   * `status IN ('completed','degraded')`: an `interrupted` cycle did not finish
   * and a `failed` one has no authorized response, so neither is a transcript to
   * learn from. `degraded` very much is — the learn stage may have been the stage
   * that threw, which is the case this sweep was built for.
   *
   * The identity comes through the conversation, because `cycle_record` has no
   * `identity_id` column; a soft-deleted conversation is excluded, since its turns
   * were withdrawn and learning from withdrawn words would be worse than not
   * learning at all.
   *
   * No cursor is bound as the empty string rather than tested for NULL: every
   * stored `completed_at` is a non-empty ISO timestamp, so `> ''` is true of all of
   * them, and "nothing consolidated yet" needs no second code path.
   */
  private candidates(cursor: ConsolidationCursor | undefined): Candidate[] {
    const rows = this.deps.db.raw
      .prepare(
        `SELECT cr.id, cr.conversation_id, cr.status, cr.started_at, cr.completed_at,
                cr.output_json, cr.decision_json, c.identity_id
           FROM cycle_record cr
           JOIN conversation c ON c.id = cr.conversation_id
          WHERE cr.status IN ('completed', 'degraded')
            AND cr.completed_at IS NOT NULL
            AND c.deleted_at IS NULL
            AND (cr.completed_at > ? OR (cr.completed_at = ? AND cr.id > ?))
          ORDER BY cr.completed_at ASC, cr.id ASC
          LIMIT ?`,
      )
      .all(
        cursor?.completedAt ?? '',
        cursor?.completedAt ?? '',
        cursor?.cycleId ?? '',
        this.cyclesPerPass,
      ) as CycleRow[];

    return rows.map((row) => ({
      completedAtText: row.completed_at,
      record: {
        id: row.id,
        identityId: row.identity_id,
        conversationId: row.conversation_id,
        startedAt: sqliteTimeToMillis(row.started_at),
        completedAt: sqliteTimeToMillis(row.completed_at),
        status: row.status === 'degraded' ? 'degraded' : 'completed',
        ...(row.output_json === null ? {} : { outputJson: row.output_json }),
        // Parsed here rather than handed on as text, because `CycleRecord`
        // declares this `unknown` — the shape of a JSON column — and the
        // extractor guards every access into it. A row written before
        // `0013_cycle_verdict.sql`, or one whose column holds something this
        // version cannot parse, leaves the field absent, which is the state
        // every reader was already built for.
        ...decisionOf(row.decision_json),
      },
    }));
  }

  /**
   * One cycle's own turns, oldest first.
   *
   * Selected on `metadata_json.$.cycleId`, which `runtime.transcriptTurns` writes
   * on both turns it appends — the only thing in the schema that ties a message to
   * a cycle, since `message` has no `cycle_id` column. `json_valid` is checked
   * first for the same reason `LearningPipeline.memoriesWrittenBy` checks it: one
   * unparseable column must not throw and take the pass with it.
   *
   * Ordered by `timestamp` then `rowid`, matching `recentForCaller`: both turns of
   * a fast cycle can land in the same millisecond, and `rowid` is insertion order,
   * so what he said cannot sort after her answer to it.
   */
  private transcriptOf(record: CycleRecord): Message[] {
    const rows = this.deps.db.raw
      .prepare(
        `SELECT m.id, m.conversation_id, m.role, m.text, m.timestamp
           FROM message m
          WHERE m.conversation_id = ?
            AND m.deleted_at IS NULL
            AND m.metadata_json IS NOT NULL
            AND json_valid(m.metadata_json)
            AND json_extract(m.metadata_json, '$.cycleId') = ?
          ORDER BY m.timestamp ASC, m.rowid ASC`,
      )
      .all(record.conversationId, record.id) as MessageRow[];

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role === 'assistant' || row.role === 'system' ? row.role : 'user',
      text: row.text,
      timestamp: sqliteTimeToMillis(row.timestamp),
    }));
  }

  /**
   * The cursor, or `undefined` for a database nothing has consolidated yet.
   *
   * An unreadable or malformed row reads as `undefined` — which is to say "start
   * from the beginning" — and that is deliberately the safe direction: rereading
   * history costs extractor calls, while skipping it would lose memories silently.
   * The pipeline's own guard is what makes the reread harmless.
   */
  private readCursor(errors: string[]): ConsolidationCursor | undefined {
    const row = this.safely('learning consolidation cursor read', errors, () =>
      this.deps.db.raw
        .prepare('SELECT value FROM app_meta WHERE key = ?')
        .get(CURSOR_KEY) as { value: string } | undefined,
    );
    if (row === undefined || row.value.trim() === '') return undefined;

    try {
      const parsed: unknown = JSON.parse(row.value);
      if (parsed === null || typeof parsed !== 'object') return undefined;
      const { completedAt, cycleId } = parsed as Record<string, unknown>;
      if (typeof completedAt !== 'string' || typeof cycleId !== 'string') return undefined;
      if (completedAt === '' || cycleId === '') return undefined;
      return { completedAt, cycleId };
    } catch {
      errors.push(`learning consolidation cursor: ${CURSOR_KEY} is not JSON; starting over`);
      return undefined;
    }
  }

  /** Stored as JSON so an operator reading `app_meta` can see both halves. */
  private writeCursor(cursor: ConsolidationCursor): void {
    this.deps.db.raw
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(CURSOR_KEY, JSON.stringify(cursor));
  }

  /**
   * The next pass, at the cadence the last one's backlog flag asks for.
   *
   * The `inFlight` re-schedule is not belt-and-braces: `pass()` is only ever
   * driven from here in production, but it is public, so an operator or a test can
   * be inside one when this timer fires.
   */
  private schedule(): void {
    if (!this.running) return;
    const delay = this.lastReport?.backlog === true ? this.backlogIntervalMs : this.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inFlight) {
        this.schedule();
        return;
      }
      this.inFlight = true;
      void this.pass()
        .catch((error: unknown) => {
          // `pass` is written not to throw; this is the belt on top of the braces.
          this.deps.report('learning consolidation pass', error);
        })
        .finally(() => {
          this.inFlight = false;
          this.schedule();
        });
    }, delay);
    // Learning that happens while nobody is waiting must not be the reason the
    // process refuses to exit.
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
