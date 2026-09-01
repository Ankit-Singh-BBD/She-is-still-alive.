/**
 * Stage 8: VERIFY
 *
 * The Application re-reads authoritative state and asserts that the intended
 * change actually occurred (Build Book Part VII.1 stage 8, Part XI.3). No LLM
 * role: a model's claim that something worked is not evidence.
 *
 * The rule this stage exists to enforce: **a textual "done" is never proof.**
 * A result only becomes `verified: true` when a registered postcondition
 * verifier re-read authoritative state and confirmed the postcondition. A tool
 * with no verifier stays unverified and the gap is recorded as a discrepancy —
 * silence is not success.
 *
 * P09 rollback contract: with no verifier registry wired, nothing is marked
 * verified and every reported success is flagged as unproven, so stage 9 cannot
 * tell the caller an action succeeded.
 */

import type { Database } from '@server/persistence/db.js';
import type { ActionResult, VerificationReport } from '../types.js';

export interface VerificationContext {
  /** Authoritative state. Verifiers re-read through this, never through a cache. */
  db?: Database | undefined;
  identityId: string;
  cycleId: string;
}

export interface PostconditionVerifier {
  /** Returns true only if authoritative state now satisfies the postcondition. */
  verify(result: ActionResult, ctx: VerificationContext): Promise<boolean> | boolean;
}

export interface VerifierRegistry {
  verifierFor(toolId: string): PostconditionVerifier | undefined;
}

export interface VerifyOptions {
  verifiers?: VerifierRegistry | undefined;
  db?: Database | undefined;
  identityId?: string | undefined;
  cycleId?: string | undefined;
}

export async function verify(
  results: ActionResult[],
  opts: VerifyOptions = {},
): Promise<VerificationReport> {
  const recheckedAt = Date.now();

  // No action was taken, so there is nothing to disprove.
  if (results.length === 0) {
    return {
      preconditionsMet: true,
      postconditionsMet: true,
      discrepancies: [],
      results: [],
      recheckedAt,
    };
  }

  const ctx: VerificationContext = {
    db: opts.db,
    identityId: opts.identityId ?? 'unknown',
    cycleId: opts.cycleId ?? 'unknown',
  };

  const discrepancies: string[] = [];
  const checked: ActionResult[] = [];

  for (const result of results) {
    // Precondition for verification: the call was addressed to an identified
    // tool. An 'unknown' tool means stage 7 refused before dispatch.
    if (!result.toolId || result.toolId === 'unknown') {
      discrepancies.push(
        `An action was attempted without an identified tool: ${result.error ?? 'no reason recorded'}`,
      );
      checked.push({ ...result, verified: false });
      continue;
    }

    if (!result.success) {
      discrepancies.push(
        `'${result.toolId}' did not execute: ${result.error ?? 'no error recorded'}`,
      );
      checked.push({ ...result, verified: false });
      continue;
    }

    const verifier = opts.verifiers?.verifierFor(result.toolId);
    if (!verifier) {
      discrepancies.push(
        `No postcondition verifier is registered for '${result.toolId}'; its reported success is not proof`,
      );
      checked.push({ ...result, verified: false });
      continue;
    }

    try {
      const confirmed = await verifier.verify(result, ctx);
      if (confirmed) {
        checked.push({ ...result, verified: true });
      } else {
        discrepancies.push(
          `Postcondition for '${result.toolId}' did not hold when authoritative state was re-read`,
        );
        checked.push({ ...result, verified: false });
      }
    } catch (e) {
      discrepancies.push(
        `Verification of '${result.toolId}' failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      checked.push({ ...result, verified: false });
    }
  }

  const preconditionsMet = results.every((r) => Boolean(r.toolId) && r.toolId !== 'unknown');

  return {
    preconditionsMet,
    postconditionsMet: discrepancies.length === 0 && checked.every((r) => r.verified),
    discrepancies,
    results: checked,
    recheckedAt,
  };
}
