/**
 * The conversation transcript: written by stage 12, read by stage 3.
 *
 * The `message` table shipped in migration `0003_domain.sql` and, until the work
 * these tests cover, nothing in the repository wrote to it or read from it. So
 * the regressions guarded here are not hypothetical — they are the state the
 * code was actually in:
 *
 *   - she could not see the previous turn of the conversation she was in;
 *   - `CycleRecord.conversationId` reported `'unknown'` for any stimulus that did
 *     not name a conversation, which is what stage 10 then wrote into provenance;
 *   - `ConversationRepository.ensure` handed a caller a conversation owned by
 *     someone else, which was bookkeeping noise before a transcript existed and a
 *     disclosure hole the moment one did.
 *
 * The transcript is the least redacted thing about a conversation — plain words,
 * with no sensitivity column to filter on — so the scoping tests below are the
 * load-bearing ones.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { ConversationRepository } from '@server/conversations/repository.js';
import { MessageRepository, appendTurns } from '@server/conversations/messages.js';
import type { TurnDraft } from '@server/conversations/messages.js';
import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { recall } from '@server/cognition/stages/3.js';
import { persist } from '@server/cognition/stages/12.js';
import {
  buildRespondPrompt,
  buildReasonPrompt,
  buildUnderstandPrompt,
} from '@server/llm/prompts.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type {
  AuthorizedDecision,
  AuthorizedResponse,
  IdentifiedStimulus,
  RawStimulus,
  RecalledContext,
  UnderstandingProposal,
} from '@server/cognition/types.js';

const migrationsDir = path.resolve(__dirname, '..', '..', 'server/persistence/migrations');

const OWNER = 'usr_owner_transcript_00000001';
const GUEST = 'usr_guest_transcript_00000001';
const OWNER_CONV = 'conv-owner-transcript';
const GUEST_CONV = 'conv-guest-transcript';

describe('the conversation transcript', () => {
  let db: Database;
  let messages: MessageRepository;
  let conversations: ConversationRepository;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, migrationsDir);

    const identity = db.raw.prepare(
      `INSERT INTO identity (id, kind, display_name, status) VALUES (?, ?, ?, 'active')`,
    );
    identity.run(OWNER, 'owner', 'Owner');
    identity.run(GUEST, 'guest', 'Guest');

    const permission = db.raw.prepare(
      `INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`,
    );
    permission.run(OWNER, JSON.stringify(DEFAULT_PERMISSIONS.owner));
    permission.run(GUEST, JSON.stringify(DEFAULT_PERMISSIONS.guest));

    const conversation = db.raw.prepare(
      `INSERT INTO conversation (id, identity_id) VALUES (?, ?)`,
    );
    conversation.run(OWNER_CONV, OWNER);
    conversation.run(GUEST_CONV, GUEST);

    messages = new MessageRepository(db);
    conversations = new ConversationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  /** An identified stimulus, as stage 3 receives one. */
  function stimulusFor(
    identityId: string,
    conversationId: string | undefined,
    text = 'and the other one?',
  ): IdentifiedStimulus {
    const kind = identityId === OWNER ? 'owner' : 'guest';
    return {
      source: 'text',
      payload: { text },
      receivedAt: Date.now(),
      identityId,
      ...(conversationId === undefined ? {} : { conversationId }),
      identityKind: kind,
      callerPermissions: DEFAULT_PERMISSIONS[kind],
      inputType: 'user_message',
    };
  }

  /** A recalled context with an empty working memory and the given transcript. */
  function contextWith(recentTurns: RecalledContext['recentTurns']): RecalledContext {
    return {
      stimulus: stimulusFor(OWNER, OWNER_CONV),
      episodic: [],
      semantic: [],
      preferences: [],
      habits: [],
      relationships: [],
      learnedPatterns: [],
      ...(recentTurns === undefined ? {} : { recentTurns }),
      retrievedAt: Date.now(),
    };
  }

  describe('appendTurns', () => {
    it('writes the turns it was given and skips a line nobody said', () => {
      const written = appendTurns(db, OWNER_CONV, [
        { role: 'user', text: 'remind me at seven' },
        { role: 'assistant', text: '   ' },
        { role: 'assistant', text: 'seven it is' },
      ]);

      // The return value is rows, not intentions: stage 12 reports it as
      // `turnsWritten`, so an empty line must not inflate the count.
      expect(written.map((turn) => turn.role)).toEqual(['user', 'assistant']);
      expect(written.map((turn) => turn.text)).toEqual(['remind me at seven', 'seven it is']);
      expect(messages.countFor(OWNER_CONV)).toBe(2);
    });

    it('trims the stored text rather than keeping the whitespace it arrived with', () => {
      appendTurns(db, OWNER_CONV, [{ role: 'user', text: '  hello  ' }]);
      const [turn] = messages.recentForCaller(OWNER_CONV, OWNER, 10);
      expect(turn?.text).toBe('hello');
    });

    it('joins an open transaction instead of committing on its own', () => {
      // This is the property stage 12 depends on: the turns must land in the
      // cycle's transaction, so a cycle cannot commit its trace and lose its
      // transcript (or keep a transcript for a cycle that rolled back).
      expect(() =>
        db.raw.transaction(() => {
          appendTurns(db, OWNER_CONV, [{ role: 'user', text: 'this should not survive' }]);
          throw new Error('the rest of the cycle failed');
        })(),
      ).toThrow('the rest of the cycle failed');

      expect(messages.countFor(OWNER_CONV)).toBe(0);
    });

    it('round-trips the metadata and audio reference a voice turn carries', () => {
      messages.append(OWNER_CONV, {
        role: 'user',
        text: 'said out loud',
        audioRef: 'audio/abc.opus',
        metadata: { cycleId: 'cyc-1', source: 'audio' },
      });

      const [turn] = messages.recentForCaller(OWNER_CONV, OWNER, 10);
      expect(turn?.audioRef).toBe('audio/abc.opus');
      expect(turn?.metadata).toEqual({ cycleId: 'cyc-1', source: 'audio' });
    });
  });

  describe('recentForCaller', () => {
    /** Four turns, a second apart, in the order they were said. */
    function seedExchange(conversationId: string): void {
      const base = Date.UTC(2026, 8, 4, 12, 0, 0);
      const drafts: TurnDraft[] = [
        { role: 'user', text: 'first thing', timestamp: base },
        { role: 'assistant', text: 'first answer', timestamp: base + 1000 },
        { role: 'user', text: 'second thing', timestamp: base + 2000 },
        { role: 'assistant', text: 'second answer', timestamp: base + 3000 },
      ];
      appendTurns(db, conversationId, drafts);
    }

    it('returns the exchange oldest first', () => {
      seedExchange(OWNER_CONV);
      const turns = messages.recentForCaller(OWNER_CONV, OWNER, 10);
      expect(turns.map((t) => t.text)).toEqual([
        'first thing',
        'first answer',
        'second thing',
        'second answer',
      ]);
    });

    it('orders two turns of one millisecond by insertion, not by id', () => {
      // Both turns of a cycle can share a millisecond. ULIDs sort randomly
      // inside one, so `rowid` — insertion order — is the tiebreak. Repeated
      // because a regression to `m.id` would pass roughly half the time.
      const at = Date.UTC(2026, 8, 4, 12, 0, 0);
      for (let i = 0; i < 12; i++) {
        const conv = `conv-same-ms-${i}`;
        db.raw
          .prepare(`INSERT INTO conversation (id, identity_id) VALUES (?, ?)`)
          .run(conv, OWNER);
        appendTurns(db, conv, [
          { role: 'user', text: 'asked', timestamp: at },
          { role: 'assistant', text: 'answered', timestamp: at },
        ]);
        expect(messages.recentForCaller(conv, OWNER, 10).map((t) => t.role)).toEqual([
          'user',
          'assistant',
        ]);
      }
    });

    it('keeps the recent end when the limit bites', () => {
      seedExchange(OWNER_CONV);
      const turns = messages.recentForCaller(OWNER_CONV, OWNER, 2);
      expect(turns.map((t) => t.text)).toEqual(['second thing', 'second answer']);
    });

    it('returns nothing rather than another identity\'s words', () => {
      seedExchange(OWNER_CONV);
      // The guest names the owner's conversation. The read is scoped by the
      // conversation's own identity_id, so this is empty rather than private.
      expect(messages.recentForCaller(OWNER_CONV, GUEST, 10)).toEqual([]);
      expect(messages.recentForCaller(GUEST_CONV, OWNER, 10)).toEqual([]);
    });

    it('skips a soft-deleted turn and a soft-deleted conversation', () => {
      seedExchange(OWNER_CONV);
      db.raw
        .prepare(`UPDATE message SET deleted_at = ?, deleted_by = ? WHERE text = 'first answer'`)
        .run(new Date().toISOString(), OWNER);
      expect(messages.recentForCaller(OWNER_CONV, OWNER, 10).map((t) => t.text)).toEqual([
        'first thing',
        'second thing',
        'second answer',
      ]);

      db.raw
        .prepare(`UPDATE conversation SET deleted_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), OWNER_CONV);
      expect(messages.recentForCaller(OWNER_CONV, OWNER, 10)).toEqual([]);
    });

    it('reads back the timestamp it stored, in UTC', () => {
      const at = Date.UTC(2026, 8, 4, 12, 0, 0);
      appendTurns(db, OWNER_CONV, [{ role: 'user', text: 'timed', timestamp: at }]);
      const [turn] = messages.recentForCaller(OWNER_CONV, OWNER, 1);
      // Second precision: the column is an ISO string, not a number.
      expect(turn?.timestamp).toBe(at);
    });

    it('asks for nothing when asked for nothing', () => {
      seedExchange(OWNER_CONV);
      expect(messages.recentForCaller(OWNER_CONV, OWNER, 0)).toEqual([]);
    });
  });

  describe('ConversationRepository.ensure', () => {
    it('refuses to hand a caller a conversation owned by someone else', () => {
      // `conversationId` arrives on a stimulus, i.e. from outside. Before a
      // transcript existed a borrowed id only misfiled a cycle; now it would put
      // the owner's own sentences into a guest's prompt.
      expect(() => conversations.ensure(OWNER_CONV, GUEST)).toThrow(/belongs to another identity/);
    });

    it('returns the id for the identity that owns it', () => {
      expect(conversations.ensure(OWNER_CONV, OWNER)).toBe(OWNER_CONV);
    });

    it('opens a conversation under the caller when the id is new', () => {
      expect(conversations.ensure('conv-brand-new', GUEST)).toBe('conv-brand-new');
      const row = db.raw
        .prepare(`SELECT identity_id FROM conversation WHERE id = ?`)
        .get('conv-brand-new') as { identity_id: string } | undefined;
      expect(row?.identity_id).toBe(GUEST);
    });
  });

  describe('stage 3 (RECALL)', () => {
    it('leaves recentTurns undefined when no reader is wired', async () => {
      appendTurns(db, OWNER_CONV, [{ role: 'user', text: 'said earlier' }]);
      const ctx = await recall(stimulusFor(OWNER, OWNER_CONV));
      // Not `[]`: nobody looked, and saying "nothing was said" would have her
      // greet someone in the middle of a conversation.
      expect(ctx.recentTurns).toBeUndefined();
    });

    it('leaves recentTurns undefined when the stimulus names no conversation', async () => {
      const ctx = await recall(stimulusFor(OWNER, undefined), undefined, messages);
      expect(ctx.recentTurns).toBeUndefined();
    });

    it('reports a genuinely first turn as an empty transcript, not as unloaded', async () => {
      const ctx = await recall(stimulusFor(OWNER, OWNER_CONV), undefined, messages);
      expect(ctx.recentTurns).toEqual([]);
    });

    it('loads the turns of this conversation, oldest first', async () => {
      const base = Date.UTC(2026, 8, 4, 9, 0, 0);
      appendTurns(db, OWNER_CONV, [
        { role: 'user', text: 'chai ya coffee?', timestamp: base },
        { role: 'assistant', text: 'chai', timestamp: base + 1000 },
      ]);

      const ctx = await recall(stimulusFor(OWNER, OWNER_CONV), undefined, messages);
      expect(ctx.recentTurns?.map((t) => t.text)).toEqual(['chai ya coffee?', 'chai']);
    });

    it('loads nothing for a caller who does not own the named conversation', async () => {
      appendTurns(db, OWNER_CONV, [{ role: 'user', text: 'owner only' }]);
      const ctx = await recall(stimulusFor(GUEST, OWNER_CONV), undefined, messages);
      // Loaded, and empty — the structural half of the guarantee `ensure` makes
      // loudly, for any caller that reaches stage 3 by another path.
      expect(ctx.recentTurns).toEqual([]);
    });

    it('keeps the transcript even with no memory retrieval wired', async () => {
      appendTurns(db, OWNER_CONV, [{ role: 'user', text: 'still here' }]);
      const ctx = await recall(stimulusFor(OWNER, OWNER_CONV), undefined, messages);
      expect(ctx.semantic).toEqual([]);
      expect(ctx.recentTurns?.map((t) => t.text)).toEqual(['still here']);
    });
  });

  describe('stage 12 (PERSIST)', () => {
    const decision: AuthorizedDecision = {
      proposal: { action: 'respond', rationale: 'a sentence was called for' },
      authorized: true,
      clearanceChecked: true,
    };
    const response: AuthorizedResponse = {
      text: 'chai',
      voiceEnabled: false,
      disclosuresApplied: [],
      redacted: false,
    };

    function persistInputFor(cycleId: string, conversationId: string, turns: TurnDraft[]) {
      return {
        cycleId,
        status: 'completed' as const,
        completedAt: Date.UTC(2026, 8, 4, 9, 0, 1),
        identityId: OWNER,
        conversationId,
        turns,
        actionResults: [],
        decision,
        response,
        learningDelta: undefined,
        updateResult: undefined,
        audit: [
          {
            actorId: OWNER,
            action: 'disclosure:allow',
            resource: 'response',
            decision: 'allowed' as const,
            at: Date.UTC(2026, 8, 4, 9, 0, 1),
          },
        ],
        stages: [],
      };
    }

    function openCycle(cycleId: string, conversationId = OWNER_CONV): void {
      db.raw
        .prepare(
          `INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json)
           VALUES (?, ?, 'running', ?, '{}')`,
        )
        .run(cycleId, conversationId, new Date().toISOString());
    }

    it('writes the cycle turns and reports what it wrote', async () => {
      openCycle('cyc-persist-1');
      const result = await persist(
        persistInputFor('cyc-persist-1', OWNER_CONV, [
          { role: 'user', text: 'chai ya coffee?', timestamp: Date.UTC(2026, 8, 4, 9, 0, 0) },
          { role: 'assistant', text: 'chai', timestamp: Date.UTC(2026, 8, 4, 9, 0, 1) },
        ]),
        { db },
      );

      expect(result.turnsWritten).toBe(2);
      expect(messages.recentForCaller(OWNER_CONV, OWNER, 10).map((t) => t.text)).toEqual([
        'chai ya coffee?',
        'chai',
      ]);
    });

    it('writes only the user turn when stage 9 authorized no response', async () => {
      openCycle('cyc-persist-2');
      const result = await persist(
        persistInputFor('cyc-persist-2', OWNER_CONV, [{ role: 'user', text: 'just this' }]),
        { db },
      );
      expect(result.turnsWritten).toBe(1);
      expect(messages.recentForCaller(OWNER_CONV, OWNER, 10).map((t) => t.role)).toEqual(['user']);
    });

    it('reports turnsWritten 0 with no database', async () => {
      const result = await persist(persistInputFor('cyc-persist-3', OWNER_CONV, []), {});
      expect(result.turnsWritten).toBe(0);
      expect(result.eventsEmitted).toBe(0);
    });

    it('rolls the whole cycle back if the transcript write fails', async () => {
      // A conversation that does not exist violates message.conversation_id's
      // foreign key. The cycle must keep its `running` row rather than commit a
      // closed cycle whose transcript is missing.
      openCycle('cyc-persist-4');
      await expect(
        persist(persistInputFor('cyc-persist-4', 'conv-does-not-exist', [
          { role: 'user', text: 'orphan' },
        ]), { db }),
      ).rejects.toThrow(/FOREIGN KEY/i);

      const row = db.raw
        .prepare(`SELECT status FROM cycle_record WHERE id = ?`)
        .get('cyc-persist-4') as { status: string } | undefined;
      expect(row?.status).toBe('running');

      const audits = db.raw.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };
      expect(audits.n).toBe(0);
      const events = db.raw.prepare(`SELECT COUNT(*) AS n FROM domain_event`).get() as { n: number };
      expect(events.n).toBe(0);
    });
  });

  describe('what the prompts say about the transcript', () => {
    const understanding: UnderstandingProposal = {
      intent: 'respond',
      confidence: 0.8,
      disambiguationNeeded: false,
      clarifyingQuestions: [],
      entities: {},
    };
    const decision: AuthorizedDecision = {
      proposal: { action: 'respond', rationale: 'a sentence was called for' },
      authorized: true,
      clearanceChecked: true,
    };

    /** The same context rendered by all three builders that carry a transcript. */
    function allThree(ctx: RecalledContext): string[] {
      return [
        buildUnderstandPrompt({ stimulus: ctx.stimulus, recalled: ctx }),
        buildReasonPrompt({ stimulus: ctx.stimulus, recalled: ctx, understanding }),
        buildRespondPrompt({ recalled: ctx, decision, results: [], verification: undefined }),
      ];
    }

    it('says the transcript was not loaded rather than that nothing was said', () => {
      for (const prompt of allThree(contextWith(undefined))) {
        expect(prompt).toContain('Earlier in this conversation: not loaded.');
        expect(prompt).toContain('Do not assume this is the first thing said.');
      }
    });

    it('says plainly when this really is the first thing said', () => {
      for (const prompt of allThree(contextWith([]))) {
        expect(prompt).toContain('this is the first thing said');
      }
    });

    it('renders the exchange oldest first, marking her own turns as hers', () => {
      const ctx = contextWith([
        {
          id: 'm1',
          conversationId: OWNER_CONV,
          role: 'user',
          text: 'chai ya coffee?',
          timestamp: 1,
        },
        { id: 'm2', conversationId: OWNER_CONV, role: 'assistant', text: 'chai', timestamp: 2 },
      ]);

      for (const prompt of allThree(ctx)) {
        expect(prompt).toContain('Earlier in this conversation, oldest first:');
        expect(prompt).toContain('- them: chai ya coffee?');
        expect(prompt).toContain('- you: chai');
        expect(prompt.indexOf('- them: chai ya coffee?')).toBeLessThan(prompt.indexOf('- you: chai'));
      }
    });

    it('says how many turns it dropped when the render is trimmed', () => {
      const turns = Array.from({ length: 14 }, (_, i) => ({
        id: `m${i}`,
        conversationId: OWNER_CONV,
        role: 'user' as const,
        text: `line ${i}`,
        timestamp: i,
      }));
      const prompt = buildUnderstandPrompt({
        stimulus: stimulusFor(OWNER, OWNER_CONV),
        recalled: contextWith(turns),
      });

      expect(prompt).toContain('the last 10 of 14 turns');
      expect(prompt).toContain('- them: line 13');
      expect(prompt).not.toContain('- them: line 3');
    });

    it('bounds one line so an old paste cannot crowd out the current sentence', () => {
      const long = 'x'.repeat(500);
      const prompt = buildUnderstandPrompt({
        stimulus: stimulusFor(OWNER, OWNER_CONV),
        recalled: contextWith([
          { id: 'm1', conversationId: OWNER_CONV, role: 'user', text: long, timestamp: 1 },
        ]),
      });

      expect(prompt).toContain(`- them: ${'x'.repeat(200)}…`);
      expect(prompt).not.toContain('x'.repeat(201));
    });
  });

  describe('a whole cycle', () => {
    function runtimeWithTranscript(): CognitiveRuntime {
      return new CognitiveRuntime({ db, conversations, transcript: messages });
    }

    function textStimulus(text: string): RawStimulus {
      return {
        source: 'text',
        payload: { text },
        receivedAt: Date.now(),
        identityId: OWNER,
        conversationId: OWNER_CONV,
      };
    }

    it('writes both turns of a cycle, and the next cycle can see them', async () => {
      const runtime = runtimeWithTranscript();

      const first = await runtime.runCycle(textStimulus('chai ya coffee?'));
      expect(first.status).toBe('completed');

      const afterFirst = messages.recentForCaller(OWNER_CONV, OWNER, 10);
      expect(afterFirst.map((t) => t.role)).toEqual(['user', 'assistant']);
      expect(afterFirst[0]?.text).toBe('chai ya coffee?');
      expect(afterFirst[1]?.text.length).toBeGreaterThan(0);

      const second = await runtime.runCycle(textStimulus('aur doosra?'));
      expect(second.status).toBe('completed');

      // The proof that stage 3 actually loaded it: the RECALL trace of the
      // second cycle carries the first cycle's words.
      const trace = db.raw
        .prepare(`SELECT output_json FROM stage_trace WHERE cycle_id = ? AND stage = 3`)
        .get(second.id) as { output_json: string | null } | undefined;
      expect(trace?.output_json).toContain('chai ya coffee?');

      expect(messages.countFor(OWNER_CONV)).toBe(4);
    });

    it('records the real conversation id, never the string "unknown"', async () => {
      // The cycle used to resolve its conversation twice and report `'unknown'`
      // for any stimulus that did not name one, which is what stage 10 then
      // wrote into the provenance of everything learned in that cycle.
      const runtime = runtimeWithTranscript();
      const cycle = await runtime.runCycle({
        source: 'text',
        payload: { text: 'no conversation named' },
        receivedAt: Date.now(),
        identityId: OWNER,
      });

      expect(cycle.conversationId).not.toBe('unknown');
      // It continued the owner's open conversation rather than opening another,
      // and — the actual regression — the id it reports is the one on the row.
      expect(cycle.conversationId).toBe(OWNER_CONV);
      const row = db.raw
        .prepare(`SELECT conversation_id FROM cycle_record WHERE id = ?`)
        .get(cycle.id) as { conversation_id: string } | undefined;
      expect(row?.conversation_id).toBe(cycle.conversationId);

      // Resolved once, not once per caller: the id used to be resolved in
      // `runCycle` and again in `createCycleRecord`, and `openOrContinue` inserts.
      const opened = db.raw
        .prepare(`SELECT COUNT(*) AS n FROM conversation WHERE identity_id = ?`)
        .get(OWNER) as { n: number };
      expect(opened.n).toBe(1);

      // And the turns of that cycle landed against it.
      expect(messages.recentForCaller(OWNER_CONV, OWNER, 10)[0]?.text).toBe(
        'no conversation named',
      );
    });

    it('writes no user turn for a stimulus that carried no text', async () => {
      // A system trigger has nothing to quote. Serialising its payload would put
      // JSON in her mouth.
      const runtime = runtimeWithTranscript();
      await runtime.runCycle({
        source: 'system',
        payload: { kind: 'tick' },
        receivedAt: Date.now(),
        identityId: OWNER,
        conversationId: OWNER_CONV,
      });

      const roles = messages.recentForCaller(OWNER_CONV, OWNER, 10).map((t) => t.role);
      expect(roles).not.toContain('user');
    });

    it('runs the same twelve stages with a transcript wired as without', async () => {
      const runtime = runtimeWithTranscript();
      const cycle = await runtime.runCycle(textStimulus('hello'));
      expect(cycle.stages).toHaveLength(12);
      expect(cycle.stages.filter((s) => s.error !== undefined)).toEqual([]);
      expect(cycle.status).toBe('completed');
    });
  });
});
