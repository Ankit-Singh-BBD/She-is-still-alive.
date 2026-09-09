/**
 * What she keeps out of band, and what she refuses to keep.
 *
 * `LearningPipeline` was composed with `{ extract: async () => [] } as never`
 * everywhere in this repository until `server/learning/extractor.ts` existed, so
 * these are the first tests of anything the extractors actually do. Three things
 * are worth asserting and the rest is detail:
 *
 *  1. A regular expression over natural language must not overrun the clause it
 *     was written for — "my name is Ankit and I like chai" is two facts, and a
 *     name of *"Ankit and I like chai"* would be written to permanent memory.
 *  2. Nothing that looks like a credential is learned by either extractor,
 *     whatever the prompt asked the model to do.
 *  3. The pipeline refuses to be the second writer for one cycle, because
 *     stages 10 and 11 already learn inside it.
 */

import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventBus } from '@server/events/event-bus.js';
import { DEFAULT_PERMISSIONS, IdentityRepository } from '@server/identity/repository.js';
import type { IdentityKind } from '@server/identity/types.js';
import {
  createLearningExtractor,
  knownMemoryLookupFrom,
  LlmLearningExtractor,
  RuleBasedLearningExtractor,
  type ScopedMemoryReader,
  type TranscriptLearningFaculty,
} from '@server/learning/extractor.js';
import { LearningPipeline } from '@server/learning/pipeline.js';
import type {
  CycleRecord,
  LearningCandidate,
  LearningExtractor,
  Message,
} from '@server/learning/types.js';
import type { ExtractionProposal } from '@server/llm/faculties.js';
import { MemoryRepository } from '@server/memory/repository.js';
import type { MemoryProvenance } from '@server/memory/types.js';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';

const CYCLE: CycleRecord = {
  id: 'cyc_001',
  identityId: 'usr_owner0000000000000000001',
  conversationId: 'conv_001',
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_001_000,
  status: 'completed',
};

let sequence = 0;
function said(text: string, role: Message['role'] = 'user'): Message {
  sequence += 1;
  return {
    id: `msg_${sequence}`,
    conversationId: 'conv_001',
    role,
    text,
    timestamp: 1_700_000_000_000 + sequence,
  };
}

/** The rule extractor's whole output for one line of speech. */
async function extractFrom(
  text: string,
  resolveKind?: (id: string) => IdentityKind | undefined,
): Promise<LearningCandidate[]> {
  const extractor = new RuleBasedLearningExtractor(resolveKind ? { resolveKind } : {});
  return extractor.extract(CYCLE, [said(text)]);
}

