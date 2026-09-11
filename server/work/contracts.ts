/**
 * B03 — Work contracts (Zod schemas + inferred types).
 * No model/network calls. Strict enums, schemaVersion: 1, fencing + version.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1 as const;

export const JOB_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'blocked',
  'paused',
  'verifying',
  'completed',
  'failed',
  'cancelled',
] as const;
export const STEP_STATUSES = [
  'pending',
  'running',
  'retry_wait',
  'reconciling',
  'waiting_approval',
  'blocked',
  'verified',
  'failed',
  'cancelled',
] as const;
export const ATTEMPT_STATUSES = ['started', 'returned', 'verified', 'failed', 'unknown'] as const;
export const VERIFICATION_STATUSES = ['pending', 'verified', 'failed'] as const;

export const JobSchema = z.object({
  id: z.string().min(1),
  identityId: z.string().min(1),
  requestId: z.string().min(1),
  goal: z.string().min(1).max(4000),
  status: z.enum(JOB_STATUSES),
  version: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().nonnegative().nullable(),
  maxRuntimeMs: z.number().int().positive().nullable(),
  maxModelCalls: z.number().int().nonnegative().nullable(),
  modelCallsUsed: z.number().int().nonnegative(),
  maxCostUnits: z.number().int().nonnegative().nullable(),
  costUnitsUsed: z.number().int().nonnegative(),
  priority: z.number().min(0).max(1),
  controlIntent: z.enum(['cancel', 'pause']).nullable(),
  schemaVersion: z.literal(SCHEMA_VERSION),
});

export const StepSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  position: z.number().int().nonnegative(),
  toolId: z.string().min(1),
  inputJson: z.string(),
  status: z.enum(STEP_STATUSES),
  version: z.number().int().nonnegative(),
  nextEligibleAt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  leaseOwner: z.string().nullable().optional(),
  leaseExpiresAt: z.number().nullable().optional(),
  fence: z.number().int().nonnegative(),
  schemaVersion: z.literal(SCHEMA_VERSION),
});

export const AttemptSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  occurrenceKey: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  fence: z.number().int().nonnegative(),
  status: z.enum(ATTEMPT_STATUSES),
  startedAt: z.number().int().nonnegative(),
  endedAt: z.number().int().nullable().optional(),
  idempotencyKey: z.string().min(1),
  providerReceipt: z.string().nullable().optional(),
  resultJson: z.string().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  verificationJson: z.string().nullable().optional(),
});

export const ArtifactSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  jobId: z.string().min(1),
  stepId: z.string().min(1),
  kind: z.string().min(1),
  mediaType: z.string().min(1),
  contentHash: z.string().min(1),
  contentRef: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  schemaVersion: z.literal(SCHEMA_VERSION),
});

export const AcceptJobInputSchema = z.object({
  identityId: z.string().min(1),
  requestId: z.string().min(1),
  goal: z.string().min(1).max(4000),
  deadlineAt: z.number().int().nonnegative().nullable().optional(),
  maxRuntimeMs: z.number().int().positive().nullable().optional(),
  maxModelCalls: z.number().int().nonnegative().nullable().optional(),
  maxCostUnits: z.number().int().nonnegative().nullable().optional(),
  priority: z.number().min(0).max(1).optional(),
  steps: z
    .array(
      z.object({
        toolId: z.string().min(1),
        inputJson: z.string(),
        position: z.number().int().nonnegative(),
        maxAttempts: z.number().int().positive().optional(),
        dependsOnPositions: z.array(z.number().int().nonnegative()).optional(),
      }),
    )
    .min(1)
    .max(32),
  schemaVersion: z.literal(SCHEMA_VERSION).optional(),
});

export const SnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  job: JobSchema,
  steps: z.array(StepSchema),
  artifacts: z.array(ArtifactSchema),
  blockers: z.array(z.string()),
  allowedControls: z.array(z.enum(['pause', 'resume', 'cancel'])),
});

export type Job = z.infer<typeof JobSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type AcceptJobInput = z.infer<typeof AcceptJobInputSchema>;
export type WorkSnapshot = z.infer<typeof SnapshotSchema>;

export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export const ILLEGAL_JOB_TRANSITIONS: Record<string, readonly string[]> = {
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalJobStatus(s: string): boolean {
  return (TERMINAL_JOB_STATUSES as readonly string[]).includes(s);
}

export function isLegalJobTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (isTerminalJobStatus(from)) return false;
  return true;
}

export function validateNoCycles(steps: { position: number; dependsOnPositions?: number[] | undefined }[]): string | null {
  const posSet = new Set(steps.map((s) => s.position));
  for (const s of steps) {
    for (const d of s.dependsOnPositions ?? []) {
      if (!posSet.has(d)) return `Step ${s.position} depends on nonexistent position ${d}`;
      if (d === s.position) return `Step ${s.position} cannot depend on itself`;
    }
  }
  // DAG cycle check (Kahn-ish)
  const adj = new Map<number, number[]>();
  const indeg = new Map<number, number>();
  for (const s of steps) {
    if (!indeg.has(s.position)) indeg.set(s.position, 0);
    for (const d of s.dependsOnPositions ?? []) {
      const list = adj.get(d) ?? [];
      list.push(s.position);
      adj.set(d, list);
      indeg.set(s.position, (indeg.get(s.position) ?? 0) + 1);
      if (!indeg.has(d)) indeg.set(d, 0);
    }
  }
  const q: number[] = [];
  for (const [k, v] of indeg) if (v === 0) q.push(k);
  let visited = 0;
  while (q.length) {
    const n = q.shift() as number;
    visited++;
    for (const m of adj.get(n) ?? []) {
      indeg.set(m, (indeg.get(m) ?? 0) - 1);
      if ((indeg.get(m) ?? 0) === 0) q.push(m);
    }
  }
  if (visited !== steps.length) return 'Dependency graph contains a cycle';
  return null;
}
