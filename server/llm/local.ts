/**
 * A local faculty stub — same `FacultyProvider`/`Faculty` interface, zero network.
 *
 * Deterministic by stage: returns a valid-shaped fallback payload so the stage's
 * Zod gate produces the same `degraded` trace whether the local model is
 * installed or not. Real Ollama/Qwen wiring belongs here later, behind this
 * same boundary — no caller of `FacultyRouter` should need to change.
 */

import type { Faculty, FacultyProvider, FacultyPrompt, FacultyResult } from './provider.js';
import type { FacultyRole } from './provider.js';

const STUB_JSON: Record<string, unknown> = {
  UNDERSTAND: { intent: 'respond', confidence: 0.3, disambiguationNeeded: false, clarifyingQuestions: [], entities: [] },
  REASON: { steps: [{ description: 'local stub', conclusion: 'insufficient context', confidence: 0.2 }], optionsConsidered: [], recommendedApproach: 'respond' },
  DECIDE: { action: 'respond', rationale: 'local stub — no tool chosen' },
  RESPOND: { text: 'Hello — I hear you (local stub).' },
  LEARN: { extractions: [] },
};

class LocalFaculty implements Faculty {
  readonly modelId = 'local-stub';
  constructor(
    readonly id: string,
    readonly role: FacultyRole,
  ) {}

  async complete(prompt: FacultyPrompt): Promise<FacultyResult> {
    const json = STUB_JSON[prompt.stage] ?? STUB_JSON['RESPOND'];
    return {
      json: structuredClone(json),
      model: this.modelId,
      promptTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
      truncated: false,
      elapsedMs: 0,
    };
  }
}

export class LocalFacultyProvider implements FacultyProvider {
  readonly id = 'local';
  readonly modelId = 'local-stub';
  createFaculty(role: FacultyRole): Faculty {
    return new LocalFaculty(`local:${role}`, role);
  }
}