describe('RuleBasedLearningExtractor', () => {
  it('keeps a name it was given, in English and in Hinglish', async () => {
    const english = await extractFrom('my name is Ankit');
    const hinglish = await extractFrom('mera naam Ankit hai');

    for (const candidates of [english, hinglish]) {
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.domain).toBe('semantic');
      // Never 'owner': the policy quarantines a non-owner's claim about the
      // owner, and this is a claim about whoever spoke.
      expect(candidates[0]?.content).toEqual({
        subject: 'speaker',
        predicate: 'is named',
        object: 'Ankit',
      });
      expect(candidates[0]?.extractor).toBe('rule');
    }
  });

  it('keeps what someone asked to be called', async () => {
    const candidates = await extractFrom('call me Madhu please');
    expect(candidates[0]?.domain).toBe('preference');
    expect(candidates[0]?.content).toEqual({ key: 'preferred_name', value: 'Madhu' });
  });

  it('keeps a stated liking and a stated dislike', async () => {
    expect((await extractFrom('I love filter coffee'))[0]?.content).toEqual({
      key: 'likes',
      value: 'filter coffee',
    });
    expect((await extractFrom('mujhe adrak wali chai pasand hai'))[0]?.content).toEqual({
      key: 'likes',
      value: 'adrak wali chai',
    });
    expect((await extractFrom("I can't stand loud rooms"))[0]?.content).toEqual({
      key: 'dislikes',
      value: 'loud rooms',
    });
  });

  it('does not let one rule run past the clause it was written for', async () => {
    const candidates = await extractFrom('my name is Ankit and I like chai');

    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.content).toEqual({
      subject: 'speaker',
      predicate: 'is named',
      object: 'Ankit',
    });
    expect(candidates[1]?.content).toEqual({ key: 'likes', value: 'chai' });
  });

  it('splits a mixed Hindi-English sentence the same way', async () => {
    const candidates = await extractFrom('mera naam Ankit hai, aur mujhe chai pasand hai');
    expect(candidates.map((c) => c.content)).toEqual([
      { subject: 'speaker', predicate: 'is named', object: 'Ankit' },
      { key: 'likes', value: 'chai' },
    ]);
  });

  it('learns nothing from her own half of the transcript', async () => {
    const extractor = new RuleBasedLearningExtractor();
    const candidates = await extractor.extract(CYCLE, [
      said('my name is Madhurita', 'assistant'),
      said('you are called Madhurita', 'system'),
    ]);
    expect(candidates).toEqual([]);
  });

  it('refuses a sentence that mentions a credential, even when a rule matches', async () => {
    expect(await extractFrom('my name is hunter2 and my password is hunter2')).toEqual([]);
    expect(await extractFrom('call me when the OTP arrives')).toEqual([]);
    expect(await extractFrom('call me with the api key')).toEqual([]);
  });

  it('keeps a repeated statement once', async () => {
    const extractor = new RuleBasedLearningExtractor();
    const candidates = await extractor.extract(CYCLE, [
      said('mera naam Ankit hai'),
      said('by the way my name is Ankit'),
    ]);
    expect(candidates).toHaveLength(1);
  });

  it('proposes nothing for a sentence no rule was written for', async () => {
    expect(await extractFrom('we sat on the terrace till two last night')).toEqual([]);
    expect(await extractFrom('theek hai, kal baat karte hain')).toEqual([]);
  });

  it('narrows to guest when the caller’s kind cannot be resolved', async () => {
    const unknown = await extractFrom('my name is Ankit');
    const known = await extractFrom('my name is Ankit', () => 'owner');

    expect(unknown[0]?.callerKind).toBe('guest');
    expect(known[0]?.callerKind).toBe('owner');
    expect(known[0]?.callerId).toBe(CYCLE.identityId);
  });
});

// ── The model-backed extractor ──────────────────────────────────────────────

type FacultyInput = Parameters<TranscriptLearningFaculty['proposeExtractionsFromTranscript']>[0];

function fakeFaculty(
  proposals: Awaited<ReturnType<TranscriptLearningFaculty['proposeExtractionsFromTranscript']>>,
): { faculty: TranscriptLearningFaculty; seen: FacultyInput[] } {
  const seen: FacultyInput[] = [];
  const faculty: TranscriptLearningFaculty = {
    modelId: 'gemini-2.5-flash-lite',
    proposeExtractionsFromTranscript: (input) => {
      seen.push(input);
      return Promise.resolve(proposals);
    },
  };
  return { faculty, seen };
}

