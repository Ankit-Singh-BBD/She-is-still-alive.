/**
 * Phase P09 Tests — Stages 7-9 (ACT..RESPOND) (M08)
 *
 * Tests per Build Book Part VII.1, Part X.4 (Knowledge Disclosure Policy),
 * Part XI (Action Pipeline & Verification), and P09 block:
 *  - Stage 7: ACT (action call correctness, authz enforcement, bounds/deadlines, refusal on unauthorized/missing executor)
 *  - Stage 8: VERIFY (re-reads authoritative state, asserts postconditions, unverified actions flagged)
 *  - Stage 9: RESPOND (LLM drafting, Knowledge Disclosure Policy, identity isolation, unverified-claim suppression, system-internal redaction, audit collection)
 *  - Full integration / Checkpoint: Action is invoked, response is generated.
 *  - Rollback contract: action disabled, text-only response.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { IdentityRepository } from '@server/identity/repository.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { act, type ToolExecutor } from '@server/cognition/stages/7.js';
import { verify, type VerifierRegistry } from '@server/cognition/stages/8.js';
import { respond, REDACTION } from '@server/cognition/stages/9.js';
import { buildRespondPrompt } from '@server/llm/prompts.js';
import type {
  ActionResult,
  AuthorizedDecision,
  IdentifiedStimulus,
  RawStimulus,
  RecalledContext,
  VerificationReport,
} from '@server/cognition/types.js';

const migrationsDir = resolve(process.cwd(), 'server/persistence/migrations');

function seedIdentity(
  db: Database,
  id: string,
  kind: 'owner' | 'person' | 'guest',
  displayName: string,
  status: 'active' | 'revoked' = 'active',
): void {
  db.raw
    .prepare(
      `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
       VALUES (?, ?, ?, ?, 1700000000000, 1700000000000)`,
    )
    .run(id, kind, displayName, status);
  db.raw
    .prepare(
      `INSERT INTO permission (identity_id, version, json)
       VALUES (?, 1, ?)`,
    )
    .run(id, JSON.stringify(DEFAULT_PERMISSIONS[kind]));
}

function identifiedOf(overrides: Partial<IdentifiedStimulus> = {}): IdentifiedStimulus {
  return {
    source: 'text',
    payload: { text: 'Turn on the lights' },
    receivedAt: 1700000000000,
    identityId: 'owner-1',
    conversationId: 'conv-1',
    identityKind: 'owner',
    callerPermissions: DEFAULT_PERMISSIONS.owner,
    inputType: 'user_message',
    ...overrides,
  };
}

function contextOf(overrides: Partial<RecalledContext> = {}): RecalledContext {
  return {
    stimulus: identifiedOf(),
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    retrievedAt: 1700000000000,
    ...overrides,
  };
}

describe('Phase P09: Stages 7-9 (ACT..RESPOND)', () => {
  let db: Database;
  let identityRepo: IdentityRepository;
  let owner: Identity;
  let guest: Identity;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    identityRepo = new IdentityRepository(db);

    seedIdentity(db, 'owner-1', 'owner', 'Owner User', 'active');
    seedIdentity(db, 'guest-1', 'guest', 'Guest User', 'active');

    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-1', 'owner-1')`).run();
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-guest', 'guest-1')`).run();

    owner = {
      id: 'owner-1',
      kind: 'owner',
      displayName: 'Owner User',
      permissions: DEFAULT_PERMISSIONS.owner,
      enrolledAt: 1700000000000,
      lastSeenAt: 1700000000000,
      status: 'active',
    };

    guest = {
      id: 'guest-1',
      kind: 'guest',
      displayName: 'Guest User',
      permissions: DEFAULT_PERMISSIONS.guest,
      enrolledAt: 1700000000000,
      lastSeenAt: 1700000000000,
      status: 'active',
    };
  });

  // ── Stage 7: ACT ──

  describe('Stage 7 ACT', () => {
    it('is a no-op for non-tool decisions', async () => {
      const decision: AuthorizedDecision = {
        proposal: { action: 'respond', rationale: 'Just respond' },
        authorized: true,
        clearance: { kind: 'not_required' },
      };
      const results = await act(decision, { identity: owner });
      expect(results).toEqual([]);
    });

    it('executes the tool via the wired executor when authorized', async () => {
      const executed: unknown[] = [];
      const executor: ToolExecutor = {
        execute: async (call) => {
          executed.push(call);
          return { status: 'lights_on' };
        },
      };

      const decision: AuthorizedDecision = {
        proposal: {
          action: 'execute_tool',
          toolId: 'lights_set',
          toolInput: { state: 'on' },
          rationale: 'User asked for lights',
        },
        authorized: true,
        clearance: { kind: 'granted', action: 'tool:execute' },
      };

      const results = await act(decision, {
        executor,
        identity: owner,
        cycleId: 'cycle-123',
      });

      expect(executed).toHaveLength(1);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        toolId: 'lights_set',
        success: true,
        output: { status: 'lights_on' },
        verified: false, // Stage 7 never marks verified; only stage 8 can
      });
    });

    it('refuses execution if decision is marked unauthorized', async () => {
      const executor: ToolExecutor = {
        execute: async () => ({ status: 'pwned' }),
      };

      // Deliberately a shape stage 6 would never emit: a refusal keeps the tool
      // call in `refusedProposal` and puts the `clarify` fallback in `proposal`.
      // Stage 7 must still refuse when handed a decision object whose parts
      // disagree, because that is what a bypass of stage 6 would look like.
      const decision: AuthorizedDecision = {
        proposal: {
          action: 'execute_tool',
          toolId: 'admin_wipe',
          rationale: 'Malicious proposal',
        },
        authorized: false,
        reason: 'Denied by authz',
        clearance: { kind: 'denied', action: 'tool:execute', reason: 'Denied by authz' },
      };

      const results = await act(decision, { executor, identity: owner });
      expect(results).toHaveLength(1);
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain('Denied by authz');
    });

    it('enforces defence in depth: re-checks caller permissions at execution boundary', async () => {
      // Guest caller identity with mayTriggerActions: 'none'
      const decision: AuthorizedDecision = {
        proposal: {
          action: 'execute_tool',
          toolId: 'system_reboot',
          rationale: 'Bypassed stage 6 somehow',
        },
        authorized: true, // Claimed authorized in object, but guest identity lacks permission
        clearance: { kind: 'granted', action: 'tool:execute' }, // and claims the check passed
      };

      const executor: ToolExecutor = { execute: async () => ({}) };
      const results = await act(decision, { executor, identity: guest });
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toMatch(/Denied by authorization policy|Action not permitted/);
    });

    it('enforces tool timeout deadline', async () => {
      const hangingExecutor: ToolExecutor = {
        execute: () => new Promise((resolve) => setTimeout(resolve, 500)),
      };

      const decision: AuthorizedDecision = {
        proposal: {
          action: 'execute_tool',
          toolId: 'slow_tool',
          rationale: 'Long running',
        },
        authorized: true,
        clearance: { kind: 'granted', action: 'tool:execute' },
      };

      const results = await act(decision, {
        executor: hangingExecutor,
        identity: owner,
        timeoutMs: 25,
      });

      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain('exceeded its 25ms deadline');
    });

    it('records refusal when no executor is wired (rollback contract)', async () => {
      const decision: AuthorizedDecision = {
        proposal: { action: 'execute_tool', toolId: 'any_tool', rationale: 'test' },
        authorized: true,
        clearance: { kind: 'granted', action: 'tool:execute' },
      };

      const results = await act(decision, { identity: owner });
      expect(results[0]?.success).toBe(false);
      expect(results[0]?.error).toContain('No tool executor is wired');
    });
  });

  // ── Stage 8: VERIFY ──

  describe('Stage 8 VERIFY', () => {
    it('returns clean report when results array is empty', async () => {
      const report = await verify([]);
      expect(report.postconditionsMet).toBe(true);
      expect(report.discrepancies).toEqual([]);
      expect(report.results).toEqual([]);
    });

    it('confirms postconditions when registered verifier asserts state change', async () => {
      let stateChecked = false;
      const verifiers: VerifierRegistry = {
        verifierFor: (toolId) =>
          toolId === 'set_temperature'
            ? {
                verify: (_res, _ctx) => {
                  stateChecked = true;
                  return true;
                },
              }
            : undefined,
      };

      const results: ActionResult[] = [
        { toolId: 'set_temperature', attempted: true, success: true, output: { temp: 72 }, verified: false },
      ];

      const report = await verify(results, { verifiers, db });
      expect(stateChecked).toBe(true);
      expect(report.postconditionsMet).toBe(true);
      expect(report.results[0]?.verified).toBe(true);
      expect(report.discrepancies).toEqual([]);
    });

    it('rejects unverified action when verifier detects postcondition failure', async () => {
      const verifiers: VerifierRegistry = {
        verifierFor: () => ({
          verify: () => false, // Re-read state shows condition not met
        }),
      };

      const results: ActionResult[] = [
        { toolId: 'unlock_door', attempted: true, success: true, output: 'ok', verified: false },
      ];

      const report = await verify(results, { verifiers });
      expect(report.postconditionsMet).toBe(false);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies[0]).toContain('Postcondition for \'unlock_door\' did not hold');
    });

    it('flags unverified gap when tool has no registered verifier (silence is not success)', async () => {
      const results: ActionResult[] = [
        { toolId: 'unknown_tool', attempted: true, success: true, output: 'ok', verified: false },
      ];

      const report = await verify(results);
      expect(report.postconditionsMet).toBe(false);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies[0]).toContain('No postcondition verifier is registered');
    });
  });

  // ── Stage 9: RESPOND & Knowledge Disclosure Policy ──

  describe('Stage 9 RESPOND & Knowledge Disclosure Policy', () => {
    it('produces deterministic response when no LLM faculty is wired', async () => {
      const ctx = contextOf();
      const decision: AuthorizedDecision = {
        proposal: { action: 'respond', rationale: 'Greeting' },
        authorized: true,
        clearance: { kind: 'not_required' },
      };

      const res = await respond(ctx, decision, [], undefined);
      expect(res.text).toContain('Hello');
      expect(res.redacted).toBe(false);
      expect(res.disclosuresApplied).toContain('knowledge_disclosure_policy');
    });

    it('suppresses unverified claims if action failed verification', async () => {
      const ctx = contextOf();
      const decision: AuthorizedDecision = {
        proposal: { action: 'execute_tool', toolId: 'lights_set', rationale: 'test' },
        authorized: true,
        clearance: { kind: 'granted', action: 'tool:execute' },
      };
      const unverifiedResults: ActionResult[] = [
        { toolId: 'lights_set', attempted: true, success: true, verified: false },
      ];
      const verification: VerificationReport = {
        postconditionsMet: false,
        discrepancies: ['State did not change'],
        results: unverifiedResults,
        recheckedAt: Date.now(),
      };

      // Faculty attempts to draft a claim of success
      const res = await respond(ctx, decision, unverifiedResults, verification, {
        llm: {
          draftResponse: async () => ({
            text: 'I have turned on the lights and it is completely done!',
          }),
        },
      });

      // Knowledge Disclosure Policy must suppress the claim
      expect(res.text).toContain('could not confirm');
      expect(res.redacted).toBe(true);
      expect(res.disclosuresApplied).toContain('unverified_claim_suppression');
    });

    it('redacts owner-only facts from guest-facing responses (Identity Isolation)', async () => {
      const guestStimulus = identifiedOf({
        identityId: 'guest-1',
        identityKind: 'guest',
        callerPermissions: DEFAULT_PERMISSIONS.guest,
      });

      const ctx: RecalledContext = {
        stimulus: guestStimulus,
        episodic: [
          {
            id: 'ep-1',
            domain: 'episodic',
            identityId: 'owner-1',
            subjectKind: 'owner',
            sensitivity: 'owner_only',
            confidence: 1,
            summary: 'Private bank vault code 9988',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        semantic: [],
        preferences: [],
        habits: [],
        relationships: [],
        learnedPatterns: [],
        retrievedAt: Date.now(),
      };

      const decision: AuthorizedDecision = {
        proposal: { action: 'respond', rationale: 'test' },
        authorized: true,
        clearance: { kind: 'not_required' },
      };

      const res = await respond(ctx, decision, [], undefined, {
        llm: {
          draftResponse: async () => ({
            text: 'Here is the private bank vault code 9988 for you.',
          }),
        },
      });

      expect(res.text).not.toContain('9988');
      expect(res.text).not.toContain('Private bank vault code 9988');
      expect(res.redacted).toBe(true);
    });

    it('redacts system internals and SQL patterns', async () => {
      const ctx = contextOf();
      const decision: AuthorizedDecision = {
        proposal: { action: 'respond', rationale: 'test' },
        authorized: true,
        clearance: { kind: 'not_required' },
      };

      const res = await respond(ctx, decision, [], undefined, {
        llm: {
          draftResponse: async () => ({
            text: 'I checked cycle_record and ran SELECT * FROM stage_trace in server/cognition/runtime.ts',
          }),
        },
      });

      expect(res.text).not.toContain('cycle_record');
      expect(res.text).not.toContain('stage_trace');
      expect(res.text).not.toContain('server/cognition/runtime.ts');
      expect(res.text).toContain(REDACTION);
      expect(res.disclosuresApplied).toContain('system_internal_redaction');
    });
  });

  /**
   * ## The claim gate has to read the language she is answered in
   *
   * Suppression works by matching claim words in the finished draft, and for a long
   * time it matched English ones only — in an application whose owner is answered in
   * Hinglish as often as in English. "Main laga diya" is the plainest possible way to
   * assert that a thing is done, and it went straight through: the same defect as a
   * terse variant phrased around the claim words, except that it applied to every
   * sentence in half the languages in use.
   *
   * These cases are about *reach*, so each one drafts a claim that means "it is done"
   * and asserts the honest notice replaced it. The last case is the other half, and
   * the reason the patterns are phrase-based rather than word-based: an ordinary Hindi
   * sentence that claims nothing must survive, or the gate has simply become a filter
   * against Hindi.
   */
  describe('Stage 9 unverified-claim suppression, in both languages', () => {
    const decision: AuthorizedDecision = {
      proposal: { action: 'execute_tool', toolId: 'reminder.schedule', rationale: 'asked for' },
      authorized: true,
      clearance: { kind: 'granted', action: 'tool:execute' },
    };

    /** One action that ran and could not be confirmed — the state the gate is for. */
    const ranButUnconfirmed: ActionResult[] = [
      { toolId: 'reminder.schedule', attempted: true, success: true, verified: false },
    ];

    const report: VerificationReport = {
      postconditionsMet: false,
      discrepancies: ['no row was found for the reminder'],
      results: ranButUnconfirmed,
      recheckedAt: 1700000000000,
    };

    const draftedAs = async (text: string) =>
      respond(contextOf(), decision, ranButUnconfirmed, report, {
        llm: { draftResponse: async () => ({ text }) },
      });

    it.each([
      ['Latin-script, light verb diya', 'Theek hai, main kal ke liye reminder laga diya.'],
      ['Latin-script, kar diya', 'Haan, set kar diya hai.'],
      ['Latin-script, ho gaya', 'Aapka reminder ho gaya.'],
      ['Latin-script, run together', 'Bilkul, hogaya.'],
      ['Devanagari, लगा दिया', 'ठीक है, मैंने कल सुबह का रिमाइंडर लगा दिया।'],
      ['Devanagari, कर दी', 'हाँ, सेट कर दी है।'],
      ['Devanagari, हो गया', 'आपका काम हो गया।'],
    ])('catches a claim in Hinglish (%s)', async (_label, text) => {
      const res = await draftedAs(text);

      expect(res.text).toContain('could not confirm');
      expect(res.redacted).toBe(true);
      expect(res.disclosuresApplied).toContain('unverified_claim_suppression');
    });

    it('leaves an ordinary Hindi sentence that claims nothing alone', async () => {
      // Contains `gaya` and `diya` as ordinary words, in a sentence that asserts no
      // outcome. A pattern matching the light verb alone would replace this with an
      // admission she never needed to make — and worse, would do it only in Hindi.
      const text = 'Woh kal chala gaya tha, aur usne mujhe kuch nahi bataya.';

      const res = await draftedAs(text);

      expect(res.text).toBe(text);
      expect(res.disclosuresApplied).not.toContain('unverified_claim_suppression');
    });

    it('does not fire on a turn where no action ran, in either language', async () => {
      // The documented boundary of this gate, pinned so it is a decision rather than
      // a surprise: with no result to check, a claim word may be her recounting
      // something true from an earlier turn, and this file must not guess. The
      // instruction that covers a zero-action turn is in `buildRespondPrompt`, and
      // `the RESPOND prompt` cases below assert it is there.
      const respondOnly: AuthorizedDecision = {
        proposal: { action: 'respond', rationale: 'answering a question about yesterday' },
        authorized: true,
        clearance: { kind: 'not_required' },
      };
      const text = 'Haan, woh reminder maine kal laga diya tha.';

      const res = await respond(contextOf(), respondOnly, [], undefined, {
        llm: { draftResponse: async () => ({ text }) },
      });

      expect(res.text).toBe(text);
      expect(res.disclosuresApplied).not.toContain('unverified_claim_suppression');
    });

    it('does not fire on a failed report that names no action', async () => {
      // `results` and `verification` reach this stage as two arguments that nothing
      // forces into agreement, so a report can say postconditions failed while naming
      // no action that could have failed them. Stage 8 does not produce that pair —
      // an empty result set yields a clean report — but stage 9 is called directly by
      // the runtime and takes what it is given. Suppressing here would replace a real
      // answer with "I started on that", which on a turn that started nothing is the
      // gate telling its own lie to cover a claim she may not have made.
      const respondOnly: AuthorizedDecision = {
        proposal: { action: 'respond', rationale: 'a question, not an instruction' },
        authorized: true,
        clearance: { kind: 'not_required' },
      };
      const emptyButFailed: VerificationReport = {
        postconditionsMet: false,
        discrepancies: ['a discrepancy about nothing in particular'],
        results: [],
        recheckedAt: 1700000000000,
      };
      const text = 'I have already told you everything I know about it.';

      const res = await respond(contextOf(), respondOnly, [], emptyButFailed, {
        llm: { draftResponse: async () => ({ text }) },
      });

      expect(res.text).toBe(text);
      expect(res.disclosuresApplied).not.toContain('unverified_claim_suppression');
    });
  });

  /**
   * ## The prompt is the gate on a zero-action turn
   *
   * Suppression cannot reach a turn that ran no action, so on those turns the only
   * thing between her and a promise she will not keep is the text of the prompt. That
   * makes these lines load-bearing rather than advisory, and it makes their absence
   * invisible without a test: a prompt that quietly stopped saying "you have not done
   * it" produces answers that read perfectly and are false.
   *
   * The specific failure this pins was live. Asked "kal subah 8 baje doctor ka
   * reminder laga do", she came back having taken no action, and nothing in the prompt
   * required her to admit it — the old line said only that there was "nothing to
   * report as done", which an answer can satisfy while still leaving him believing the
   * reminder is set.
   */
  describe('the RESPOND prompt, on a turn that did nothing', () => {
    const decision: AuthorizedDecision = {
      proposal: { action: 'respond', rationale: 'no tool could carry it' },
      authorized: true,
      clearance: { kind: 'not_required' },
    };

    it('states that nothing changed and requires her to say she has not done it', () => {
      const prompt = buildRespondPrompt({
        recalled: contextOf(),
        decision,
        results: [],
        verification: undefined,
      });

      expect(prompt).toContain('You took no action this turn.');
      expect(prompt).toContain('nothing was scheduled, sent, saved, switched on or set up');
      expect(prompt).toContain('say plainly that you have not done it');
      // The three evasions that are technically not the word "done".
      expect(prompt).toContain('handled, on a list, or coming later');
    });

    it('does not say it on a turn that did something', () => {
      const prompt = buildRespondPrompt({
        recalled: contextOf(),
        decision,
        results: [{ toolId: 'reminder.schedule', attempted: true, success: true, verified: true }],
        verification: undefined,
      });

      // The same lines on a turn that *did* schedule something would be a false
      // statement in the other direction, and she is being asked to speak from this.
      expect(prompt).not.toContain('You took no action this turn.');
      expect(prompt).toContain('ran, and was confirmed against stored state');
    });
  });

  // ── P09 Checkpoint & Rollback Integration ──

  describe('P09 Milestone M08 Checkpoint & Rollback Integration', () => {
    it('checkpoint: Action is invoked, response is generated', async () => {
      let executed = false;
      const executor: ToolExecutor = {
        execute: async () => {
          executed = true;
          return { status: 'door_locked' };
        },
      };

      const verifiers: VerifierRegistry = {
        verifierFor: (t) =>
          t === 'lock_door' ? { verify: () => true } : undefined,
      };

      const runtime = new CognitiveRuntime({
        db,
        identityRepo,
        identity: owner,
        decide: {
          llm: {
            proposeDecision: async () => ({
              action: 'execute_tool',
              toolId: 'lock_door',
              toolInput: {},
              rationale: 'User asked to lock the door',
            }),
          },
        },
        act: { executor },
        verify: { verifiers },
      });

      const stimulus: RawStimulus = {
        source: 'text',
        payload: { text: 'Lock the front door please' },
        receivedAt: Date.now(),
        identityId: 'owner-1',
        conversationId: 'conv-1',
      };

      const cycle = await runtime.runCycle(stimulus);

      expect(cycle.status).toBe('completed');
      expect(executed).toBe(true);
      expect(cycle.actionResults).toHaveLength(1);
      const actRes = cycle.actionResults?.[0];
      expect(actRes?.toolId).toBe('lock_door');

      expect(cycle.response).toBeDefined();
      const resp = cycle.response;
      // The caller is told what happened, not which mechanism did it. `lock_door` is a
      // fixture with no entry in `describeOutcome`, so the generic line answers it — and
      // the generic line is the whole point: an id in the text would be the inside of the
      // machine read out loud, and this assertion used to require one.
      expect(resp?.text).not.toContain('lock_door');
      expect(resp?.text).toContain('checked it');

      // Assert stages 7, 8, 9 completed in traces
      const s7 = cycle.stages.find((s) => s.stage === 7);
      const s8 = cycle.stages.find((s) => s.stage === 8);
      const s9 = cycle.stages.find((s) => s.stage === 9);
      expect(s7?.error).toBeUndefined();
      expect(s8?.error).toBeUndefined();
      expect(s9?.error).toBeUndefined();
    });

    it('rollback contract: action disabled, text-only response', async () => {
      // Runtime with no executor wired
      const runtime = new CognitiveRuntime({
        db,
        identityRepo,
        identity: owner,
        decide: {
          llm: {
            proposeDecision: async () => ({
              action: 'execute_tool',
              toolId: 'music_play',
              rationale: 'Play jazz',
            }),
          },
        },
      });

      const stimulus: RawStimulus = {
        source: 'text',
        payload: { text: 'Play some jazz' },
        receivedAt: Date.now(),
        identityId: 'owner-1',
        conversationId: 'conv-1',
      };

      const cycle = await runtime.runCycle(stimulus);

      expect(cycle.status).toBe('completed');
      const actRes = cycle.actionResults?.[0];
      expect(actRes?.success).toBe(false);
      expect(actRes?.error).toContain('No tool executor is wired');

      // Response safely handles unverified/disabled action and returns text-only without crashing
      expect(typeof cycle.response?.text).toBe('string');
      expect(cycle.response?.text.length).toBeGreaterThan(0);
    });
  });
});
