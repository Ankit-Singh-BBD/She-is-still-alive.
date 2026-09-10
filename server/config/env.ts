/**
 * Configuration — the one place `process.env` is read.
 *
 * Everything the application needs from its environment is parsed here, once,
 * at boot, and validated before a single subsystem is constructed. A bad
 * `PORT`, an out-of-range quiet hour, or a `DATABASE_PATH` that is an empty
 * string fails immediately with a message naming the variable — rather than
 * surfacing hours later as a mystery `NaN` in a timer or a database opened at
 * the wrong path.
 *
 * Three rules this module exists to enforce:
 *
 *  1. **One reader.** Subsystems take options, not environment. Scattered
 *     `process.env` reads are how two parts of a program come to disagree
 *     about what the configuration says.
 *
 *  2. **Absence is a fact, not a crash.** She must boot and think with no
 *     `GOOGLE_API_KEY` at all, falling back to the deterministic heuristics
 *     already in the cognitive stages. So the key is optional and the derived
 *     `llm.enabled` states plainly whether a real faculty is available. Code
 *     branches on that boolean instead of guessing from a truthy string.
 *
 *  3. **No secret is logged.** `describeConfig()` is the only sanctioned way to
 *     print configuration, and it reports secrets as present/absent — never as
 *     values. The raw `apiKey` is reachable only by the client that needs it.
 *
 * The module is pure: it takes an environment record and returns a value. The
 * process entry point (`server/main.ts`) is what loads `.env` from disk. That
 * split is what makes configuration testable without touching the real
 * environment.
 */

import { z } from 'zod';

// ── Coercion helpers ─────────────────────────────────────────────────────────

/**
 * Strips a trailing inline comment before coercion.
 *
 * `.env.example` documents its values with trailing notes
 * (`SESSION_MAX_AGE_MS=2592000000  # 30 days`). A `.env` copied from it keeps
 * them, and while dotenv strips inline comments for unquoted values, a value
 * that arrived some other way — an exported shell variable, a container env
 * file, a CI secret pasted with its note — does not go through dotenv at all.
 * Coercing `"2592000000  # 30 days"` to a number yields `NaN`, and the
 * resulting error would point at the operator's arithmetic rather than at a
 * stray comment. Cheaper to tolerate it.
 *
 * Applied only to numbers, booleans and enums. Secrets are never rewritten:
 * a `#` inside a credential is part of the credential.
 */
function scalar(raw: string): string {
  const withoutComment = raw.replace(/\s+#.*$/, '');
  return withoutComment.trim();
}

/**
 * An unset variable and one set to the empty string mean the same thing.
 *
 * `.env.example` ships `GOOGLE_API_KEY=` so an operator can see the name
 * without having a value yet. Read literally that is the empty string, which is
 * truthy enough to fool a `!== undefined` check and would have the application
 * announce a working LLM faculty and then send an unauthenticated request. Both
 * forms collapse to `undefined` here.
 */
function present(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);

/** Boolean flag with a default, tolerant of the usual spellings. */
function envBool(defaultValue: boolean): z.ZodType<boolean, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = present(raw);
      if (value === undefined) return defaultValue;
      const normalized = scalar(value).toLowerCase();
      if (TRUTHY.has(normalized)) return true;
      if (FALSY.has(normalized)) return false;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `expected a boolean (true/false), received "${value}"`,
      });
      return z.NEVER;
    });
}

/** Integer with a default and an inclusive range. */
function envInt(
  defaultValue: number,
  range: { min?: number; max?: number } = {},
): z.ZodType<number, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = present(raw);
      if (value === undefined) return defaultValue;
      const normalized = scalar(value);
      if (!/^-?\d+$/.test(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected an integer, received "${value}"`,
        });
        return z.NEVER;
      }
      const parsed = Number(normalized);
      if (range.min !== undefined && parsed < range.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be at least ${range.min}, received ${parsed}`,
        });
        return z.NEVER;
      }
      if (range.max !== undefined && parsed > range.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be at most ${range.max}, received ${parsed}`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

/** Finite decimal with a default and an inclusive range. */
function envFloat(
  defaultValue: number,
  range: { min?: number; max?: number } = {},
): z.ZodType<number, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = present(raw);
      if (value === undefined) return defaultValue;
      const parsed = Number(scalar(value));
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected a number, received "${value}"`,
        });
        return z.NEVER;
      }
      if (range.min !== undefined && parsed < range.min) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be at least ${range.min}, received ${parsed}`,
        });
        return z.NEVER;
      }
      if (range.max !== undefined && parsed > range.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be at most ${range.max}, received ${parsed}`,
        });
        return z.NEVER;
      }
      return parsed;
    });
}