describe('LlmLearningExtractor', () => {
  it('turns proposals into candidates and records that a model made them', async () => {
    const { faculty } = fakeFaculty([
      { domain: 'preference', data: { key: 'drink', value: 'chai' }, confidence: 0.9, importance: 0.7 },
    ]);

    const candidates = await new LlmLearningExtractor({
      faculty,
      resolveKind: () => 'owner',
    }).extract(CYCLE, [said('mujhe chai pasand hai')]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.extractor).toBe('llm');
    expect(candidates[0]?.callerKind).toBe('owner');
    expect(candidates[0]?.callerId).toBe(CYCLE.identityId);
    expect(candidates[0]?.reasoning).toContain('gemini-2.5-flash-lite');
    expect(candidates[0]?.content).toEqual({ key: 'drink', value: 'chai' });
  });

  it('drops a proposal that carries a credential however it was labelled', async () => {
    const { faculty } = fakeFaculty([
      { domain: 'semantic', data: { subject: 'speaker', predicate: 'password is', object: 'hunter2' }, confidence: 1, importance: 1 },
      { domain: 'preference', data: { key: 'drink', value: 'chai' }, confidence: 0.9, importance: 0.7 },
    ]);

    const candidates = await new LlmLearningExtractor({ faculty }).extract(CYCLE, []);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.content).toEqual({ key: 'drink', value: 'chai' });
  });

  it('does not carry the model’s own idea of who a memory is about', async () => {
    // `ExtractionProposal` has `sensitivity` and `subjectKind`; a candidate does
    // not. Scope belongs to the policy, which reads the caller's kind from
    // authoritative state — passing the model's labelling through would let it
    // grant itself owner scope.
    const proposals: ExtractionProposal[] = [
      {
        domain: 'semantic',
        data: { subject: 'owner', predicate: 'is named', object: 'Ankit' },
        confidence: 0.9,
        importance: 0.9,
        sensitivity: 'public',
        subjectKind: 'owner',
      },
    ];
    const { faculty } = fakeFaculty(proposals);

    const candidates = await new LlmLearningExtractor({ faculty }).extract(CYCLE, []);

    expect(Object.keys(candidates[0] ?? {})).not.toContain('sensitivity');
    expect(Object.keys(candidates[0] ?? {})).not.toContain('subjectKind');
    expect(candidates[0]?.callerKind).toBe('guest');
  });

  it('shows the faculty what the cycle did and what she already knows', async () => {
    const { faculty, seen } = fakeFaculty([]);

    await new LlmLearningExtractor({
      faculty,
      resolveKind: () => 'person',
      known: () => ['[preference] drink = chai'],
    }).extract(
      {
        ...CYCLE,
        authorizedDecision: { proposal: { action: 'execute_tool', rationale: 'she asked' } },
        outputJson: JSON.stringify({ text: 'yaad rakh liya' }),
      },
      [said('mujhe chai pasand hai')],
    );

    expect(seen[0]?.cycle).toEqual({
      status: 'completed',
      decision: 'execute_tool — she asked',
      answered: 'yaad rakh liya',
    });
    expect(seen[0]?.speakerKind).toBe('person');
    expect(seen[0]?.alreadyKnown).toEqual(['[preference] drink = chai']);
    expect(seen[0]?.messages).toEqual([{ role: 'user', text: 'mujhe chai pasand hai' }]);
  });

  it('lets a failing faculty reach the caller instead of reporting nothing to learn', async () => {
    const faculty: TranscriptLearningFaculty = {
      modelId: 'gemini-2.5-flash-lite',
      proposeExtractionsFromTranscript: () => Promise.reject(new Error('429 quota exceeded')),
    };

    await expect(new LlmLearningExtractor({ faculty }).extract(CYCLE, [])).rejects.toThrow(
      /429 quota exceeded/,
    );
  });

  it('ignores an unreadable stored answer rather than throwing over it', async () => {
    const { faculty, seen } = fakeFaculty([]);

    await new LlmLearningExtractor({ faculty }).extract(
      { ...CYCLE, outputJson: 'not json', authorizedDecision: null },
      [],
    );

    expect(seen[0]?.cycle.answered).toBeUndefined();
    expect(seen[0]?.cycle.decision).toBeUndefined();
  });
});

describe('createLearningExtractor', () => {
  it('uses the model when there is one', () => {
    const { faculty } = fakeFaculty([]);
    expect(createLearningExtractor({ faculty })).toBeInstanceOf(LlmLearningExtractor);
  });

  it('still learns what was literally said when there is no model', () => {
    expect(createLearningExtractor({})).toBeInstanceOf(RuleBasedLearningExtractor);
  });
});

// ── What she is told she already knows ──────────────────────────────────────

