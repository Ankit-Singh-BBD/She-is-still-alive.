/**
 * The tools she actually has, and the one function that installs them.
 *
 * Seven of them, over subsystems that already existed and had no way in: four
 * into memory (`server/memory/`) and three into scheduling
 * (`server/tasks/executor.ts`). Before this, `server/app.ts` constructed an
 * empty `ToolRegistry` and boot said so out loud — *"tools — none registered;
 * stage 7 has nothing it can execute"*. That line is what this file removes,
 * honestly.
 *
 * ## Clearance
 *
 * Reads are `safe`, writes are `all`. With `DEFAULT_PERMISSIONS` that means only
 * the owner can do either, because `person` and `guest` both get
 * `mayAccessTools: []` — an allow-list, not a deny-list, so a newly enrolled
 * person cannot execute a tool until the owner grants it by name. The split still
 * matters: it is what lets the owner grant `memory.recall` to a family member
 * without also granting the ability to write into her memory.
 *
 * ## Why there is no tool roster in the build book
 *
 * There isn't one — the book specifies the registry, the pipeline and the
 * verification rule, and names no tool ids anywhere. So this roster is an
 * implementation choice, chosen to be the smallest set that makes the four
 * faculties she already has reachable: remember, recall, prefer, remind.
 */

import type { Database } from '@server/persistence/db.js';
import type { ToolRegistry } from '@server/actions/registry.js';
import type { MemoryRepository } from '@server/memory/repository.js';
import type { MemoryRetrieval } from '@server/memory/retrieval.js';
import type { TaskExecutor } from '@server/tasks/executor.js';
import { installTool } from './verification.js';
import type { ToolVerifierRegistry } from './verification.js';
import {
  rememberEventTool,
  rememberFactTool,
  setPreferenceTool,
  recallTool,
} from './memory.js';
import {
  scheduleReminderTool,
  cancelReminderTool,
  listRemindersTool,
} from './reminders.js';

export interface CoreToolDeps {
  registry: ToolRegistry;
  verifiers: ToolVerifierRegistry;
  memoryRepo: MemoryRepository;
  memoryRetrieval: MemoryRetrieval;
  taskExecutor: TaskExecutor;
  db: Database;
}

/**
 * Installs every core tool, each with its postcondition.
 *
 * Registration is one `installTool` call per tool rather than a loop over an
 * array, and that is not an accident of style: each tool has its own input and
 * output types, and calling the generic function directly is what type-checks
 * `execute`'s input against its schema and its return against its output schema.
 * A heterogeneous array would need a cast, and the cast would be exactly where a
 * mismatched schema stopped being caught.
 *
 * Returns the ids in registration order, which is what boot prints.
 */
export function installCoreTools(deps: CoreToolDeps): string[] {
  const { registry, verifiers } = deps;
  const memory = {
    memoryRepo: deps.memoryRepo,
    memoryRetrieval: deps.memoryRetrieval,
    db: deps.db,
  };
  const reminders = { taskExecutor: deps.taskExecutor };

  return [
    installTool(registry, verifiers, rememberEventTool(memory)),
    installTool(registry, verifiers, rememberFactTool(memory)),
    installTool(registry, verifiers, setPreferenceTool(memory)),
    installTool(registry, verifiers, recallTool(memory)),
    installTool(registry, verifiers, scheduleReminderTool(reminders)),
    installTool(registry, verifiers, cancelReminderTool(reminders)),
    installTool(registry, verifiers, listRemindersTool(reminders)),
  ];
}

/**
 * What clearance a tool declares, for stage 7's defence-in-depth check.
 *
 * Stage 7 re-authorizes before dispatch, and it has no registry — so without
 * this it had to assume `safe`, which is the weaker of the two requirements. A
 * write tool would then pass stage 7's check and be refused later inside the
 * pipeline, meaning the boundary that exists to catch a tampered decision was
 * checking the wrong thing.
 */
export function clearanceLookup(registry: ToolRegistry) {
  return (toolId: string): 'safe' | 'all' | undefined => registry.get(toolId)?.clearanceRequired;
}

export { ToolVerifierRegistry, installTool } from './verification.js';
export { PipelineToolExecutor } from './executor.js';
export type { Postcondition, VerifiedTool, VerificationEvidence, VerificationOutcome } from './types.js';
export { held, broken, parseOutput } from './types.js';