/** One of a fixed set, compared case-insensitively. */
function envEnum<const T extends readonly [string, ...string[]]>(
  allowed: T,
  defaultValue: T[number],
): z.ZodType<T[number], z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = present(raw);
      if (value === undefined) return defaultValue;
      const normalized = scalar(value).toLowerCase();
      const match = allowed.find((candidate) => candidate.toLowerCase() === normalized);
      if (match === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected one of ${allowed.join(' | ')}, received "${value}"`,
        });
        return z.NEVER;
      }
      return match;
    });
}

/** Non-empty string, falling back to a default when unset or blank. */
function envString(defaultValue: string): z.ZodType<string, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw) => present(raw) ?? defaultValue);
}

/**
 * A value that may legitimately be absent, and is never rewritten.
 *
 * Used for credentials: no comment stripping, no case folding, no default. Only
 * the outer whitespace an operator's editor may have added is removed, and
 * blank collapses to `undefined` so absence is unambiguous everywhere
 * downstream.
 */
function envOptional(): z.ZodType<string | undefined, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw) => present(raw));
}

/** Which axis a coordinate is on, and therefore what may legally be written on it. */
type Axis = 'latitude' | 'longitude';

const AXES: Record<Axis, { readonly limit: number; readonly positive: string; readonly negative: string }> =
  {
    latitude: { limit: 90, positive: 'N', negative: 'S' },
    longitude: { limit: 180, positive: 'E', negative: 'W' },
  };

/**
 * A latitude or longitude, in the notations a person actually has one in.
 *
 * This accepted decimal degrees and nothing else, which sounds complete until
 * you ask where an owner gets their coordinates from. Google Maps' own "copy
 * coordinates" hands you `25°58'31.7"N`, that is what was pasted into `.env`, and
 * she refused to boot — a fatal configuration error naming the operator's home as
 * an invalid number. A location is optional in this application; making the one
 * format people paste unbootable is the wrong trade by a wide margin.
 *
 * Accepted, case-insensitively, spaces optional, `°`, `'`, `"`, `′`, `″` and `:`
 * all read as separators:
 *
 *   `25.9755`        decimal degrees, still the canonical form
 *   `-79.4489`       south or west by sign
 *   `25.9755 N`      decimal with a hemisphere letter
 *   `25°58'31.7"N`   degrees-minutes-seconds, as Maps writes it
 *   `25° 58' 31.7"`  no hemisphere: positive
 *   `25 58 31.7 N`   separators are optional
 *   `25:58:31.7N`    colons instead
 *
 * Refused, each with a message that says what to write instead: a hemisphere
 * letter belonging to the other axis, a letter that contradicts a minus sign,
 * minutes or seconds at 60 or above, fractional degrees with minutes after them,
 * and both halves pasted into one variable — which is the other thing that
 * happens when someone copies a location.
 */
function envCoordinate(axis: Axis): z.ZodType<number | undefined, z.ZodTypeDef, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = present(raw);
      if (value === undefined) return undefined;
      const parsed = parseCoordinate(scalar(value), axis);
      if (!parsed.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.problem });
        return z.NEVER;
      }
      return parsed.degrees;
    });
}

type CoordinateParse = { ok: true; degrees: number } | { ok: false; problem: string };

