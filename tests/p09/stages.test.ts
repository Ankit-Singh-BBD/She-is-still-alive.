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
        clearanceChecked: true,
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
        clearanceChecked: true,
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

      const decision: AuthorizedDecision = {
        proposal: {
          action: 'execute_tool',
          toolId: 'admin_wipe',
          rationale: 'Malicious proposal',
        },
        authorized: false,
        reason: 'Denied by authz',
        clearanceChecked: true,
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
        clearanceChecked: true,
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
        clearanceChecked: true,
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
        clearanceChecked: true,
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
      expect(report.preconditionsMet).toBe(true);
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
        { toolId: 'set_temperature', success: true, output: { temp: 72 }, verified: false },
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
        { toolId: 'unlock_door', success: true, output: 'ok', verified: false },
      ];

      const report = await verify(results, { verifiers });
      expect(report.postconditionsMet).toBe(false);
      expect(report.results[0]?.verified).toBe(false);
      expect(report.discrepancies[0]).toContain('Postcondition for \'unlock_door\' did not hold');
    });

    it('flags unverified gap when tool has no registered verifier (silence is not success)', async () => {
      const results: ActionResult[] = [
        { toolId: 'unknown_tool', success: true, output: 'ok', verified: false },
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
        clearanceChecked: true,
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
        clearanceChecked: true,
      };
      const unverifiedResults: ActionResult[] = [
        { toolId: 'lights_set', success: true, verified: false },
      ];
      const verification: VerificationReport = {
        preconditionsMet: true,
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
        clearanceChecked: true,
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
        clearanceChecked: true,
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
      const actRes = (cycle.actionResults as ActionResult[])[0];
      expect(actRes?.toolId).toBe('lock_door');

      expect(cycle.response).toBeDefined();
      const resp = cycle.response as { text: string };
      expect(resp.text).toContain('lock_door');
      expect(resp.text).toContain('checked it');

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
      const actRes = (cycle.actionResults as ActionResult[])[0];
      expect(actRes?.success).toBe(false);
      expect(actRes?.error).toContain('No tool executor is wired');

      // Response safely handles unverified/disabled action and returns text-only without crashing
      const resp = cycle.response as { text: string };
      expect(typeof resp.text).toBe('string');
      expect(resp.text.length).toBeGreaterThan(0);
    });
  });
});
