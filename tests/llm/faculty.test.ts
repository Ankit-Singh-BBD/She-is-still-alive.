/**
 * The language faculty, checked without a network or an API key.
 *
 * `GeminiLanguageModel` takes its transport as a function, so everything in it
 * that can actually be wrong — the budget clamp, the truncation, the deadline,
 * the JSON parse, the error translation — is reachable from a fake. What is
 * asserted here is the part that protects her rather than the part that is
 * clever: that a stage cannot spend another stage's tokens, that a hung provider
 * becomes a `degraded` cycle instead of a hang, that a malformed answer is a
 * loud failure, and that nothing she was told is copied into a durable error
 * message.
 *
 * The prompt builders are checked through the real adapters for the same reason:
 * a prompt is the one place an owner-only memory could leak to a guest, and
 * `renderMemory`'s disclosure filter is the thing standing between the two.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_STAGE_TOKEN_BUDGETS, TokenBudgetManager } from '@server/cognition/budgets.js';
import type {
  ActionResult,
  AuthorizedDecision,
  IdentifiedStimulus,
  RecalledContext,
  VerificationReport,
} from '@server/cognition/types.js';
import type { PermissionSet } from '@server/identity/types.js';
import type { ScopedMemoryItem } from '@server/memory/types.js';
import { LanguageFaculties } from '@server/llm/faculties.js';
import {
  GeminiLanguageModel,
  type GeminiTransport,
  type GeminiTransportRequest,
} from '@server/llm/gemini.js';
import { LanguageFacultyError } from '@server/llm/types.js';

// ── Fakes ───────────────────────────────────────────────────────────────────

/** A transport that answers with one canned body and records what it was sent. */
function stubTransport(body: unknown | string): {
  transport: GeminiTransport;
  sent: GeminiTransportRequest[];
} {
  const sent: GeminiTransportRequest[] = [];
  const transport: GeminiTransport = (request) => {
    sent.push(request);
    return Promise.resolve({
      text: typeof body === 'string' ? body : JSON.stringify(body),
      modelVersion: 'gemini-2.5-flash-lite-001',
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 22, totalTokenCount: 33 },
    });
  };
  return { transport, sent };
}

function modelWith(
  transport: GeminiTransport,
  overrides: { timeoutMs?: number; budgets?: TokenBudgetManager } = {},
): GeminiLanguageModel {
  return new GeminiLanguageModel({
    transport,
    model: 'gemini-2.5-flash-lite',
    temperature: 0.4,
    timeoutMs: overrides.timeoutMs ?? 5_000,
    ...(overrides.budgets ? { budgets: overrides.budgets } : {}),
  });
}

function facultiesWith(
  transport: GeminiTransport,
  toolIds: readonly string[] = [],
): LanguageFaculties {
  return new LanguageFaculties({ model: modelWith(transport), toolIds: () => toolIds });
}

const PERMISSIONS: PermissionSet = {
  mayReadMemories: true,
  mayReadConversations: true,
  mayTriggerActions: 'safe',
  mayEnrollNewKnowledge: false,
  mayMutatePreferences: false,
  mayAccessTools: [],
  mayBeHeardInVoice: true,
  mayReceiveProactiveMessages: false,
};

function stimulus(overrides: Partial<IdentifiedStimulus> = {}): IdentifiedStimulus {
  return {
    source: 'text',
    payload: { text: 'kya haal hai' },
    receivedAt: 1_700_000_000_000,
    identityId: 'id_owner',
    identityKind: 'owner',
    callerPermissions: PERMISSIONS,
    inputType: 'user_message',
    ...overrides,
  };
}