/** Pure, so the whole grammar above is testable without building a config. */
export function parseCoordinate(text: string, axis: Axis): CoordinateParse {
  const { limit, positive, negative } = AXES[axis];
  const otherAxis: Axis = axis === 'latitude' ? 'longitude' : 'latitude';

  if (/[,;]/.test(text)) {
    return {
      ok: false,
      problem:
        `"${text}" looks like both coordinates in one variable — keep the ${axis} here and ` +
        `put the other in LOCATION_${otherAxis.toUpperCase()}`,
    };
  }

  // A hemisphere letter is written before the number as often as after it.
  const shape = /^([NSEW])?\s*([^NSEW]*?)\s*([NSEW])?$/i.exec(text);
  if (shape === null || shape[2] === undefined || shape[2] === '') {
    return { ok: false, problem: `expected a ${axis}, received "${text}"` };
  }
  if (shape[1] !== undefined && shape[3] !== undefined) {
    return { ok: false, problem: `two hemisphere letters in "${text}"` };
  }

  const letter = (shape[1] ?? shape[3])?.toUpperCase();
  if (letter !== undefined && letter !== positive && letter !== negative) {
    return {
      ok: false,
      problem: `"${letter}" is a ${otherAxis} hemisphere; a ${axis} is ${positive} or ${negative}`,
    };
  }

  const body = shape[2];
  const negativeSign = body.startsWith('-');
  if (negativeSign && letter !== undefined) {
    return {
      ok: false,
      problem: `"${text}" says ${letter} and also carries a minus sign; use one or the other`,
    };
  }

  const parts = body
    .replace(/^[+-]/, '')
    .replace(/[°'"′″:]/g, ' ')
    .trim()
    .split(/\s+/);
  if (parts.length > 3) {
    return { ok: false, problem: `expected degrees, minutes and seconds at most, received "${text}"` };
  }

  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^\d+(?:\.\d+)?$/.test(part)) {
      return { ok: false, problem: `expected a ${axis}, received "${text}"` };
    }
    numbers.push(Number(part));
  }

  const [degrees = 0, minutes = 0, seconds = 0] = numbers;
  // Fractional degrees are how decimal notation says the same thing minutes do,
  // so a value carrying both is two notations at once and cannot be read.
  if (numbers.length > 1 && !Number.isInteger(degrees)) {
    return { ok: false, problem: `"${text}" mixes fractional degrees with minutes; use one notation` };
  }
  if (numbers.length > 2 && !Number.isInteger(minutes)) {
    return { ok: false, problem: `"${text}" mixes fractional minutes with seconds; use one notation` };
  }
  if (minutes >= 60 || seconds >= 60) {
    return { ok: false, problem: `minutes and seconds run 0 to 59, received "${text}"` };
  }

  const magnitude = degrees + minutes / 60 + seconds / 3600;
  if (magnitude > limit) {
    return { ok: false, problem: `a ${axis} runs -${limit} to ${limit}, received "${text}"` };
  }

  const sign = negativeSign || letter === negative ? -1 : 1;
  // Rounded to seven places: about a centimetre, well past what any weather grid
  // resolves, and it keeps 25°58'31.7"N from being stored as 25.975472222222224.
  return { ok: true, degrees: sign === -1 && magnitude === 0 ? 0 : round7(sign * magnitude) };
}

