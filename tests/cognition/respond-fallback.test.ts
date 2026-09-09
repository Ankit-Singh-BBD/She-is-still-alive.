/**
 * What she says when the faculty that was supposed to write her answer throws.
 *
 * This is a regression test for a defect found by running her, not by reading her.
 * With a real key and a model id that had been retired underneath us, every
 * thinking stage threw — and the transcript came back holding the owner's sentence
 * and nothing else. She had not refused, or apologised, or said she was having
 * trouble. She had said nothing at all, and the interface faithfully displayed
 * nothing.
 *
 * The old behaviour was deliberate and argued from the honesty contract: stage 9
 * threw, so there was no authorized response, so writing one would be a claim the
 * traces contradicted. But her own seeded self-knowledge says the opposite about
 * exactly this case — *"a cycle ran all the way to the end but at least one of its
 * stages failed and used its fallback — the answer still arrives, and it arrives
 * labelled"* — and a provider outage is the most ordinary reason a stage will ever
 * fail in daily use.
 *
 * So the rule now: she answers, the answer is the deterministic draft in her own
 * register, the cycle is still `degraded`, the stage trace still carries the
 * provider's error, and the turn carries `respond_stage_fallback` so the record
 * says where the words came from. Every assertion below is one of those five
 * things, because dropping any one of them turns this from a graceful degradation
 * back into either silence or a lie.
 */

import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { CognitiveRuntime } from '@server/cognition/runtime.js';
import { RESPOND_FALLBACK } from '@server/cognition/stages/9.js';
import { EventBus } from '@server/events/event-bus.js';
import { IdentityRepository } from '@server/identity/repository.js';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import type { Identity } from '@server/identity/types.js';
import type { ResponseFaculty } from '@server/cognition/stages/9.js';
import type {
  AuthorizedDecision,
  AuthorizedResponse,
  CycleRecord,
} from '@server/cognition/types.js';

const MIGRATIONS = path.resolve(__dirname, '..', '..', 'server/persistence/migrations');

/** The failure this test is about: the provider answered, and the answer was 404. */
const PROVIDER_ERROR = 'models/gemini-2.5-flash-lite is no longer available to new users';

/**
 * Two readers named once, because the assertions below reach for the same two fields
 * a dozen times. Neither casts: `CycleRecord` types both stage outputs, and
 * `authorizedDecision` is non-optional here only because every cycle in this file
 * reaches stage 6 — the fallback under test is stage 9's.
 */
const said = (cycle: CycleRecord): AuthorizedResponse | undefined => cycle.response;
const decided = (cycle: CycleRecord): AuthorizedDecision => {
  if (cycle.authorizedDecision === undefined) throw new Error('cycle reached no decision');
  return cycle.authorizedDecision;
};

