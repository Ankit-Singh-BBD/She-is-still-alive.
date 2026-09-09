/**
 * The boundary the language model may not cross.
 *
 * Part II of the build book: `LLM PROPOSAL → APP VALIDATION → APP
 * AUTHORIZATION → EXECUTION`. The model is a *faculty* — one organ among
 * several — and this file is written to make the wrong thing hard rather than
 * merely discouraged. A `LanguageModel` here can do exactly one thing: turn a
 * prompt into JSON. It is handed no database, no repository, no event bus, no
 * tool registry and no identity. There is nothing it could mutate, persist,
 * execute, publish or disclose even if a prompt talked it into trying.
 *
 * Everything downstream of `generateJson` is application code: the faculty
 * adapters in `./faculties.ts` parse the JSON with the stage's own Zod schema,
 * and the stage itself then validates, clamps and authorizes. A model that
 * returns nonsense produces a rejected proposal, never a bad write.
 *
 * ## Why this returns `unknown`
 *
 * `generateJson` deliberately does not take a schema and hand back a typed
 * value. Structured-output support is a property of one provider's API, and a
 * transport that promised typed results would be promising something it cannot
 * check. So the transport returns whatever the model said, parsed as JSON, and
 * the caller — which owns the type — is the one that validates.
 */

import type { CognitiveStageKey } from '@server/cognition/budgets.js';

/**
 * A JSON Schema fragment, in the subset Gemini's `responseSchema` accepts.
 *
 * Typed loosely on purpose: this is a wire format, not a domain type, and every
 * schema in `./schemas.ts` is written once and read by the provider rather than
 * by us.
 */
export interface JsonSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  nullable?: boolean;
}

export interface LanguageModelRequest {
  /**
   * Which cognitive stage is asking. This is what the token budget is looked up
   * by, so a stage cannot spend another stage's allowance.
   */
  stage: CognitiveStageKey;
  /** Who she is, and what this stage of thinking is for. */
  systemInstruction: string;
  /** The stage's input, already reduced to text by the faculty adapter. */
  prompt: string;
  /** The shape the answer must take. */
  schema: JsonSchema;
}

/** What a call actually cost, as the provider reported it. */
export interface LanguageModelUsage {
  promptTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  /** True when the prompt was cut to fit the stage's input budget. */
  truncated: boolean;
}

export interface LanguageModelResult {
  /** The model's answer, parsed as JSON. Never validated here. */
  json: unknown;
  /** The model that answered, as the provider named it. */
  model: string;
  usage: LanguageModelUsage;
  elapsedMs: number;
}

/**
 * The only capability the language faculty has.
 *
 * One method, no state, no side effects. An implementation that needed anything
 * else would be doing something the Application is supposed to do.
 */
export interface LanguageModel {
  generateJson(request: LanguageModelRequest): Promise<LanguageModelResult>;
  /** For the boot banner and for provenance on anything she learns. */
  readonly modelId: string;
}

/**
 * Raised when the faculty could not produce a usable proposal.
 *
 * A stage that catches nothing lets this reach `CognitiveRuntime.runStage`,
 * which records it on the trace and substitutes the stage's documented
 * fallback — so the cycle reports `degraded`. That is the honest outcome: she
 * answered, and the record says the thinking faculty was not available.
 * Swallowing it inside the faculty and silently returning a heuristic would
 * make a broken model look like a working one.
 */
export class LanguageFacultyError extends Error {
  constructor(
    readonly stage: CognitiveStageKey,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`Language faculty failed at ${stage}: ${message}`);
    this.name = 'LanguageFacultyError';
  }
}
