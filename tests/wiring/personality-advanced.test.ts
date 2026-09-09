/**
 * Personality and the advanced faculties, as the production runtime actually
 * wires them.
 *
 * Both subsystems were fully built and completely unreachable. `PersonalityEngine`
 * was constructed in `createApp` and read by nothing; the four advanced modules had
 * a registry, flags, a dispatcher and eleven passing tests, and no cycle ever
 * invoked one. Tests over their internals stayed green throughout — which is why
 * these tests deliberately assert on **committed effects** instead: the sentence
 * that reached the transcript, the register a caller actually got, the config a
 * boot banner would print. Every assertion here fails if the wiring in
 * `server/app.ts` is removed, no matter how healthy the units underneath remain.
 *
 * ## Why the clock is pinned
 *
 * `runtimeFor` feeds the hour into her register, so the same input legitimately
 * produces a shorter, warmer sentence at 2am than at noon. That is the intended
 * behaviour and it would make every assertion below depend on when CI ran. Only
 * `Date` is faked — no timers are intercepted, because these tests drive cycles
 * directly and a faked timer queue would deadlock the real `await`s.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig, describeConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { timeOfDayDeltas } from '@server/personality/index.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

/** Local noon: the one band that contributes nothing, so identity is the only variable. */
const NOON = new Date('2026-09-05T12:00:00');
/** Local late night: `timeOfDayForHour` returns `night` from 19:00 to 05:00. */
const NIGHT = new Date('2026-09-05T23:30:00');

/**
 * A greeting and a distressed greeting.
 *
 * Both must contain a greeting word, because stage 9 picks its bank from what the
 * message *is* before it picks a variant from her register — comparing a greeting
 * against a non-greeting would compare two different banks and prove nothing about
 * tone. `pareshan` carries the valence, `bahut` intensifies it past the actionable
 * floor, and `abhi` supplies the arousal that buys brevity.
 */
const CALM = 'hello';
const CHARGED = 'hello, main bahut pareshan hoon abhi';

