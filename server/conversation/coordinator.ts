/**
 * B06 — Conversation coordinator. Routes one turn to exactly one path.
 */
import type { Database } from '@server/persistence/db.js';
import type { WorkRepository } from '@server/work/repository.js';
import type { Identity } from '@server/identity/types.js';
import { ulid } from '@server/persistence/ids.js';
import { z } from 'zod';

export type RouteKind = 'converse' | 'accept_work' | 'read_work' | 'view_intent' | 'correct_memory' | 'control_work' | 'clarify';

export interface RouteDecision {
  kind: RouteKind;
  goal?: string;
  jobId?: string;
  control?: 'pause' | 'cancel' | 'resume';
  correction?: { oldText: string; newText: string };
  viewIntent?: string;
}

const RouteSchema = z.object({
  kind: z.enum(['converse', 'accept_work', 'read_work', 'view_intent', 'correct_memory', 'control_work', 'clarify']),
  goal: z.string().optional(),
  jobId: z.string().optional(),
  control: z.enum(['pause', 'cancel', 'resume']).optional(),
  correction: z.object({ oldText: z.string(), newText: z.string() }).optional(),
  viewIntent: z.string().optional(),
});

function heuristicRoute(text: string, _recentJobId?: string): RouteDecision {
  const t = text.toLowerCase();
  if (t.includes('correct') || t.includes('actually') || t.includes('no, i meant')) return { kind: 'correct_memory', correction: { oldText: text, newText: text } };
  if (t.match(/\b(pause|cancel|resume|stop)\b/) && (t.includes('job') || t.includes('work'))) {
    const ctrl = t.includes('pause') ? 'pause' : t.includes('resume') ? 'resume' : 'cancel';
    return { kind: 'control_work', control: ctrl };
  }
  if (t.includes('status') || t.includes('how is') || t.includes('progress')) return { kind: 'read_work' };
  if (t.includes('show') || t.includes('open') || t.includes('view')) return { kind: 'view_intent', viewIntent: 'work' };
  if (t.match(/\b(build|create|make|do|prepare|draft|research|write)\b/)) return { kind: 'accept_work', goal: text.slice(0, 4000) };
  return { kind: 'converse' };
}

export interface ResponseFrame {
  turnId: string;
  facts: { text: string; provenance: string }[];
  acceptedJobIds: string[];
  verifiedOutcomeIds: string[];
  activeWork: { jobId: string; status: string } | null;
  uncertainties: string[];
  viewIntent: string | null;
  sayText: string;
}

export class ConversationCoordinator {
  constructor(
    private readonly db: Database,
    private readonly repo: WorkRepository,
  ) {}

  route(text: string, recentJobId?: string): RouteDecision {
    const d = heuristicRoute(text, recentJobId);
    // Validate shape — never dispatch an invalid decision.
    RouteSchema.parse(d);
    return d;
  }

  async handleTurn(input: { text: string; identity: Identity; conversationId: string }): Promise<ResponseFrame> {
    const decision = this.route(input.text);
    const turnId = ulid();
    if (decision.kind === 'accept_work' && decision.goal) {
      const requestId = `conv:${input.conversationId}:${turnId}`;
      // Minimal demo job: single step that echoes the goal. Real brief pipeline wires via tools.
      const { jobId } = this.repo.accept({
        identityId: input.identity.id,
        requestId,
        goal: decision.goal,
        steps: [{ toolId: 'echo', inputJson: JSON.stringify({ text: decision.goal }), position: 0 }],
      });
      return {
        turnId,
        facts: [],
        acceptedJobIds: [jobId],
        verifiedOutcomeIds: [],
        activeWork: { jobId, status: 'queued' },
        uncertainties: [],
        viewIntent: 'work',
        sayText: `Got it — queued work ${jobId.slice(-6)}: ${decision.goal.slice(0, 120)}`,
      };
    }
    if (decision.kind === 'read_work') {
      const snap = this.findLatestJob(input.identity.id);
      if (!snap) {
        return { turnId, facts: [], acceptedJobIds: [], verifiedOutcomeIds: [], activeWork: null, uncertainties: ['no active work'], viewIntent: null, sayText: `No active work right now.` };
      }
      return {
        turnId,
        facts: [{ text: `job ${snap.job.id} is ${snap.job.status}`, provenance: `work_job:${snap.job.id}` }],
        acceptedJobIds: [],
        verifiedOutcomeIds: snap.artifacts.filter((a) => a.verificationStatus === 'verified').map((a) => a.artifactId),
        activeWork: { jobId: snap.job.id, status: snap.job.status },
        uncertainties: [],
        viewIntent: null,
        sayText: `Job ${snap.job.id.slice(-6)} — ${snap.job.status}. ${snap.steps.length} steps, ${snap.artifacts.length} artifacts.`,
      };
    }
    if (decision.kind === 'control_work' && decision.control) {
      const snap = this.findLatestJob(input.identity.id);
      if (!snap) return { turnId, facts: [], acceptedJobIds: [], verifiedOutcomeIds: [], activeWork: null, uncertainties: ['no job to control'], viewIntent: null, sayText: `No job to ${decision.control}.` };
      // coordinator control is wired at HTTP layer; here we just frame the intent
      return {
        turnId,
        facts: [],
        acceptedJobIds: [],
        verifiedOutcomeIds: [],
        activeWork: { jobId: snap.job.id, status: snap.job.status },
        uncertainties: [],
        viewIntent: null,
        sayText: `Control ${decision.control} for ${snap.job.id.slice(-6)} — confirm in the work view.`,
      };
    }
    return {
      turnId,
      facts: [],
      acceptedJobIds: [],
      verifiedOutcomeIds: [],
      activeWork: null,
      uncertainties: [],
      viewIntent: decision.viewIntent ?? null,
      sayText: `Heard: ${input.text.slice(0, 160)}`,
    };
  }

  private findLatestJob(identityId: string): ReturnType<WorkRepository['getSnapshot']> {
    const row = this.db.raw.prepare(`SELECT id FROM work_job WHERE identity_id=? ORDER BY created_at DESC LIMIT 1`).get(identityId) as { id: string } | undefined;
    if (!row) return null;
    return this.repo.getSnapshot(row.id);
  }
}
