/**
 * What a tool is, and what proving it worked requires.
 *
 * Part XI.3 of the build book: *a textual "done" is never proof.* A tool that
 * returns `{ok: true}` has told you a story about itself. The only thing that
 * settles whether the world changed is re-reading the world.
 *
 * So in this directory a tool is never registered alone. It arrives paired with
 * a **postcondition** — a function that opens the database and asks whether the
 * change the tool claims to have made is actually there. Registration installs
 * both or neither, which is what stops a tool from ever being executable but
 * unprovable.
 *
 * ## Why a postcondition may only look at `output` and `db`
 *
 * Two callers verify, and they know different things:
 *
 *  - `ActionPipeline` stage 5 has the input, the output and the database.
 *  - Cognitive stage 8 has an `ActionResult` — `{toolId, success, output}` — and
 *    a context carrying the database. **It never sees the input**, because
 *    `ActionResult` does not carry one.
 *
 * A postcondition that needed the input would therefore be unusable by stage 8,
 * which is the one that decides whether she may tell you an action succeeded.
 * The intersection is `output` + `db`, and that is the contract: a tool's output
 * must carry every identifier its postcondition needs to find the row again.
 * `input` is passed when the caller happens to have it, and no postcondition
 * here relies on it.
 */

import type { Database } from '@server/persistence/db.js';
import type { ToolDefinition } from '@server/actions/registry.js';

/** Everything a postcondition is allowed to reason from. */
export interface VerificationEvidence {
  toolId: string;
  /** What the tool claimed. Must carry the ids needed to re-read the row. */
  output: unknown;
  /** Present only when the caller has it; see the note above. */
  input?: unknown | undefined;
  /** Authoritative state. Never a cache. */
  db: Database;
  identityId?: string | undefined;
  cycleId?: string | undefined;
}

export interface VerificationOutcome {
  /** True only when authoritative state was read and the postcondition holds. */
  ok: boolean;
  /** Why it did not hold. Empty when it did. */
  discrepancies: string[];
}

export type Postcondition = (
  evidence: VerificationEvidence,
) => Promise<VerificationOutcome> | VerificationOutcome;

/**
 * A tool and the proof obligation that comes with it.
 *
 * The pairing is the point. `ToolRegistry.register()` takes a bare
 * `ToolDefinition` and would happily accept a tool nothing can verify;
 * `installTool()` in `./verification.ts` takes this instead.
 */
export interface VerifiedTool<TInput = unknown, TOutput = unknown> {
  definition: ToolDefinition<TInput, TOutput>;
  postcondition: Postcondition;
}

/** The postcondition holds. */
export function held(): VerificationOutcome {
  return { ok: true, discrepancies: [] };
}

/** The postcondition does not hold, for these reasons. */
export function broken(...discrepancies: string[]): VerificationOutcome {
  return { ok: false, discrepancies };
}

/**
 * Narrows a tool's own output before verifying it.
 *
 * A postcondition receives `unknown`, because by the time stage 8 runs the
 * output has been through `JSON.stringify` and back. Rather than cast, each
 * postcondition parses with the tool's own output schema — so an output that
 * does not match the shape the tool promised is itself a discrepancy, not a
 * crash inside the verifier.
 */
export function parseOutput<T>(
  toolId: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown } },
  output: unknown,
): { ok: true; value: T } | { ok: false; outcome: VerificationOutcome } {
  const parsed = schema.safeParse(output);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    outcome: broken(
      `'${toolId}' returned something that does not match its own output schema, so there is ` +
        `nothing a postcondition could look up`,
    ),
  };
}
