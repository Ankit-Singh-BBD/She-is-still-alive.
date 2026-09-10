/**
 * The Faculty seam — the place a model is replaced without rebuilding the app.
 *
 * Every stage in the cognitive cycle goes through this, not through
 * `@google/genai` directly. A new model behind `FacultyProvider` is a new
 * `server/llm/<name>.ts`, and `server/llm/router.ts` decides *which* faculty
 * to call — nothing else moves. `server/app.ts` holds one `FacultyRouter`
 * and every stage reads it; adding a provider never changes a call site.
 *
 * Two invariants:
 *
 *  1. `Faculty.complete` is the only operation. A faculty cannot read a
 *     database, publish an event, or call a tool — there is nothing here to do
 *     so with, so even a compromised prompt cannot talk it into trying.
 *
 *  2. Failure is an exception, not a silent heuristic. The router turns
 *     timeouts and schema mismatches into `FacultyError`, which a stage does
 *     not catch — `CognitiveRuntime` records it and substitutes the stage's
 *     documented fallback, so the cycle reports `degraded` honestly.
 */

import type { CognitiveStageKey } from '@server/cognition/budgets.js';
import type { JsonSchema, LanguageModel, LanguageModelResult } from './types.js';
import { LanguageFacultyError } from './types.js';

/**
 * The shape a `Faculty` call carries — what the stage actually says and what
 * shape it wants back. Stages never import a provider; they only build one of
 * these for the faculty they are about to call.
 */
export interface FacultyPrompt {
  /** Which cognitive stage is calling. Drives budget lookup and responseId. */
  stage: CognitiveStageKey;
  systemInstruction: string;
  prompt: string;
  schema: JsonSchema;
}

/** What a faculty hands back. Parsed but not yet Zod-checked by the stage. */
export interface FacultyResult {
  json: unknown;
  model: string;
  promptTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  truncated: boolean;
  elapsedMs: number;
}

export type FacultyRole = 'reason' | 'decide' | 'respond' | 'learn' | 'live';
export const FACULTY_MODES = ['local-only', 'hybrid', 'quality'] as const;
export type FacultyMode = (typeof FACULTY_MODES)[number];

export interface Faculty {
  readonly id: string;
  readonly role: FacultyRole;
  complete(prompt: FacultyPrompt): Promise<FacultyResult>;
  readonly modelId: string;
}

export interface FacultyProvider {
  readonly id: string;
  createFaculty(role: FacultyRole): Faculty;
  /** How the factory was configured, for the boot banner. */
  readonly modelId: string;
}

export class FacultyError extends LanguageFacultyError {
  constructor(
    stage: CognitiveStageKey,
    message: string,
    readonly facultyId: string,
    override readonly cause?: unknown,
  ) {
    super(stage, `[${facultyId}] ${message}`, cause);
    this.name = 'FacultyError';
  }
}

export interface LanguageModelFacultyOptions {
  id: string;
  role: FacultyRole;
  model: LanguageModel;
}

export class LanguageModelFaculty implements Faculty {
  readonly id: string;
  readonly role: FacultyRole;
  readonly modelId: string;
  private readonly model: LanguageModel;

  constructor(options: LanguageModelFacultyOptions) {
    this.id = options.id;
    this.role = options.role;
    this.model = options.model;
    this.modelId = options.model.modelId;
  }

  async complete(prompt: FacultyPrompt): Promise<FacultyResult> {
    let result: LanguageModelResult;
    try {
      result = await this.model.generateJson({
        stage: prompt.stage,
        systemInstruction: prompt.systemInstruction,
        prompt: prompt.prompt,
        schema: prompt.schema,
      });
    } catch (error) {
      if (error instanceof LanguageFacultyError) {
        const facultyError = error as FacultyError & { facultyId?: string };
        if (facultyError.facultyId !== undefined) throw error;
        throw new FacultyError(error.stage, error.message, this.id, error.cause);
      }
      const stage = prompt.stage;
      throw new FacultyError(stage, error instanceof Error ? error.message : String(error), this.id, error);
    }
    return {
      json: result.json,
      model: result.model,
      promptTokens: result.usage.promptTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      truncated: result.usage.truncated,
      elapsedMs: result.elapsedMs,
    };
  }
}
