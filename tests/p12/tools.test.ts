/**
 * P12 — the tool registry, and the checkpoint it exists to satisfy.
 *
 * The build book's P12 verification block asks for one thing in particular:
 * *"A malformed tool input is rejected."* Rejected is not the same as tolerated
 * with a default, and it is not the same as thrown away either — the rejection
 * has to reach `action_result` and the event log, or a caller learns nothing and
 * a trace shows nothing.
 *
 * So these tests drive real tools through the real pipeline, with the real
 * database underneath. What they check, beyond the checkpoint:
 *
 *  - Every executable tool is provable. The registry and the verifier registry
 *    hold the same seven ids, which is the invariant boot refuses to start
 *    without.
 *  - A tool cannot be told whose memory to write into. The schemas carry no
 *    `identityId`, and the write lands on the caller the application
 *    authenticated.
 *  - Authorization is enforced where the side effect happens, including the one
 *    case `check()` cannot see: a caller whose enrolment is no longer active.
 *
 * `start()` is never called. Tools are installed at construction, so a runtime
 * can act without the background loops running — and this file paying no timers
 * is the evidence for that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { ulid } from '@server/persistence/ids.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { installTool } from '@server/tools/index.js';
import { rememberEventTool } from '@server/tools/memory.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

describe('P12 — the tool registry', () => {
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

  /** One tool call, as stage 7 would make it. */
  const run = (toolId: string, input: unknown, as?: Identity): Promise<unknown> =>
    app.toolExecutor.execute({
      toolId,
      input,
      context: { identityId: (as ?? owner).id, cycleId, causationId: cycleId },
    });

  const actionRows = (): { tool_id: string; verified: number; error: string | null }[] =>
    db.raw
      .prepare(`SELECT tool_id, verified, error FROM action_result ORDER BY persisted_at, id`)
      .all() as { tool_id: string; verified: number; error: string | null }[];

  const eventTypes = (): string[] =>
    (db.raw.prepare(`SELECT type FROM domain_event ORDER BY seq`).all() as { type: string }[]).map(
      (row) => row.type,
    );

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

  describe('every executable tool is also provable', () => {
    it('holds the same seven ids in the registry and the verifier registry', () => {
      const registered = app.registry.list().map((tool) => tool.id);
      expect(registered).toHaveLength(7);
      // Sorted, because registration order is boot's concern and set equality is
      // this one's. A mismatch here is what `start()` refuses to boot on.
      expect(app.verifiers.ids()).toEqual([...registered].sort());
    });

    it('refuses to install the same tool twice', () => {
      expect(() =>
        installTool(
          app.registry,
          app.verifiers,
          rememberEventTool({
            memoryRepo: app.memoryRepo,
            memoryRetrieval: app.memoryRetrieval,
            db: app.db,
          }),
        ),
      ).toThrow(/already registered/);
    });
  });

  describe('a malformed tool input is rejected (P12 checkpoint)', () => {
    it('rejects a summary that is only whitespace, and writes nothing', async () => {
      await expect(run('memory.remember_event', { summary: '   ' })).rejects.toThrow(
        /Input validation failed/,
      );
      expect(app.memoryRepo.listEpisodic(owner.id)).toEqual([]);
    });

    it('records the rejection rather than losing it', async () => {
      // A rejection that leaves no row is indistinguishable from a call that was
      // never made. Stage 6 of the pipeline persists either way.
      await expect(run('memory.remember_event', { summary: '' })).rejects.toThrow();

      const rows = actionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tool_id).toBe('memory.remember_event');
      expect(rows[0]?.verified).toBe(0);
      expect(rows[0]?.error).toMatch(/Input validation failed/);

      expect(eventTypes()).toContain('action.failed');
      expect(eventTypes()).not.toContain('action.executed');
    });

    it('rejects an event dated in the future', async () => {
      // Ranking is recency-weighted, so an event dated ahead of now would
      // outrank everything she knows for as long as it existed.
      await expect(
        run('memory.remember_event', { summary: 'ok', occurredAt: Date.now() + 600_000 }),
      ).rejects.toThrow(/occurredAt cannot be in the future/);
    });

    it('rejects a recall limit outside its bounds', async () => {
      await expect(run('memory.recall', { query: 'x', limit: 0 })).rejects.toThrow(
        /Input validation failed/,
      );
      await expect(run('memory.recall', { query: 'x', limit: 21 })).rejects.toThrow(
        /Input validation failed/,
      );
    });

    it('rejects a reminder that names both times, and one that names neither', async () => {
      await expect(
        run('reminder.schedule', { message: 'chai', dueAt: Date.now() + 60_000, inMinutes: 5 }),
      ).rejects.toThrow(/exactly one of dueAt or inMinutes/);
      await expect(run('reminder.schedule', { message: 'chai' })).rejects.toThrow(
        /exactly one of dueAt or inMinutes/,
      );
    });

    it('refuses a reminder due in the past, which is a wrong number rather than "now"', async () => {
      // The executor claims anything due on its next poll, so accepting this
      // would deliver a reminder set for 1970 a moment after it was set.
      await expect(
        run('reminder.schedule', { message: 'chai', dueAt: Date.now() - 600_000 }),
      ).rejects.toThrow(/in the past/);
      expect(app.taskExecutor.getPendingTasks(owner.id)).toEqual([]);
    });

    it('rejects a call to a tool that does not exist', async () => {
      await expect(run('memory.forget_everything', {})).rejects.toThrow(/not found/);
    });
  });

  describe('a tool cannot be told whose memory to write into', () => {
    it('ignores an identityId in the input and writes to the authenticated caller', async () => {
      const other = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Someone else',
      });

      // No schema in `server/tools/` has an `identityId` field, so Zod strips it.
      // The assertion that matters is the second one: stripping is not merely
      // permissive, the write still lands on the caller the application
      // authenticated.
      const output = await run('memory.remember_event', {
        summary: 'chai pi',
        identityId: other.id,
      });

      expect(output).toMatchObject({ identityId: owner.id, domain: 'episodic' });
      expect(app.memoryRepo.listEpisodic(other.id)).toEqual([]);
      expect(app.memoryRepo.listEpisodic(owner.id)).toHaveLength(1);
    });

    it('derives an owner’s sensitivity rather than accepting one', async () => {
      // A model that could set this field could mark its own memory `public` and
      // read it back out through any caller.
      await run('memory.remember_fact', {
        subject: 'Ankit',
        predicate: 'lives in',
        object: 'Bengaluru',
        sensitivity: 'public',
      });

      const stored = app.memoryRepo.listSemantic(owner.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.sensitivity).toBe('owner_only');
    });
  });

  describe('authorization is enforced where the side effect happens', () => {
    it('denies a person a tool the owner has not granted by name', async () => {
      const person = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Friend',
      });
      // `mayAccessTools` is an allow-list, and a newly enrolled person's is
      // empty — so even a `safe` read is refused until the owner grants it.
      await expect(run('memory.recall', { query: 'anything' }, person)).rejects.toThrow(
        /not in allowed tool access list/,
      );
    });

    it('denies a guest before it reaches the allow-list at all', async () => {
      const guest = await app.identityRepo.createIdentity({ kind: 'guest', displayName: 'Guest' });
      await expect(run('memory.recall', { query: 'anything' }, guest)).rejects.toThrow(
        /tool execution is disabled/,
      );
    });

    it('refuses a caller whose enrolment is no longer active', async () => {
      // `check()` reasons purely from permissions and never looks at status, so a
      // revoked identity still carrying owner permissions passes it. The refusal
      // lives at the execution boundary instead, where the caller is re-read.
      db.raw.prepare(`UPDATE identity SET status = 'revoked' WHERE id = ?`).run(owner.id);

      await expect(run('memory.remember_event', { summary: 'anything' })).rejects.toThrow(
        /is revoked/,
      );
      expect(app.memoryRepo.listEpisodic(owner.id)).toEqual([]);
    });

    it('refuses a caller who is not enrolled at all', async () => {
      await expect(
        app.toolExecutor.execute({
          toolId: 'memory.recall',
          input: { query: 'x' },
          context: { identityId: ulid(), cycleId, causationId: cycleId },
        }),
      ).rejects.toThrow(/No enrolled identity/);
    });
  });

  describe('a well-formed call runs, is verified, and is recorded', () => {
    it('writes the memory and marks the row verified', async () => {
      const output = await run('memory.remember_event', {
        summary: 'aaj chai pi',
        importance: 0.7,
      });
      expect(output).toMatchObject({ domain: 'episodic', summary: 'aaj chai pi' });

      const rows = actionRows();
      expect(rows).toHaveLength(1);
      // `verified = 1` here is the pipeline's own VERIFY stage having re-read the
      // row it just wrote — not the tool's word for it.
      expect(rows[0]?.verified).toBe(1);
      expect(rows[0]?.error).toBeNull();
      expect(eventTypes()).toContain('action.executed');
    });

    it('schedules a reminder the executor can actually find', async () => {
      const dueAt = Date.now() + 45 * 60_000;
      const output = (await run('reminder.schedule', { message: 'chai banana', dueAt })) as {
        taskId: string;
      };

      const task = app.taskExecutor.getTask(output.taskId);
      expect(task?.identityId).toBe(owner.id);
      expect(task?.kind).toBe('reminder');
      expect(task?.dueAt).toBe(dueAt);
      expect(actionRows()[0]?.verified).toBe(1);
    });
  });
});
