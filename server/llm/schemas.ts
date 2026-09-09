/**
 * What each faculty is allowed to say, in two forms that sit next to each other.
 *
 * Every entry here is a pair: the JSON Schema sent to the provider as
 * `responseSchema`, and the Zod schema the answer is parsed with when it comes
 * back. They are declared together because the failure mode of keeping them
 * apart is silent — the wire schema drifts, the model starts returning a field
 * nothing reads, and the stage quietly falls back to its default forever.
 *
 * Neither schema is trusted on its own. The provider's structured output is a
 * convenience; the Zod parse is the check. A stage receives a proposal only
 * after both agree, and even then the stage clamps and authorizes it — a
 * `confidence` of 9 is rejected here, and a `toolId` she may not run is
 * rejected in stage 6.
 *
 * ## Why free-form objects travel as strings
 *
 * `DecisionProposal.toolInput` and a learning candidate's `data` are `unknown` by
 * design: their shape belongs to whichever tool or memory domain they are for, and
 * no single schema covers them. A JSON Schema cannot describe "any object", so those
 * fields cross the wire as JSON *text* and are parsed here. A model that returns
 * malformed text for one of them loses that field rather than the whole proposal.
 */

import { z } from 'zod';

import type { JsonSchema } from './types.js';

/**
 * A schema pair: what the provider is told, and what we check.
 *
 * The Zod side is `ZodType<T, ZodTypeDef, unknown>` rather than `ZodType<T>`
 * because its input really is unknown — it is whatever JSON the provider
 * returned. Declaring the input as `T` would ask Zod to accept only values that
 * are already correct, which is the one case that needs no validation.
 */
export interface FacultySchema<T> {
  json: JsonSchema;
  zod: z.ZodType<T, z.ZodTypeDef, unknown>;
}

const unitInterval = z.number().min(0).max(1);

/** Parses a JSON-text field, yielding `undefined` rather than throwing. */
const jsonText = z
  .string()
  .optional()
  .transform((value): unknown => {
    if (value === undefined || value.trim() === '') return undefined;
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  });

// ── Stage 4: UNDERSTAND ────────────────────────────────────────────────────

/**
 * The only intents stage 4 will admit.
 *
 * `validateAndNormalize` in `server/cognition/stages/4.ts` reduces anything
 * outside this set to `clarify` at confidence 0. So the vocabulary is declared
 * here as an enum the provider itself enforces — a schema that invited
 * `remember_event` or `set_reminder` would produce a proposal the application
 * throws away on arrival, and she would ask "could you rephrase that?" forever
 * while the model was answering perfectly well.
 */
export const INTENTS = ['respond', 'clarify', 'execute', 'learn', 'noop'] as const;

/**
 * `entities` is a `Record<string, unknown>` in the domain and an array of pairs
 * on the wire, because JSON Schema has no way to say "an object with keys I do
 * not know yet" that Gemini accepts.
 */
export interface UnderstandingWire {
  intent: (typeof INTENTS)[number];
  confidence: number;
  disambiguationNeeded: boolean;
  clarifyingQuestions: string[];
  entities: Record<string, unknown>;
}

export const understandingSchema: FacultySchema<UnderstandingWire> = {
  json: {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        description:
          'What the speaker wants from you, as one of these five: "respond" to say something, ' +
          '"execute" to use a tool, "learn" to remember something, "clarify" when you cannot ' +
          'tell, "noop" when nothing is called for.',
        enum: [...INTENTS],
      },
      confidence: { type: 'number', description: 'How sure you are, from 0 to 1.' },
      disambiguationNeeded: {
        type: 'boolean',
        description: 'True only when you genuinely cannot tell what was meant.',
      },
      clarifyingQuestions: {
        type: 'array',
        description: 'At most two short questions. Empty unless disambiguationNeeded is true.',
        items: { type: 'string' },
      },
      entities: {
        type: 'array',
        description: 'Named things mentioned: people, times, places, topics.',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['key', 'value'],
        },
      },
    },
    required: ['intent', 'confidence', 'disambiguationNeeded', 'clarifyingQuestions', 'entities'],
  },
  zod: z
    .object({
      intent: z.enum(INTENTS),
      confidence: unitInterval,
      disambiguationNeeded: z.boolean(),
      clarifyingQuestions: z.array(z.string().min(1).max(240)).max(3).default([]),
      entities: z
        .array(z.object({ key: z.string().min(1).max(64), value: z.string().max(400) }))
        .max(24)
        .default([]),
    })
    .transform((value) => ({
      intent: value.intent,
      confidence: value.confidence,
      disambiguationNeeded: value.disambiguationNeeded,
      clarifyingQuestions: value.clarifyingQuestions,
      entities: Object.fromEntries(value.entities.map((e) => [e.key, e.value])),
    })),
};

// ── Stage 5: REASON ────────────────────────────────────────────────────────

export interface ReasoningWire {
  steps: Array<{ description: string; conclusion: string; confidence: number }>;
  optionsConsidered: string[];
  recommendedApproach: (typeof INTENTS)[number];
}

