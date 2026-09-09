/**
 * `attempted` — the field that decides which sentence she says.
 *
 * A tool call fails in two completely different ways and she has to answer them
 * differently:
 *
 *  - **It was never dispatched.** Nothing was touched, so the honest sentence is
 *    "I did not do that" and there is nothing to go and check.
 *  - **It was dispatched and threw.** The tool may have done half of what it was
 *    asked, so the honest sentence is "I started on that, but I could not confirm it
 *    actually went through" — and someone should go and look.
 *
 * The second sentence is the more alarming one, and it was being said for both. The
 * chain is four hops long — `ActionPipeline` → `PipelineToolExecutor` → stage 7 →
 * stage 9 — and the distinction was lost at the second: `ToolExecutor.execute`
 * returns `Promise<unknown>`, so a refusal could only reach stage 7 as a rejection,
 * and every rejection was stamped `attempted: true`. Every reader downstream was
 * already written correctly and was reading a field that lied.
 *
 * So these tests drive the real chain — real database, real registry, real tools —
 * and assert the field at each hop, plus the sentence at the end. A unit test over
 * any single hop would have passed throughout the defect, which is what happened:
 * 1023 tests were green over it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { z } from 'zod';

import { ulid } from '@server/persistence/ids.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { act, NotAttemptedError } from '@server/cognition/stages/7.js';
import { respond } from '@server/cognition/stages/9.js';
import { DEFAULT_RETRY_POLICY } from '@server/actions/registry.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type {
  ActionResult,
  AuthorizedDecision,
  RecalledContext,
} from '@server/cognition/types.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

describe('attempted — a refusal is not an attempt', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;
  let cycleId: string;

  /** A real cycle row, because `action_result.cycle_id` is a foreign key. */
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

  /** An authorized `execute_tool` decision, as stage 6 forms one. */
  const decisionFor = (toolId: string, toolInput: unknown): AuthorizedDecision => ({
    proposal: { action: 'execute_tool', toolId, toolInput, rationale: 'test' },
    authorized: true,
    clearance: { kind: 'granted', action: 'tool:execute' },
  });

  /**
   * Stage 7 over the real executor, wired the way `CognitiveRuntime` wires it.
   *
   * `clearanceFor` reads the registry, so the boundary check here is against the
   * clearance the tool actually declares rather than an assumed `safe`.
   */
  const runStage7 = (toolId: string, input: unknown, as?: Identity): Promise<ActionResult[]> =>
    act(decisionFor(toolId, input), {
      executor: app.toolExecutor,
      identity: as ?? owner,
      cycleId,
      clearanceFor: (id) => app.registry.get(id)?.clearanceRequired,
    });

  const soleResult = async (
    toolId: string,
    input: unknown,
    as?: Identity,
  ): Promise<ActionResult> => {
    const results = await runStage7(toolId, input, as);
    expect(results).toHaveLength(1);
    return results[0] as ActionResult;
  };

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
    cycleId = openCycle(owner.id);
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  describe('nothing was dispatched', () => {
    it('records a revoked caller as never called', async () => {
      // The trigger the audit found first. `check()` never looks at `status`, so the
      // refusal lives in `resolveCaller` — before the pipeline is entered at all.
      db.raw.prepare(`UPDATE identity SET status = 'revoked' WHERE id = ?`).run(owner.id);

      const result = await soleResult('memory.remember_event', { summary: 'anything' });
      expect(result.attempted).toBe(false);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/is revoked/);
      expect(app.memoryRepo.listEpisodic(owner.id)).toEqual([]);
    });

    it('records an unenrolled caller as never called', async () => {
      const stranger: Identity = { ...owner, id: ulid() };
      const result = await soleResult('memory.recall', { query: 'x' }, stranger);
      expect(result.attempted).toBe(false);
      expect(result.error).toMatch(/No enrolled identity/);
    });

    it('records a tool the caller may not reach as never called', async () => {
      // A newly enrolled person's `mayAccessTools` is empty. This one is refused at
      // stage 7's *own* boundary check and never reaches the executor: now that stage
      // 7 asks the registry for the real declared clearance, its `check` call and the
      // pipeline's AUTHORIZE stage are the same predicate over the same inputs, so
      // whichever runs first is the one that answers. Stage 7 runs first.
      //
      // Which means AUTHORIZE inside the pipeline is only reachable by a caller that
      // does not come through stage 7 — `TaskExecutor`, which calls `pipeline.execute`
      // directly. The case below covers that path.
      const person = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Friend',
      });
      const result = await soleResult('memory.recall', { query: 'anything' }, person);
      expect(result.attempted).toBe(false);
      expect(result.error).toMatch(/not in allowed tool access list/);
    });

    it('records a pipeline AUTHORIZE refusal as never called', async () => {
      // The path a scheduled task takes: `TaskExecutor` resolves the caller and calls
      // `pipeline.execute` itself, so stage 7's boundary check is not in front of it.
      // A permission revoked between scheduling and execution lands here.
      const person = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Friend',
      });
      const refused = await app.pipeline.execute({
        toolId: 'memory.recall',
        input: { query: 'anything' },
        identityId: person.id,
        cycleId,
        causationId: cycleId,
        caller: person,
      });
      expect(refused.attempted).toBe(false);
      expect(refused.error).toMatch(/not in allowed tool access list/);
    });

    it('records an input its schema rejected as never called', async () => {
      const result = await soleResult('memory.remember_event', { summary: '   ' });
      expect(result.attempted).toBe(false);
      expect(result.error).toMatch(/Input validation failed/);
      expect(app.memoryRepo.listEpisodic(owner.id)).toEqual([]);
    });

    it('records an unknown tool as never called', async () => {
      const result = await soleResult('memory.forget_everything', {});
      expect(result.attempted).toBe(false);
      expect(result.error).toMatch(/not found/);
    });
  });

  describe('the call went out', () => {
    it('records a tool that threw as attempted', async () => {
      app.registry.register({
        id: 'test.explodes',
        name: 'Explodes',
        description: 'Throws from inside the handler.',
        inputSchema: z.object({}).strict(),
        clearanceRequired: 'safe',
        retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
        timeoutMs: 1000,
        execute: () => Promise.reject(new Error('the tool broke halfway')),
      });

      const result = await soleResult('test.explodes', {});
      // The distinction the whole chain exists for: this one gets "go and look".
      expect(result.attempted).toBe(true);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/the tool broke halfway/);
    });

    it('records a call that succeeded as attempted, and unverified until stage 8', async () => {
      const result = await soleResult('memory.remember_event', { summary: 'aaj chai pi' });
      expect(result.attempted).toBe(true);
      expect(result.success).toBe(true);
      // Stage 7 never sets this. Stage 8 re-reads state and decides.
      expect(result.verified).toBe(false);
    });
  });

  describe('the seam', () => {
    it('raises NotAttemptedError, not a plain Error, when nothing was dispatched', async () => {
      // Stage 7 discriminates on the type, so the type is the contract. A plain
      // `Error` here is read as "the call went out", which is how the defect worked.
      await expect(
        app.toolExecutor.execute({
          toolId: 'memory.recall',
          input: { query: 'x' },
          context: { identityId: ulid(), cycleId, causationId: cycleId },
        }),
      ).rejects.toThrow(NotAttemptedError);
    });

    it('reports attempted on the pipeline result itself', async () => {
      const refused = await app.pipeline.execute({
        toolId: 'memory.remember_event',
        input: { summary: '' },
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });
      expect(refused.attempted).toBe(false);
      expect(refused.success).toBe(false);

      const ran = await app.pipeline.execute({
        toolId: 'memory.remember_event',
        input: { summary: 'kuch hua' },
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });
      expect(ran.attempted).toBe(true);
      expect(ran.success).toBe(true);
    });
  });

  describe('the durable record', () => {
    const rowFor = (id: string): { attempted: number | null; discrepancies_json: string | null } =>
      db.raw
        .prepare(`SELECT attempted, discrepancies_json FROM action_result WHERE id = ?`)
        .get(id) as { attempted: number | null; discrepancies_json: string | null };

    it('writes attempted = 0 for a refusal and 1 for a dispatch', async () => {
      const refused = await app.pipeline.execute({
        toolId: 'memory.remember_event',
        input: { summary: '' },
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });
      expect(rowFor(refused.actionResultId).attempted).toBe(0);

      const ran = await app.pipeline.execute({
        toolId: 'memory.remember_event',
        input: { summary: 'kuch hua' },
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });
      expect(rowFor(ran.actionResultId).attempted).toBe(1);
    });

    it('keeps the reason a verification failed, rather than only that it did', async () => {
      // A tool with no registered verifier: the pipeline's VERIFY stage reports the
      // discrepancy, and before this the row said `verified = 0` with no record of why.
      app.registry.register({
        id: 'test.unverifiable',
        name: 'Unverifiable',
        description: 'Runs, but nothing can prove it.',
        inputSchema: z.object({}).strict(),
        clearanceRequired: 'safe',
        retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
        timeoutMs: 1000,
        execute: () => Promise.resolve({ ok: true }),
      });

      const ran = await app.pipeline.execute({
        toolId: 'test.unverifiable',
        input: {},
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });
      expect(ran.verified).toBe(false);

      const row = rowFor(ran.actionResultId);
      expect(row.attempted).toBe(1);
      expect(JSON.parse(row.discrepancies_json ?? 'null')).toEqual([
        expect.stringContaining('test.unverifiable'),
      ]);
    });

    it('names the gate that actually refused, not the last one that would have', async () => {
      // Stages 1–3 used to all run and each overwrite the same `error`, so an unknown
      // tool was persisted with whatever AUTHORIZE said about it — a row naming a gate
      // the call never reached.
      const refused = await app.pipeline.execute({
        toolId: 'test.not.a.tool',
        input: { anything: true },
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });
      const row = db.raw
        .prepare(`SELECT error, attempted FROM action_result WHERE id = ?`)
        .get(refused.actionResultId) as { error: string; attempted: number };
      expect(row.attempted).toBe(0);
      expect(row.error).toMatch(/^Tool 'test\.not\.a\.tool' not found$/);
    });
  });

  describe('the sentence she actually says', () => {
    /**
     * Stage 9 over a real stage 7 outcome. The faculty is given a draft that claims
     * the thing was done, because that is the case the gate exists for — and the two
     * notices it can answer with are the two halves of the defect.
     */
    const sentenceFor = async (results: ActionResult[]): Promise<string> => {
      const recalled: RecalledContext = {
        stimulus: {
          source: 'text',
          payload: { text: 'yaad rakh lena' },
          receivedAt: Date.now(),
          identityId: owner.id,
          conversationId: app.conversations.open(owner.id).id,
          identityKind: 'owner',
          callerPermissions: DEFAULT_PERMISSIONS.owner,
          inputType: 'user_message',
        },
        episodic: [],
        semantic: [],
        preferences: [],
        habits: [],
        relationships: [],
        learnedPatterns: [],
        retrievedAt: Date.now(),
      };
      const response = await respond(recalled, decisionFor('memory.remember_event', {}), results, undefined, {
        llm: { draftResponse: async () => ({ text: 'Haan, kar diya — save ho gaya.' }) },
      });
      return response.text;
    };

    it('says "I did not do that" for a refusal, not "I started on that"', async () => {
      db.raw.prepare(`UPDATE identity SET status = 'revoked' WHERE id = ?`).run(owner.id);
      const refused = await soleResult('memory.remember_event', { summary: 'anything' });

      const text = await sentenceFor([refused]);
      // The defect in one assertion: this sentence used to be the other one.
      expect(text).toContain('I did not do that');
      expect(text).toContain('nothing has changed');
      expect(text).not.toContain('could not confirm');
    });

    it('says "I started on that" for a call that went out and threw', async () => {
      app.registry.register({
        id: 'test.half_done',
        name: 'Half done',
        description: 'Throws after touching something.',
        inputSchema: z.object({}).strict(),
        clearanceRequired: 'safe',
        retryPolicy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 },
        timeoutMs: 1000,
        execute: () => Promise.reject(new Error('halfway')),
      });
      const threw = await soleResult('test.half_done', {});

      // Same gate, opposite verdict — and this is the one that should send him to look.
      expect(await sentenceFor([threw])).toContain('could not confirm');
    });
  });

  describe('what the event log says', () => {
    it('carries attempted on action.failed', async () => {
      await app.pipeline.execute({
        toolId: 'memory.remember_event',
        input: { summary: '' },
        identityId: owner.id,
        cycleId,
        causationId: cycleId,
        caller: owner,
      });

      const row = db.raw
        .prepare(`SELECT type, payload_json FROM domain_event ORDER BY seq DESC LIMIT 1`)
        .get() as { type: string; payload_json: string };
      expect(row.type).toBe('action.failed');
      expect(JSON.parse(row.payload_json)).toMatchObject({ attempted: false, success: false });
    });
  });
});
