/**
 * One verifier registry, serving both places that verify.
 *
 * `ActionPipeline` stage 5 and cognitive stage 8 each declare their own
 * `PostconditionVerifier` shape, and each verifies the same execution: the
 * pipeline writes `action_result.verified`, stage 8 sets the `verified` flag
 * that stage 9 uses to decide what she is allowed to tell you. Two registries
 * would mean two answers to one question, and eventually a row that says
 * `verified = 1` under a sentence that says the action could not be confirmed.
 *
 * So there is one registry, implementing both interfaces over one map of
 * postconditions. What differs between the callers is only how much evidence
 * they can hand over, and that difference is already accounted for in
 * `./types.ts`.
 *
 * The two still verify independently rather than one trusting the other, which
 * is deliberate: the pipeline records what was true at execution time, and stage
 * 8 re-reads before she speaks. If those disagree, the conservative one wins
 * where it matters — she says it is unverified — and the row keeps the earlier
 * observation.
 */

import type { Database } from '@server/persistence/db.js';
import type { ToolRegistry } from '@server/actions/registry.js';
import type { PostconditionVerifier as PipelineVerifier } from '@server/actions/pipeline.js';
import type {
  PostconditionVerifier as StageVerifier,
  VerifierRegistry,
  VerificationContext,
} from '@server/cognition/stages/8.js';
import type { ActionResult } from '@server/cognition/types.js';
import type { Postcondition, VerifiedTool } from './types.js';

export class ToolVerifierRegistry implements VerifierRegistry, PipelineVerifier {
  private readonly postconditions = new Map<string, Postcondition>();

  register(toolId: string, postcondition: Postcondition): void {
    if (this.postconditions.has(toolId)) {
      throw new Error(`A postcondition is already registered for tool '${toolId}'`);
    }
    this.postconditions.set(toolId, postcondition);
  }

  has(toolId: string): boolean {
    return this.postconditions.has(toolId);
  }

  ids(): string[] {
    return [...this.postconditions.keys()].sort();
  }

  // ── Cognitive stage 8 ──

  verifierFor(toolId: string): StageVerifier | undefined {
    const postcondition = this.postconditions.get(toolId);
    if (!postcondition) return undefined;
    return {
      verify: async (result: ActionResult, ctx: VerificationContext) => {
        if (!ctx.db) {
          // Without authoritative state there is nothing to re-read, and the
          // honest answer is "not proven" rather than an optimistic true.
          return {
            ok: false,
            discrepancies: [
              `'${toolId}' could not be verified: stage 8 was given no database to re-read`,
            ],
          };
        }
        return postcondition({
          toolId,
          output: result.output,
          db: ctx.db,
          identityId: ctx.identityId,
          cycleId: ctx.cycleId,
        });
      },
    };
  }

  // ── ActionPipeline stage 5 ──

  async verify(
    toolId: string,
    input: unknown,
    output: unknown,
    db: Database,
  ): Promise<{ postconditionsMet: boolean; discrepancies: string[] }> {
    const postcondition = this.postconditions.get(toolId);
    if (!postcondition) {
      return {
        postconditionsMet: false,
        discrepancies: [`No postcondition is registered for tool '${toolId}'`],
      };
    }
    const outcome = await postcondition({ toolId, output, input, db });
    return { postconditionsMet: outcome.ok, discrepancies: outcome.discrepancies };
  }
}

/**
 * Installs a tool and its postcondition together.
 *
 * This is the only function in `server/` that should put a tool into a registry.
 * `ToolRegistry.register()` accepts a bare definition and cannot tell whether
 * anything is able to prove the tool worked; going through here means a tool
 * that is executable is always also verifiable.
 */
export function installTool<TInput, TOutput>(
  registry: ToolRegistry,
  verifiers: ToolVerifierRegistry,
  tool: VerifiedTool<TInput, TOutput>,
): string {
  registry.register(tool.definition);
  verifiers.register(tool.definition.id, tool.postcondition);
  return tool.definition.id;
}