describe('A drafting faculty that throws does not cost her the turn', () => {
  let db: Database;
  let owner: Identity;
  let identityRepo: IdentityRepository;
  let eventBus: EventBus;

  const runtimeWith = (llm: ResponseFaculty): CognitiveRuntime =>
    new CognitiveRuntime({ db, eventBus, identityRepo, respond: { llm } });

  const throwing: ResponseFaculty = {
    draftResponse: vi.fn().mockRejectedValue(new Error(PROVIDER_ERROR)),
  };

  const turns = (cycleId: string): Array<{ role: string; text: string; metadata_json: string }> =>
    db.raw
      .prepare(
        `SELECT role, text, metadata_json FROM message
          WHERE metadata_json LIKE ? ORDER BY timestamp, rowid`,
      )
      .all(`%${cycleId}%`) as Array<{ role: string; text: string; metadata_json: string }>;

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    identityRepo = new IdentityRepository(db);
    eventBus = new EventBus(db);
    owner = await identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
    db.raw.prepare(`INSERT INTO conversation (id, identity_id) VALUES ('conv-1', ?)`).run(owner.id);
  });

  afterEach(() => {
    db.close();
  });

  const ask = async (text: string) =>
    runtimeWith(throwing).runCycle({
      source: 'text',
      payload: { text },
      receivedAt: Date.now(),
      identityId: owner.id,
      conversationId: 'conv-1',
    });

  it('answers in words, and says something true about what happened', async () => {
    const cycle = await ask('Tum kaisi ho aaj?');

    expect(said(cycle)?.text ?? '').not.toBe('');
    // The words themselves matter here. "I hear you" is what she says when nothing
    // was ever wired to answer, and using it for a faculty that broke would dress a
    // failure up as her ordinary manner.
    expect(said(cycle)?.text).toMatch(/could not/i);
    expect(said(cycle)?.text).toMatch(/again/i);
  });

  it('does not ask him to rephrase a question she never got to read', async () => {
    // With no understanding faculty wired, confidence is 0 and stage 6 decides
    // `clarify` — so the line the register would otherwise reach for is "could you
    // tell me a little more?". That sends him to fix a problem on her side of the
    // wire, which he cannot do however he rewords it.
    const cycle = await ask('Tum kaisi ho aaj?');

    expect(decided(cycle).proposal.action).toBe('clarify');
    expect(said(cycle)?.text).not.toMatch(/tell me a little more/i);
    expect(said(cycle)?.text).toMatch(/could not/i);
  });

  it('is still degraded, and the trace still names the provider error', async () => {
    const cycle = await ask('Tum kaisi ho aaj?');

    expect(cycle.status).toBe('degraded');
    expect(cycle.error).toContain('RESPOND');
    expect(cycle.error).toContain(PROVIDER_ERROR);

    const trace = db.raw
      .prepare(`SELECT error FROM stage_trace WHERE cycle_id = ? AND stage_name = 'RESPOND'`)
      .get(cycle.id) as { error: string | null };
    expect(trace.error).toContain(PROVIDER_ERROR);

    const record = db.raw
      .prepare(`SELECT status, error FROM cycle_record WHERE id = ?`)
      .get(cycle.id) as { status: string; error: string | null };
    expect(record.status).toBe('degraded');
    expect(record.error).toContain(PROVIDER_ERROR);
  });

  it('writes the answer to the transcript, next to the question', async () => {
    // The defect in its most direct form: before this, the only row here was his.
    const cycle = await ask('Tum kaisi ho aaj?');
    const written = turns(cycle.id);

    expect(written.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(written[0]?.text).toBe('Tum kaisi ho aaj?');
    expect(written[1]?.text).toBe(said(cycle)?.text);
  });

  it('labels the turn as its own fallback, in the record that outlives the process', async () => {
    const cycle = await ask('Tum kaisi ho aaj?');

    expect(said(cycle)?.disclosuresApplied).toContain(RESPOND_FALLBACK);
    // And the same marker in the durable row, which is what a reader has months
    // later when they wonder why one turn reads unlike the rest.
    const assistant = turns(cycle.id).find((t) => t.role === 'assistant');
    expect(JSON.parse(assistant?.metadata_json ?? '{}')).toMatchObject({
      disclosuresApplied: expect.arrayContaining([RESPOND_FALLBACK]),
    });
  });

  it('still runs the disclosure gate over the fallback', async () => {
    const cycle = await ask('Tum kaisi ho aaj?');
    // The gate is the only producer of caller-visible text, degraded or not, and
    // the marker is appended to its verdict rather than replacing it.
    expect(said(cycle)?.disclosuresApplied).toContain('knowledge_disclosure_policy');
  });

  it('learns from what she actually said, not from a line she never said', async () => {
    // Stage 10 used to be handed a hardcoded default while the transcript stayed
    // empty — so the one place the fallback existed was the only place it was
    // never spoken.
    const cycle = await ask('Tum kaisi ho aaj?');
    const trace = db.raw
      .prepare(`SELECT input_json FROM stage_trace WHERE cycle_id = ? AND stage_name = 'LEARN'`)
      .get(cycle.id) as { input_json: string | null };
    expect(trace.input_json).toContain(RESPOND_FALLBACK);
  });

  it('greets normally, because a greeting never needed a faculty', async () => {
    // Degradation should cost exactly as much as it actually costs. "Namaste" is
    // answerable without a model, so this turn reads like any other.
    const cycle = await ask('Namaste');
    expect(cycle.status).toBe('degraded');
    expect(said(cycle)?.text).toMatch(/^Hello/);
    expect(said(cycle)?.text).not.toMatch(/could not/i);
  });

  it('says nothing extra when the faculty works', async () => {
    const working: ResponseFaculty = {
      draftResponse: vi.fn().mockResolvedValue({ text: 'Theek hoon, Ankit.' }),
    };
    const cycle = await runtimeWith(working).runCycle({
      source: 'text',
      payload: { text: 'Tum kaisi ho aaj?' },
      receivedAt: Date.now(),
      identityId: owner.id,
      conversationId: 'conv-1',
    });

    expect(cycle.status).toBe('completed');
    expect(said(cycle)?.text).toBe('Theek hoon, Ankit.');
    expect(said(cycle)?.disclosuresApplied).not.toContain(RESPOND_FALLBACK);
  });
});
