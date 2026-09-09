/**
 * The language faculty, assembled.
 *
 * One function, one decision: is a real model available, or is she running on
 * the deterministic heuristics the stages already carry? Both are supported ways
 * to run — `config.llm.enabled` is false whenever `GOOGLE_API_KEY` is absent,
 * and every stage has a documented fallback — so this returns `undefined`
 * rather than throwing, and the caller passes `undefined` straight through to
 * the stages as "no faculty wired".
 *
 * Nothing else in the process constructs a Gemini client. `config.llm.apiKey`
 * is read here, handed to `createGeminiTransport`, and closed over; it is never
 * stored on an object a stage can reach and never written to a log.
 */

import type { Config } from '@server/config/env.js';

import { createGeminiTransport, GeminiLanguageModel } from './gemini.js';
import { LanguageFaculties } from './faculties.js';
import type { LanguageModel } from './types.js';

export {
  LanguageFacultyError,
  type JsonSchema,
  type LanguageModel,
  type LanguageModelRequest,
  type LanguageModelResult,
  type LanguageModelUsage,
} from './types.js';
export {
  createGeminiTransport,
  GeminiLanguageModel,
  type GeminiTransport,
  type GeminiTransportRequest,
  type GeminiTransportResponse,
} from './gemini.js';
export { LanguageFaculties, type ExtractionProposal } from './faculties.js';
export { IDENTITY, SYSTEM_INSTRUCTIONS } from './prompts.js';

export interface CreateLanguageFacultiesOptions {
  config: Config;
  /** The installed tool roster, read at call time. See `LanguageFaculties`. */
  toolIds: () => readonly string[];
  /** Injectable so a test can drive the real adapters without a network. */
  model?: LanguageModel | undefined;
}

/**
 * Builds the faculties, or reports honestly that there are none.
 *
 * `undefined` is not an error path. It is the configuration in which she thinks
 * with rules instead of with a model, and the boot banner says so.
 */
export function createLanguageFaculties(
  options: CreateLanguageFacultiesOptions,
): LanguageFaculties | undefined {
  const model = options.model ?? realModel(options.config);
  if (!model) return undefined;
  return new LanguageFaculties({ model, toolIds: options.toolIds });
}

function realModel(config: Config): LanguageModel | undefined {
  if (!config.llm.enabled || config.llm.apiKey === undefined) return undefined;
  return new GeminiLanguageModel({
    transport: createGeminiTransport(config.llm.apiKey),
    model: config.llm.reasoningModel,
    temperature: config.llm.temperature,
    timeoutMs: config.llm.timeoutMs,
  });
}