describe('Personality and advanced faculties in the production runtime', () => {
  let db: Database;
  let app: MadhuritaApp | undefined;
  let second: MadhuritaApp | undefined;

  const buildApp = (env: Record<string, string> = {}): MadhuritaApp =>
    createApp({
      config: loadConfig(env),
      db,
      installGlobalDatabase: false,
    });

  const say = async (
    instance: MadhuritaApp,
    identityId: string,
    payload: string,
  ): Promise<string> => {
    const identity = instance.identityRepo.getIdentity(identityId);
    if (identity === null) throw new Error('identity vanished');
    const cycle = await instance.runtimeFor(identity).runCycle({
      source: 'text',
      payload,
      receivedAt: Date.now(),
      identityId,
    });
    expect(cycle.status).toBe('completed');
    return cycle.response?.text ?? '';
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOON });
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
  });

  afterEach(async () => {
    await app?.stop();
    await second?.stop();
    app = undefined;
    second = undefined;
    db.close();
    closeDatabase();
    vi.useRealTimers();
  });

  describe('personality reaches the runtime', () => {
    it('derives the baseline from the real identity, not from an authored persona', async () => {
      // The deleted `createPersonalityEngine()` seeded a hand-written sheet for the
      // literal id 'default-owner'. This is the replacement, and the assertion is
      // that the register is traceable to a row in her database: the name carries
      // the identity's own display name and kind, and the numbers come from that
      // kind rather than from a table of characters.
      app = buildApp({ FLAG_PERSONALITY: 'true' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      // Building the runtime is what seeds it — no cycle needed, which is the point:
      // she has a register before the first word is spoken.
      app.runtimeFor(owner);

      const tone = app.personality.profileFor(owner.id);
      expect(tone.name).toContain('Ankit');
      expect(tone.name).toContain('owner');
      expect(tone.warmth).toBe(2);
      expect(tone.verbosity).toBe(1);
      expect(tone.formality).toBe(1);
    });

    it('gives a guest a different register than the owner, from kind alone', async () => {
      app = buildApp({ FLAG_PERSONALITY: 'true' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });
      const guest = await app.identityRepo.createIdentity({
        kind: 'guest',
        displayName: 'Stranger',
      });

      app.runtimeFor(owner);
      app.runtimeFor(guest);

      expect(app.personality.profileFor(guest.id).verbosity).toBe(0);
      expect(app.personality.profileFor(guest.id).warmth).toBe(1);
      expect(app.personality.profileFor(owner.id).warmth).toBe(2);
    });

    it('speaks the register: one greeting, two callers, two sentences', async () => {
      // The committed effect. Stage 9 chooses between sentences it already holds,
      // and the choice is made by the register — so the same greeting reaches the
      // transcript differently for the two of them. If `respond: { tone }` were
      // dropped from `runtimeFor`, both would fall to the plain variant and be
      // identical.
      app = buildApp({ FLAG_PERSONALITY: 'true' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });
      const guest = await app.identityRepo.createIdentity({
        kind: 'guest',
        displayName: 'Stranger',
      });

      const toOwner = await say(app, owner.id, CALM);
      const toGuest = await say(app, guest.id, CALM);

      expect(toOwner).not.toBe(toGuest);
      // The guest asked for nothing and gets the short form; the owner's warmth is
      // the one dimension his kind actually raises.
      expect(toGuest.length).toBeLessThan(toOwner.length);
      expect(toOwner.toLowerCase()).toContain('hello');
      expect(toGuest.toLowerCase()).toContain('hello');
    });

    it('is one fixed neutral register for everyone when the flag is off', async () => {
      app = buildApp({ FLAG_PERSONALITY: 'false' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });
      const guest = await app.identityRepo.createIdentity({
        kind: 'guest',
        displayName: 'Stranger',
      });

      app.runtimeFor(owner);
      app.runtimeFor(guest);

      expect(app.personality.profileFor(owner.id)).toMatchObject({
        name: 'Default Neutral',
        verbosity: 1,
        formality: 1,
        warmth: 1,
        sources: [],
      });

      // Off means off in the sentence too, not just in the numbers.
      expect(await say(app, owner.id, CALM)).toBe(await say(app, guest.id, CALM));
    });
  });

  describe('the hour reaches her', () => {
    it('maps each band to deltas, and treats midday as an absence of one', () => {
      // `day` returning `{}` is load-bearing: `noteTimeOfDay` with no deltas
      // *clears* the slot rather than writing a zero, so noon is positive evidence
      // that the night register has passed.
      expect(timeOfDayDeltas('day')).toEqual({});
      expect(timeOfDayDeltas('night')).toEqual({ verbosityDelta: -1, warmthDelta: 1 });
      expect(timeOfDayDeltas('sunrise')).toEqual({ verbosityDelta: -1 });
      expect(timeOfDayDeltas('sunset')).toEqual({ warmthDelta: 1 });
    });

    it('shows the hour in her register at night and not at noon', async () => {
      // `noteTimeOfDay` had no caller in the repository at all — the TTL constant
      // was exported, the slot existed, and nothing ever wrote it. This is the
      // proof that `runtimeFor` now does.
      app = buildApp({ FLAG_PERSONALITY: 'true' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      app.runtimeFor(owner);
      expect(app.personality.profileFor(owner.id).sources).not.toContain('timeOfDay');

      vi.setSystemTime(NIGHT);
      app.runtimeFor(owner);

      const nightTone = app.personality.profileFor(owner.id);
      expect(nightTone.sources).toContain('timeOfDay');
      // Late at night people say less. Warmth was already at its ceiling for an
      // owner, so brevity is the dimension with room to move.
      expect(nightTone.verbosity).toBe(0);
    });
  });

  describe('advanced modules run inside the cycle', () => {
    it('writes what it read at stage 2 into the answer given at stage 9 of the same cycle', async () => {
      // This is the assertion the whole in-cycle change exists for.
      //
      // `AdvancedModuleCognitiveHook` ran the modules over a *finished* record, so
      // an affect reading taken at stage 2 landed after stage 12 had committed and
      // could not reach the stage 9 that had already spoken. She answered in the
      // register of the previous turn, permanently one behind. Under the in-cycle
      // dispatcher the reading lands before stage 9 of the cycle that took it.
      //
      // Same input, same pinned clock, same identity kind, one flag apart — so the
      // difference in the sentence is attributable to the module and nothing else.
      const owner = await buildApp().identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      app = buildApp({ FLAG_PERSONALITY: 'true', FLAG_ADVANCED_MODULES: 'false' });
      const withoutModules = await say(app, owner.id, CHARGED);
      expect(app.personality.profileFor(owner.id).sources).toEqual([]);

      second = buildApp({ FLAG_PERSONALITY: 'true', FLAG_ADVANCED_MODULES: 'true' });
      const withModules = await say(second, owner.id, CHARGED);

      // The module found a personality service to write to — which only happens if
      // `createDefaultAdvancedModuleRegistry` was given real deps.
      expect(second.personality.profileFor(owner.id).sources).toContain('emotion');
      // And the write changed the sentence that this cycle produced.
      expect(withModules).not.toBe(withoutModules);
      expect(withModules.length).toBeLessThan(withoutModules.length);
    });

    it('runs nothing, and writes nothing, while the master flag is off', async () => {
      // The honest off state: the registry is still built and still handed to every
      // runtime, so this proves the flags are consulted rather than the wiring
      // being absent.
      app = buildApp({ FLAG_PERSONALITY: 'true', FLAG_ADVANCED_MODULES: 'false' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      await say(app, owner.id, CHARGED);

      const sources = app.personality.profileFor(owner.id).sources;
      expect(sources).not.toContain('emotion');
      expect(sources).not.toContain('relationship');
    });

    it('leaves the cycle completed when a module has an opinion', async () => {
      // A faculty, not an authority: whatever the modules read, the twelve stages
      // still run and the record still commits. A module that could fail a cycle
      // would be a module that could take her voice away.
      app = buildApp({ FLAG_PERSONALITY: 'true', FLAG_ADVANCED_MODULES: 'true' });
      const owner = await app.identityRepo.createIdentity({
        kind: 'owner',
        displayName: 'Ankit',
      });

      const identity = app.identityRepo.getIdentity(owner.id);
      if (identity === null) throw new Error('identity vanished');
      const cycle = await app.runtimeFor(identity).runCycle({
        source: 'text',
        payload: CHARGED,
        receivedAt: Date.now(),
        identityId: owner.id,
      });

      expect(cycle.status).toBe('completed');
      expect(cycle.stages).toHaveLength(12);

      const turns = db.raw
        .prepare(
          `SELECT m.role, m.text FROM message m
             JOIN conversation c ON c.id = m.conversation_id
            WHERE c.identity_id = ? ORDER BY m.timestamp ASC, m.id ASC`,
        )
        .all(owner.id) as { role: string; text: string }[];
      expect(turns.some((t) => t.role === 'assistant' && t.text.trim() !== '')).toBe(true);
    });
  });

  describe('a fold announces itself', () => {
    /**
     * Two recollections with identical text, which is all `dream.ts` will fold.
     *
     * `provenance` is required and is not decoration here: the surviving row is the
     * oldest, so the one that keeps its `occurredAt` is the one whose provenance
     * points at the cycle that actually learned the thing.
     */
    const remember = (instance: MadhuritaApp, identityId: string, summary: string): string =>
      instance.memoryRepo.createEpisodic({
        identityId,
        summary,
        occurredAt: Date.now(),
        provenance: {
          sourceCycleId: 'cycle-seed',
          sourceConversationId: 'conv-seed',
          sourceMessageIds: [],
          extractedAt: Date.now(),
          extractor: 'rule',
          confidence: 1,
          validatedBy: 'app_rule',
        },
      }).id;

    it('publishes memory.consolidated, and the counts follow it', async () => {
      // 23:30 is inside the default quiet window (22–07). The window is the whole
      // conceit — she tidies her memory when nobody is talking to her — so at noon
      // this test would assert nothing at all.
      vi.setSystemTime(NIGHT);
      app = buildApp({ FLAG_ADVANCED_MODULES: 'true' });
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      remember(app, owner.id, 'she said the lake was frozen');
      const duplicate = remember(app, owner.id, 'she said the lake was frozen');

      const before = app.projector.buildInitial(owner);
      expect(before.memory.episodicCount).toBe(2);
      expect(before.memory.lastConsolidationAt).toBe(0);

      await say(app, owner.id, CALM);

      // The fold itself: the row is intact, and out of the default view.
      expect(app.memoryRepo.getEpisodic(duplicate)?.lifecycleStatus).toBe('consolidated');
      expect(app.memoryRepo.listEpisodic(owner.id).map((m) => m.id)).not.toContain(duplicate);

      // The announcement, read back off the durable log rather than off a spy —
      // `memory.consolidated` was a declared event type with no publisher, and a
      // row in `domain_event` is the only proof that is now false.
      const published = db.raw
        .prepare(`SELECT payload_json FROM domain_event WHERE type = 'memory.consolidated'`)
        .all() as { payload_json: string }[];
      expect(published).toHaveLength(1);
      expect(JSON.parse(published[0]!.payload_json)).toMatchObject({
        folded: 1,
        duplicateGroups: 1,
        foldedIds: [duplicate],
      });

      // And why it had to be published. Stage 12's pass runs after
      // `cycle.completed`, so the recount that event triggers happened while both
      // rows were still retrievable. Without this event nothing else would recount
      // until the next cycle, which during quiet hours may be hours away.
      const after = app.projector.buildInitial(owner);
      expect(after.memory.episodicCount).toBe(1);
      expect(after.memory.lastConsolidationAt).toBeGreaterThan(0);
    });

    it('folds nothing, and announces nothing, outside the quiet window', async () => {
      // Still noon from `beforeEach`. Same duplicates, same flags: the module runs,
      // declines, and says why — which is the module working, not missing.
      app = buildApp({ FLAG_ADVANCED_MODULES: 'true' });
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      remember(app, owner.id, 'she said the lake was frozen');
      const duplicate = remember(app, owner.id, 'she said the lake was frozen');

      await say(app, owner.id, CALM);

      expect(app.memoryRepo.getEpisodic(duplicate)?.lifecycleStatus).toBe('active');
      const published = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM domain_event WHERE type = 'memory.consolidated'`)
        .get() as { n: number };
      expect(published.n).toBe(0);
      expect(app.projector.buildInitial(owner).memory.episodicCount).toBe(2);
    });

    it('leaves a duplicate alone while the dream flag alone is off', async () => {
      vi.setSystemTime(NIGHT);
      app = buildApp({ FLAG_ADVANCED_MODULES: 'true', FLAG_DREAM_CONSOLIDATION: 'false' });
      const owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
      remember(app, owner.id, 'she said the lake was frozen');
      const duplicate = remember(app, owner.id, 'she said the lake was frozen');

      await say(app, owner.id, CALM);

      expect(app.memoryRepo.getEpisodic(duplicate)?.lifecycleStatus).toBe('active');
      expect(app.projector.buildInitial(owner).memory.episodicCount).toBe(2);
    });
  });

  describe('the config never claims more than it does', () => {
    it('reports a module disabled whenever the master switch is off', () => {
      // `describeConfig` prints these at boot. A banner reading `emotionReading` in
      // the enabled list while `FLAG_ADVANCED_MODULES=false` would be the exact
      // defect this project keeps removing: a status nothing honours.
      const off = loadConfig({ FLAG_ADVANCED_MODULES: 'false', FLAG_EMOTION_READING: 'true' });
      expect(off.flags.advancedModules).toBe(false);
      expect(off.flags.emotionReading).toBe(false);
      expect(describeConfig(off)).not.toMatch(/flags on.*emotionReading/);
    });

    it('lets one module be switched off without taking the other three with it', () => {
      const partial = loadConfig({
        FLAG_ADVANCED_MODULES: 'true',
        FLAG_DREAM_CONSOLIDATION: 'false',
      });
      expect(partial.flags.dreamConsolidation).toBe(false);
      expect(partial.flags.emotionReading).toBe(true);
      expect(partial.flags.relationshipContext).toBe(true);
      expect(partial.flags.longHorizonReflection).toBe(true);
    });

    it('has every faculty on by default, and each one switchable off', () => {
      // The Build Book files the advanced four under "opt-in", which was right while
      // they were stubs. They now run inside the cycle and are asserted by their
      // committed effects a few hundred lines above, so an off default ships the flat
      // version of her to an owner with no way to know four more variables existed —
      // the same argument that has always kept personality on.
      const defaults = loadConfig({});
      expect(defaults.flags.advancedModules).toBe(true);
      expect(defaults.flags.emotionReading).toBe(true);
      expect(defaults.flags.relationshipContext).toBe(true);
      expect(defaults.flags.longHorizonReflection).toBe(true);
      expect(defaults.flags.dreamConsolidation).toBe(true);
      expect(defaults.flags.personality).toBe(true);

      // And the escape hatch the two durable-writing ones make necessary: one
      // variable for the subsystem, one per capability.
      expect(loadConfig({ FLAG_ADVANCED_MODULES: 'false' }).flags.emotionReading).toBe(false);
      expect(loadConfig({ FLAG_DREAM_CONSOLIDATION: 'false' }).flags.dreamConsolidation).toBe(
        false,
      );
      expect(loadConfig({ FLAG_DREAM_CONSOLIDATION: 'false' }).flags.emotionReading).toBe(true);
    });
  });
});
