/**
 * The Gemini transport.
 *
 * One class, one job: send a prompt to the configured reasoning model
 * (`DEFAULT_REASONING_MODEL` unless `LLM_REASONING_MODEL` says otherwise) and
 * return the JSON it answered with. Everything that makes it safe to hand to a
 * cognitive stage lives here, and each of these is a rule the model cannot talk
 * its way out of because it is applied on this side of the wire:
 *
 *  - **The stage's token budget is enforced, not requested.** The prompt is
 *    truncated to the stage's `maxInputTokens` before it is sent, and
 *    `maxOutputTokens` is clamped to the stage's `hardCeiling`. A stage cannot
 *    spend another stage's allowance, and a prompt built from a long
 *    conversation cannot quietly grow the bill.
 *
 *  - **Structured output is required.** `responseMimeType` is
 *    `application/json` and the caller's schema is sent as `responseSchema`, so
 *    prose is a provider-level error rather than a parse failure three frames
 *    later.
 *
 *  - **Every call has a deadline.** `LLM_TIMEOUT_MS` becomes an `AbortSignal`,
 *    because a cognitive cycle that hangs is worse than one that degrades: she
 *    stops answering at all.
 *
 *  - **Nothing is logged.** Not the key, not the prompt. The prompt is built
 *    from her memories, and this class has no business deciding that any of it
 *    is safe to write to a terminal.
 *
 * ## Why the transport is injected
 *
 * `GoogleGenAI` is constructed in `createGeminiTransport`, and this class takes
 * the resulting function rather than the client. That is what lets the whole of
 * this file be tested without a network or an API key — the budget clamp, the
 * truncation, the JSON parse and the error translation are the parts that can
 * actually be wrong, and none of them need Google to be reachable to be checked.
 */

import { GoogleGenAI } from '@google/genai';

import type { CognitiveStageKey } from '@server/cognition/budgets.js';
import { TokenBudgetManager } from '@server/cognition/budgets.js';
import {
  LanguageFacultyError,
  type JsonSchema,
  type LanguageModel,
  type LanguageModelRequest,
  type LanguageModelResult,
} from './types.js';

/** What one round trip to the provider looks like, reduced to what we use. */
export interface GeminiTransportRequest {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    temperature: number;
    maxOutputTokens: number;
    responseMimeType: string;
    responseSchema: JsonSchema;
    abortSignal?: AbortSignal | undefined;
  };
}

export interface GeminiTransportResponse {
  text?: string | undefined;
  modelVersion?: string | undefined;
  usageMetadata?:
    | {
        promptTokenCount?: number | undefined;
        candidatesTokenCount?: number | undefined;
        totalTokenCount?: number | undefined;
      }
    | undefined;
}

export type GeminiTransport = (
  request: GeminiTransportRequest,
) => Promise<GeminiTransportResponse>;

/**
 * Builds the real transport.
 *
 * The client is constructed once and closed over, so the key exists in exactly
 * one place in the process and no caller of `generateJson` is ever handed it.
 */
export function createGeminiTransport(apiKey: string): GeminiTransport {
  const client = new GoogleGenAI({ apiKey });
  return async (request) => {
    const response = await client.models.generateContent({
      model: request.model,
      contents: request.contents,
      config: {
        systemInstruction: request.config.systemInstruction,
        temperature: request.config.temperature,
        maxOutputTokens: request.config.maxOutputTokens,
        responseMimeType: request.config.responseMimeType,
        responseSchema: request.config.responseSchema,
        ...(request.config.abortSignal ? { abortSignal: request.config.abortSignal } : {}),
      },
    });
    return {
      text: response.text,
      modelVersion: response.modelVersion,
      usageMetadata: response.usageMetadata,
    };
  };
}

export interface GeminiLanguageModelOptions {
  transport: GeminiTransport;
  model: string;
  temperature: number;
  timeoutMs: number;
  /** Defaults to the budgets in `server/cognition/budgets.ts`. */
  budgets?: TokenBudgetManager | undefined;
  /** Injectable for tests; defaults to `Date.now`. */
  now?: (() => number) | undefined;
}

export class GeminiLanguageModel implements LanguageModel {
  readonly modelId: string;

  private readonly transport: GeminiTransport;
  private readonly temperature: number;
  private readonly timeoutMs: number;
  private readonly budgets: TokenBudgetManager;
  private readonly now: () => number;

  constructor(options: GeminiLanguageModelOptions) {
    this.transport = options.transport;
    this.modelId = options.model;
    this.temperature = options.temperature;
    this.timeoutMs = options.timeoutMs;
    this.budgets = options.budgets ?? new TokenBudgetManager();
    this.now = options.now ?? Date.now;
  }

  async generateJson(request: LanguageModelRequest): Promise<LanguageModelResult> {
    const startedAt = this.now();
    const prompt = this.budgets.truncateToBudget(request.stage, request.prompt);
    const truncated = prompt !== request.prompt;
    const maxOutputTokens = this.budgets.enforceCeiling(
      request.stage,
      this.budgets.getBudget(request.stage).maxOutputTokens,
    );

    // A deadline, not a hope. `AbortController` is used rather than a race so
    // the request is actually cancelled instead of being left in flight.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: GeminiTransportResponse;
    try {
      response = await this.transport({
        model: this.modelId,
        contents: prompt,
        config: {
          systemInstruction: request.systemInstruction,
          temperature: this.temperature,
          maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: request.schema,
          abortSignal: controller.signal,
        },
      });
    } catch (error) {
      // The provider's own message is kept, but nothing of the prompt is — this
      // string reaches a stage trace, which is durable.
      throw new LanguageFacultyError(
        request.stage,
        controller.signal.aborted
          ? `no answer within ${this.timeoutMs}ms`
          : errorMessage(error),
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = response.text?.trim();
    if (!text) {
      // An empty answer is the shape a safety block or an output-token cutoff
      // takes. Either way there is no proposal, and pretending otherwise would
      // hand the stage an empty object to validate.
      throw new LanguageFacultyError(request.stage, 'the model returned no content');
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LanguageFacultyError(
        request.stage,
        'the model returned something that is not JSON despite being asked for JSON',
      );
    }

    return {
      json,
      model: response.modelVersion ?? this.modelId,
      usage: {
        promptTokens: response.usageMetadata?.promptTokenCount,
        outputTokens: response.usageMetadata?.candidatesTokenCount,
        totalTokens: response.usageMetadata?.totalTokenCount,
        truncated,
      },
      elapsedMs: this.now() - startedAt,
    };
  }

  /** The budget this model would apply to a stage. Read by tests and the doc. */
  budgetFor(stage: CognitiveStageKey): ReturnType<TokenBudgetManager['getBudget']> {
    return this.budgets.getBudget(stage);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
