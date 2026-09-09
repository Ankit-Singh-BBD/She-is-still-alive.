/**
 * P13 — VERIFY, and the checkpoint that a tool's word is not evidence.
 *
 * The build book's P13 verification block asks for one thing: *"A simulated tool
 * that doesn't change state is marked unverified."* Part XI.3 says why, and says
 * it in the strongest terms the book uses anywhere: *"A textual 'done' is never
 * proof… The user is never told an action succeeded unless VERIFY passed."*
 *
 * There are two places that verify — the action pipeline's stage 5 and cognitive
 * stage 8 — and since P12 they share one registry of postconditions. Two would
 * eventually disagree, and an `action_result` row reading `verified = 1` under a
 * sentence saying the action could not be confirmed is exactly the split the
 * honesty rule exists to prevent. So most of these tests assert the same fact
 * twice, once through each caller, and expect the same answer.
 *
 * The tool at the centre of the file, `test.pretend_remember`, is the book's
 * "simulated tool" made literal: it returns a perfectly well-formed answer
 * naming a memory id, and writes nothing. Everything about it looks like success
 * except authoritative state.
 *
 * The rest guard the postconditions that are easy to write flakily — a reminder
 * the executor has legitimately already claimed, a list that another reminder
 * joined between the read and the re-read. Those must still verify, or she would
 * report a failure for something that worked.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { ulid } from '@server/persistence/ids.js';
import { z } from 'zod';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { DEFAULT_RETRY_POLICY } from '@server/actions/registry.js';
import { broken, held, installTool, parseOutput } from '@server/tools/index.js';
import type { VerifiedTool } from '@server/tools/index.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import { verify } from '@server/cognition/stages/8.js';
import type { ActionResult } from '@server/cognition/types.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

const pretendOutput = z.object({
  memoryId: z.string().min(1),
  identityId: z.string().min(1),
  summary: z.string(),
});

/**
 * The book's "simulated tool that doesn't change state".
 *
 * It is installed through `installTool` like any other, so it is provable — and
 * the point is that being provable is what convicts it. Its postcondition is the
 * same shape as the real `memory.remember_event` one: re-read the id the output
 * named, and fail if the row is not there.
 */
function pretendRememberTool(
  memoryRepo: MemoryRepository,
): VerifiedTool<{ summary: string }, z.infer<typeof pretendOutput>> {
  const id = 'test.pretend_remember';
  return {
    definition: {
      id,
      name: 'Pretend to remember',
      description: 'Returns a well-formed answer and writes nothing at all.',
      inputSchema: z.object({ summary: z.string().min(1) }),
      outputSchema: pretendOutput,
      clearanceRequired: 'all',
      retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
      timeoutMs: 1_000,
      execute: async (input, context) => ({
        // A well-formed id that nothing will ever find.
        memoryId: `mem_${ulid()}`,
        identityId: context.identityId,
        summary: input.summary,
      }),
    },
    postcondition: (evidence) => {
      const parsed = parseOutput(id, pretendOutput, evidence.output);
      if (!parsed.ok) return parsed.outcome;
      const row = memoryRepo.getEpisodic(parsed.value.memoryId);
      if (!row) {
        return broken(
          `No episodic memory '${parsed.value.memoryId}' exists; nothing was remembered`,
        );
      }
      return held();
    },
  };
}