function round7(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

// ── Schema ───────────────────────────────────────────────────────────────────

/**
 * Model defaults.
 *
 * These are the models this application is built around, not placeholders:
 * a small fast model for the reasoning faculty (stages 4-6, 9-10) and the live
 * model for bidirectional voice. They are exported so the doc, the faculty layer
 * and her own self-knowledge quote one source rather than repeating string
 * literals that drift.
 *
 * The reasoning default was `gemini-2.5-flash-lite` — the model the Build Book
 * names and this application was written against — until an actual request found
 * out what `models.list` does not say: it still appears in the listing and
 * `generateContent` answers `404 … no longer available to new users`. Every one
 * of stages 4, 5, 6, 9 and 10 threw, the cycle came back `degraded`, and she said
 * nothing at all. `gemini-3.5-flash-lite` is the successor Google's own error
 * message names, and it answers. Pinned rather than `gemini-flash-lite-latest`
 * on purpose: an alias that moves under her would change how she thinks without
 * anything in the configuration changing, and a floating model is exactly the
 * kind of quiet drift the rest of this file exists to prevent.
 */
export const DEFAULT_REASONING_MODEL = 'gemma-4-31b-it';
export const DEFAULT_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

const EnvObject = z
  .object({
    NODE_ENV: envEnum(['development', 'production', 'test'], 'development'),
    LOG_LEVEL: envEnum(['debug', 'info', 'warn', 'error'], 'info'),
    LOG_PRETTY: envBool(true),

    PORT: envInt(3000, { min: 1, max: 65535 }),
    HOST: envString('127.0.0.1'),

    DATABASE_PATH: envString('./data/madhurita.db'),

    // Only Google is implemented — `@google/genai` is the sole LLM client in
    // `package.json`. Accepting 'anthropic' here and failing at the first
    // request would be a configuration knob that lies about what it does.
    LLM_PROVIDER: envEnum(['google'], 'google'),
    FACULTY_MODE: envEnum(['local-only', 'hybrid', 'quality'], 'hybrid'),
    GOOGLE_API_KEY: envOptional(),
    LLM_REASONING_MODEL: envString(DEFAULT_REASONING_MODEL),
    LLM_LIVE_MODEL: envString(DEFAULT_LIVE_MODEL),
    /**
     * Which prebuilt Gemini voice speaks her lines, and in what language.
     *
     * Both optional, and absent by default, because the provider's own default is
     * a real answer here and inventing one would be picking her voice from a list
     * of names in a config file. `LLM_VOICE_LANGUAGE` absent lets synthesis follow
     * the language of the line, which is what Hinglish needs — a hard `en-IN` would
     * spell Roman-script Hindi out as English words.
     */
    LLM_VOICE_NAME: envOptional(),
    LLM_VOICE_LANGUAGE: envOptional(),
    LLM_TEMPERATURE: envFloat(0.7, { min: 0, max: 2 }),
    LLM_MAX_TOKENS: envInt(8192, { min: 1, max: 1_000_000 }),
    LLM_TIMEOUT_MS: envInt(20_000, { min: 100, max: 600_000 }),

    SESSION_COOKIE_NAME: envString('madhurita_session'),
    SESSION_COOKIE_SECURE: envBool(false),
    SESSION_COOKIE_SAME_SITE: envEnum(['lax', 'strict', 'none'], 'lax'),
    SESSION_MAX_AGE_MS: envInt(2_592_000_000, { min: 60_000 }),

    PROACTIVITY_ENABLED: envBool(true),
    QUIET_HOURS_START: envInt(22, { min: 0, max: 23 }),
    QUIET_HOURS_END: envInt(7, { min: 0, max: 23 }),

    // Background sweep cadences. Each one is a loop that wakes up, asks the
    // database a bounded question, and goes back to sleep; none of them is a
    // busy-wait, so these are lower bounds on latency, not throughput knobs.
    PROACTIVE_SWEEP_INTERVAL_MS: envInt(60_000, { min: 1_000 }),
    TASK_SWEEP_INTERVAL_MS: envInt(15_000, { min: 1_000 }),
    LOOP_SWEEP_INTERVAL_MS: envInt(60_000, { min: 1_000 }),
    /**
     * How often the out-of-band learner looks for cycles the in-cycle learn stage
     * did not learn from. Five minutes, the slowest of the four on purpose:
     * nothing is waiting on it, and with a model wired each cycle it picks up is a
     * network call. See `server/learning/consolidation.ts`.
     */
    LEARNING_SWEEP_INTERVAL_MS: envInt(300_000, { min: 1_000 }),

    // Where she is. Absent by default: guessing a location and then narrating
    // the weather there would be a confident fabrication. Both halves are
    // required together — see the refinement below. Decimal degrees or the
    // degrees-minutes-seconds Google Maps hands you; `envCoordinate` documents
    // the grammar and why it is not just `Number(value)`.
    LOCATION_LATITUDE: envCoordinate('latitude'),
    LOCATION_LONGITUDE: envCoordinate('longitude'),
    LOCATION_LABEL: envOptional(),

    BACKUP_ENABLED: envBool(false),
    BACKUP_DESTINATION: envString('./backups'),
    // `.env.example` proposed a cron expression. Parsing cron correctly means
    // taking a dependency for a single scheduled job; an interval says the same
    // thing with arithmetic already in the language.
    BACKUP_INTERVAL_HOURS: envInt(24, { min: 1, max: 8_760 }),

    FLAG_COGNITION: envBool(true),
    FLAG_ACTIONS: envBool(true),
    FLAG_TASKS: envBool(true),
    FLAG_LEARNING: envBool(true),
    FLAG_PROACTIVITY: envBool(true),
    FLAG_VOICE: envBool(true),
    FLAG_REALTIME: envBool(true),

    /**
     * The four advanced faculties, on by default — a default the Build Book does not
     * ask for, changed on purpose and reversible with one variable.
     *
     * The book files these under "opt-in advanced features", which is the right
     * caution for what they were when it was written: four stubs. They are now
     * implemented, run inside the cycle rather than after it, and are covered by
     * tests that assert their committed effects. What an opt-in default buys at that
     * point is a runtime that reads her own emotional signal, weighs recall by who is
     * asking, and consolidates while idle — and then does none of it, for an owner
     * who has no way to know there were four more variables to find.
     *
     * The same argument as `FLAG_PERSONALITY` below, one subsystem along: a switch
     * whose default produces the flat version of her is the wrong default.
     *
     * Two of the four write durable rows (`FLAG_LONG_HORIZON_REFLECTION`) or retire
     * existing recollections from retrieval (`FLAG_DREAM_CONSOLIDATION`), so the
     * escape hatch matters and is deliberately coarse and fine: this variable turns
     * the whole subsystem off, and the four below turn one capability off each.
     */
    FLAG_ADVANCED_MODULES: envBool(true),

    /**
     * Personality modulation, on by default — where the argument above was first
     * made, and the cheapest case for it.
     *
     * It has no credential, no network call, and writes nothing durable: the three
     * signals write in-memory overrides that expire on their own (see
     * `server/personality/service.ts`). Its "off" state is a fixed neutral register
     * for every caller at every hour — which is precisely the flat, robotic voice
     * this application exists not to have. A switch whose default produces the
     * defect is the wrong default.
     */
    FLAG_PERSONALITY: envBool(true),

    /**
     * The four advanced modules, each on unless switched off — but every one of
     * them still `AND`ed with `FLAG_ADVANCED_MODULES` when the config is built.
     *
     * That is the whole semantic: the master flag decides whether the subsystem
     * runs at all, and these subtract from it. Defaulting them to `true`
     * individually means turning the master on gets you the four modules, which is
     * what "enable advanced modules" plainly ought to mean; defaulting them false
     * would make the master switch do nothing on its own and give an operator four
     * more variables to discover before anything happened.
     *
     * They are separate variables rather than one because they are separate
     * capabilities with different consequences. Emotion reading and relationship
     * context write only expiring in-memory tone. Long-horizon reflection writes
     * durable `semantic_memory` rows. Dream consolidation changes the lifecycle
     * status of existing recollections so they stop being retrieved. An operator
     * may reasonably want the first two and not the last, and no single flag can
     * express that.
     */
    FLAG_EMOTION_READING: envBool(true),
    FLAG_RELATIONSHIP_CONTEXT: envBool(true),
    FLAG_LONG_HORIZON_REFLECTION: envBool(true),
    FLAG_DREAM_CONSOLIDATION: envBool(true),
  });

const EnvSchema = EnvObject.superRefine((values, ctx) => {
  const hasLat = values.LOCATION_LATITUDE !== undefined;
  const hasLon = values.LOCATION_LONGITUDE !== undefined;
  if (hasLat !== hasLon) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLat ? 'LOCATION_LONGITUDE' : 'LOCATION_LATITUDE'],
      message:
        'LOCATION_LATITUDE and LOCATION_LONGITUDE must be set together — half a coordinate is not a place',
    });
  }
});

