import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { IdentityRepository, DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { MemoryRetrieval } from '@server/memory/retrieval.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { perceive } from '@server/cognition/stages/1.js';
import { identify } from '@server/cognition/stages/2.js';
import { recall } from '@server/cognition/stages/3.js';
import { understand } from '@server/cognition/stages/4.js';
import { reason } from '@server/cognition/stages/5.js';
import { decide } from '@server/cognition/stages/6.js';
import type { Identity, IdentityKind, IdentityStatus } from '@server/identity/types.js';
import type { MemoryProvenance } from '@server/memory/types.js';
import type {
  RawStimulus,
  IdentifiedStimulus,
  RecalledContext,
  UnderstandingProposal,
  ReasoningTraceProposal,
  DecisionProposal,
} from '@server/cognition/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

const hello: RawStimulus = {
  source: 'text',
  payload: { text: 'Hello' },
  receivedAt: 1700000000000,
  identityId: 'ident-1',
  conversationId: 'conv-1',
};

function identifiedOf(overrides: Partial<IdentifiedStimulus> = {}): IdentifiedStimulus {
  return {
    ...hello,
    identityKind: 'guest',
    callerPermissions: DEFAULT_PERMISSIONS.guest,
    inputType: 'user_message',
    ...overrides,
  };
}

function seedIdentity(
  db: Database,
  id: string,
  kind: IdentityKind,
  displayName: string,
  status: IdentityStatus,
): void {
  db.raw
    .prepare(
      `INSERT INTO identity (id, kind, display_name, status)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, kind, displayName, status);
  db.raw
    .prepare(
      `INSERT INTO permission (identity_id, version, json)
       VALUES (?, 1, ?)`,
    )
    .run(id, JSON.stringify(DEFAULT_PERMISSIONS[kind]));
}

const dummyProvenance: MemoryProvenance = {
  sourceCycleId: 'cycle-0',
  sourceConversationId: 'conv-1',
  sourceMessageIds: ['msg-1'],
  extractedAt: 1700000000000,
  extractor: 'rule',
  confidence: 1,
  validatedBy: 'auto_policy',
};

function contextOf(stimulus: IdentifiedStimulus = identifiedOf()): RecalledContext {
  return {
    stimulus,
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    retrievedAt: 1700000000000,
  };
}

describe('Phase P08: Stages 1-6 (PERCEIVE..DECIDE)', () => {
  let db: Database;
  let identityRepo: IdentityRepository;
  let owner: Identity;
  let guest: Identity;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);
    identityRepo = new IdentityRepository(db);

    seedIdentity(db, 'ident-1', 'guest', 'Guest User', 'active');
    seedIdentity(db, 'owner-1', 'owner', 'Owner', 'active');
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-1', 'ident-1')`).run();

    guest = {
      id: 'ident-1',
      kind: 'guest',
      displayName: 'Guest User',
      permissions: DEFAULT_PERMISSIONS.guest,
      enrolledAt: 1700000000000,
      lastSeenAt: 1700000000000,
      status: 'active',
    };
    owner = {
      id: 'owner-1',
      kind: 'owner',
      displayName: 'Owner',
      permissions: DEFAULT_PERMISSIONS.owner,
      enrolledAt: 1700000000000,
      lastSeenAt: 1700000000000,
      status: 'active',
    };
  });

  // ── Stage 1: PERCEIVE ──

  describe('Stage 1 PERCEIVE', () => {
    it('normalizes a stimulus and preserves the payload', () => {
      const out = perceive(hello);
      expect(out.source).toBe('text');
      expect(out.payload).toEqual({ text: 'Hello' });
      expect(out.receivedAt).toBe(1700000000000);
      expect(out.identityId).toBe('ident-1');
      expect(out.conversationId).toBe('conv-1');
    });

    it('fills a missing receivedAt with the current time', () => {
      const before = Date.now();
      const out = perceive({ ...hello, receivedAt: 0 });
      expect(out.receivedAt).toBeGreaterThanOrEqual(before);
    });

    it('defaults a missing payload to an empty object', () => {
      const out = perceive({ ...hello, payload: undefined });
      expect(out.payload).toEqual({});
    });

    it('rejects a stimulus with no source', () => {
      expect(() => perceive({ ...hello, source: undefined as unknown as 'text' })).toThrow(
        /source is required/,
      );
    });

    it('rejects a stimulus with no identityId', () => {
      expect(() => perceive({ ...hello, identityId: '' })).toThrow(/identityId is required/);
    });
  });

  // ── Stage 2: IDENTIFY ──

  describe('Stage 2 IDENTIFY', () => {
    it('resolves a known active identity and attaches its permissions', () => {
      const out = identify(hello, identityRepo);
      expect(out.identityKind).toBe('guest');
      expect(out.callerPermissions).toEqual(DEFAULT_PERMISSIONS.guest);
      expect(out.attachedContext).toContain('Guest User');
      expect(out.attachedContext).not.toContain('unauthenticated');
    });

    it('falls back to guest clearance when no identity store is wired', () => {
      const out = identify(hello);
      expect(out.identityKind).toBe('guest');
      expect(out.callerPermissions).toEqual(DEFAULT_PERMISSIONS.guest);
      expect(out.attachedContext).toContain('unauthenticated');
    });

    it('downgrades an unknown identity to guest rather than trusting it', () => {
      const out = identify({ ...hello, identityId: 'does-not-exist' }, identityRepo);
      expect(out.identityKind).toBe('guest');
      expect(out.callerPermissions.mayTriggerActions).toBe('none');
    });

    it('downgrades a revoked identity to guest (auth never fails open)', () => {
      seedIdentity(db, 'rev-1', 'owner', 'Revoked Owner', 'revoked');
      const out = identify({ ...hello, identityId: 'rev-1' }, identityRepo);
      expect(out.identityKind).toBe('guest');
      expect(out.callerPermissions.mayAccessTools).toEqual([]);
    });

    it('classifies the input type from the stimulus source', () => {
      expect(identify({ ...hello, source: 'text' }).inputType).toBe('user_message');
      expect(identify({ ...hello, source: 'audio' }).inputType).toBe('user_message');
      expect(identify({ ...hello, source: 'system' }).inputType).toBe('system_event');
      expect(identify({ ...hello, source: 'proactive' }).inputType).toBe('proactive_trigger');
    });
  });

  // ── Stage 3: RECALL ──

  describe('Stage 3 RECALL', () => {
    it('returns an empty working context when no retrieval service is wired', async () => {
      const ctx = await recall(identifiedOf());
      expect(ctx.episodic).toEqual([]);
      expect(ctx.semantic).toEqual([]);
      expect(ctx.preferences).toEqual([]);
      expect(ctx.stimulus.identityId).toBe('ident-1');
    });

    it('buckets retrieved items into their memory domains', async () => {
      const memRepo = new MemoryRepository(db);
      memRepo.createEpisodic({
        identityId: 'ident-1',
        subjectKind: 'guest', provenance: dummyProvenance,
        sensitivity: 'public',
        confidence: 0.9,
        sourceKind: 'conversation',
        summary: 'Said hello to Madhurita',
        occurredAt: Date.now(),
        importance: 0.7,
      });
      memRepo.createPreference({
        identityId: 'ident-1',
        subjectKind: 'guest', provenance: dummyProvenance,
        sensitivity: 'public',
        confidence: 0.9,
        sourceKind: 'conversation',
        key: 'greeting',
        value: 'Hello',
        statedAt: Date.now(),
      });

      const ctx = await recall(identifiedOf(), new MemoryRetrieval(memRepo));
      expect(ctx.episodic).toHaveLength(1);
      expect(ctx.preferences).toHaveLength(1);
      expect(ctx.episodic[0]?.domain).toBe('episodic');
      expect(ctx.preferences[0]?.domain).toBe('preference');
    });

    it('enforces identity isolation: a guest never recalls owner memories', async () => {
      const memRepo = new MemoryRepository(db);
      memRepo.createEpisodic({
        identityId: 'owner-1',
        subjectKind: 'owner', provenance: dummyProvenance,
        sensitivity: 'owner_only',
        confidence: 1,
        sourceKind: 'conversation',
        summary: 'Owner private matter',
        occurredAt: Date.now(),
        importance: 1,
      });

      const ctx = await recall(identifiedOf(), new MemoryRetrieval(memRepo));
      expect(ctx.episodic).toEqual([]);
    });
  });

  // ── Stage 4: UNDERSTAND ──

  describe('Stage 4 UNDERSTAND', () => {
    it('proposes a well-formed understanding for a plain greeting', async () => {
      const u = await understand(contextOf());
      expect(u.intent).toBe('respond');
      expect(u.confidence).toBeGreaterThan(0);
      expect(u.disambiguationNeeded).toBe(false);
      expect(u.clarifyingQuestions).toEqual([]);
    });

    it('asks for clarification when the payload carries no text', async () => {
      const u = await understand(contextOf(identifiedOf({ payload: {} })));
      expect(u.disambiguationNeeded).toBe(true);
      expect(u.clarifyingQuestions.length).toBeGreaterThan(0);
      expect(u.confidence).toBe(0);
    });

    it('rejects an unrecognized intent proposed by the LLM faculty', async () => {
      const u = await understand(contextOf(), {
        llm: {
          proposeUnderstanding: async () =>
            ({ intent: 'exfiltrate_everything', confidence: 1 }) as unknown as UnderstandingProposal,
        },
      });
      expect(u.intent).toBe('clarify');
      expect(u.confidence).toBe(0);
      expect(u.disambiguationNeeded).toBe(true);
    });

    it('clamps an out-of-range confidence from the LLM faculty', async () => {
      const u = await understand(contextOf(), {
        llm: {
          proposeUnderstanding: async () =>
            ({
              intent: 'respond',
              confidence: 42,
              disambiguationNeeded: false,
              clarifyingQuestions: [],
              entities: {},
            }) as UnderstandingProposal,
        },
      });
      expect(u.confidence).toBe(0);
    });

    // LLM-stage property test: whatever the faculty returns, the admitted
    // proposal always satisfies the UnderstandingProposal shape.
    it('always yields a shape-valid proposal for arbitrary faculty output', async () => {
      const garbage: unknown[] = [
        null,
        undefined,
        {},
        { intent: 42 },
        { intent: 'respond', confidence: 'high' },
        { intent: 'respond', confidence: 0.5, clarifyingQuestions: 'nope' },
        { intent: 'respond', confidence: 0.5, entities: 'nope' },
        [],
        'a string',
      ];

      for (const g of garbage) {
        const u = await understand(contextOf(), {
          llm: { proposeUnderstanding: async () => g as UnderstandingProposal },
        });
        expect(typeof u.intent).toBe('string');
        expect(u.intent.length).toBeGreaterThan(0);
        expect(typeof u.confidence).toBe('number');
        expect(u.confidence).toBeGreaterThanOrEqual(0);
        expect(u.confidence).toBeLessThanOrEqual(1);
        expect(typeof u.disambiguationNeeded).toBe('boolean');
        expect(Array.isArray(u.clarifyingQuestions)).toBe(true);
        expect(typeof u.entities).toBe('object');
        expect(u.entities).not.toBeNull();
      }
    });
  });

  // ── Stage 5: REASON ──

  describe('Stage 5 REASON', () => {
    it('builds a trace whose recommendation follows the understood intent', async () => {
      const u = await understand(contextOf());
      const t = await reason(contextOf(), u);
      expect(t.recommendedApproach).toBe('respond');
      expect(t.steps.length).toBeGreaterThan(0);
      expect(t.optionsConsidered).toContain('respond');
    });

    it('carries a clarify intent through to a clarify recommendation', async () => {
      const t = await reason(contextOf(), {
        intent: 'clarify',
        confidence: 0.2,
        disambiguationNeeded: true,
        clarifyingQuestions: ['What do you mean?'],
        entities: {},
      });
      expect(t.recommendedApproach).toBe('clarify');
    });

    it('reports the size of the recalled working context in the trace', async () => {
      const ctx = contextOf();
      ctx.preferences.push({
        id: 'p1',
        domain: 'preference',
        identityId: 'ident-1',
        subjectKind: 'guest',
        sensitivity: 'public',
        confidence: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      const t = await reason(ctx, await understand(ctx));
      expect(t.steps.some((s) => s.description.includes('1 preference'))).toBe(true);
    });

    // LLM-stage property test.
    it('always yields a shape-valid trace for arbitrary faculty output', async () => {
      const garbage: unknown[] = [
        null,
        {},
        { steps: 'nope' },
        { steps: [] },
        { steps: [{ description: 'd' }] },
        { steps: [{ description: 'd', conclusion: 'c', confidence: 99 }] },
        { steps: [{ description: 'd', conclusion: 'c', confidence: -5 }], recommendedApproach: 7 },
      ];

      for (const g of garbage) {
        const t = await reason(contextOf(), await understand(contextOf()), {
          llm: { proposeReasoning: async () => g as ReasoningTraceProposal },
        });
        expect(Array.isArray(t.steps)).toBe(true);
        expect(t.steps.length).toBeGreaterThan(0);
        for (const s of t.steps) {
          expect(typeof s.description).toBe('string');
          expect(typeof s.conclusion).toBe('string');
          expect(s.confidence).toBeGreaterThanOrEqual(0);
          expect(s.confidence).toBeLessThanOrEqual(1);
        }
        expect(Array.isArray(t.optionsConsidered)).toBe(true);
        expect(typeof t.recommendedApproach).toBe('string');
        expect(t.recommendedApproach.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Stage 6: DECIDE ──

  describe('Stage 6 DECIDE', () => {
    const respondTrace: ReasoningTraceProposal = {
      steps: [{ description: 'greeting', conclusion: 'respond', confidence: 0.6 }],
      optionsConsidered: ['respond'],
      recommendedApproach: 'respond',
    };

    it('authorizes a plain response without requiring elevated clearance', async () => {
      const d = await decide(respondTrace, identifiedOf(), { identity: guest });
      expect(d.proposal.action).toBe('respond');
      expect(d.authorized).toBe(true);
      // `not_required`, not "checked". Nothing was checked: `mapToAuthz` returns
      // null for `respond`, so `check()` is never called on this path — and this
      // is the path every cycle that produces language takes. The field it
      // replaces claimed `clearanceChecked: true` right here.
      expect(d.clearance).toEqual({ kind: 'not_required' });
      expect(d.refusedProposal).toBeUndefined();
    });

    it('authorizes a response even with no identity, since none is needed', async () => {
      const d = await decide(respondTrace, identifiedOf());
      expect(d.authorized).toBe(true);
      expect(d.proposal.action).toBe('respond');
    });

    it('says why it cannot run a tool with no faculty, instead of blaming a model', async () => {
      // The heuristic path used to propose `execute_tool` with no `toolId`, which
      // `validateProposal` rewrote to clarify with the rationale "Tool execution
      // proposed without a toolId". That string is durable — it lands in
      // `CycleRecord` — and it describes a model returning a malformed proposal
      // when there is no model in the cycle at all. Choosing a tool means choosing
      // its arguments, and nothing deterministic here can read those out of a
      // sentence, so the honest answer is clarify for that stated reason.
      const executeTrace: ReasoningTraceProposal = {
        steps: [{ description: 'reminder asked for', conclusion: 'execute', confidence: 0.6 }],
        optionsConsidered: ['execute'],
        recommendedApproach: 'execute',
      };
      const d = await decide(executeTrace, identifiedOf({ identityKind: 'owner' }), {
        identity: owner,
      });
      expect(d.proposal.action).toBe('clarify');
      expect(d.proposal.toolId).toBeUndefined();
      expect(d.proposal.rationale).toContain('language faculty');
      expect(d.proposal.rationale).not.toContain('without a toolId');
      // Not a refusal: nothing was proposed for authorization to turn down.
      expect(d.refusedProposal).toBeUndefined();
      expect(d.authorized).toBe(true);
    });

    it('refuses a guest tool execution and forces a clarify fallback', async () => {
      const d = await decide(respondTrace, identifiedOf(), {
        identity: guest,
        llm: {
          proposeDecision: async () => ({
            action: 'execute_tool',
            toolId: 'shell',
            toolInput: { cmd: 'rm -rf /' },
            rationale: 'user asked',
          }),
        },
      });
      expect(d.authorized).toBe(false);
      expect(d.proposal.action).toBe('clarify');
      expect(d.proposal.toolId).toBeUndefined();
      expect(d.clearance.kind).toBe('denied');
      expect(d.reason).toMatch(/disabled|not in allowed/i);

      // The refusal has to leave a trace of what was refused. `proposal` holds the
      // fallback, so without this the one record of what she wanted to do — and
      // for an unprompted cycle, the only evidence the gate did anything at all —
      // is discarded by the stage that refused it.
      expect(d.refusedProposal).toEqual({
        action: 'execute_tool',
        toolId: 'shell',
        toolInput: { cmd: 'rm -rf /' },
        rationale: 'user asked',
      });
      // And the clearance names what was actually checked, which a boolean could not.
      expect(d.clearance).toMatchObject({ kind: 'denied', action: 'tool:execute' });
    });

    it('reports `unavailable` rather than `denied` when there is no identity to check', async () => {
      // The distinction is load-bearing: `denied` asserts a policy decided
      // something about this caller, and here no policy ran at all. The old
      // boolean said `clearanceChecked: true` on this path, where there was
      // nothing to check against.
      const d = await decide(respondTrace, identifiedOf(), {
        llm: {
          proposeDecision: async () => ({
            action: 'execute_tool',
            toolId: 'weather.get',
            rationale: 'user asked',
          }),
        },
      });
      expect(d.authorized).toBe(false);
      expect(d.clearance).toMatchObject({ kind: 'unavailable', action: 'tool:execute' });
      expect(d.refusedProposal?.toolId).toBe('weather.get');
    });

    it('authorizes the same tool execution for the owner', async () => {
      const d = await decide(respondTrace, identifiedOf({ identityKind: 'owner' }), {
        identity: owner,
        llm: {
          proposeDecision: async () => ({
            action: 'execute_tool',
            toolId: 'weather.get',
            toolInput: { city: 'Delhi' },
            rationale: 'user asked for weather',
          }),
        },
      });
      expect(d.authorized).toBe(true);
      expect(d.proposal.action).toBe('execute_tool');
      expect(d.proposal.toolId).toBe('weather.get');
    });

    it('rejects a tool execution proposed without a toolId', async () => {
      const d = await decide(respondTrace, identifiedOf(), {
        identity: owner,
        llm: {
          proposeDecision: async () =>
            ({ action: 'execute_tool', rationale: 'no tool named' }) as DecisionProposal,
        },
      });
      expect(d.proposal.action).toBe('clarify');
    });

    it('strips a tool call that rides along on a respond decision', async () => {
      const d = await decide(respondTrace, identifiedOf(), {
        identity: owner,
        llm: {
          proposeDecision: async () => ({
            action: 'respond',
            toolId: 'shell',
            toolInput: { cmd: 'whoami' },
            rationale: 'just talking',
          }),
        },
      });
      expect(d.authorized).toBe(true);
      expect(d.proposal.action).toBe('respond');
      expect(d.proposal.toolId).toBeUndefined();
      expect(d.proposal.toolInput).toBeUndefined();
    });

    it('refuses learning to a caller the owner revoked it from, and falls back to clarify', async () => {
      // The refusal used to come from `DEFAULT_PERMISSIONS.guest.mayEnrollNewKnowledge`
      // being `false`, which contradicted Build Book XIII.4 ("Madhurita does **not**
      // implement a blanket 'guests teach nothing' rule") and was enforced nowhere a
      // memory is written. The default is `true` now and the field is honoured in stage
      // 10, so revoking it is a real instruction rather than a decoration — which is
      // what this asks for explicitly.
      const d = await decide(respondTrace, identifiedOf(), {
        identity: {
          ...guest,
          permissions: { ...DEFAULT_PERMISSIONS.guest, mayEnrollNewKnowledge: false },
        },
        llm: {
          proposeDecision: async () =>
            ({
              action: 'learn',
              // Not a field of `DecisionProposal` — a `learningItems` was removed
              // from it because nothing read it. Sent here anyway: a model may
              // still volunteer a field, and the fallback must not carry it.
              learningItems: [{ key: 'owner_secret', value: 'leaked' }],
              rationale: 'noticed a fact',
            }) as unknown as DecisionProposal,
        },
      });
      expect(d.authorized).toBe(false);
      expect(d.proposal.action).toBe('clarify');
      // The refusal fallback is built from scratch rather than edited, so it carries
      // no payload of any kind — including one this type does not declare.
      expect(Object.keys(d.proposal).sort()).toEqual(['action', 'rationale']);
    });

    it('coerces an unrecognized action to respond', async () => {
      const d = await decide(respondTrace, identifiedOf(), {
        identity: guest,
        llm: {
          proposeDecision: async () =>
            ({ action: 'delete_everything', rationale: 'why not' }) as unknown as DecisionProposal,
        },
      });
      expect(d.proposal.action).toBe('respond');
      expect(d.authorized).toBe(true);
    });

    // LLM-stage property test.
    it('always yields a shape-valid AuthorizedDecision for arbitrary faculty output', async () => {
      const garbage: unknown[] = [
        null,
        {},
        { action: 42 },
        { action: 'respond' },
        { action: 'execute_tool' },
        { action: 'learn', learningItems: 'nope' },
        // `schedule_task` was an action once, and stage 9 answered it with "I have
        // put that on the list to take care of" while stage 7 did nothing with it.
        // It is in this list rather than deleted from the file: a model trained on
        // the old prompt may still propose it, and the assertion below is that it
        // now degrades to `respond` instead of promising anything.
        { action: 'schedule_task', taskSpec: { at: 'tomorrow 08:00' } },
        'a string',
        [],
      ];

      for (const g of garbage) {
        const d = await decide(respondTrace, identifiedOf(), {
          identity: guest,
          llm: { proposeDecision: async () => g as DecisionProposal },
        });
        expect(typeof d.proposal.action).toBe('string');
        expect(['respond', 'execute_tool', 'learn', 'noop', 'clarify']).toContain(
          d.proposal.action,
        );
        expect(typeof d.proposal.rationale).toBe('string');
        expect(d.proposal.rationale.length).toBeGreaterThan(0);
        expect(typeof d.authorized).toBe('boolean');
        // Whatever the garbage was, the clearance and the flag agree — the pair is
        // built by one constructor in stage 6 precisely so they cannot disagree.
        expect(['not_required', 'granted', 'denied', 'unavailable']).toContain(d.clearance.kind);
        expect(d.authorized).toBe(
          d.clearance.kind === 'not_required' || d.clearance.kind === 'granted',
        );
        // An unauthorized decision never carries an executable payload.
        if (!d.authorized) {
          expect(d.proposal.toolId).toBeUndefined();
          expect(d.proposal.toolInput).toBeUndefined();
          // …and the refused payload is kept where it cannot be executed from.
          expect(d.refusedProposal).toBeDefined();
        }
      }
    });
  });

  // ── Checkpoint ──

  describe('Checkpoint: a trivial "hello" walks stages 1-6 to a default decision', () => {
    it('runs the cycle and lands on an authorized default respond decision', async () => {
      const runtime = new CognitiveRuntime({ db, identityRepo, identity: guest });
      const cycle = await runtime.runCycle(hello);

      // Stages 1-6 all completed without error.
      const firstSix = cycle.stages.slice(0, 6);
      expect(firstSix.map((s) => s.stageName)).toEqual([
        'PERCEIVE',
        'IDENTIFY',
        'RECALL',
        'UNDERSTAND',
        'REASON',
        'DECIDE',
      ]);
      for (const s of firstSix) {
        expect(s.error).toBeUndefined();
        expect(s.outputJson).toBeDefined();
      }

      // And it landed on the default decision.
      const decision = cycle.authorizedDecision;
      expect(decision?.authorized).toBe(true);
      expect(decision?.proposal.action).toBe('respond');
      expect(cycle.status).toBe('completed');
    });

    it('records the real stage outputs in the persisted traces', async () => {
      const runtime = new CognitiveRuntime({ db, identityRepo, identity: guest });
      const cycle = await runtime.runCycle(hello);

      const rows = db.raw
        .prepare(`SELECT stage, stage_name, output_json FROM stage_trace WHERE cycle_id = ? AND stage <= 6 ORDER BY stage`)
        .all(cycle.id) as Array<{ stage: number; stage_name: string; output_json: string }>;
      expect(rows).toHaveLength(6);

      const identified = JSON.parse(rows[1]!.output_json) as IdentifiedStimulus;
      expect(identified.identityKind).toBe('guest');
      expect(identified.callerPermissions.mayTriggerActions).toBe('none');

      const understanding = JSON.parse(rows[3]!.output_json) as UnderstandingProposal;
      expect(understanding.intent).toBe('respond');

      const decision = JSON.parse(rows[5]!.output_json) as { authorized: boolean };
      expect(decision.authorized).toBe(true);
    });

    it('wires memory retrieval into RECALL when provided', async () => {
      const memRepo = new MemoryRepository(db);
      memRepo.createPreference({
        identityId: 'ident-1',
        subjectKind: 'guest', provenance: dummyProvenance,
        sensitivity: 'public',
        confidence: 1,
        sourceKind: 'conversation',
        key: 'greeting_style',
        value: 'Hello there',
        statedAt: Date.now(),
      });

      const runtime = new CognitiveRuntime({
        db,
        identityRepo,
        identity: guest,
        memoryRetrieval: new MemoryRetrieval(memRepo),
      });
      const cycle = await runtime.runCycle(hello);

      const recallTrace = cycle.stages[2]!;
      const ctx = JSON.parse(recallTrace.outputJson!) as RecalledContext;
      expect(ctx.preferences).toHaveLength(1);
      expect(ctx.preferences[0]?.key).toBe('greeting_style');
    });

    it('still completes all 12 stages with the real stages 1-6 in place', async () => {
      const runtime = new CognitiveRuntime({ db, identityRepo, identity: guest });
      const cycle = await runtime.runCycle(hello);
      expect(cycle.stages).toHaveLength(12);
      expect(cycle.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('completes the cycle even when a stage throws, recording the error', async () => {
      const runtime = new CognitiveRuntime({
        db,
        identityRepo,
        identity: guest,
        understand: {
          llm: {
            proposeUnderstanding: async () => {
              throw new Error('faculty offline');
            },
          },
        },
      });
      const cycle = await runtime.runCycle(hello);

      expect(cycle.stages[3]!.error).toBe('faculty offline');
      expect(cycle.stages).toHaveLength(12);
      // The cycle ran all 12 stages and produced a response, but UNDERSTAND
      // threw and was replaced by its fallback. `degraded` is that outcome:
      // answered, but not cleanly. Reporting 'completed' here would be a claim
      // this test's own first assertion contradicts.
      expect(cycle.status).toBe('degraded');
      expect(cycle.error).toContain('UNDERSTAND: faculty offline');
      // Rollback contract: stages 4-6 degrade to a default decision.
      expect(cycle.authorizedDecision?.proposal.action).toBe('respond');
    });
  });
});