describe('P13 — VERIFY re-reads authoritative state', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;
  let cycleId: string;

  const openCycle = (identityId: string): string => {
    const conversation = app.conversations.open(identityId);
    const id = ulid();
    app.db.raw
      .prepare(
        `INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json)
         VALUES (?, ?, 'running', ?, '{}')`,
      )
      .run(id, conversation.id, new Date().toISOString());
    return id;
  };

  const run = (toolId: string, input: unknown): Promise<unknown> =>
    app.toolExecutor.execute({
      toolId,
      input,
      context: { identityId: owner.id, cycleId, causationId: cycleId },
    });

  /** What the pipeline's own VERIFY stage concluded, as persisted. */
  const persistedVerdict = (toolId: string): { verified: number; error: string | null } => {
    const row = db.raw
      .prepare(
        `SELECT verified, error FROM action_result WHERE tool_id = ? ORDER BY persisted_at DESC, id DESC LIMIT 1`,
      )
      .get(toolId) as { verified: number; error: string | null } | undefined;
    if (!row) throw new Error(`No action_result row for '${toolId}'`);
    return row;
  };

  /** What cognitive stage 8 concludes, over the same registry. */
  const stage8 = (results: ActionResult[]) =>
    verify(results, { verifiers: app.verifiers, db, identityId: owner.id, cycleId });

  const succeeded = (toolId: string, output: unknown): ActionResult => ({
    toolId,
    attempted: true,
    success: true,
    output,
    verified: false,
  });

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    installTool(app.registry, app.verifiers, pretendRememberTool(app.memoryRepo));
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
    cycleId = openCycle(owner.id);
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  describe('a simulated tool that changes nothing is marked unverified (P13 checkpoint)', () => {
    it('runs, succeeds, and is still not verified', async () => {
      const output = await run('test.pretend_remember', { summary: 'I definitely remembered this' });

      // The call returned, so `success` is true — that is what `success` means.
      expect(output).toMatchObject({ summary: 'I definitely remembered this' });

      // And the world did not change, so `verified` is false.
      const verdict = persistedVerdict('test.pretend_remember');
      expect(verdict.verified).toBe(0);
      expect(verdict.error).toBeNull();
    });

    it('publishes action.failed, because a tool that proved nothing did not do its job', async () => {
      await run('test.pretend_remember', { summary: 'nothing happened' });

      const types = (
        db.raw.prepare(`SELECT type FROM domain_event ORDER BY seq`).all() as { type: string }[]
      ).map((row) => row.type);
      expect(types).toContain('action.failed');
      expect(types).not.toContain('action.executed');
    });

    it('is reported unverified by cognitive stage 8, with the reason', async () => {
      const output = await run('test.pretend_remember', { summary: 'still nothing' });

      const report = await stage8([succeeded('test.pretend_remember', output)]);
      expect(report.postconditionsMet).toBe(false);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/nothing was remembered/);
    });
  });

  describe('a real write verifies, in both places, for the same reason', () => {
    it('confirms an episodic memory that is actually on disk', async () => {
      const output = await run('memory.remember_event', { summary: 'aaj chai pi' });

      expect(persistedVerdict('memory.remember_event').verified).toBe(1);

      const report = await stage8([succeeded('memory.remember_event', output)]);
      expect(report.postconditionsMet).toBe(true);
      expect(report.results[0]?.verified).toBe(true);
      expect(report.discrepancies).toEqual([]);
    });

    it('reads a preference back by the pair the table is unique on', async () => {
      await run('preference.set', { key: 'chai', value: 'kadak' });
      const second = await run('preference.set', { key: 'chai', value: 'elaichi wali' });

      // An upsert, not a second row — so the id in the output still finds it.
      expect(app.memoryRepo.listPreferences(owner.id)).toHaveLength(1);
      const report = await stage8([succeeded('preference.set', second)]);
      expect(report.results[0]?.verified).toBe(true);
    });
  });

  describe('a fabricated recall does not survive the re-read', () => {
    it('verifies a recall whose memories are all really there', async () => {
      await run('memory.remember_event', { summary: 'chai ke saath biscuit' });
      await run('memory.remember_fact', {
        subject: 'Ankit',
        predicate: 'lives in',
        object: 'Bengaluru',
      });

      const output = (await run('memory.recall', { query: 'chai' })) as { count: number };
      expect(output.count).toBeGreaterThan(0);

      const report = await stage8([succeeded('memory.recall', output)]);
      expect(report.results[0]?.verified).toBe(true);
    });

    it('refuses a recall that names a memory the database does not hold', async () => {
      // This is the postcondition that catches a model inventing a memory and an
      // id to go with it. Stage 9 is then forbidden from presenting it as
      // something she remembers.
      const fabricated = {
        identityId: owner.id,
        query: 'what did I say',
        count: 1,
        items: [{ id: `mem_${ulid()}`, domain: 'episodic', text: 'something she never heard' }],
      };

      const report = await stage8([succeeded('memory.recall', fabricated)]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(
        /authoritative state does not confirm.*no episodic memory/s,
      );
    });

    it('refuses a recall whose own count contradicts its own list', async () => {
      const report = await stage8([
        succeeded('memory.recall', { identityId: owner.id, query: 'x', count: 3, items: [] }),
      ]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/its own answer is inconsistent/);
    });

    it('refuses a memory that exists but has been deleted', async () => {
      const written = (await run('memory.remember_event', { summary: 'purani baat' })) as {
        memoryId: string;
      };
      app.memoryRepo.softDeleteEpisodic(written.memoryId, owner.id);

      const report = await stage8([succeeded('memory.remember_event', written)]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/already deleted/);
    });
  });

  describe('the reminder postconditions do not fail on things that are allowed to happen', () => {
    it('still verifies a reminder the executor has already claimed and run', async () => {
      // The executor polls every 15 seconds and claims anything due, so a
      // reminder can legitimately be `running` or `completed` by the time stage 8
      // re-reads it. Asserting `pending` would report a failure for a reminder
      // that had already been delivered.
      const output = (await run('reminder.schedule', {
        message: 'chai banana',
        inMinutes: 0,
      })) as { taskId: string };

      for (const status of ['running', 'completed'] as const) {
        db.raw.prepare(`UPDATE task SET status = ? WHERE id = ?`).run(status, output.taskId);
        const report = await stage8([succeeded('reminder.schedule', output)]);
        expect(report.results[0]?.verified).toBe(true);
      }
    });

    it('refuses a reminder that was scheduled and is already cancelled', async () => {
      // Cancelled is the one status that contradicts having scheduled it.
      const output = (await run('reminder.schedule', {
        message: 'chai banana',
        inMinutes: 30,
      })) as { taskId: string };
      app.taskExecutor.cancelTask(output.taskId);

      const report = await stage8([succeeded('reminder.schedule', output)]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/already cancelled/);
    });

    it('still verifies a listing that another reminder joined afterwards', async () => {
      await run('reminder.schedule', { message: 'pehla', inMinutes: 10 });
      const listed = await run('reminder.list', {});

      // Scheduled between the read and the re-read. The claim she made was about
      // what she saw, not about what the queue contains now, so a subset check is
      // the honest one.
      await run('reminder.schedule', { message: 'doosra', inMinutes: 20 });

      const report = await stage8([succeeded('reminder.list', listed)]);
      expect(report.results[0]?.verified).toBe(true);
    });

    it('refuses a cancellation the row does not agree with', async () => {
      const scheduled = (await run('reminder.schedule', {
        message: 'chai banana',
        inMinutes: 30,
      })) as { taskId: string };
      const cancelled = await run('reminder.cancel', { taskId: scheduled.taskId });
      expect(persistedVerdict('reminder.cancel').verified).toBe(1);

      // Put it back the way it was: the output now claims something the row
      // contradicts, which is precisely what stage 8 is for.
      db.raw.prepare(`UPDATE task SET status = 'pending' WHERE id = ?`).run(scheduled.taskId);
      const report = await stage8([succeeded('reminder.cancel', cancelled)]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/still 'pending'; it was not cancelled/);
    });
  });

  describe('nothing is verified by default', () => {
    it('will not verify a tool no postcondition covers, in either caller', async () => {
      // The gap this closes: a verifier registry that returned "fine" for an id
      // it had never heard of would make every unprovable tool look proven, which
      // is the exact opposite of what the registry is for.
      const report = await stage8([succeeded('nope.not_a_tool', { anything: true })]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(
        /No postcondition verifier is registered for 'nope.not_a_tool'/,
      );

      const pipelineSide = await app.verifiers.verify('nope.not_a_tool', {}, {}, db);
      expect(pipelineSide.postconditionsMet).toBe(false);
      expect(pipelineSide.discrepancies.join('\n')).toMatch(/No postcondition is registered/);
    });

    it('says it had nothing to re-read rather than assuming the best', async () => {
      const output = await run('memory.remember_event', { summary: 'chai' });

      // The memory really is on disk — the same output verifies with a database.
      // Without one there is no authoritative state, and the honest answer is
      // "not proven", with the reason being the missing database rather than a
      // claim about the memory.
      const report = await verify([succeeded('memory.remember_event', output)], {
        verifiers: app.verifiers,
        identityId: owner.id,
        cycleId,
      });
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/no database to re-read/);
    });

    it('reports an output that does not match the tool’s own schema', async () => {
      // A postcondition receives `unknown`, so a malformed output has to become a
      // discrepancy rather than an exception thrown from inside the verifier.
      const report = await stage8([succeeded('memory.remember_event', { nothing: 'useful' })]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/does not match its own output schema/);
    });

    it('does not re-read anything for a call that did not complete', async () => {
      // Dispatched and thrown, so `attempted` is true and the sentence has to leave
      // room for a tool that did half of what it was asked before failing. Stage 8
      // still re-reads nothing: an unfinished call has no postcondition to hold.
      const report = await stage8([
        {
          toolId: 'memory.remember_event',
          attempted: true,
          success: false,
          error: 'timed out',
          verified: false,
        },
      ]);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/was called and did not complete: timed out/);
    });

    it('says a refused call was never made, rather than that it failed', async () => {
      // The other half of `!success`, and the one the old single sentence read wrong.
      // Nothing was dispatched, so nothing can be half-done.
      const report = await stage8([
        {
          toolId: 'memory.remember_event',
          attempted: false,
          success: false,
          error: 'No tool executor is wired; action is disabled',
          verified: false,
        },
      ]);
      expect(report.postconditionsMet).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/was never called: No tool executor is wired/);
      expect(report.discrepancies.join('\n')).not.toMatch(/did not complete/);
    });

    it('says so when no tool was ever identified, rather than verifying nothing quietly', async () => {
      // Stage 7 refused before dispatch, so there is no id to look state up by. The
      // honest report is the sentence naming that — which is what stage 9 can show
      // the caller — and a `postconditionsMet` of false by the same route as any
      // other discrepancy.
      const report = await stage8([
        { toolId: 'unknown', attempted: false, success: false, error: 'not authorized', verified: false },
      ]);
      expect(report.postconditionsMet).toBe(false);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies.join('\n')).toMatch(/without an identified tool: not authorized/);
    });

    it('verifies an empty action list, because nothing was claimed', async () => {
      // A cycle that decided to say something and act on nothing must not be
      // reported as unverified — there is no claim to disprove.
      const report = await stage8([]);
      expect(report.postconditionsMet).toBe(true);
      expect(report.discrepancies).toEqual([]);
      expect(report.results).toEqual([]);
    });
  });

  describe('the two verifiers give one answer', () => {
    it('agrees on a real write and on a pretend one', async () => {
      const real = await run('memory.remember_event', { summary: 'kal shaam chai' });
      const pretend = await run('test.pretend_remember', { summary: 'kal shaam chai' });

      // Same registry, so the pipeline's row and stage 8's report cannot drift:
      // both prove the first and both refuse the second.
      expect(persistedVerdict('memory.remember_event').verified).toBe(1);
      expect(persistedVerdict('test.pretend_remember').verified).toBe(0);

      const report = await stage8([
        succeeded('memory.remember_event', real),
        succeeded('test.pretend_remember', pretend),
      ]);
      expect(report.results.map((r) => r.verified)).toEqual([true, false]);
      expect(report.postconditionsMet).toBe(false);
      expect(report.discrepancies).toHaveLength(1);
    });

    it('leaves the original result object untouched', async () => {
      // Stage 9 reads `verified` off the report, not off whatever stage 7 handed
      // over. A verifier that mutated its input would make the two disagree the
      // moment anything held a reference to the earlier value.
      const output = await run('memory.remember_event', { summary: 'chai' });
      const result = succeeded('memory.remember_event', output);

      const report = await stage8([result]);
      expect(report.results[0]?.verified).toBe(true);
      expect(result.verified).toBe(false);
      expect(report.results[0]).not.toBe(result);
    });
  });
});