function memory(overrides: Partial<ScopedMemoryItem>): ScopedMemoryItem {
  return {
    id: 'mem_1',
    domain: 'semantic',
    identityId: 'id_owner',
    subjectKind: 'owner',
    sensitivity: 'public',
    confidence: 0.9,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function recalled(overrides: Partial<RecalledContext> = {}): RecalledContext {
  return {
    stimulus: stimulus(),
    episodic: [],
    semantic: [],
    preferences: [],
    habits: [],
    relationships: [],
    learnedPatterns: [],
    retrievedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const UNDERSTANDING_BODY = {
  intent: 'respond',
  confidence: 0.8,
  disambiguationNeeded: false,
  clarifyingQuestions: [],
  entities: [{ key: 'topic', value: 'chai' }],
};

// ── The transport ───────────────────────────────────────────────────────────

describe('GeminiLanguageModel', () => {
  it('spends the asking stage’s output budget, not another stage’s', async () => {
    const { transport, sent } = stubTransport(UNDERSTANDING_BODY);
    const model = modelWith(transport);
    const call = { systemInstruction: 'x', prompt: 'y', schema: { type: 'object' } };

    await model.generateJson({ stage: 'UNDERSTAND', ...call });
    await model.generateJson({ stage: 'REASON', ...call });

    expect(sent[0]?.config.maxOutputTokens).toBe(DEFAULT_STAGE_TOKEN_BUDGETS.UNDERSTAND.maxOutputTokens);
    expect(sent[1]?.config.maxOutputTokens).toBe(DEFAULT_STAGE_TOKEN_BUDGETS.REASON.maxOutputTokens);
    expect(sent[0]?.config.maxOutputTokens).not.toBe(sent[1]?.config.maxOutputTokens);
  });

  it('clamps an over-budget stage configuration to its hard ceiling', async () => {
    const budgets = new TokenBudgetManager();
    budgets.setBudget('UNDERSTAND', { maxOutputTokens: 99_000 });
    const { transport, sent } = stubTransport(UNDERSTANDING_BODY);

    await modelWith(transport, { budgets }).generateJson({
      stage: 'UNDERSTAND',
      systemInstruction: 'x',
      prompt: 'y',
      schema: { type: 'object' },
    });

    expect(sent[0]?.config.maxOutputTokens).toBe(DEFAULT_STAGE_TOKEN_BUDGETS.UNDERSTAND.hardCeiling);
  });

  it('truncates a prompt past the input budget and says so in usage', async () => {
    const { transport, sent } = stubTransport(UNDERSTANDING_BODY);
    const maxChars = DEFAULT_STAGE_TOKEN_BUDGETS.UNDERSTAND.maxInputTokens * 4;

    const result = await modelWith(transport).generateJson({
      stage: 'UNDERSTAND',
      systemInstruction: 'x',
      prompt: 'a'.repeat(maxChars + 500),
      schema: { type: 'object' },
    });

    expect(result.usage.truncated).toBe(true);
    expect(sent[0]?.contents).toBe(`${'a'.repeat(maxChars)}... [TRUNCATED]`);
  });

  it('leaves a prompt inside the budget alone', async () => {
    const { transport, sent } = stubTransport(UNDERSTANDING_BODY);

    const result = await modelWith(transport).generateJson({
      stage: 'UNDERSTAND',
      systemInstruction: 'x',
      prompt: 'short enough',
      schema: { type: 'object' },
    });

    expect(result.usage.truncated).toBe(false);
    expect(sent[0]?.contents).toBe('short enough');
  });

  it('requires JSON of the provider and passes the caller’s schema through', async () => {
    const { transport, sent } = stubTransport(UNDERSTANDING_BODY);
    const schema = { type: 'object', properties: { intent: { type: 'string' } } };

    await modelWith(transport).generateJson({
      stage: 'DECIDE',
      systemInstruction: 'x',
      prompt: 'y',
      schema,
    });

    expect(sent[0]?.config.responseMimeType).toBe('application/json');
    expect(sent[0]?.config.responseSchema).toBe(schema);
    expect(sent[0]?.model).toBe('gemini-2.5-flash-lite');
  });

  it('reports the model version the provider answered with', async () => {
    const { transport } = stubTransport(UNDERSTANDING_BODY);
    const result = await modelWith(transport).generateJson({
      stage: 'DECIDE',
      systemInstruction: 'x',
      prompt: 'y',
      schema: { type: 'object' },
    });
    expect(result.model).toBe('gemini-2.5-flash-lite-001');
  });

  it('aborts a call that outlives its deadline, and names the deadline', async () => {
    // A provider that never answers on its own. The only thing that ends this
    // request is the model's own AbortController, which is the point.
    const transport: GeminiTransport = (request) =>
      new Promise((_resolve, reject) => {
        request.config.abortSignal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
      });

    await expect(
      modelWith(transport, { timeoutMs: 20 }).generateJson({
        stage: 'REASON',
        systemInstruction: 'x',
        prompt: 'y',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow(/Language faculty failed at REASON: no answer within 20ms/);
  });

  it('treats an empty answer as no proposal at all', async () => {
    const { transport } = stubTransport('   ');
    await expect(
      modelWith(transport).generateJson({
        stage: 'RESPOND',
        systemInstruction: 'x',
        prompt: 'y',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow(/the model returned no content/);
  });

  it('refuses prose from a call that demanded JSON', async () => {
    const { transport } = stubTransport('sure, here you go!');
    await expect(
      modelWith(transport).generateJson({
        stage: 'LEARN',
        systemInstruction: 'x',
        prompt: 'y',
        schema: { type: 'object' },
      }),
    ).rejects.toThrow(/not JSON despite being asked for JSON/);
  });

  it('keeps the prompt out of the error a transport failure produces', async () => {
    const secret = 'she lives at 12 Nowhere Lane';
    const transport: GeminiTransport = () => Promise.reject(new Error('429 quota exceeded'));

    const error = await modelWith(transport)
      .generateJson({
        stage: 'RESPOND',
        systemInstruction: 'x',
        prompt: secret,
        schema: { type: 'object' },
      })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LanguageFacultyError);
    expect((error as Error).message).toContain('429 quota exceeded');
    expect((error as Error).message).not.toContain(secret);
  });
});

// ── The adapters ────────────────────────────────────────────────────────────

describe('LanguageFaculties', () => {
  it('folds the wire’s entity pairs into the record the stage expects', async () => {
    const { transport } = stubTransport(UNDERSTANDING_BODY);
    const proposal = await facultiesWith(transport).proposeUnderstanding({
      stimulus: stimulus(),
      recalled: recalled(),
    });

    expect(proposal.intent).toBe('respond');
    expect(proposal.entities).toEqual({ topic: 'chai' });
  });

  it('names what drifted in a schema failure without recording what she was told', async () => {
    const { transport } = stubTransport({
      intent: 'remember_event',
      confidence: 5,
      disambiguationNeeded: false,
      clarifyingQuestions: [],
      entities: [],
    });

    const error = await facultiesWith(transport)
      .proposeUnderstanding({ stimulus: stimulus(), recalled: recalled() })
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(LanguageFacultyError);
    const message = (error as Error).message;
    expect(message).toContain('did not match the schema');
    expect(message).toContain('intent: invalid_enum_value');
    // The offending value is what a stage trace must not keep.
    expect(message).not.toContain('remember_event');
  });

  it('reduces a tool she was never shown to a clarification that names it', async () => {
    const { transport } = stubTransport({
      action: 'execute_tool',
      toolId: 'drop_all_memories',
      rationale: 'seemed useful',
    });

    const proposal = await facultiesWith(transport, ['memory.remember']).proposeDecision({
      stimulus: stimulus(),
      reasoning: { steps: [], optionsConsidered: [], recommendedApproach: 'execute' },
    });

    expect(proposal.action).toBe('clarify');
    expect(proposal.rationale).toContain('drop_all_memories');
    expect(proposal.toolId).toBeUndefined();
  });

  it('keeps a tool that is installed', async () => {
    const { transport } = stubTransport({
      action: 'execute_tool',
      toolId: 'memory.remember',
      toolInputJson: '{"text":"chai"}',
      rationale: 'she asked me to remember it',
    });

    const proposal = await facultiesWith(transport, ['memory.remember']).proposeDecision({
      stimulus: stimulus(),
      reasoning: { steps: [], optionsConsidered: [], recommendedApproach: 'execute' },
    });

    expect(proposal.action).toBe('execute_tool');
    expect(proposal.toolId).toBe('memory.remember');
    expect(proposal.toolInput).toEqual({ text: 'chai' });
  });

  it('reads the tool roster at call time, so a tool registered later is offered', async () => {
    const { transport, sent } = stubTransport({ action: 'respond', rationale: 'talking' });
    const roster: string[] = ['memory.remember'];
    const faculties = new LanguageFaculties({
      model: modelWith(transport),
      toolIds: () => roster,
    });
    const call = {
      stimulus: stimulus(),
      reasoning: { steps: [], optionsConsidered: [], recommendedApproach: 'respond' as const },
    };

    await faculties.proposeDecision(call);
    roster.push('task.schedule');
    await faculties.proposeDecision(call);

    expect(sent[0]?.contents).not.toContain('task.schedule');
    expect(sent[1]?.contents).toContain('task.schedule');
  });
});

// ── What she is shown ───────────────────────────────────────────────────────

const DECISION: AuthorizedDecision = {
  proposal: { action: 'execute_tool', toolId: 'memory.remember', rationale: 'she asked' },
  authorized: true,
  clearanceChecked: true,
};

function ran(overrides: Partial<ActionResult> = {}): ActionResult {
  return { toolId: 'memory.remember', success: true, verified: false, ...overrides };
}

describe('the RESPOND prompt', () => {
  async function promptFor(input: {
    results: ActionResult[];
    verification?: VerificationReport | undefined;
    recalled?: RecalledContext;
  }): Promise<string> {
    const { transport, sent } = stubTransport({ text: 'thik hai' });
    await facultiesWith(transport).draftResponse({
      recalled: input.recalled ?? recalled(),
      decision: DECISION,
      results: input.results,
      verification: input.verification,
    });
    return sent[0]?.contents ?? '';
  }

  it('forbids success language over an action that could not be confirmed', async () => {
    const prompt = await promptFor({ results: [ran({ verified: false })] });
    expect(prompt).toContain('could NOT be confirmed — you may not say it happened');
  });

  it('permits it only once stored state confirmed the action', async () => {
    const prompt = await promptFor({
      results: [ran({ verified: true, output: { id: 'mem_9' } })],
    });
    expect(prompt).toContain('confirmed against stored state — you may say this happened');
    expect(prompt).toContain('mem_9');
  });

  it('passes on why confirmation failed, so she can say it herself', async () => {
    const prompt = await promptFor({
      results: [ran({ verified: false })],
      verification: {
        preconditionsMet: true,
        postconditionsMet: false,
        discrepancies: ['no row found for the id the tool returned'],
        results: [ran({ verified: false })],
        recheckedAt: 1,
      },
    });
    expect(prompt).toContain('no row found for the id the tool returned');
  });

  it('does not put an owner-only memory in front of a guest at all', async () => {
    const guestFacing = recalled({
      stimulus: stimulus({ identityId: 'id_guest', identityKind: 'guest' }),
      semantic: [
        memory({ id: 'mem_pub', sensitivity: 'public', subject: 'Madhurita', predicate: 'drinks', object: 'chai' }),
        memory({
          id: 'mem_own',
          sensitivity: 'owner_only',
          subject: 'Ankit',
          predicate: 'is seeing',
          object: 'a cardiologist on Thursday',
        }),
      ],
    });

    const prompt = await promptFor({ results: [], recalled: guestFacing });

    expect(prompt).toContain('drinks chai');
    // Redaction downstream matches literal strings, so a paraphrase would walk
    // past it. The guarantee is that the sentence never reaches the model.
    expect(prompt).not.toContain('cardiologist');
    expect(prompt).toContain('1 further memory is loaded but not yours to share');
  });

  it('tells the owner about their own owner-only memory', async () => {
    const ownerFacing = recalled({
      semantic: [
        memory({ id: 'mem_own', sensitivity: 'owner_only', subject: 'Ankit', predicate: 'sleeps by', object: 'two' }),
      ],
    });

    const prompt = await promptFor({ results: [], recalled: ownerFacing });

    expect(prompt).toContain('sleeps by two');
    expect(prompt).not.toContain('not yours to share');
  });
});

// ── LEARN, live and after the fact ──────────────────────────────────────────

describe('the LEARN faculty', () => {
  const LIVE_INPUT = {
    recalled: recalled(),
    decision: DECISION,
    response: { text: 'yaad rakh liya', voiceEnabled: false, disclosuresApplied: [], redacted: false },
    actionResults: [{ toolId: 'memory.remember', success: true, verified: true }],
    verification: undefined,
  };

  it('drops one extraction whose payload did not parse and keeps the rest', async () => {
    const { transport } = stubTransport({
      extractions: [
        { domain: 'preference', dataJson: '{"key":"drink","value":"chai"}', confidence: 0.9, importance: 0.7 },
        { domain: 'semantic', dataJson: 'not json at all', confidence: 0.9, importance: 0.9 },
        { domain: 'habit', dataJson: '{"pattern":"calls at night"}', confidence: 0.8, importance: 0.6 },
      ],
    });

    const proposals = await facultiesWith(transport).proposeExtractions(LIVE_INPUT);

    expect(proposals.map((p) => p.domain)).toEqual(['preference', 'habit']);
    expect(proposals[0]?.data).toEqual({ key: 'drink', value: 'chai' });
  });

  it('defaults an unlabelled extraction to the narrowest scope', async () => {
    const { transport } = stubTransport({
      extractions: [
        { domain: 'preference', dataJson: '{"key":"drink","value":"chai"}', confidence: 0.9, importance: 0.7 },
      ],
    });

    const proposals = await facultiesWith(transport).proposeExtractions(LIVE_INPUT);

    expect(proposals[0]?.sensitivity).toBe('owner_only');
    expect(proposals[0]?.subjectKind).toBe('owner');
  });

  it('answers an empty exchange with an empty list rather than failing', async () => {
    const { transport } = stubTransport({ extractions: [] });
    await expect(facultiesWith(transport).proposeExtractions(LIVE_INPUT)).resolves.toEqual([]);
  });

  it('reviews a stored transcript with the same instruction as the live stage', async () => {
    const { transport, sent } = stubTransport({ extractions: [] });

    await facultiesWith(transport).proposeExtractionsFromTranscript({
      cycle: { status: 'completed', decision: 'respond — nothing to do', answered: 'thik hai' },
      messages: [
        { role: 'user', text: 'mera naam Ankit hai' },
        { role: 'assistant', text: 'yaad rakh liya' },
      ],
      speakerKind: 'owner',
      alreadyKnown: ['[preference] drink = chai'],
    });

    const prompt = sent[0]?.contents ?? '';
    expect(sent[0]?.config.systemInstruction).toContain('This is the LEARN stage');
    expect(prompt).toContain('reviewing afterwards, not one you are in');
    expect(prompt).toContain('user: mera naam Ankit hai');
    expect(prompt).toContain('already remember this about them');
    expect(prompt).toContain('[preference] drink = chai');
  });

  it('says plainly when nothing was loaded about what she already knows', async () => {
    const { transport, sent } = stubTransport({ extractions: [] });

    await facultiesWith(transport).proposeExtractionsFromTranscript({
      cycle: { status: 'degraded' },
      messages: [],
      speakerKind: 'guest',
    });

    const prompt = sent[0]?.contents ?? '';
    expect(prompt).toContain('Nothing was loaded here about what you already remember');
    expect(prompt).toContain('(no messages were recorded for this cycle)');
  });

  it('keeps the end of a long transcript, and admits what it dropped', async () => {
    const { transport, sent } = stubTransport({ extractions: [] });
    const messages = Array.from({ length: 30 }, (_unused, i) => ({
      role: 'user',
      text: `turn number ${i}`,
    }));

    await facultiesWith(transport).proposeExtractionsFromTranscript({
      cycle: { status: 'completed' },
      messages,
      speakerKind: 'owner',
    });

    const prompt = sent[0]?.contents ?? '';
    expect(prompt).toContain('last 24 of 30 turns');
    expect(prompt).toContain('turn number 29');
    expect(prompt).not.toContain('turn number 5');
  });
});
