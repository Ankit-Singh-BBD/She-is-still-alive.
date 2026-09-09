/**
 * The roster the deciding faculty is shown.
 *
 * Two things are checked here, and the second is the one that matters.
 *
 * `describeArgs` is a unit — it reads Zod's runtime `_def`, which is not public API,
 * so the shapes it must survive are written out rather than assumed.
 *
 * Then the **real seven tools**: every argument name in the prompt is asserted against
 * the schema `PipelineToolExecutor` validates against, because the failure this file
 * exists to catch is the two drifting apart. Before `toolRoster`, `server/app.ts`
 * passed `registry.list().map((tool) => tool.id)` and the prompt showed seven bare ids
 * beside the instruction "you must give its id and its input as JSON text" — so the
 * model invented `{text: …}` for a tool that wanted `{subject, predicate, object}`,
 * stage 7 rejected it, and the cycle recorded an attempted action that could not have
 * validated. A hardcoded argument hint would have had the same failure silently; these
 * assertions fail loudly the moment a tool's schema changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { z } from 'zod';

import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { loadConfig } from '@server/config/env.js';
import { createApp, type MadhuritaApp } from '@server/app.js';
import { toolRoster, describeArgs, type ToolSpec } from '@server/tools/roster.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

describe('describeArgs', () => {
  it('names every field and marks the optional ones', () => {
    const schema = z.object({
      message: z.string().trim().min(1),
      dueAt: z.number(),
      repeat: z.string().optional(),
      silent: z.boolean().default(false),
    });
    expect(describeArgs(schema)).toBe(
      'message: string, dueAt: number, repeat?: string, silent?: boolean',
    );
  });

  it('prints the members of an enum, because there the values are the constraint', () => {
    const schema = z.object({ domain: z.enum(['semantic', 'episodic']), kind: z.literal('note') });
    expect(describeArgs(schema)).toBe('domain: "semantic" | "episodic", kind: "note"');
  });

  it('reads through refinements and defaults to the object underneath', () => {
    const schema = z
      .object({ query: z.string(), limit: z.number().optional() })
      .refine((value) => value.query !== 'x', 'no');
    expect(describeArgs(schema)).toBe('query: string, limit?: number');
  });

  it('names an array by its element', () => {
    expect(describeArgs(z.object({ ids: z.array(z.string()) }))).toBe('ids: string[]');
  });

  /**
   * Silence, not a guess. A tool with a non-object input would be listed by its
   * description alone — which is what all seven had before this module existed — and
   * that is strictly better than a shape the executor will reject.
   */
  it('yields nothing for a schema that is not an object', () => {
    expect(describeArgs(z.string())).toBeUndefined();
    expect(describeArgs(z.object({}))).toBeUndefined();
  });
});

describe('the roster built from the installed tools', () => {
  let db: Database;
  let app: MadhuritaApp;

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    // `start()` is never called: tools are installed at construction, so the roster is
    // complete without any background loop running.
    app = createApp({
      db,
      config: loadConfig({
        MADHURITA_ENV: 'test',
        OWNER_NAME: 'Owner',
        MADHURITA_DB_PATH: ':memory:',
        MADHURITA_BACKUP_PASSPHRASE: 'a-passphrase-long-enough-to-pass',
      }),
    });
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  const specFor = (id: string): ToolSpec => {
    const found = toolRoster(app.registry.list()).find((tool) => tool.id === id);
    if (!found) throw new Error(`No tool '${id}' is installed`);
    return found;
  };

  it('gives every installed tool a description and an argument list', () => {
    const roster = toolRoster(app.registry.list());
    expect(roster.length).toBe(7);
    for (const tool of roster) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.args).toBeDefined();
    }
  });

  /**
   * The four shapes `intent/recognizer.ts` hardcodes, and the three it does not.
   *
   * The recogniser could propose a valid call because it holds these shapes in code;
   * the model could not, because it was shown none of them. These assertions are the
   * same knowledge, now derived rather than written twice.
   */
  it('names the arguments each tool actually validates', () => {
    expect(specFor('memory.remember_fact').args).toBe(
      'subject: string, predicate: string, object: string, confidence?: number',
    );
    expect(specFor('memory.remember_event').args).toContain('summary: string');
    expect(specFor('preference.set').args).toContain('key: string');
    expect(specFor('preference.set').args).toContain('value: string');
    expect(specFor('memory.recall').args).toContain('query: string');
    // `.refine()` on the object — the "exactly one of dueAt or inMinutes" rule — is the
    // wrapper `describeArgs` has to read through, and both alternatives have to appear
    // or the model can only ever send the one it guessed.
    expect(specFor('reminder.schedule').args).toBe(
      'message: string, dueAt?: number, inMinutes?: number, channel?: "text" | "voice"',
    );
    expect(specFor('reminder.cancel').args).toBe('taskId: string');
    expect(specFor('reminder.list').args).toBe('limit?: number');
  });

  it('carries each tool’s clearance, so a read can be preferred over a write', () => {
    expect(specFor('memory.recall').clearance).toBe('safe');
    expect(specFor('reminder.list').clearance).toBe('safe');
    expect(specFor('memory.remember_fact').clearance).toBe('all');
    expect(specFor('reminder.schedule').clearance).toBe('all');
  });

  /**
   * The one direction that matters: a field named in the prompt that the schema does
   * not have is a field the model will send and the executor will refuse.
   *
   * Checked against the schema's shape rather than by parsing, because a plain Zod
   * object *strips* an unknown key instead of failing — so a parse would pass for a
   * field that silently never arrives, which is the quieter version of the same bug.
   */
  it('names no argument the tool would reject', () => {
    for (const tool of app.registry.list()) {
      const spec = toolRoster([tool])[0]!;
      const names = (spec.args ?? '')
        .split(', ')
        .map((part) => part.split(':')[0]!.replace('?', ''));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(Object.keys(shapeOf(tool.inputSchema))).toContain(name);
      }
    }
  });
});

/**
 * A schema's own field names, through `.refine()`.
 *
 * `reminder.schedule` is `z.object({…}).refine(…)`, i.e. a `ZodEffects` whose `.shape`
 * is `undefined` — the exact wrapper `describeArgs` exists to see through, so a test
 * that could not see through it would be testing the easy six.
 */
function shapeOf(schema: z.ZodTypeAny): Record<string, unknown> {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof z.ZodObject) return current.shape as Record<string, unknown>;
    if (!(current instanceof z.ZodEffects)) break;
    current = current.innerType() as z.ZodTypeAny;
  }
  throw new Error('No object shape under this schema');
}