/**
 * Every variable this application reads, taken from the schema's own shape
 * rather than written out again by hand — a second list would be one more thing
 * to forget to update.
 *
 * It exists so `.env.example` can be checked against it. A variable that is
 * read at boot but appears in no example file is undiscoverable: an operator has
 * no way to learn it exists short of reading this module, which is the one job
 * an example file has.
 */
export const DECLARED_ENV_VARS: readonly string[] = Object.freeze(
  Object.keys(EnvObject.shape).sort(),
);

// ── Public shape ─────────────────────────────────────────────────────────────

export type NodeEnv = 'development' | 'production' | 'test';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SameSite = 'lax' | 'strict' | 'none';

/** Where she is, when the operator has told her. Both halves or neither. */
export interface LocationConfig {
  readonly latitude: number;
  readonly longitude: number;
  /** Human-readable name for the place, purely for what she says out loud. */
  readonly label: string | undefined;
}

export interface Config {
  readonly env: NodeEnv;
  readonly isProduction: boolean;
  readonly logging: { readonly level: LogLevel; readonly pretty: boolean };
  readonly server: { readonly port: number; readonly host: string };
  readonly database: { readonly path: string };
  readonly llm: {
    readonly provider: 'google';
    readonly facultyMode: 'local-only' | 'hybrid' | 'quality';
    /**
     * Whether a real language faculty is available.
     *
     * False is a supported way to run: stages 4-6, 9 and 10 fall back to the
     * deterministic heuristics they already carry, and she is quieter and more
     * literal but entirely alive. Every consumer branches on this rather than
     * testing the key for truthiness.
     */
    readonly enabled: boolean;
    readonly apiKey: string | undefined;
    readonly reasoningModel: string;
    readonly liveModel: string;
    readonly voiceName: string | undefined;
    readonly voiceLanguage: string | undefined;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
  };
  readonly session: {
    readonly cookieName: string;
    readonly cookieSecure: boolean;
    readonly cookieSameSite: SameSite;
    readonly maxAgeMs: number;
  };
  readonly proactivity: {
    readonly enabled: boolean;
    readonly quietHoursStart: number;
    readonly quietHoursEnd: number;
  };
  readonly intervals: {
    readonly proactiveSweepMs: number;
    readonly taskSweepMs: number;
    readonly loopSweepMs: number;
    readonly learningSweepMs: number;
  };
  readonly location: LocationConfig | undefined;
  readonly backup: {
    readonly enabled: boolean;
    readonly destination: string;
    readonly intervalHours: number;
  };
  readonly flags: {
    readonly cognition: boolean;
    readonly actions: boolean;
    readonly tasks: boolean;
    readonly learning: boolean;
    readonly proactivity: boolean;
    readonly voice: boolean;
    readonly realtime: boolean;
    readonly personality: boolean;
    readonly advancedModules: boolean;
    /**
     * The four per-module flags, already `AND`ed with `advancedModules`.
     *
     * Resolved once in `loadConfig` rather than left to each reader, for the reason
     * the whole file exists: a config that reports `emotionReading: true` while the
     * master gate is off would be stating something the process does not do, and
     * `describeConfig` prints these at boot. Every `true` here means that module
     * will actually run.
     *
     * Flat rather than a nested `AdvancedModuleFlagMap` on purpose — `describeConfig`
     * renders this object generically with `Object.entries`, so a nested object
     * would print as `[object Object]`, and `server/config` would take a type
     * dependency on an opt-in subsystem. The four-line translation lives in
     * `server/app.ts`, which is already the layer that knows about wiring.
     */
    readonly emotionReading: boolean;
    readonly relationshipContext: boolean;
    readonly longHorizonReflection: boolean;
    readonly dreamConsolidation: boolean;
  };
}

