import { describe, expect, it } from 'vitest';

import { GeminiLanguageModel } from '@server/llm/gemini.js';
import type { FacultyProvider } from '@server/llm/provider.js';
import { LanguageModelFaculty } from '@server/llm/provider.js';
import { FacultyRouter, STAGE_ROLE } from '@server/llm/router.js';
import type { LanguageModel, LanguageModelRequest } from '@server/llm/types.js';
import { TokenBudgetManager } from '@server/cognition/budgets.js';

function fakeModel(modelId = 'fake'): LanguageModel {
  return new GeminiLanguageModel({
    transport: async () => ({ text: '{"intent":"respond","confidence":0.5,"disambiguationNeeded":false,"clarifyingQuestions":[],"entities":{}}', modelVersion: modelId }),
    model: modelId,
    temperature: 0,
    timeoutMs: 2_000,
    budgets: new TokenBudgetManager(),
  });
}

function provider(id: string, modelId = id): FacultyProvider {
  const model = fakeModel(modelId);
  return {
    id,
    modelId,
    createFaculty: (role) => new LanguageModelFaculty({ id: `${id}:${role}`, role, model }),
  };
}

describe('faculty router — slice s1', () => {
  it('routes UNDERSTAND -> reason', () => {
    expect(STAGE_ROLE.UNDERSTAND).toBe('reason');
    expect(STAGE_ROLE.RESPOND).toBe('respond');
  });

  it('returns undefined when role has no provider (no silent fallback)', async () => {
    const router = new FacultyRouter({ providers: {} });
    expect(router.hasRole('reason')).toBe(false);
    expect(router.facultyFor('reason')).toBeUndefined();
    await expect(
      router.complete('reason', {
        stage: 'UNDERSTAND',
        systemInstruction: 'x',
        prompt: 'hi',
        schema: { type: 'object', properties: {} },
      }),
    ).rejects.toThrow(/no faculty wired for reason/);
  });

  it('swap provider without touching app call sites', async () => {
    const google = provider('google', 'gemini');
    const local = provider('local', 'qwen');
    const router = new FacultyRouter({ providers: { reason: google } });
    // Replace provider backing — app still calls router.complete('reason', ...)
    const swapped = new FacultyRouter({ providers: { reason: local } });
    expect(google.modelId).toBe('gemini');
    expect(local.modelId).toBe('qwen');
    const a = await router.complete('reason', { stage: 'UNDERSTAND', systemInstruction: '', prompt: 'hi', schema: { type: 'object', properties: {} } });
    const b = await swapped.complete('reason', { stage: 'UNDERSTAND', systemInstruction: '', prompt: 'hi', schema: { type: 'object', properties: {} } });
    expect(a.model).toBe('gemini');
    expect(b.model).toBe('qwen');
  });

  it('local-only mode refuses hosted faculty deterministically', async () => {
    const router = new FacultyRouter({ providers: { reason: provider('google') }, mode: 'local-only' });
    expect(router.facultyFor('reason')).toBeUndefined();
    await expect(
      router.complete('reason', { stage: 'UNDERSTAND', systemInstruction: '', prompt: 'x', schema: { type: 'object', properties: {} } }),
    ).rejects.toThrow(/no faculty wired/);
  });

  it('timeout surfaces as FacultyError and is not caught as silent heuristic', async () => {
    const failing: LanguageModel = {
      modelId: 'fail',
      generateJson: async () => { throw new Error('network down'); },
    };
    const failFaculty = new LanguageModelFaculty({ id: 'google:reason', role: 'reason', model: failing });
    void (0 as unknown as LanguageModelRequest);
    const router = new FacultyRouter({
      providers: { reason: { id: 'google', modelId: 'x', createFaculty: () => failFaculty } },
    });
    await expect(
      router.complete('reason', { stage: 'UNDERSTAND', systemInstruction: '', prompt: 'x', schema: { type: 'object', properties: {} } }),
    ).rejects.toThrow(/network down/);
  });

  it('describe reports mode and wired roles', () => {
    const r = new FacultyRouter({ providers: { reason: provider('google'), respond: provider('google') }, mode: 'quality' });
    const d = r.describe();
    expect(d.mode).toBe('quality');
    expect(d.roles).toEqual(expect.arrayContaining(['reason', 'respond']));
  });
});
