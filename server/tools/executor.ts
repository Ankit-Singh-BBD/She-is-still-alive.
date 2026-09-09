/**
 * The seam between cognitive stage 7 (ACT) and the action pipeline.
 *
 * Stage 7 declares a deliberately small interface — `execute({toolId, input,
 * context}) → Promise<unknown>` — and until now nothing in the codebase
 * implemented it. So `ActionPipeline` was reachable only from a test, and every
 * cycle that reasoned its way to `execute_tool` was answered with "no tool
 * executor is wired; action is disabled".
 *
 * This is that implementation, and it is thin on purpose. It resolves the
 * caller, hands the call to the pipeline, and translates the pipeline's result
 * back into the shape stage 7 expects. What it must *not* do is decide anything
 * the pipeline already decides.
 *
 * Two translations are worth stating outright, because both are places where a
 * sloppier adapter would make her lie.
 *
 * **`verified` is dropped.** The pipeline verifies at execution time and records
 * what it saw in `action_result`. This adapter returns only the output, so stage
 * 7 marks the result `verified: false` and stage 8 re-reads authoritative state
 * for itself. Passing the pipeline's verdict through would let a verdict formed
 * before stage 8 ran decide what she is allowed to claim.
 *
 * **An unverified success is still a success here.** `success` means the call
 * returned; `verified` means the world changed. Throwing when the pipeline could
 * not confirm the postcondition would collapse those two into one, and stage 9
 * would report "the tool failed" for a tool that in fact ran and whose effect
 * merely could not be proven. Stage 8 draws that distinction; this adapter
 * leaves it room to.
 */

import type { ActionPipeline, PipelineContext } from '@server/actions/pipeline.js';
import type { IdentityRepository } from '@server/identity/repository.js';
import type { Identity } from '@server/identity/types.js';
import type { ToolExecutor, ToolExecutionContext } from '@server/cognition/stages/7.js';

export interface PipelineToolExecutorOptions {
  pipeline: ActionPipeline;
  /**
   * Where the caller is looked up. The identity is re-read here rather than
   * carried in from stage 7, so the permissions the pipeline authorizes against
   * are the ones in the database at the moment of execution.
   */
  identityRepo: IdentityRepository;
}

export class PipelineToolExecutor implements ToolExecutor {
  private readonly pipeline: ActionPipeline;
  private readonly identityRepo: IdentityRepository;

  constructor(opts: PipelineToolExecutorOptions) {
    this.pipeline = opts.pipeline;
    this.identityRepo = opts.identityRepo;
  }

  async execute(call: {
    toolId: string;
    input: unknown;
    context: ToolExecutionContext;
  }): Promise<unknown> {
    const caller = this.resolveCaller(call.context.identityId);

    const context: PipelineContext = {
      toolId: call.toolId,
      input: call.input,
      identityId: call.context.identityId,
      cycleId: call.context.cycleId,
      causationId: call.context.causationId,
      caller,
    };

    const result = await this.pipeline.execute(context);
    if (!result.success) {
      throw new Error(result.error ?? `Tool '${call.toolId}' failed without recording a reason`);
    }
    return result.output;
  }

  /**
   * The caller, as the database has them now.
   *
   * Stage 7 already holds an `Identity`, so re-reading looks redundant. It is
   * not: that object was captured when the runtime was constructed, and
   * `authz.check()` reasons purely from `permissions` without looking at
   * `status`. A runtime built for an owner whose identity was revoked mid-session
   * would therefore still carry owner permissions into the pipeline. Re-reading
   * closes that, and refusing a non-active identity here is the check `check()`
   * does not make.
   */
  private resolveCaller(identityId: string): Identity {
    const identity = this.identityRepo.getIdentity(identityId);
    if (!identity) {
      throw new Error(
        `No enrolled identity '${identityId}'; a tool cannot execute for an unknown caller`,
      );
    }
    if (identity.status !== 'active') {
      throw new Error(
        `Identity '${identityId}' is ${identity.status}; a tool cannot execute for a caller ` +
          `whose enrolment is not active`,
      );
    }
    return identity;
  }
}
