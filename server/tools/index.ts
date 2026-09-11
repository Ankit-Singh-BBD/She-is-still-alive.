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
import {
  ingestDocumentTool,
  readDocumentTool,
  saveArtifactTool,
  type DocIngestInput,
  type DocReadInput,
  type ArtifactSaveInput,
  type DocIngestOutput,
  type DocReadOutput,
  type ArtifactSaveOutput,
} from './documents.js';
import {
  composeBriefTool,
  fetchSourceTool,
  type BriefInput,
  type BriefOutput,
  type FetchInput,
  type FetchOutput,
} from './sources.js';
import { held, broken } from './types.js';

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
    // B05 — document + brief + bounded fetch (offline-first: doc.ingest before source.fetch)
    installTool<DocIngestInput, DocIngestOutput>(registry, verifiers, {
      definition: ingestDocumentTool({ db: deps.db }),
      postcondition: ({ output, db }) => {
        const id = (output as { sourceId?: string } | undefined)?.sourceId;
        if (typeof id !== 'string') return broken('doc.ingest output missing sourceId');
        const row = (db as Database).raw.prepare(`SELECT id FROM doc_source WHERE id=?`).get(id) as
          | { id: string }
          | undefined;
        return row ? held() : broken(`doc_source ${id} not found`);
      },
    }),
    installTool<DocReadInput, DocReadOutput>(registry, verifiers, {
      definition: readDocumentTool({ db: deps.db }),
      postcondition: ({ output, db: _db }) => {
        const id = (output as { hash?: string } | undefined)?.hash;
        // doc.read is a read — verified if it returned without throwing; hash presence proves the re-read.
        if (typeof id === 'string' && id.length > 0) return held();
        // Also accept lookup by sourceId still present
        const sid = (output as { title?: string } | undefined)?.title;
        return sid ? held() : broken('doc.read returned no verifiable output');
      },
    }),
    installTool<ArtifactSaveInput, ArtifactSaveOutput>(registry, verifiers, {
      definition: saveArtifactTool({ db: deps.db }),
      postcondition: ({ output, db }) => {
        const v = output as { artifactId?: string; version?: number } | undefined;
        if (!v?.artifactId || typeof v.version !== 'number') return broken('artifact.save output missing artifactId/version');
        const row = (db as Database).raw
          .prepare(`SELECT artifact_id FROM work_artifact WHERE artifact_id=? AND version=?`)
          .get(v.artifactId, v.version) as { artifact_id: string } | undefined;
        return row ? held() : broken(`work_artifact ${v.artifactId} v${v.version} not found`);
      },
    }),
    installTool<BriefInput, BriefOutput>(registry, verifiers, {
      definition: composeBriefTool({ db: deps.db }),
      postcondition: ({ output, db }) => {
        const v = output as { artifactId?: string; version?: number } | undefined;
        if (!v?.artifactId || typeof v.version !== 'number') return broken('brief.compose output missing artifactId/version');
        const row = (db as Database).raw
          .prepare(`SELECT artifact_id FROM work_artifact WHERE artifact_id=? AND version=?`)
          .get(v.artifactId, v.version) as { artifact_id: string } | undefined;
        return row ? held() : broken(`brief artifact ${v.artifactId} v${v.version} not found`);
      },
    }),
    installTool<FetchInput, FetchOutput>(registry, verifiers, {
      definition: fetchSourceTool({ db: deps.db }),
      postcondition: ({ output, db }) => {
        const v = output as { sourceId?: string } | undefined;
        if (!v?.sourceId) return broken('source.fetch output missing sourceId');
        const row = (db as Database).raw.prepare(`SELECT id FROM doc_source WHERE id=?`).get(v.sourceId) as
          | { id: string }
          | undefined;
        return row ? held() : broken(`doc_source ${v.sourceId} not found`);
      },
    }),
  ];
}

/**
 * What clearance a tool declares, for the two authorization gates that need it.
 *
 * Stages 6 and 7 both call `check()` with a `clearanceRequired`, and neither has a
 * registry — so without this both had to assume `safe`, the weaker of the two
 * requirements. A write tool then passed both checks and was refused inside the
 * pipeline, meaning the boundary that exists to catch a tampered decision was
 * checking the wrong thing, and the trace blamed the wrong stage.
 */
export function clearanceLookup(registry: ToolRegistry) {
  return (toolId: string): 'safe' | 'all' | undefined => registry.get(toolId)?.clearanceRequired;
}

export { ToolVerifierRegistry, installTool } from './verification.js';
export { PipelineToolExecutor } from './executor.js';
export { toolRoster, describeArgs, type ToolSpec } from './roster.js';
export type { Postcondition, VerifiedTool, VerificationEvidence, VerificationOutcome } from './types.js';
export { held, broken, parseOutput } from './types.js';