/**
 * Thrown when the environment cannot produce a valid configuration.
 *
 * Carries every problem found, not just the first: an operator fixing a fresh
 * `.env` should learn about all four mistakes in one pass rather than
 * rediscovering the process one restart at a time.
 */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

/**
 * Parses and validates an environment into a `Config`.
 *
 * Pure by design — it reads the record you hand it and nothing else, so a test
 * can assert on a hostile environment without mutating the real one. Loading
 * `.env` from disk is `server/main.ts`'s job, because reading files is a side
 * effect and this module should have none.
 *
 * @throws ConfigError listing every invalid variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);

  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const name = issue.path.length > 0 ? issue.path.join('.') : '(configuration)';
        return `${name}: ${issue.message}`;
      }),
    );
  }

  const values = parsed.data;

  // The refinement above guarantees these agree; the explicit check is what
  // narrows the types, and it keeps the invariant true here even if the
  // refinement is ever loosened.
  const location: LocationConfig | undefined =
    values.LOCATION_LATITUDE !== undefined && values.LOCATION_LONGITUDE !== undefined
      ? {
          latitude: values.LOCATION_LATITUDE,
          longitude: values.LOCATION_LONGITUDE,
          label: values.LOCATION_LABEL,
        }
      : undefined;

  return {
    env: values.NODE_ENV,
    isProduction: values.NODE_ENV === 'production',
    logging: { level: values.LOG_LEVEL, pretty: values.LOG_PRETTY },
    server: { port: values.PORT, host: values.HOST },
    database: { path: values.DATABASE_PATH },
    llm: {
      provider: values.LLM_PROVIDER,
      facultyMode: values.FACULTY_MODE,
      enabled: values.GOOGLE_API_KEY !== undefined,
      apiKey: values.GOOGLE_API_KEY,
      reasoningModel: values.LLM_REASONING_MODEL,
      liveModel: values.LLM_LIVE_MODEL,
      voiceName: values.LLM_VOICE_NAME,
      voiceLanguage: values.LLM_VOICE_LANGUAGE,
      temperature: values.LLM_TEMPERATURE,
      maxOutputTokens: values.LLM_MAX_TOKENS,
      timeoutMs: values.LLM_TIMEOUT_MS,
    },
    session: {
      cookieName: values.SESSION_COOKIE_NAME,
      cookieSecure: values.SESSION_COOKIE_SECURE,
      cookieSameSite: values.SESSION_COOKIE_SAME_SITE,
      maxAgeMs: values.SESSION_MAX_AGE_MS,
    },
    proactivity: {
      enabled: values.PROACTIVITY_ENABLED,
      quietHoursStart: values.QUIET_HOURS_START,
      quietHoursEnd: values.QUIET_HOURS_END,
    },
    intervals: {
      proactiveSweepMs: values.PROACTIVE_SWEEP_INTERVAL_MS,
      taskSweepMs: values.TASK_SWEEP_INTERVAL_MS,
      loopSweepMs: values.LOOP_SWEEP_INTERVAL_MS,
      learningSweepMs: values.LEARNING_SWEEP_INTERVAL_MS,
    },
    location,
    backup: {
      enabled: values.BACKUP_ENABLED,
      destination: values.BACKUP_DESTINATION,
      intervalHours: values.BACKUP_INTERVAL_HOURS,
    },
    flags: {
      cognition: values.FLAG_COGNITION,
      actions: values.FLAG_ACTIONS,
      tasks: values.FLAG_TASKS,
      learning: values.FLAG_LEARNING,
      proactivity: values.FLAG_PROACTIVITY,
      voice: values.FLAG_VOICE,
      realtime: values.FLAG_REALTIME,
      personality: values.FLAG_PERSONALITY,
      advancedModules: values.FLAG_ADVANCED_MODULES,
      // The master gate applied here, once, so that every reader of these four —
      // `describeConfig`, `server/app.ts`, a diagnostic endpoint — sees the same
      // answer, and the answer is the one the runtime will act on.
      emotionReading: values.FLAG_ADVANCED_MODULES && values.FLAG_EMOTION_READING,
      relationshipContext: values.FLAG_ADVANCED_MODULES && values.FLAG_RELATIONSHIP_CONTEXT,
      longHorizonReflection: values.FLAG_ADVANCED_MODULES && values.FLAG_LONG_HORIZON_REFLECTION,
      dreamConsolidation: values.FLAG_ADVANCED_MODULES && values.FLAG_DREAM_CONSOLIDATION,
    },
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

/**
 * A redacted, human-readable summary — the sanctioned way to log configuration.
 *
 * Credentials are reported as present or absent and never printed. Part II of
 * the build book is unambiguous: API keys live in `.env`, never in the database,
 * never in the UI, and no secret is logged. A boot line that echoed a key would
 * put it in every terminal scrollback and log aggregator that ever saw the
 * process start.
 */