describe('knownMemoryLookupFrom', () => {
  type ReaderItem = Awaited<ReturnType<ScopedMemoryReader['retrieve']>>['items'][number];
  type ReaderRequest = Parameters<ScopedMemoryReader['retrieve']>[0];

  function reader(items: ReaderItem[]): { reader: ScopedMemoryReader; asked: ReaderRequest[] } {
    const asked: ReaderRequest[] = [];
    return {
      asked,
      reader: {
        retrieve: (request) => {
          asked.push(request);
          return Promise.resolve({ items });
        },
      },
    };
  }

  it('renders one line per memory, domain first', async () => {
    const { reader: scoped } = reader([
      { domain: 'semantic', subject: 'speaker', predicate: 'is named', object: 'Ankit' },
      { domain: 'preference', key: 'drink', value: 'chai' },
      { domain: 'relationship', name: 'Maa', relation: 'mother' },
      { domain: 'episodic', summary: 'we sat on the terrace' },
    ]);

    const lines = await knownMemoryLookupFrom(scoped)('usr_1');

    expect(lines).toEqual([
      '[semantic] speaker is named Ankit',
      '[preference] drink = chai',
      '[relationship] Maa — mother',
      '[episodic] we sat on the terrace',
    ]);
  });

  it('asks through the scoping policy, and as a guest when the kind is unknown', async () => {
    const { reader: scoped, asked } = reader([]);

    await knownMemoryLookupFrom(scoped)('usr_1');
    await knownMemoryLookupFrom(scoped, () => 'owner')('usr_1');

    expect(asked[0]?.callerKind).toBe('guest');
    expect(asked[1]?.callerKind).toBe('owner');
    expect(asked[0]?.excludeSoftDeleted).toBe(true);
    // There is no query to be similar to; importance and recency order it.
    expect(asked[0]?.similarityWeight).toBe(0);
  });
});

// ── The pipeline, over a real database ──────────────────────────────────────

