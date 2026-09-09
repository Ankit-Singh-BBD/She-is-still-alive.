/**
 * A tool, as the deciding faculty is shown it.
 *
 * ## What was wrong
 *
 * `server/app.ts` handed the faculty `registry.list().map((tool) => tool.id)` and
 * `buildDecidePrompt` printed that bare list under "Tools you may propose, by exact
 * id". So a model asked to answer "kal 7 baje yaad dilana ki paani peena hai" was
 * shown the seven words `reminder.schedule`, `memory.remember_fact`, … and nothing
 * else — not what any of them does, and not one argument name. It then had to obey
 * the instruction "you must give its id and its input as JSON text" by *inventing*
 * the input shape from the id string.
 *
 * That input is not corrected anywhere downstream. `LlmFaculties.proposeDecision`
 * checks the id against the roster and passes `toolInput` through untouched; stage 7
 * hands it to `executor.execute`, and the tool's `inputSchema` rejects it. The cycle
 * then records `execute_tool` attempted and failed — a decision that reads as
 * capability and was a guess at a schema nobody showed her. `reminder.schedule`
 * wants `{message, when}`, `preference.set` wants `{key, value}`,
 * `memory.remember_fact` wants `{subject, predicate, object}`; there is no reading of
 * the seven ids from which those follow.
 *
 * The one path that did work was the deterministic floor, `intent/recognizer.ts`,
 * because it hardcodes the four shapes it proposes — and declines
 * `memory.remember_fact` for a written reason. So the roster the model could act on
 * was smaller than the roster it was shown, and only rules knew the difference.
 *
 * ## Why the argument list is derived and not written
 *
 * A hand-written `inputHint: '{message, when}'` beside each tool is a second copy of
 * the schema, and the failure of a second copy is silent: a tool gains a required
 * field, the hint keeps describing last month's shape, and the model keeps sending
 * input the executor rejects. Every line below is read out of the tool's own
 * `inputSchema` — the same object `ToolExecutor` validates against — so the prompt
 * and the check cannot disagree.
 *
 * `describeArgs` reads Zod's runtime `_def`, which is not part of its public API. The
 * cost of being wrong is bounded and visible: an unreadable schema yields `undefined`
 * and the tool is listed by description alone, which is what the model had for all
 * seven before. It never yields a *wrong* argument list, because every branch that
 * cannot identify a type falls through to the type's own name.
 */

import { z } from 'zod';

import type { ToolDefinition } from '@server/actions/registry.js';

/** One roster entry, flat and printable — no Zod beyond this module's edge. */
export interface ToolSpec {
  id: string;
  /** The tool's own sentence about itself. */
  description: string;
  /** `message: string, when: string, repeat?: string`, or `undefined` if unreadable. */
  args?: string | undefined;
  /**
   * Whether the tool writes.
   *
   * `'safe'` tools are readable-only; `'all'` means a caller needs full clearance.
   * Shown because "which of these changes something" is the distinction a model
   * needs to prefer a read when it is unsure, and it is already declared per tool.
   */
  clearance: 'safe' | 'all';
}

/** The roster, in registration order. */
export function toolRoster(tools: readonly ToolDefinition[]): ToolSpec[] {
  return tools.map((tool) => {
    const args = describeArgs(tool.inputSchema);
    return {
      id: tool.id,
      description: tool.description,
      ...(args === undefined ? {} : { args }),
      clearance: tool.clearanceRequired,
    };
  });
}

/**
 * `field: type` pairs for an object schema, optional fields marked with `?`.
 *
 * `undefined` for anything that is not an object schema — no tool here has a
 * non-object input, and a made-up rendering of one would be worse than silence.
 */
export function describeArgs(schema: z.ZodTypeAny): string | undefined {
  const shape = objectShape(schema);
  if (shape === undefined) return undefined;

  const parts: string[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const { type, optional } = unwrap(field);
    parts.push(`${name}${optional ? '?' : ''}: ${type}`);
  }
  return parts.length === 0 ? undefined : parts.join(', ');
}

/** The shape of an object schema, through any wrapper that preserves one. */
function objectShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | undefined {
  let current: z.ZodTypeAny = schema;
  // `.optional()`, `.default()` and `.strict()` all wrap the object they were called
  // on; unwrapping until an object appears keeps this working for a tool that used one.
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject) {
      return current.shape as Record<string, z.ZodTypeAny>;
    }
    const inner = innerType(current);
    if (inner === undefined) return undefined;
    current = inner;
  }
  return undefined;
}

/** A field's readable type, and whether it may be omitted. */
function unwrap(field: z.ZodTypeAny): { type: string; optional: boolean } {
  let current = field;
  let optional = false;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) optional = true;
    const inner = innerType(current);
    if (inner === undefined) break;
    current = inner;
  }
  return { type: typeName(current), optional };
}

/** One layer off a wrapper schema, or `undefined` when there is nothing to unwrap. */
function innerType(schema: z.ZodTypeAny): z.ZodTypeAny | undefined {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return schema.unwrap() as z.ZodTypeAny;
  }
  if (schema instanceof z.ZodDefault) {
    return schema.removeDefault() as z.ZodTypeAny;
  }
  if (schema instanceof z.ZodEffects) {
    return schema.innerType() as z.ZodTypeAny;
  }
  return undefined;
}

/**
 * A type as a word the model can act on.
 *
 * Enums and literals print their members, because that is the one case where the
 * *values* are the constraint and a bare `string` would invite a rejected input.
 */
function typeName(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return 'string';
  if (schema instanceof z.ZodNumber) return 'number';
  if (schema instanceof z.ZodBoolean) return 'boolean';
  if (schema instanceof z.ZodLiteral) return JSON.stringify(schema.value);
  if (schema instanceof z.ZodEnum) {
    return (schema.options as readonly string[]).map((o) => JSON.stringify(o)).join(' | ');
  }
  if (schema instanceof z.ZodArray) {
    return `${typeName(schema.element as z.ZodTypeAny)}[]`;
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options as readonly z.ZodTypeAny[];
    return options.map((o) => typeName(o)).join(' | ');
  }
  if (schema instanceof z.ZodObject) return 'object';
  if (schema instanceof z.ZodRecord) return 'object';
  // Not a shape this knows how to name. Zod's own type name is still true and still
  // narrows what to send, which is the whole job of this string.
  return (schema._def as { typeName?: string }).typeName?.replace(/^Zod/, '').toLowerCase() ?? 'value';
}