export function describeConfig(config: Config): string {
  const label = (text: string): string => text.padEnd(18, ' ');
  const secs = (ms: number): string => `${Math.round(ms / 1000)}s`;
  const oclock = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

  /**
   * Two switches, one behaviour.
   *
   * `server/app.ts:960` starts the proactive sweep only when
   * `flags.proactivity && proactivity.enabled`, so a line reporting either term
   * alone can print "enabled" for a runtime in which she will never speak first —
   * which is what happened with `FLAG_PROACTIVITY=false` and the default
   * `PROACTIVITY_ENABLED=true`, this banner claiming proactivity while listing it
   * under `flags off` four lines down.
   *
   * When the two disagree the line names the one that won, because an operator
   * reading a bare "disabled" against `PROACTIVITY_ENABLED=true` in their own
   * `.env` would go looking in the wrong variable.
   */
  const proactivity = (): string => {
    const byFlag = config.flags.proactivity;
    const bySetting = config.proactivity.enabled;
    if (byFlag && bySetting) {
      return `enabled · quiet ${oclock(config.proactivity.quietHoursStart)}-${oclock(
        config.proactivity.quietHoursEnd,
      )}`;
    }
    if (!byFlag && !bySetting) return 'disabled (FLAG_PROACTIVITY, PROACTIVITY_ENABLED)';
    return byFlag ? 'disabled by PROACTIVITY_ENABLED' : 'disabled by FLAG_PROACTIVITY';
  };

  const flags = Object.entries(config.flags);
  const enabled = flags.filter(([, on]) => on).map(([name]) => name);
  const disabled = flags.filter(([, on]) => !on).map(([name]) => name);

  const place = config.location
    ? `${config.location.label ?? 'unnamed'} (${config.location.latitude}, ${config.location.longitude})`
    : 'not configured — weather and time-of-day context unavailable';

  const lines = [
    `${label('env')}${config.env} · log ${config.logging.level}${config.logging.pretty ? ' (pretty)' : ''}`,
    // The address she was *asked* to bind, which is not yet the address she is
    // on: this banner is printed before `start()`, and a `0` port is only
    // resolved by `listen`. `server/main.ts` prints the real URL once the
    // listener is up, so the clickable line is the one that is true.
    `${label('bind')}${config.server.host}:${config.server.port}`,
    `${label('database')}${config.database.path}`,
    `${label('reasoning model')}${config.llm.reasoningModel}`,
    `${label('live model')}${config.llm.liveModel}`,
    `${label('llm credential')}${
      config.llm.enabled
        ? `present (${config.llm.provider})`
        : 'absent — stages 4-6, 9, 10 use their deterministic fallbacks'
    }`,
    `${label('location')}${place}`,
    `${label('proactivity')}${proactivity()}`,
    `${label('sweeps')}proactive ${secs(config.intervals.proactiveSweepMs)} · tasks ${secs(
      config.intervals.taskSweepMs,
    )} · loops ${secs(config.intervals.loopSweepMs)} · learning ${secs(
      config.intervals.learningSweepMs,
    )}`,
    `${label('backup')}${
      config.backup.enabled
        ? `every ${config.backup.intervalHours}h → ${config.backup.destination}`
        : 'disabled'
    }`,
    `${label('flags on')}${enabled.length > 0 ? enabled.join(', ') : 'none'}`,
  ];

  if (disabled.length > 0) {
    lines.push(`${label('flags off')}${disabled.join(', ')}`);
  }

  return lines.join('\n');
}
