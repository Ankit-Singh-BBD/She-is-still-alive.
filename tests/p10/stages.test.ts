import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { resolve } from 'node:path';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';
import type { PermissionSet } from '@server/identity/types.js';
import { learn } from '@server/cognition/stages/10.js';
import { update } from '@server/cognition/stages/11.js';
import { persist } from '@server/cognition/stages/12.js';
import type {
  IdentifiedStimulus,
  RecalledContext,
  AuthorizedDecision,
  AuthorizedResponse,
  AuditEntry,
} from '@server/cognition/types.js';

describe('Cognitive Loop - Stages 10-12 (LEARN .. PERSIST)', () => {
  let db: Database;
  let memoryRepo: MemoryRepository;
  const ownerId = 'usr_00000000000000000000000001';
  const guestId = 'usr_guest00000000000000000001';

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));

    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', 'Owner', 'active', 0, 0)`).run(ownerId);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(ownerId, JSON.stringify(DEFAULT_PERMISSIONS.owner));
    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'guest', 'Guest', 'active', 0, 0)`).run(guestId);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(guestId, JSON.stringify(DEFAULT_PERMISSIONS.guest));
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv1', ?)`).run(ownerId);
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-guest', ?)`).run(guestId);
    db.raw.prepare(`INSERT INTO cycle_record (id, conversation_id, status, started_at, input_json) VALUES (?, 'conv1', 'running', ?, '{}')`).run('cycle1', new Date().toISOString());

    memoryRepo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeContext(
    identityId: string,
    kind: 'owner' | 'guest',
    payload: string,
    /**
     * What the owner has revoked, if anything. Stage 10 authorizes every candidate
     * against `callerPermissions`, so this is the only way to drive a denial — and it
     * is a field of the stimulus rather than an option, deliberately: an option a
     * caller can forget is how the check became skippable in the first place.
     */
    revoked: Partial<PermissionSet> = {},
  ): RecalledContext {
    const identified: IdentifiedStimulus = {
      source: 'text',
      payload,
      receivedAt: Date.now(),
      identityId,
      conversationId: kind === 'guest' ? 'conv-guest' : 'conv1',
      identityKind: kind,
      callerPermissions: { ...DEFAULT_PERMISSIONS[kind], ...revoked },
      inputType: 'user_message'
    };
    return {
      stimulus: identified,
      episodic: [],
      semantic: [],
      preferences: [],
      habits: [],
      relationships: [],
      learnedPatterns: [],
      retrievedAt: Date.now()
    };
  }

  const defaultDecision: AuthorizedDecision = {
    proposal: { action: 'respond', rationale: 'test' },
    authorized: true,
    clearance: { kind: 'not_required' }
  };
  const defaultResponse: AuthorizedResponse = { text: 'ok', voiceEnabled: false, disclosuresApplied: [], redacted: false };

  describe('Stage 10: LEARN (Scoped Guest Learning Policy)', () => {
    it('extracts Owner explicit preferences via rules (no LLM)', async () => {
      const recalled = makeContext(ownerId, 'owner', 'I prefer dark mode');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      expect(delta.memories.length).toBe(1);
      const mem = delta.memories[0]!;
      expect(mem.domain).toBe('preference');
      // Key is the thing, value is the stance — the same convention `preference.set`
      // writes, so a later reversal overwrites this row instead of contradicting it.
      expect(mem.data['key']).toBe('dark mode');
      expect(mem.data['value']).toBe('likes');
      expect(mem.sensitivity).toBe('person_shared');
      expect(mem.data['identityId']).toBe(ownerId);
      expect(mem.provenance.extractor).toBe('rule');
    });

    it('quarantines Guest observations about Owner (Part XIII.4)', async () => {
      const recalled = makeContext(guestId, 'guest', 'The owner likes spicy food');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      expect(delta.memories.length).toBe(1);
      const mem = delta.memories[0]!;
      expect(mem.domain).toBe('preference');
      expect(mem.data['key']).toBe('spicy food');
      expect(mem.data['value']).toBe('likes');
      expect(mem.data['aboutOwner']).toBe(true);
      // Must map identity back to the guest as it is unverified claim about owner by a guest
      expect(mem.data['identityId']).toBe(guestId);
      expect(mem.provenance.validatedBy).toBe('owner_confirmation');
      /**
       * The three cells that make the quarantine mean something, asserted here because
       * this stage and `LearningPipeline` now read one `decideScope` and these are the
       * cells the two old copies disagreed on. `subjectKind` says who the claim is about
       * (this stage's copy said `guest`, which is who *said* it); `owner_only` is the one
       * sensitivity under which `MemoryRetrieval.isAllowedByPolicy` refuses the guest
       * their own unconfirmed claim back; `archived` keeps it out of ordinary recall until
       * he confirms it, and this stage used to hardcode `'active'` — so the row XIII.4
       * says must wait for him was written as an ordinary live memory.
       */
      expect(mem.subjectKind).toBe('owner');
      expect(mem.sensitivity).toBe('owner_only');
      expect(mem.data['lifecycleStatus']).toBe('archived');
    });

    it('allows Guest to safely declare their own preferences', async () => {
      const recalled = makeContext(guestId, 'guest', 'I love jazz music');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      expect(delta.memories.length).toBe(1);
      const mem = delta.memories[0]!;
      expect(mem.domain).toBe('preference');
      expect(mem.data['key']).toBe('jazz music');
      expect(mem.data['value']).toBe('likes');
      expect(mem.data['aboutOwner']).toBeUndefined();
      // Should be assigned to the guest
      expect(mem.data['identityId']).toBe(guestId);
      expect(mem.provenance.validatedBy).toBe('app_rule');
      // Isolated from the owner, which `person_shared` does and `public` — the value the
      // pipeline's copy of this row used — does not: `public` is the single sensitivity
      // that returns `true` from `isAllowedByPolicy` for any caller.
      expect(mem.sensitivity).toBe('person_shared');
      expect(mem.subjectKind).toBe('guest');
      expect(mem.data['lifecycleStatus']).toBe('active');
    });

    it('holds every extraction to the thresholds, not only a model\'s', async () => {
      // `minConfidence` and `minImportance` are documented as the minimum "for any
      // extraction to be accepted" and were applied to the model's proposals only — so
      // on the configuration the owner actually runs, where there is no model and the
      // rule pass is the whole of stage 10, neither threshold governed anything. That
      // is what made `RuleExtraction.importance` a number seven rule call sites chose
      // and nothing read.
      const recalled = makeContext(ownerId, 'owner', 'mujhe chai pasand hai');

      expect((await learn(recalled, defaultDecision, defaultResponse, [], undefined)).memories).toHaveLength(1);
      // The stance rule scores this 0.8 confident and 0.6 important. Ask for more of
      // either and the same sentence is no longer worth keeping.
      expect(
        (await learn(recalled, defaultDecision, defaultResponse, [], undefined, { minConfidence: 0.9 })).memories,
      ).toHaveLength(0);
      expect(
        (await learn(recalled, defaultDecision, defaultResponse, [], undefined, { minImportance: 0.7 })).memories,
      ).toHaveLength(0);
    });

    it('discards small talk', async () => {
      const recalled = makeContext(ownerId, 'owner', 'Good morning');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);
      expect(delta.memories.length).toBe(0);
    });
  });

  /**
   * Stage 10 asks `authz.check()` before it keeps anything (Build Book V.4).
   *
   * It did not, and the omission was the kind that hides: `mayEnrollNewKnowledge` had
   * exactly one live call site — stage 6, on an `action: 'learn'` proposal — and
   * following that action shows it changes only the fallback *sentence* stage 9 emits.
   * Stage 10 writes memory on every cycle whatever stage 6 decided, so the permission
   * gated phrasing while the writes it names went through unasked. `mayMutatePreferences`
   * had no live site at all.
   *
   * These drive the whole stage with the permission revoked and assert on what comes
   * out, because a test that called `check()` itself would pass just as happily against
   * the version where stage 10 never calls it.
   */
  describe('Stage 10: LEARN authorizes every candidate before keeping it', () => {
    it('keeps nothing when enrolment is revoked', async () => {
      const said = 'I prefer dark mode';
      // Same sentence, same caller, one field different — so the only thing this can be
      // measuring is the permission.
      expect(
        (await learn(makeContext(ownerId, 'owner', said), defaultDecision, defaultResponse, [], undefined))
          .memories,
      ).toHaveLength(1);

      const revoked = makeContext(ownerId, 'owner', said, {
        mayEnrollNewKnowledge: false,
        mayMutatePreferences: false,
      });
      const delta = await learn(revoked, defaultDecision, defaultResponse, [], undefined);
      expect(delta.memories).toHaveLength(0);
      // Through stage 11 as well, because the delta is not the write — stage 11 is. An
      // empty delta reaching an untouched table is what "kept nothing" means.
      expect((await update(delta, { memoryRepo })).applied).toBe(0);
      expect(memoryRepo.listPreferences(ownerId)).toHaveLength(0);
    });

    /**
     * The two permissions are separate grants and stage 10 maps to them by domain:
     * `preference` is the one kind of memory that *overwrites*, so "may change what she
     * believes I want" is revocable without silencing everything else.
     */
    it('drops a preference but keeps an episode when only preferences are revoked', async () => {
      const said = 'nahi, main 7 baje uthta hun';
      const episodeOnly = await learn(
        makeContext(ownerId, 'owner', said, { mayMutatePreferences: false }),
        defaultDecision,
        defaultResponse,
        [],
        undefined,
      );
      expect(episodeOnly.memories.map((m) => m.domain)).toEqual(['episodic']);

      const stance = await learn(
        makeContext(ownerId, 'owner', 'I prefer dark mode', { mayMutatePreferences: false }),
        defaultDecision,
        defaultResponse,
        [],
        undefined,
      );
      expect(stance.memories).toHaveLength(0);

      // And the converse: revoking enrolment alone takes the episode, not the stance.
      const prefOnly = await learn(
        makeContext(ownerId, 'owner', 'I prefer dark mode', { mayEnrollNewKnowledge: false }),
        defaultDecision,
        defaultResponse,
        [],
        undefined,
      );
      expect(prefOnly.memories.map((m) => m.domain)).toEqual(['preference']);
    });

    /**
     * A guest with default permissions keeps their own record — `true` by default, per
     * Build Book XIII.4's opening sentence — and the scope clause in `check()` is what
     * keeps it theirs. The policy assigns the scope first, then authorization asks
     * whether this caller may write *there*, so a guest's quarantined claim about the
     * owner lands under the guest's own id and passes rather than being refused as a
     * write into someone else's memory.
     */
    it('lets a guest keep their own record, including a quarantined claim', async () => {
      const own = await learn(
        makeContext(guestId, 'guest', 'I love jazz music'),
        defaultDecision,
        defaultResponse,
        [],
        undefined,
      );
      expect(own.memories).toHaveLength(1);
      expect(own.memories[0]!.data['identityId']).toBe(guestId);

      const aboutOwner = await learn(
        makeContext(guestId, 'guest', 'The owner likes spicy food'),
        defaultDecision,
        defaultResponse,
        [],
        undefined,
      );
      expect(aboutOwner.memories).toHaveLength(1);
      expect(aboutOwner.memories[0]!.data['identityId']).toBe(guestId);

      // Revoked, the same guest keeps nothing — which is what makes the default a
      // control the owner has rather than a value nothing reads.
      const silenced = await learn(
        makeContext(guestId, 'guest', 'I love jazz music', { mayEnrollNewKnowledge: false, mayMutatePreferences: false }),
        defaultDecision,
        defaultResponse,
        [],
        undefined,
      );
      expect(silenced.memories).toHaveLength(0);
    });
  });

  /**
   * The rule pass is the floor, not a fallback: stage 10 runs it on every cycle and the
   * language faculty above it is optional. So it has to hear the language he actually
   * speaks — in either script — or a Hinglish speaker with no faculty wired learns
   * nothing at all. Each row folds to Roman at the door and is read by the same
   * `readStatedPreference` the recognizer uses, so both halves of the cycle agree.
   */
  describe('Stage 10: LEARN reads Hinglish in both scripts', () => {
    const learned = async (said: string): Promise<Record<string, unknown>[]> => {
      const delta = await learn(makeContext(ownerId, 'owner', said), defaultDecision, defaultResponse, [], undefined);
      return delta.memories.map((m) => ({ domain: m.domain, ...m.data }));
    };

    it('hears a stance in Roman and in Devanagari, both directions', async () => {
      expect(await learned('mujhe chai pasand hai')).toMatchObject([{ domain: 'preference', key: 'chai', value: 'pasand hai' }]);
      expect(await learned('मुझे धनिया पसंद नहीं है')).toMatchObject([{ domain: 'preference', key: 'dhaniya', value: 'pasand nahi' }]);
      expect(await learned('mujhe bheed napasand hai')).toMatchObject([{ domain: 'preference', key: 'bheed', value: 'pasand nahi' }]);
    });

    it('does not discard a dislike as a greeting', async () => {
      // `nahi` contains `hi`. An unbounded substring match on a greeting list therefore
      // threw away every negated Hinglish stance at the last step before storage.
      expect(await learned('mujhe chai pasand nahi hai')).toHaveLength(1);
      expect(await learned('namaste')).toHaveLength(0);
    });

    it('reads the chosen thing and the wanted thing', async () => {
      expect(await learned('mera favourite khana biryani hai')).toMatchObject([{ key: 'khana', value: 'biryani' }]);
      expect(await learned('मेरा फेवरेट खाना बिरयानी है')).toMatchObject([{ key: 'khana', value: 'biryani' }]);
      expect(await learned('मुझे एक नया फोन चाहिए')).toMatchObject([{ key: 'ek naya phon', value: 'wants' }]);
      // `chahiye` also means "should" — an obligation is not a want.
      expect(await learned('mujhe jana chahiye')).toHaveLength(0);
      // And an instruction addressed to her is not a preference either.
      expect(await learned('i want you to remind me at 7')).toHaveLength(0);
    });

    it('reads the sentence a correction opens, not the marker', async () => {
      // The marker comes off before any rule reads the sentence, so the stance is keyed on
      // the thing either way — with the comma he usually types, and without it.
      expect(await learned('nahi, mujhe chai pasand nahi hai')).toMatchObject([{ key: 'chai', value: 'pasand nahi' }]);
      expect(await learned('nahi mujhe chai pasand nahi hai')).toMatchObject([{ key: 'chai', value: 'pasand nahi' }]);
      // Nothing else in this one is readable by a rule, so the sentence is kept as an
      // episode rather than as a standing preference under a fixed `correction` key.
      expect(await learned('nahi, main 7 baje uthta hun')).toMatchObject([
        { domain: 'episodic', summary: 'nahi, main 7 baje uthta hun' },
      ]);
      expect(await learned('नहीं, मैंने 7 बजे कहा था')).toMatchObject([
        { domain: 'episodic', summary: 'नहीं, मैंने 7 बजे कहा था' },
      ]);
      // Bare disagreement corrects nothing, and surprise is not disagreement.
      expect(await learned('nahi yaar')).toHaveLength(0);
      expect(await learned('arre main bhool gaya')).toHaveLength(0);
    });

    it('is surer of a corrected memory than of one merely stated', async () => {
      const one = await learn(makeContext(ownerId, 'owner', 'mujhe chai pasand nahi hai'), defaultDecision, defaultResponse, [], undefined);
      const two = await learn(makeContext(ownerId, 'owner', 'nahi, mujhe chai pasand nahi hai'), defaultDecision, defaultResponse, [], undefined);

      // Confidence is the one column every memory table has, and it reaches both the row
      // and its provenance. A flag beside it would be read by nothing — the defect this
      // rule pass was written to remove.
      const stated = one.memories[0]!;
      const corrected = two.memories[0]!;
      expect(Number(corrected.data['confidence'])).toBeGreaterThan(Number(stated.data['confidence']));
      expect(corrected.provenance.confidence).toBeGreaterThan(stated.provenance.confidence);
    });

    it('stores a person only when the sentence names one', async () => {
      expect(await learned('mera bhai rohit dilli men rahta hai')).toMatchObject([{ domain: 'relationship', relation: 'brother', name: 'rohit' }]);
      expect(await learned('मेरा भाई रोहित दिल्ली में रहता है')).toMatchObject([{ domain: 'relationship', relation: 'brother', name: 'rohit' }]);
      expect(await learned('meri behan anita ke saath')).toMatchObject([{ relation: 'sister', name: 'anita' }]);
      // A place is not a name, a verb is not a name, and `maa` folds to `man` — which is
      // also "mind", so "mera man nahi hai" must not invent a mother.
      expect(await learned('mera bhai dilli men rahta hai')).toHaveLength(0);
      expect(await learned('my friend said that too')).toHaveLength(0);
      expect(await learned('mera man nahi hai')).toHaveLength(0);
    });

    it('takes the predicate from the verb, not from the shape of the sentence', async () => {
      expect(await learned('main infosys men kaam karta hun')).toMatchObject([{ domain: 'semantic', predicate: 'works at', object: 'infosys' }]);
      expect(await learned('मैं दिल्ली में रहता हूं')).toMatchObject([{ domain: 'semantic', predicate: 'lives in', object: 'dilli' }]);
      expect(await learned('main theek hun')).toHaveLength(0);
    });

    it('keeps what he actually typed in an episodic summary', async () => {
      const [episode] = await learned('आज मैंने पहली बार कॉफी पी');
      expect(episode?.['domain']).toBe('episodic');
      // The rules read the fold; the record keeps the sentence.
      expect(episode?.['summary']).toBe('आज मैंने पहली बार कॉफी पी');
    });
  });

  /**
   * The quarantine has to know who "he" is.
   *
   * A guest's claim about the owner is stored as an unverified claim needing his
   * confirmation; the guest's own taste is stored plainly. The only thing in a sentence
   * that says which of the two it is, is the name — and the policy used to carry that
   * name as the literal string `ankit`, so it was correct for one installation and, for
   * every other owner, quarantined nothing at all.
   */
  describe('Stage 10: LEARN quarantines by the name he is enrolled under', () => {
    const guestSaid = async (said: string, ownerName?: string): Promise<{ validatedBy: string | undefined; aboutOwner: unknown; count: number }> => {
      const delta = await learn(makeContext(guestId, 'guest', said), defaultDecision, defaultResponse, [], undefined, { ownerName });
      const first = delta.memories[0];
      return { validatedBy: first?.provenance.validatedBy, aboutOwner: first?.data['aboutOwner'], count: delta.memories.length };
    };

    it('quarantines a claim naming the owner, and only that owner', async () => {
      expect(await guestSaid('rohit ko chai pasand hai', 'Rohit Sharma')).toMatchObject({ validatedBy: 'owner_confirmation' });
      // The first name alone is how a guest actually refers to him.
      expect(await guestSaid('rohit ko chai pasand hai', 'Rohit')).toMatchObject({ validatedBy: 'owner_confirmation' });
      // Same sentence, different owner: this is now just a guest talking about a friend.
      expect(await guestSaid('rohit ko chai pasand hai', 'Meera')).toMatchObject({ validatedBy: 'app_rule' });
      // And the name the policy used to be hardcoded to has no special power any more.
      expect(await guestSaid('ankit ko chai pasand hai', 'Meera')).toMatchObject({ validatedBy: 'app_rule' });
    });

    it('reads the name in either script, and does not treat it as a pattern', async () => {
      expect(await guestSaid('मुझे रोहित की चाय पसंद है', 'Rohit')).toMatchObject({ validatedBy: 'owner_confirmation' });
      // A display name is whatever he typed at enrollment. Unescaped, this one is a
      // syntax error in a regular expression rather than a name.
      expect(await guestSaid('mujhe chai pasand hai', 'Ankit (bhai)')).toMatchObject({ validatedBy: 'app_rule' });
      // An owner called "Om" is not found inside an unrelated word.
      expect(await guestSaid('mujhe shalom pasand hai', 'Om')).toMatchObject({ validatedBy: 'app_rule' });
    });

    it('still quarantines on the role word alone, with no name to go on', async () => {
      expect(await guestSaid('The owner likes spicy food')).toMatchObject({ aboutOwner: true, validatedBy: 'owner_confirmation' });
      // But not on a word that merely contains it, and not on her own name — she is not
      // the owner, and a guest talking to her is not making a claim about him.
      expect(await guestSaid('mujhe landowner pasand hai')).toMatchObject({ validatedBy: 'app_rule' });
      expect(await guestSaid('mujhe madhurita pasand hai')).toMatchObject({ validatedBy: 'app_rule' });
    });
  });

  /**
   * A credential is not written down, whatever else the sentence also is.
   *
   * The sensitivity test used to run below three branches that store, so anything phrased
   * as a taste or a habit carried its secret straight past the rule meant to stop it.
   */
  describe('Stage 10: LEARN discards a credential before it scopes anything', () => {
    const stored = async (said: string, kind: 'owner' | 'guest' = 'owner'): Promise<number> =>
      (await learn(makeContext(kind === 'guest' ? guestId : ownerId, kind, said), defaultDecision, defaultResponse, [], undefined)).memories.length;

    it('drops a secret that arrives as a preference, from either kind of caller', async () => {
      expect(await stored('mujhe apna password pasand hai')).toBe(0);
      expect(await stored('mujhe apna password pasand hai', 'guest')).toBe(0);
      expect(await stored('mera favourite otp 4321 hai')).toBe(0);
    });

    it('does not mistake an ordinary word for a credential', async () => {
      // `includes('pin')` matched "spinach", which is a thing a person has an opinion on.
      expect(await stored('mujhe palak pasand hai')).toBe(1);
    });
  });

  describe('Stage 11: UPDATE (Domain Writes)', () => {
    it('applies authorized learning delta to memory tables', async () => {
      const recalled = makeContext(ownerId, 'owner', 'I prefer dark mode');
      const delta = await learn(recalled, defaultDecision, defaultResponse, [], undefined);

      const updateResult = await update(delta, { memoryRepo });
      expect(updateResult.applied).toBe(1);
      expect(updateResult.skipped).toBe(0);
      expect(updateResult.errors.length).toBe(0);

      // Verify persistence
      const prefs = memoryRepo.listPreferences(ownerId);
      expect(prefs.length).toBe(1);
      expect(prefs[0]?.key).toBe('dark mode');
      expect(prefs[0]?.value).toBe('likes');
    });

    it('overwrites a stance instead of storing its contradiction', async () => {
      const liked = await learn(makeContext(ownerId, 'owner', 'mujhe chai pasand hai'), defaultDecision, defaultResponse, [], undefined);
      expect((await update(liked, { memoryRepo })).applied).toBe(1);

      const reversed = await learn(makeContext(ownerId, 'owner', 'mujhe chai pasand nahi hai'), defaultDecision, defaultResponse, [], undefined);
      await update(reversed, { memoryRepo });

      // One key, one row: stage 10 and `preference.set` share the key space the table
      // is unique on, so the dedupe engine finds this row and updates the stance.
      const prefs = memoryRepo.listPreferences(ownerId).filter((p) => p.key === 'chai');
      expect(prefs.length).toBe(1);
      expect(prefs[0]?.value).toBe('pasand nahi');
    });
  });

  describe('Stage 12: PERSIST (Transactional Comit)', () => {
    it('commits cycle_record update, domain_event, and audit_log atomically', async () => {
      const cycleId = 'cycle1';
      const auditEntry: AuditEntry = {
        actorId: ownerId,
        action: 'disclosure:redact',
        resource: 'response',
        decision: 'redacted',
        at: Date.now()
      };

      const persistInput = {
        cycleId,
        status: 'completed' as const,
        startedAt: Date.now(),
        completedAt: Date.now(),
        identityId: ownerId,
        conversationId: 'conv1',
        turns: [
          { role: 'user' as const, text: 'remember I prefer dark mode' },
          { role: 'assistant' as const, text: 'noted' },
        ],
        actionResults: [],
        decision: defaultDecision,
        response: defaultResponse,
        learningDelta: undefined,
        updateResult: undefined,
        audit: [auditEntry],
        stages: []
      };

      const result = await persist(persistInput, { db });
      expect(result.cycleRecordId).toBe(cycleId);
      expect(result.eventsEmitted).toBeGreaterThan(0);
      expect(result.turnsWritten).toBe(2);

      // Verify cycle record status
      const cycle = db.raw.prepare(`SELECT status FROM cycle_record WHERE id = ?`).get(cycleId) as { status: string } | undefined;
      expect(cycle?.status).toBe('completed');

      // Verify audit logic
      const audits = db.raw.prepare(`SELECT * FROM audit_log WHERE actor_id = ?`).all(ownerId) as Array<{ action: string }>;
      expect(audits.length).toBe(1);
      expect(audits[0]?.action).toBe('disclosure:redact');

      // Verify domain events
      const events = db.raw.prepare(`SELECT * FROM domain_event WHERE cycle_id = ? ORDER BY seq`).all(cycleId) as Array<{ type: string }>;
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]?.type).toBe('cycle.completed');
    });

    it('closes the row with the verdict on it, so the cycle can be described back', async () => {
      // `output_json` was declared in the first schema and written by nothing, and there
      // was no decision column at all. A row read back said only *that* a cycle ran.
      // Both are written inside the same transaction that closes it, so a row is never
      // half a verdict.
      await persist(
        {
          cycleId: 'cycle1',
          status: 'completed' as const,
          startedAt: Date.now(),
          completedAt: Date.now(),
          identityId: ownerId,
          conversationId: 'conv1',
          turns: [],
          actionResults: [],
          decision: defaultDecision,
          response: defaultResponse,
          learningDelta: undefined,
          updateResult: undefined,
          audit: [],
          stages: [],
        },
        { db },
      );

      const row = db.raw
        .prepare(`SELECT decision_json, output_json FROM cycle_record WHERE id = ?`)
        .get('cycle1') as { decision_json: string; output_json: string };

      expect(JSON.parse(row.decision_json)).toMatchObject({ authorized: true, proposal: { action: 'respond' } });
      expect(JSON.parse(row.output_json)).toMatchObject({ text: 'ok' });
    });

    it('leaves both columns null on a cycle that reached neither', async () => {
      // A stimulus refused at the gate has no authorized decision; an interrupted cycle
      // has no response. `null` is the honest value, and it is what every reader of these
      // columns was built for — including rows written before the column existed.
      await persist(
        {
          cycleId: 'cycle1',
          status: 'failed' as const,
          startedAt: Date.now(),
          completedAt: Date.now(),
          identityId: ownerId,
          conversationId: 'conv1',
          turns: [],
          actionResults: [],
          decision: undefined,
          response: undefined,
          learningDelta: undefined,
          updateResult: undefined,
          audit: [],
          stages: [],
        },
        { db },
      );

      expect(
        db.raw.prepare(`SELECT decision_json, output_json FROM cycle_record WHERE id = ?`).get('cycle1'),
      ).toEqual({ decision_json: null, output_json: null });
    });
  });
});
