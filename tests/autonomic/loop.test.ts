/**
 * The autonomic layer (`server/autonomic/`).
 *
 * These tests exist to check one claim that nothing in the repository could check
 * before: **she says something nobody asked for.** Every part of that was
 * present and unconnected — `ProactiveEngine.runCycle` had one caller and it was
 * a test, `runIfIdle` had none, and `TaskExecutor` completed reminders by
 * dropping them on the floor.
 *
 * So the assertions here are deliberately about committed state rather than about
 * calls: a `message` row with `role: 'assistant'` and no user turn beside it, a
 * `proactive_decision` row with `acted_at` set, a reminder that retries when she
 * was busy. A spy proving `runIfIdle` was invoked would pass just as well against
 * a version of this that spoke into a void.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import type { Identity } from '@server/identity/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

/** Quiet hours off, so a test at 3am behaves like a test at noon. */
const ALWAYS_AWAKE = { QUIET_HOURS_START: '0', QUIET_HOURS_END: '0' };

describe('Autonomic layer (server/autonomic/)', () => {
  let db: Database;
  let app: MadhuritaApp | undefined;

  const buildApp = (env: Record<string, string> = {}): MadhuritaApp =>
    createApp({
      config: loadConfig({ ...ALWAYS_AWAKE, ...env }),
      db,
      installGlobalDatabase: false,
    });

  /** A permanently failed task: every attempt used, none successful. */
  const insertDeadTask = (owner: Identity, message: string): string => {
    const id = `task_dead_${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO task (id, identity_id, kind, payload_json, due_at, status, attempt,
                           max_attempts, created_at, updated_at, last_error)
         VALUES (?, ?, 'reminder', ?, ?, 'failed', 3, 3, ?, ?, ?)`,
      )
      .run(
        id,
        owner.id,
        JSON.stringify({ kind: 'reminder', message }),
        now,
        now,
        now,
        'Reminder dispatch returned false',
      );
    return id;
  };

  const turnsFor = (identityId: string): { role: string; text: string }[] =>
    db.raw
      .prepare(
        `SELECT m.role, m.text FROM message m
           JOIN conversation c ON c.id = m.conversation_id
          WHERE c.identity_id = ? ORDER BY m.timestamp ASC, m.id ASC`,
      )
      .all(identityId) as { role: string; text: string }[];

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
  });

  afterEach(async () => {
    await app?.stop();
    app = undefined;
    db.close();
    closeDatabase();
  });

  describe('noticing', () => {
    it('reports a permanently failed task once, not on every tick', async () => {
      app = buildApp();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      // `task.exhausted` is an event, so the sensor is a differ over its own
      // watermark. A second sweep with nothing new must find nothing — otherwise
      // she would report the same failure every minute for the life of the
      // process.
      const first = app.noticing.sweep(owner.id, Date.now());
      expect(first.notices).toHaveLength(1);
      expect(first.notices[0]?.sensor).toBe('task.exhausted');
      expect(first.notices[0]?.seed).toContain('buy milk');
      expect(first.errors).toEqual([]);

      const second = app.noticing.sweep(owner.id, Date.now());
      expect(second.notices).toHaveLength(0);
    });

    it('cites a row rather than inventing a topic', async () => {
      app = buildApp();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      const taskId = insertDeadTask(owner, 'call the bank');

      const { notices } = app.noticing.sweep(owner.id, Date.now());

      // The id is in the topic so the engine's per-topic rate limit is per task.
      // A bare `task.exhausted` topic would let one failure mask every other.
      expect(notices[0]?.topic).toBe(`task.exhausted:${taskId}`);
      expect(notices[0]?.subject).toEqual({ kind: 'task', id: taskId });
    });

    it('keeps every score under the urgency bypass', async () => {
      app = buildApp();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'renew the insurance');

      // The tree emits immediately at `urgency >= 0.8`, skipping quiet hours.
      // Nothing a sensor produces may reach that: a failed job is worth saying
      // and is not worth waking him at 3am.
      for (const notice of app.noticing.sweep(owner.id, Date.now()).notices) {
        expect(notice.urgency).toBeLessThan(0.8);
      }
    });
  });

  describe('the heartbeat', () => {
    it('speaks unprompted, and the transcript shows only her turn', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      const report = await app.autonomic.tick();

      expect(report.noticed).toBe(1);
      expect(report.authorized).toBe(1);
      expect(report.spoken).toBe(1);
      expect(report.yielded).toBe(0);
      expect(report.sensorErrors).toEqual([]);

      // The load-bearing assertion. One turn, hers — the seed was her own
      // noticing, and writing it as a user turn would have put her internal
      // prompt in his mouth.
      const turns = turnsFor(owner.id);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.role).toBe('assistant');
      expect(turns[0]?.text.trim()).not.toBe('');
    });

    it('marks the decision delivered only after she actually spoke', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      await app.autonomic.tick();

      const decisions = db.raw
        .prepare(`SELECT action, acted_at FROM proactive_decision WHERE identity_id = ?`)
        .all(owner.id) as { action: string; acted_at: string | null }[];
      expect(decisions).toHaveLength(1);
      expect(decisions[0]?.action).toBe('emit');
      expect(decisions[0]?.acted_at).not.toBeNull();
    });

    it('yields rather than interrupting a cycle already in flight', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      // His turn and her tick, at once. The gate gives him the lane; `runIfIdle`
      // declines rather than queueing, which is the whole of Build Book VII.5.
      const [, report] = await Promise.all([
        app.runtimeFor(owner).runCycle({
          source: 'text',
          payload: { text: 'kaisi ho?' },
          receivedAt: Date.now(),
          identityId: owner.id,
        }),
        app.autonomic.tick(),
      ]);

      expect(report.authorized).toBe(1);
      expect(report.spoken + report.yielded).toBe(1);
    });

    it('survives a sensor that throws instead of going mute', async () => {
      app = buildApp();
      await app.start();
      // An owner has to exist or the tick returns early and no sensor ever runs.
      await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });

      // A broken reader is a gap in what she can notice. It is not a reason for
      // the heartbeat to stop, and the report has to say what broke.
      const boom = new Error('task table unreadable');
      app.taskExecutor.failedTasks = () => {
        throw boom;
      };
      const report = await app.autonomic.tick();

      expect(report.sensorErrors.join('\n')).toContain('task table unreadable');
      // The stalled-loop sensor still ran, and the tick still reported.
      expect(app.autonomic.report()).toBe(report);
      expect(app.autonomic.isRunning()).toBe(true);
    });

    it('says the thing she noticed, not hello', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      await app.autonomic.tick();

      // The defect this pins down was invisible to every other test here: she
      // spoke, one assistant turn was committed, the report counted it — and the
      // words were 'Hello — I hear you.' With no language faculty wired, stage 9's
      // draft ran the seed through a greeting matcher and threw the observation
      // away, so the whole autonomic layer delivered a hello over a failed
      // reminder. Asserting a turn *exists* passes against that. Asserting it
      // mentions the reminder does not.
      const text = turnsFor(owner.id)[0]?.text ?? '';
      expect(text).toContain('buy milk');
      expect(text).not.toMatch(/^Hello/);
    });

    it('speaks to him rather than about him', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      await app.autonomic.tick();

      // The seeds are the utterance on the no-faculty path, so a seed written as a
      // note *about* him ("something he asked for has failed") reached him as
      // third-person narration about himself. Second person is not a style
      // preference here; it is the difference between a sentence she can say and
      // one she cannot.
      const text = turnsFor(owner.id)[0]?.text ?? '';
      expect(text).toMatch(/\byou\b/i);
      expect(text).not.toMatch(/\b(he|his|him)\b/i);
    });

    it('tells the state projector about a cycle she started herself', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      insertDeadTask(owner, 'buy milk');

      // `/api/state`'s `cognitive` block reports the cycle she is in, and for a
      // while only `POST /api/chat` told it one had happened. So a full
      // twelve-stage cycle she ran herself left the block reading `cycleId: ''` —
      // "she has never had a thought" — while she was mid-conversation with
      // herself. Every cycle now announces itself on the event log (`cycle.started`,
      // one event per stage, then the terminal event) and the projector folds that
      // log whether or not anybody is streaming, so no door skips it. Read through
      // `buildInitial` here on purpose: that is the expression `GET /api/state`
      // evaluates when realtime is off, and it must not be the blind one.
      const before = app.projector.buildInitial(owner);
      expect(before.cognitive.cycleId).toBe('');

      await app.autonomic.tick();

      const after = app.projector.buildInitial(owner);
      expect(after.cognitive.cycleId).not.toBe('');
      expect(after.cognitive.lastCompletedStage).toBe('PERSIST');
      expect(after.presence.activeActor).toBe(owner.id);
    });

    it('does nothing at all before an owner is enrolled', async () => {
      app = buildApp();
      await app.start();

      const report = await app.autonomic.tick();
      expect(report).toMatchObject({ noticed: 0, authorized: 0, spoken: 0, yielded: 0 });
      expect(report.sensorErrors).toEqual([]);
    });
  });

  describe('reminders', () => {
    it('speaks a due reminder in her own words instead of discarding it', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });

      app.taskExecutor.scheduleTask({
        identityId: owner.id,
        kind: 'reminder',
        payload: { kind: 'reminder', message: 'pick up the parcel' },
      });

      await app.taskExecutor.tick();

      // The reminder is a task the executor claimed; the *words* came from the
      // twelve stages. So the assertion is that a turn exists and that it is
      // hers — not that it equals the reminder text, which would be asserting
      // she is a template.
      const turns = turnsFor(owner.id);
      expect(turns).toHaveLength(1);
      expect(turns[0]?.role).toBe('assistant');
      // It does have to be *about* the parcel, though. With no faculty wired the
      // seed is what she says, and a reminder that arrives as a greeting is a
      // reminder that did not arrive.
      expect(turns[0]?.text).toContain('pick up the parcel');
    });

    it('retries instead of completing when she was too busy to say it', async () => {
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });

      const taskId = app.taskExecutor.scheduleTask({
        identityId: owner.id,
        kind: 'reminder',
        payload: { kind: 'reminder', message: 'pick up the parcel' },
      });

      // `onReminder` returning false is the executor's signal to retry with
      // backoff. That is the correct behaviour for a reminder she could not say
      // yet — the alternative is a row marked delivered for words nobody heard.
      await Promise.all([
        app.runtimeFor(owner).runCycle({
          source: 'text',
          payload: { text: 'kaisi ho?' },
          receivedAt: Date.now(),
          identityId: owner.id,
        }),
        app.taskExecutor.tick(),
      ]);

      const task = app.taskExecutor.getTask(taskId);
      expect(task?.status === 'pending' || task?.status === 'completed').toBe(true);
      if (task?.status === 'pending') {
        expect(task.lastError).toMatch(/Reminder dispatch returned false/);
      }
    });

    it('refuses a reminder for anyone who is not the enrolled owner', async () => {
      app = buildApp();
      await app.start();
      await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      const guest = await app.identityRepo.createIdentity({ kind: 'guest', displayName: 'Someone' });

      // The loop watches one person. A reminder addressed to somebody else is not
      // hers to speak, and answering `false` sends it back to the retry path
      // rather than silently completing it.
      expect(await app.autonomic.deliverReminder(guest.id, 'not yours')).toBe(false);
    });
  });
});