describe('LearningPipeline with a real extractor', () => {
  const OWNER = 'usr_owner0000000000000000001';
  const GUEST = 'usr_guest0000000000000000001';

  let db: Database;
  let memoryRepo: MemoryRepository;
  let identityRepo: IdentityRepository;
  let eventBus: EventBus;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));

    /**
     * Enrolled under names, not under their kinds.
     *
     * `display_name` used to be the string `'owner'` here, which quietly made two rules
     * untestable: the quarantine matches the owner's *enrolled name* in the sentence, and
     * `'owner'` is also the role word `OWNER_ROLE` matches, so a fixture named `'owner'`
     * cannot tell the two paths apart. Naming him `Ankit` — and the guest someone else —
     * is what makes "Ankit ko chai pasand hai" a claim about the owner and "mera naam
     * Ankit hai" from a guest a self-report.
     */
    for (const [id, kind, displayName] of [
      [OWNER, 'owner', 'Ankit'],
      [GUEST, 'guest', 'Rohit'],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at)
           VALUES (?, ?, ?, 'active', 0, 0)`,
        )
        .run(id, kind, displayName);
      db.raw
        .prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`)
        .run(id, JSON.stringify(DEFAULT_PERMISSIONS[kind]));
    }

    // Three conversations, so each case's cycle is its own row: the double-write guard
    // counts by cycle id, and reusing one id would have the later cases skipped by the
    // earlier cases' writes. `semantic_memory.source_cycle` is a foreign key, so a cycle
    // a test invents has to exist here too.
    for (const [conversation, cycle, identity] of [
      ['conv_001', 'cyc_001', OWNER],
      ['conv_002', 'cyc_002', GUEST],
      ['conv_003', 'cyc_003', GUEST],
    ] as const) {
      db.raw
        .prepare(
          `INSERT INTO conversation (id, identity_id, channel, status) VALUES (?, ?, 'text', 'active')`,
        )
        .run(conversation, identity);
      db.raw
        .prepare(`INSERT INTO cycle_record (id, conversation_id, status) VALUES (?, ?, 'completed')`)
        .run(cycle, conversation);
    }

    memoryRepo = new MemoryRepository(db);
    identityRepo = new IdentityRepository(db);
    eventBus = new EventBus(db);
  });

  afterEach(() => {
    db.close();
  });

  /** An extractor that proposes exactly what a test hands it. */
  function fixedExtractor(candidates: LearningCandidate[]): LearningExtractor {
    return { extract: () => Promise.resolve(candidates) };
  }

  function candidate(overrides: Partial<LearningCandidate> = {}): LearningCandidate {
    return {
      domain: 'preference',
      callerId: OWNER,
      callerKind: 'owner',
      content: { key: 'drink', value: 'chai' },
      confidence: 0.9,
      importance: 0.8,
      reasoning: 'she said so',
      ...overrides,
    };
  }

  function provenanceFor(cycleId: string): MemoryProvenance {
    return {
      sourceCycleId: cycleId,
      sourceConversationId: 'conv_001',
      sourceMessageIds: [],
      extractedAt: 1_700_000_000_000,
      extractor: 'llm',
      confidence: 0.9,
      validatedBy: 'auto_policy',
    };
  }

  function pipelineWith(
    extractor: LearningExtractor,
    options?: { relearnCycles?: boolean },
  ): LearningPipeline {
    return new LearningPipeline({
      db,
      eventBus,
      memoryRepo,
      identityRepo,
      extractor,
      ...(options ? { options } : {}),
    });
  }

  function rows(table: 'preference' | 'semantic_memory'): Array<Record<string, unknown>> {
    return db.raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  }
  it('refuses to learn twice from a cycle that already wrote its own memories', async () => {
    // What stages 10 and 11 do inside the cycle, written the way they write it.
    memoryRepo.createPreference({
      identityId: OWNER,
      key: 'drink',
      value: 'chai',
      provenance: provenanceFor('cyc_001'),
    });

    const result = await pipelineWith(
      fixedExtractor([candidate({ content: { key: 'drink', value: 'filter coffee' } })]),
    ).processCycle(CYCLE, [said('mujhe filter coffee pasand hai')]);

    expect(result.learned).toBe(false);
    expect(result.count).toBe(0);
    expect(result.skipped).toContain('cyc_001');
    // `skipped` set with empty details is the honest shape: it did not run, as
    // distinct from running and finding nothing.
    expect(result.details).toEqual([]);
    expect(rows('preference')).toHaveLength(1);
    expect(rows('preference')[0]?.['value']).toBe('chai');
  });

  it('runs over the same cycle when a consolidation pass asks it to', async () => {
    memoryRepo.createPreference({
      identityId: OWNER,
      key: 'drink',
      value: 'chai',
      provenance: provenanceFor('cyc_001'),
    });

    const result = await pipelineWith(
      fixedExtractor([candidate({ content: { key: 'drink', value: 'filter coffee' } })]),
      { relearnCycles: true },
    ).processCycle(CYCLE, []);

    expect(result.skipped).toBeUndefined();
    expect(result.learned).toBe(true);
    expect(result.count).toBe(1);
    // Dedupe matched on (identity, key), so this reinforced the row rather than
    // holding the same preference twice.
    expect(result.details[0]?.dedupe.action).toBe('update');
    expect(rows('preference')).toHaveLength(1);
    expect(rows('preference')[0]?.['value']).toBe('filter coffee');
  });
  it('records which kind of extractor actually proposed each memory', async () => {
    const result = await pipelineWith(
      fixedExtractor([
        candidate({ content: { key: 'drink', value: 'chai' }, extractor: 'rule' }),
        candidate({ content: { key: 'music', value: 'ghazals' }, extractor: 'llm' }),
        // A candidate built by hand says nothing about who proposed it. `rule` is
        // the honest default: provenance naming a model where no model ran would
        // have a later reader attribute a regular expression to her judgement.
        candidate({ content: { key: 'city', value: 'Pune' } }),
      ]),
    ).processCycle(CYCLE, []);

    expect(result.count).toBe(3);

    const stored = new Map(
      rows('preference').map((row) => [
        row['key'],
        (JSON.parse(row['provenance_json'] as string) as MemoryProvenance).extractor,
      ]),
    );
    expect(stored.get('drink')).toBe('rule');
    expect(stored.get('music')).toBe('llm');
    expect(stored.get('city')).toBe('rule');
  });
  it('learns a name the owner stated, end to end, with no model configured', async () => {
    // The composition this task existed to make possible: a real extractor, the
    // real policy, the real dedupe engine, a real database, and no API key.
    const extractor = createLearningExtractor({
      resolveKind: (id) => identityRepo.getIdentity(id)?.kind,
    });

    const result = await pipelineWith(extractor).processCycle(CYCLE, [said('mera naam Ankit hai')]);

    expect(result.learned).toBe(true);
    expect(result.count).toBe(1);

    const [row] = rows('semantic_memory');
    expect(row?.['subject']).toBe('speaker');
    expect(row?.['predicate']).toBe('is named');
    expect(row?.['object']).toBe('Ankit');
    expect(row?.['subject_kind']).toBe('owner');
    expect(row?.['sensitivity']).toBe('person_shared');
    expect(row?.['source_cycle']).toBe('cyc_001');
  });

  it('keeps a guest’s own preference and their own self-report, isolated from the owner', async () => {
    const extractor = createLearningExtractor({
      resolveKind: (id) => identityRepo.getIdentity(id)?.kind,
    });
    const guestCycle: CycleRecord = {
      ...CYCLE,
      id: 'cyc_002',
      conversationId: 'conv_002',
      identityId: GUEST,
    };

    const result = await pipelineWith(extractor).processCycle(guestCycle, [
      said('mera naam Ankit hai'),
      said('mujhe chai pasand hai'),
    ]);

    /**
     * Both kept, and this test used to assert the opposite for the first one.
     *
     * Build Book XIII.4's table has five rows and forbids none of `episodic`,
     * `relationship`, `habit`, or a guest's own `semantic` fact — but this pipeline's
     * copy of the policy discarded all four by name, under a reason
     * (`Guest semantic facts about non-owner subjects are not retained`) that appears
     * nowhere in the book. Its quarantine branch was the reason: it tested
     * `content['subject'] === 'owner'`, a literal `extractor.ts` is written never to
     * emit, so the branch could not fire and the blanket discard beneath it swallowed
     * everything. Fixing the detection removes the need for the blanket.
     */
    expect(result.count).toBe(2);

    const [fact] = rows('semantic_memory');
    expect(fact?.['subject']).toBe('speaker');
    expect(fact?.['object']).toBe('Ankit');
    expect(fact?.['identity_id']).toBe(GUEST);
    // Not quarantined, though the sentence contains the owner's own name: the candidate
    // says its subject is the speaker, and a guest introducing himself is not making a
    // claim about the owner. `lifecycle_status` is what separates the two outcomes.
    expect(fact?.['subject_kind']).toBe('guest');
    expect(fact?.['lifecycle_status']).toBe('active');

    const [preference] = rows('preference');
    expect(preference?.['key']).toBe('likes');
    expect(preference?.['value']).toBe('chai');
    expect(preference?.['subject_kind']).toBe('guest');
    expect(preference?.['identity_id']).toBe(GUEST);
    /**
     * `person_shared`, not `public`, and the difference is the whole guest row.
     *
     * `public` is the one `Sensitivity` value that returns `true` from
     * `MemoryRetrieval.isAllowedByPolicy` for every caller who clears identity
     * isolation — so the copy of the policy whose own header quoted "Completely
     * isolated from Owner" was the copy that un-isolated it. Stage 10's copy said
     * `person_shared` and stage 10's copy was right.
     */
    expect(preference?.['sensitivity']).toBe('person_shared');
  });

  /**
   * The quarantine, reachable off this path for the first time.
   *
   * It could not fire before: the branch tested `content['subject'] === 'owner'`, a
   * literal the extractor is written never to emit. What makes it reachable is reading the
   * sentence for the owner's *enrolled name*, which is why the fixture enrols him under
   * one. The candidate is handed in rather than extracted because the rule extractor has
   * no third-person pattern — "X ko Y pasand hai" yields nothing — and what is under test
   * here is the policy and the writer, not the regular expressions.
   */
  it('quarantines a guest’s claim about the owner instead of learning it', async () => {
    const guestCycle: CycleRecord = {
      ...CYCLE,
      id: 'cyc_003',
      conversationId: 'conv_003',
      identityId: GUEST,
    };

    const result = await pipelineWith(
      fixedExtractor([
        candidate({
          domain: 'semantic',
          callerId: GUEST,
          callerKind: 'guest',
          content: { subject: 'Ankit', predicate: 'likes', object: 'chai' },
        }),
      ]),
    ).processCycle(guestCycle, [said('Ankit ko chai pasand hai')]);

    expect(result.count).toBe(1);
    const quarantined = result.details.find((d) => d.decision.action === 'quarantine');
    expect(quarantined).toBeDefined();
    expect(quarantined?.decision.validatedBy).toBe('owner_confirmation');

    const [row] = rows('semantic_memory');
    // Under the guest's identity — the book's "with Guest provenance" — while
    // `subject_kind` records who the claim is *about*.
    expect(row?.['identity_id']).toBe(GUEST);
    expect(row?.['subject_kind']).toBe('owner');
    // `owner_only` is the only setting under which the guest cannot read their own
    // unconfirmed claim back out of her, and `archived` keeps it out of ordinary recall
    // until he confirms it.
    expect(row?.['sensitivity']).toBe('owner_only');
    expect(row?.['lifecycle_status']).toBe('archived');
    expect((JSON.parse(row?.['provenance_json'] as string) as MemoryProvenance).validatedBy).toBe(
      'owner_confirmation',
    );
    // Traceable to the cycle that produced it. `persistNew` used to leave this null for
    // accepted facts while the quarantine writer filled it in, which is the wrong way
    // round; now both fill it.
    expect(row?.['source_cycle']).toBe('cyc_003');

    /**
     * It reads back through the repository's own mapping.
     *
     * The old writer built its own INSERT beside `MemoryRepository`, listing this table's
     * columns and formatting its timestamps by hand, because the repository hardcoded
     * `lifecycle_status` and raw SQL was the only way to reach it. A second writer of one
     * table is a second thing to keep in step with the schema; asserting on the mapped
     * object rather than the raw row is what would have caught a drift in either.
     */
    const [mapped] = memoryRepo.listSemantic(GUEST, true);
    expect(mapped?.subject).toBe('Ankit');
    expect(mapped?.lifecycleStatus).toBe('archived');
    expect(Number.isFinite(mapped?.createdAt)).toBe(true);
    expect(mapped?.createdAt).toBeGreaterThan(1_600_000_000_000);

    // And it is out of the default view, which is what "quarantine" has to mean to be
    // more than a word.
    expect(memoryRepo.listSemantic(GUEST)).toEqual([]);
    expect(memoryRepo.listSemantic(GUEST, true)).toHaveLength(1);
  });

  /**
   * A claim about the owner that was extracted as something other than a fact.
   *
   * The policy quarantines on the *sentence*, so any of the six domains can reach it — but
   * the writer cast `content` to `{ subject, predicate, object }` unconditionally, so for
   * the other five it bound `undefined` to three NOT NULL columns. The insert threw, the
   * loop swallowed it into `details`, and the claim was held nowhere: the one outcome the
   * table forbids is the one the writer produced.
   */
  it('holds a claim about the owner that was extracted as a preference', async () => {
    const guestCycle: CycleRecord = {
      ...CYCLE,
      id: 'cyc_003',
      conversationId: 'conv_003',
      identityId: GUEST,
    };

    // The guest's own `likes` preference, already stored. `setPreference` matches on
    // (identity_id, key), so a quarantine written into that table would have replaced it.
    memoryRepo.createPreference({
      identityId: GUEST,
      key: 'likes',
      value: 'coffee',
      provenance: provenanceFor('cyc_002'),
    });

    const result = await pipelineWith(
      fixedExtractor([
        candidate({
          domain: 'preference',
          callerId: GUEST,
          callerKind: 'guest',
          // No `subject` field at all — a preference does not carry one. What makes this
          // a claim about the owner is his name in the value.
          content: { key: 'likes', value: 'Ankit likes chai' },
        }),
      ]),
    ).processCycle(guestCycle, [said('Ankit ko chai pasand hai')]);

    expect(result.details[0]?.error).toBeUndefined();
    expect(result.count).toBe(1);

    const [held] = rows('semantic_memory');
    expect(held?.['subject']).toBe('Ankit');
    expect(held?.['predicate']).toBe('prefers:likes');
    expect(held?.['object']).toBe('Ankit likes chai');
    expect(held?.['lifecycle_status']).toBe('archived');

    // Untouched.
    expect(rows('preference')).toHaveLength(1);
    expect(rows('preference')[0]?.['value']).toBe('coffee');
  });
});
