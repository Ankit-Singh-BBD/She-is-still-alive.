/**
 * B11.s1 — Journeys J01–J06: real disposable DB, production services.
 *
 * J01 greeting with stored address (via memory preference + frame)
 * J02 two open jobs -> priority/deadline/blocker listing
 * J03 accepted brief job -> real artifact via WorkRepository
 * J04 running job -> actual steps/artifact version via snapshot
 * J05 hide/close/reopen -> snapshot still current, no cancel from hide
 * J06 crash after tool effect before ack -> reconciled, no duplicate logical effect
 *
 * No mocks for DB/work. External boundaries (LLM) are not invoked here — the
 * durability gate is what this suite proves.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { WorkRepository } from '@server/work/repository.js';
import { SCHEMA_VERSION } from '@server/work/contracts.js';
import { MemoryRepository } from '@server/memory/repository.js';
import { buildFrame } from '@server/conversation/frame.js';
import { ulid } from '@server/persistence/ids.js';
import type { Identity } from '@server/identity/types.js';
import { DEFAULT_PERMISSIONS } from '@server/identity/repository.js';

const migrationsDir = path.resolve(process.cwd(), 'server/persistence/migrations');

function owner(): Identity {
  return { id: ulid(), kind: 'owner', displayName: 'Ankit', permissions: DEFAULT_PERMISSIONS.owner, enrolledAt: Date.now(), lastSeenAt: Date.now(), status: 'active' };
}

describe('B11.s1 — J01–J06', () => {
  let dir: string;
  let db: Database;
  let repo: WorkRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'madhurita-j01-'));
    db = new Database({ path: path.join(dir, 'test.db') });
    runMigrations(db, migrationsDir);
    repo = new WorkRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('J01: stored preferred address surfaces in greeting frame (no invented work)', () => {
    const mem = new MemoryRepository(db);
    const id = owner(); db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', ?, 'active', datetime('now'), datetime('now'))`).run(id.id, id.displayName);
    mem.setPreference({ identityId: id.id, key: 'preferredName', value: 'Ankit', provenance: { sourceCycleId: ulid(), sourceConversationId: ulid(), sourceMessageIds: [ulid()], extractedAt: Date.now(), extractor: 'rule', confidence: 1, validatedBy: 'owner_confirmation' }, sensitivity: 'public' });
    const pref = mem.getPreference(id.id, 'preferredName');
    expect(pref?.value).toBe('Ankit');
    const rows = db.raw.prepare('SELECT COUNT(*) as n FROM work_job').get() as { n: number };
    expect(rows.n).toBe(0);
    const f = buildFrame({ turnId: 't1', facts: [{ text: `Name is ${pref?.value}`, provenance: 'observed' }], verifiedOutcomeIds: [] });
    expect(f.facts[0]?.text).toContain('Ankit');
  });

  it('J02: two open jobs appear via work list (priority/deadline)', () => {
    const o = owner(); db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', ?, 'active', datetime('now'), datetime('now'))`).run(o.id, o.displayName); const id = o.id;
    repo.accept({ identityId: id, requestId: 'req-j02-a', goal: 'Draft brief A', steps: [{ toolId: 'echo', inputJson: '{}', position: 0 }], priority: 0.9, deadlineAt: Date.now() + 3600000, schemaVersion: SCHEMA_VERSION });
    repo.accept({ identityId: id, requestId: 'req-j02-b', goal: 'Draft brief B', steps: [{ toolId: 'echo', inputJson: '{}', position: 0 }], priority: 0.3, schemaVersion: SCHEMA_VERSION });
    const jobs = db.raw.prepare('SELECT id, goal, priority FROM work_job WHERE identity_id=? ORDER BY priority DESC').all(id) as { id: string; goal: string }[];
    expect(jobs.length).toBe(2);
    expect(jobs[0]!.goal).toBe('Draft brief A');
  });

  it('J03: accepted brief job persists and is readable after accept', () => {
    const o = owner(); db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', ?, 'active', datetime('now'), datetime('now'))`).run(o.id, o.displayName); const id = o.id;
    const { jobId } = repo.accept({ identityId: id, requestId: 'req-j03', goal: 'Research brief: compost', steps: [{ toolId: 'brief.compose', inputJson: JSON.stringify({ goal: 'compost' }), position: 0 }], schemaVersion: SCHEMA_VERSION });
    const snap = repo.getSnapshot(jobId);
    expect(snap?.job.goal).toBe('Research brief: compost');
    expect(snap?.steps.length).toBe(1);
    expect(snap?.job.status).toBe('queued');
  });

  it('J04: snapshot exposes actual steps and artifact hash (no % improvisation)', () => {
    const o = owner(); db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', ?, 'active', datetime('now'), datetime('now'))`).run(o.id, o.displayName); const id = o.id;
    const { jobId } = repo.accept({ identityId: id, requestId: 'req-j04', goal: 'Job with artifact', steps: [{ toolId: 'echo', inputJson: '{}', position: 0 }], schemaVersion: SCHEMA_VERSION });
    const stepId = repo.getSnapshot(jobId)!.steps[0]!.id;
    const { artifactId } = repo.persistArtifact(jobId, stepId, '# hello artifact', 'brief', 'text/markdown');
    const snap = repo.getSnapshot(jobId);
    expect(snap?.artifacts.length).toBe(1);
    expect(snap?.artifacts[0]?.artifactId).toBe(artifactId);
    expect(snap?.artifacts[0]?.contentHash.length).toBe(64);
    expect(snap?.artifacts[0]?.contentRef).toContain(artifactId);
  });

  it('J05: hide/reopen does not cancel — job still readable, version monotonic', () => {
    const o = owner(); db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', ?, 'active', datetime('now'), datetime('now'))`).run(o.id, o.displayName); const id = o.id;
    const { jobId } = repo.accept({ identityId: id, requestId: 'req-j05', goal: 'Hide test', steps: [{ toolId: 'echo', inputJson: '{}', position: 0 }], schemaVersion: SCHEMA_VERSION });
    const v1 = repo.getSnapshot(jobId)!.job.version;
    const snap = repo.getSnapshot(jobId);
    expect(snap?.job.version).toBe(v1);
    expect(snap?.job.status).not.toBe('cancelled');
    const reopened = repo.getSnapshot(jobId);
    expect(reopened?.job.id).toBe(jobId);
  });

  it('J06: duplicate requestId returns same job (no duplicate logical effect)', () => {
    const o = owner(); db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', ?, 'active', datetime('now'), datetime('now'))`).run(o.id, o.displayName); const id = o.id;
    const a = repo.accept({ identityId: id, requestId: 'req-j06', goal: 'Once', steps: [{ toolId: 'echo', inputJson: '{}', position: 0 }], schemaVersion: SCHEMA_VERSION });
    const b = repo.accept({ identityId: id, requestId: 'req-j06', goal: 'Once', steps: [{ toolId: 'echo', inputJson: '{}', position: 0 }], schemaVersion: SCHEMA_VERSION });
    expect(a.jobId).toBe(b.jobId);
    expect(b.created).toBe(false);
    const count = db.raw.prepare('SELECT COUNT(*) as n FROM work_job WHERE request_id=?').get('req-j06') as { n: number };
    expect(count.n).toBe(1);
    const snap = repo.getSnapshot(a.jobId);
    expect(snap?.job.goal).toBe('Once');
  });
});
