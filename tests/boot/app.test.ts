/**
 * The composition root (`server/app.ts`).
 *
 * Until this file existed there was no boot path at all: `server/index.ts` was
 * a two-line `console.log`, so no part of the build book's "application boots"
 * condition could honestly be claimed. These tests are what makes the claim
 * checkable — they boot the real application, with the real database and the
 * real subsystems, and assert on what it actually did.
 *
 * The load-bearing ones:
 *
 *  - The deferral sweep really runs. `processDeferred()` was written and tested
 *    in P17, but nothing outside a test ever called it, which meant a candidate
 *    held back for quiet hours was deferred forever. The test here drives it
 *    through the app's own timer.
 *
 *  - `boot.completed` carries no credential. It is a durable row; anything in
 *    its payload is in her database permanently.
 *
 *  - Boot reports what is missing. An empty tool registry, an absent language
 *    model and an unenrolled owner are all supported states, and each has to be
 *    said out loud rather than discovered later.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { z } from 'zod';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { ProactiveCandidate } from '@server/proactive/types.js';
import type { PersistedDomainEvent } from '@server/events/types.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

describe('Composition root (server/app.ts)', () => {
  let db: Database;
  let app: MadhuritaApp | undefined;

  /** An app over a database the test owns, never installed as the singleton. */
  const buildApp = (env: Record<string, string> = {}): MadhuritaApp =>
    createApp({
      config: loadConfig(env),
      db,
      installGlobalDatabase: false,
    });

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

  const events = (type?: string): PersistedDomainEvent[] => {
    const rows = db.raw
      .prepare(
        type
          ? `SELECT seq, type, payload_json FROM domain_event WHERE type = ? ORDER BY seq`
          : `SELECT seq, type, payload_json FROM domain_event ORDER BY seq`,
      )
      .all(...(type ? [type] : [])) as { seq: number; type: string; payload_json: string }[];
    return rows.map((row) => ({
      id: '',
      seq: row.seq,
      type: row.type as PersistedDomainEvent['type'],
      payload: JSON.parse(row.payload_json) as unknown,
      timestamp: 0,
      version: 1,
    }));
  };

  describe('boot', () => {
    it('migrates the database it is given', () => {
      // A caller should not have to remember to migrate first. `buildApp` hands
      // in an already-migrated database, so this asserts the other direction:
      // an unmigrated one is brought up to date rather than failing later on a
      // missing table.
      const fresh = new Database({ path: ':memory:' });
      try {
        const freshApp = createApp({
          config: loadConfig({}),
          db: fresh,
          installGlobalDatabase: false,
        });
        expect(freshApp.db).toBe(fresh);
        const version = fresh.raw
          .prepare(`SELECT value FROM app_meta WHERE key = 'schema_version'`)
          .get() as { value: string } | undefined;
        expect(Number(version?.value)).toBeGreaterThanOrEqual(11);
      } finally {
        fresh.close();
      }
    });

    it('publishes exactly one boot.completed', async () => {
      app = buildApp();
      await app.start();

      const booted = events('boot.completed');
      expect(booted).toHaveLength(1);
      expect(booted[0]?.seq).toBe(1);
    });

    it('never puts a credential in the boot event', async () => {
      const secret = 'AIza-super-secret-value-0123456789';
      app = buildApp({ GOOGLE_API_KEY: secret });
      await app.start();

      // `domain_event` is durable. A key echoed here would be in her database
      // for as long as she exists, and in every replay of her history.
      const payload = JSON.stringify(events('boot.completed')[0]?.payload);
      expect(payload).not.toContain(secret);
      expect(payload).not.toContain('AIza');
      expect(payload).toContain('"llmEnabled":true');
    });

    it('refuses to start twice', async () => {
      app = buildApp();
      await app.start();
      await expect(app.start()).rejects.toThrow(/already running/);
    });

    it('stops cleanly, and stopping again is a no-op', async () => {
      app = buildApp();
      await app.start();
      expect(app.isRunning()).toBe(true);

      await app.stop();
      expect(app.isRunning()).toBe(false);
      await app.stop();
      expect(app.isRunning()).toBe(false);
    });

    it('leaves a database it was handed open', async () => {
      // The app closes only what it opened. A test still has assertions to make
      // after shutdown.
      app = buildApp();
      await app.start();
      await app.stop();
      expect(db.isOpen()).toBe(true);
    });
  });

  describe('the boot report is honest about what is missing', () => {
    it('names the absent language faculty and the missing owner', async () => {
      app = buildApp();
      const report = await app.start();

      expect(report.ownerEnrolled).toBe(false);
      const absent = report.absent.join('\n');
      expect(absent).toMatch(/language faculty/);
      expect(absent).toMatch(/GOOGLE_API_KEY/);
      expect(absent).toMatch(/owner/);
      // The registry is no longer empty, so the line that said so would now be a
      // lie in the other direction.
      expect(absent).not.toMatch(/none registered/);
    });

    it('lists the tools she can actually execute', async () => {
      app = buildApp();
      const report = await app.start();

      expect(report.tools).toEqual([
        'memory.remember_event',
        'memory.remember_fact',
        'preference.set',
        'memory.recall',
        'reminder.schedule',
        'reminder.cancel',
        'reminder.list',
      ]);
    });

    it('refuses to boot with a tool nothing can prove', async () => {
      // The invariant `installTool()` exists to enforce, checked at the one place
      // that can see the whole registry. A tool registered directly is executable
      // and unprovable, which means stage 8 would report every one of its
      // successes as unproven — and the reason would be nowhere in sight.
      app = buildApp();
      app.registry.register({
        id: 'test.unprovable',
        name: 'Unprovable',
        description: 'Registered behind installTool’s back',
        inputSchema: z.object({}),
        clearanceRequired: 'safe',
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, retryableErrors: [] },
        timeoutMs: 1000,
        execute: async () => ({}),
      });

      await expect(app.start()).rejects.toThrow(/no postcondition verifier/);
    });

    it('says so when an operator has switched scheduling off', async () => {
      app = buildApp({ FLAG_TASKS: 'false' });
      const report = await app.start();

      expect(app.taskExecutor.isRunning()).toBe(false);
      expect(app.loopManager.isRunning()).toBe(false);
      expect(report.started.join('\n')).not.toMatch(/task executor/);
      expect(report.absent.join('\n')).toMatch(/FLAG_TASKS/);
    });

    it('starts the loops when the flags are on', async () => {
      app = buildApp();
      const report = await app.start();

      expect(app.taskExecutor.isRunning()).toBe(true);
      expect(app.loopManager.isRunning()).toBe(true);
      expect(report.started.join('\n')).toMatch(/proactive deferral sweep/);
    });

    it('admits that BACKUP_ENABLED cannot mean an unattended timer', async () => {
      // The backup key is derived from the owner's passphrase, and only its
      // hash is stored. A scheduled backup would therefore need the passphrase
      // held in memory for the life of the process. Rather than do that
      // silently, or pretend the timer exists, boot says what is true.
      app = buildApp({ BACKUP_ENABLED: 'true' });
      const report = await app.start();
      expect(report.absent.join('\n')).toMatch(/owner passphrase/);
    });

    it('reports how many audit rows the chain backfill covered', async () => {
      // `audit_log.actor_id` references a real identity, so the actor has to
      // exist before the rows do.
      db.raw
        .prepare(
          `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
           VALUES ('usr_backfill000000000000001', 'owner', 'Owner', 'active', 0, 0)`,
        )
        .run();
      db.raw
        .prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`)
        .run('usr_backfill000000000000001', JSON.stringify(DEFAULT_PERMISSIONS.owner));

      // Two rows written without a chain — the shape a pre-0007 database has.
      const insert = db.raw.prepare(
        `INSERT INTO audit_log (id, actor_id, action, resource, decision, reason, timestamp)
         VALUES (?, 'usr_backfill000000000000001', 'memory:read', 'memory/1', 'allow', NULL, ?)`,
      );
      insert.run('aud_1', new Date(1000).toISOString());
      insert.run('aud_2', new Date(2000).toISOString());
      db.raw.prepare(`UPDATE audit_log SET seq = NULL, prev_hash = NULL, entry_hash = NULL`).run();

      app = buildApp();
      const report = await app.start();
      expect(report.auditRowsChained).toBe(2);
      expect(app.audit.verifyIntegrity().valid).toBe(true);
    });
  });

  describe('the deferral sweep actually runs', () => {
    it('re-evaluates a deferred candidate once its due time passes', async () => {
      // This is the wiring `processDeferred()` never had. It was written and
      // tested in P17, but nothing outside a test called it, so "later" still
      // meant never in the running application. One second is the configured
      // floor for a sweep interval, and paying it here is what makes the claim
      // that she picks deferrals back up a measured fact.
      app = buildApp({ PROACTIVE_SWEEP_INTERVAL_MS: '1000' });

      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      const costly: ProactiveCandidate = {
        identityId: owner.id,
        callerKind: 'owner',
        topic: 'evening_check_in',
        decision: {
          kind: 'speak',
          channel: 'text',
          priority: 'normal',
          text: 'How did the day go?',
        },
        urgency: 0.5,
        novelty: 0.8,
        interruptionCost: 0.85,
        contextCompatibility: 0.9,
      };

      // Deferred because it would interrupt, not because of the clock.
      const deferred = app.proactive.evaluate(costly, { currentHour: 14 });
      expect(deferred.outcome.action).toBe('defer');

      // Bring its due time into the past so the next sweep finds it. This is
      // the only thing the test fakes: waiting fifteen real minutes for the
      // engine's own backoff would not make the assertion any truer.
      db.raw
        .prepare(`UPDATE proactive_decision SET deferred_until = ? WHERE id = ?`)
        .run(new Date(Date.now() - 1000).toISOString(), deferred.decisionId);

      expect(app.proactive.pendingDeferrals()).toHaveLength(1);
      const deferCountBefore = app.proactive.pendingDeferrals()[0]?.deferCount ?? -1;
      expect(deferCountBefore).toBeGreaterThanOrEqual(0);

      await app.start();

      // The re-evaluation defers it a second time — it is still costly to
      // interrupt — so the proof that the sweep ran is that the count moved and
      // the due time is back in the future, not that the queue emptied. That is
      // also the behaviour that matters: the engine gives up after three tries
      // rather than deferring forever, and it can only count tries it makes.
      await vi.waitFor(
        () => {
          const after = app?.proactive.pendingDeferrals()[0];
          expect(after?.deferCount).toBe(deferCountBefore + 1);
          expect(after?.deferredUntil).toBeGreaterThan(Date.now());
        },
        { timeout: 8000, interval: 100 },
      );
    }, 12_000);
  });

  describe('subsystems are wired to each other, not just constructed', () => {
    it('publishes identity.enrolled when an identity is created', async () => {
      // `IdentityRepository` had no event bus at all, so enrolment — the single
      // most consequential write in her database — was invisible to everything
      // else in the process.
      app = buildApp();
      await app.start();

      const identity = await app.identityRepo.createIdentity({
        kind: 'person',
        displayName: 'Friend',
      });

      const enrolled = events('identity.enrolled');
      expect(enrolled).toHaveLength(1);
      expect(enrolled[0]?.payload).toMatchObject({
        identityId: identity.id,
        kind: 'person',
        displayName: 'Friend',
        hasCredential: false,
      });
    });

    it('runs a full cognitive cycle for an enrolled caller', async () => {
      // The end-to-end proof that composition worked: twelve stages, no
      // language model, a real database underneath. `completed` is the strict
      // verdict — it means no stage threw and fell back.
      app = buildApp();
      await app.start();

      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      const cycle = await app.runtimeFor(owner).runCycle({
        source: 'text',
        payload: 'kaisi ho?',
        receivedAt: Date.now(),
        identityId: owner.id,
      });

      expect(cycle.status).toBe('completed');
      expect(cycle.stages).toHaveLength(12);

      const persisted = db.raw
        .prepare(`SELECT id, status FROM cycle_record WHERE id = ?`)
        .get(cycle.id) as { id: string; status: string } | undefined;
      expect(persisted?.status).toBe('completed');
    });

    it('gives every caller their own runtime rather than sharing one identity', async () => {
      app = buildApp();
      const a = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'A' });
      const b = await app.identityRepo.createIdentity({ kind: 'guest', displayName: 'B' });

      // Stages 6 and 7 authorize against the identity the runtime was built
      // with. One process-wide runtime would have to carry somebody's identity,
      // and it would be the wrong somebody.
      expect(app.runtimeFor(a)).not.toBe(app.runtimeFor(b));
    });

    it('shares one database across every subsystem', async () => {
      app = buildApp();
      await app.start();

      // The split-brain failure this guards against is silent: a subsystem
      // constructed without a database opens its own empty in-memory one, and
      // her memories get written to a copy nobody reads. So the assertion is
      // that a write through a subsystem is visible on the test's own handle.
      expect(app.db).toBe(db);
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });
      const conversation = app.conversations.open(owner.id);

      const row = db.raw
        .prepare(`SELECT identity_id FROM conversation WHERE id = ?`)
        .get(conversation.id) as { identity_id: string } | undefined;
      expect(row?.identity_id).toBe(owner.id);
      expect(app.memoryRepo.listEpisodic(owner.id)).toEqual([]);
    });

    it('opens a conversation for a cycle that does not name one', async () => {
      // `cycle_record.conversation_id` is a foreign key, and the runtime used to
      // fall back to the string 'unknown' — which no conversation can ever be.
      app = buildApp();
      await app.start();
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      expect(app.conversations.listForIdentity(owner.id)).toHaveLength(0);

      const first = await app.runtimeFor(owner).runCycle({
        source: 'text',
        payload: 'hello',
        receivedAt: Date.now(),
        identityId: owner.id,
      });
      const opened = app.conversations.listForIdentity(owner.id);
      expect(opened).toHaveLength(1);

      // A second message continues the same conversation rather than starting a
      // new one — she is not meeting you again every time you speak.
      await app.runtimeFor(owner).runCycle({
        source: 'text',
        payload: 'and again',
        receivedAt: Date.now(),
        identityId: owner.id,
      });
      expect(app.conversations.listForIdentity(owner.id)).toHaveLength(1);

      const cycles = db.raw
        .prepare(`SELECT conversation_id FROM cycle_record`)
        .all() as { conversation_id: string }[];
      expect(cycles).toHaveLength(2);
      expect(new Set(cycles.map((c) => c.conversation_id))).toEqual(
        new Set([opened[0]?.id]),
      );
      expect(first.status).toBe('completed');
    });
  });
});