export const reasoningSchema: FacultySchema<ReasoningWire> = {
  json: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Two to four steps. Each one has to actually follow from the last.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            conclusion: { type: 'string' },
            confidence: { type: 'number' },
          },
          required: ['description', 'conclusion', 'confidence'],
        },
      },
      optionsConsidered: {
        type: 'array',
        description: 'The approaches you weighed, including the one you rejected.',
        items: { type: 'string' },
      },
      recommendedApproach: {
        // Deliberately the same five words stage 4 uses, not the six action
        // names stage 6 uses: `heuristicProposal` in stage 6 switches on this
        // string, and 'execute_tool' would silently fall through to 'respond'.
        type: 'string',
        description: 'Which of the five approaches the steps actually support.',
        enum: [...INTENTS],
      },
    },
    required: ['steps', 'optionsConsidered', 'recommendedApproach'],
  },
  zod: z.object({
    steps: z
      .array(
        z.object({
          description: z.string().min(1).max(500),
          conclusion: z.string().min(1).max(500),
          confidence: unitInterval,
        }),
      )
      .min(1)
      .max(6),
    optionsConsidered: z.array(z.string().min(1).max(120)).max(8).default([]),
    recommendedApproach: z.enum(INTENTS),
  }),
};

// ── Stage 6: DECIDE ────────────────────────────────────────────────────────

export const DECISION_ACTIONS = [
  'respond',
  'execute_tool',
  'learn',
  'noop',
  'clarify',
] as const;

export interface DecisionWire {
  action: (typeof DECISION_ACTIONS)[number];
  toolId: string | undefined;
  toolInput: unknown;
  rationale: string;
}

export const decisionSchema: FacultySchema<DecisionWire> = {
  json: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'What to do next. Propose only; the application decides whether you may.',
        enum: [...DECISION_ACTIONS],
      },
      toolId: {
        type: 'string',
        description: 'Required when action is execute_tool. Must be one of the tools listed.',
      },
      toolInputJson: {
        type: 'string',
        description: 'The tool input as a JSON object, encoded as a string.',
      },
      rationale: {
        type: 'string',
        description: 'One sentence on why. This is recorded.',
      },
    },
    required: ['action', 'rationale'],
  },
  zod: z
    .object({
      action: z.enum(DECISION_ACTIONS),
      toolId: z.string().min(1).max(120).optional(),
      toolInputJson: jsonText,
      rationale: z.string().min(1).max(600),
    })
    .transform((value) => ({
      action: value.action,
      toolId: value.toolId,
      toolInput: value.toolInputJson,
      rationale: value.rationale,
    })),
};

// ── Stage 9: RESPOND ───────────────────────────────────────────────────────

export interface ResponseWire {
  text: string;
  voicePreferred?: boolean | undefined;
}

export const responseSchema: FacultySchema<ResponseWire> = {
  json: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'What to say. Plain sentences, no markdown, no stage directions.',
      },
      voicePreferred: {
        type: 'boolean',
        description: 'Whether this would be better spoken than shown. Permission still decides.',
      },
    },
    required: ['text'],
  },
  zod: z.object({
    text: z.string().min(1).max(4000),
    voicePreferred: z.boolean().optional(),
  }),
};

// ── Stage 10: LEARN ────────────────────────────────────────────────────────

export const MEMORY_DOMAINS = [
  'episodic',
  'semantic',
  'preference',
  'habit',
  'relationship',
  'learned_pattern',
] as const;

export const SENSITIVITIES = ['public', 'person_shared', 'owner_only'] as const;

export const SUBJECT_KINDS = ['owner', 'person', 'guest', 'system'] as const;

export interface ExtractionWire {
  domain: (typeof MEMORY_DOMAINS)[number];
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  sensitivity: (typeof SENSITIVITIES)[number];
  subjectKind: (typeof SUBJECT_KINDS)[number];
}

export const extractionsSchema: FacultySchema<{ extractions: ExtractionWire[] }> = {
  json: {
    type: 'object',
    properties: {
      extractions: {
        type: 'array',
        description:
          'Things worth remembering from this exchange. Empty is a good answer when nothing was.',
        items: {
          type: 'object',
          properties: {
            domain: { type: 'string', enum: [...MEMORY_DOMAINS] },
            dataJson: {
              type: 'string',
              description:
                'The memory itself as a JSON object, encoded as a string. Use the fields the ' +
                'domain calls for: episodic {summary, details}, semantic {subject, predicate, ' +
                'object}, preference {key, value}, habit {pattern, frequency}, relationship ' +
                '{name, relation, notes}, learned_pattern {pattern}.',
            },
            confidence: { type: 'number' },
            importance: { type: 'number' },
            sensitivity: { type: 'string', enum: [...SENSITIVITIES] },
            subjectKind: { type: 'string', enum: [...SUBJECT_KINDS] },
          },
          required: ['domain', 'dataJson', 'confidence', 'importance'],
        },
      },
    },
    required: ['extractions'],
  },
  zod: z
    .object({
      extractions: z
        .array(
          z
            .object({
              domain: z.enum(MEMORY_DOMAINS),
              dataJson: jsonText,
              confidence: unitInterval,
              importance: unitInterval,
              sensitivity: z.enum(SENSITIVITIES).default('owner_only'),
              subjectKind: z.enum(SUBJECT_KINDS).default('owner'),
            })
            .transform((value) => ({
              domain: value.domain,
              data: isRecord(value.dataJson) ? value.dataJson : undefined,
              confidence: value.confidence,
              importance: value.importance,
              sensitivity: value.sensitivity,
              subjectKind: value.subjectKind,
            })),
        )
        .max(12)
        .default([]),
    })
    // An extraction whose payload did not parse is dropped here, rather than
    // stored as an empty memory with a confident score attached.
    //
    // Dropping happens at this level and not as a `.refine` on the element,
    // which is where it was: a failing refine inside an array fails the *whole*
    // parse, so one malformed `dataJson` among four good extractions raised
    // `LanguageFacultyError`, the stage fell back, and three things she was
    // actually told were lost over the fourth. The two learn paths share this
    // schema, so that cost both of them.
    .transform((value) => ({
      extractions: value.extractions.filter(
        (extraction): extraction is ExtractionWire => extraction.data !== undefined,
      ),
    })),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
