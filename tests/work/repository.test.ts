import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { WorkRepository } from '@server/work/repository.js';
import { resolve } from 'node:path';

function makeRepo(db: Database): WorkRepository {
  return new WorkRepository(db);
}

describe('WorkRepository B03 gate', () => {
  let db: Database;
  let repo: WorkRepository;
  const identityId = 'usr_owner0000000000000000001';

  beforeEach(() => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, resolve(process.cwd(), 'server/persistence/migrations'));
    // identity id is FK-referenced by work_job
    db.raw.prepare(`INSERT INTO identity (id, kind, display_name, status, enrolled_at, last_seen_at) VALUES (?, 'owner', 'Owner', 'active', 0, 0)`).run(identityId);
    db.raw.prepare(`INSERT INTO permission (identity_id, version, json) VALUES (?, 1, ?)`).run(identityId, JSON.stringify({ manageIdentity: true }));
    repo = makeRepo(db);
  });

  afterEach(() => db.close());

  it('duplicate requestId returns same job (no duplicate)', () => {
    const input = {
      identityId,
      requestId: 'req-001',
      goal: 'build something',
      steps: [{ toolId: 'tool.a', inputJson: '{}', position: 0 }],
    };
    const first = repo.accept(input);
    const second = repo.accept(input);
    expect(first.jobId).toBe(second.jobId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const rows = db.raw.prepare(`SELECT COUNT(*) as c FROM work_job WHERE request_id='req-001'`).get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('invalid plan (cycle) produces no half-job', () => {
    try {
      repo.accept({
        identityId,
        requestId: 'req-cycle',
        goal: 'cycle goal',
        steps: [
          { toolId: 'a', inputJson: '{}', position: 0, dependsOnPositions: [1] },
          { toolId: 'b', inputJson: '{}', position: 1, dependsOnPositions: [0] },
        ],
      });
    } catch {
      // expected
    }
    const rows = db.raw.prepare(`SELECT COUNT(*) as c FROM work_job WHERE request_id='req-cycle'`).get() as { c: number };
    expect(rows.c).toBe(0);
  });

  it('stale expectedVersion returns false (409)', () => {
    const { jobId } = repo.accept({
      identityId,
      requestId: 'req-version',
      goal: 'version test',
      steps: [{ toolId: 'a', inputJson: '{}', position: 0 }],
    });
    const ok = repo.updateJobStatus(jobId, 1, 'running');
    expect(ok).toBe(true);
    const stale = repo.updateJobStatus(jobId, 1, 'paused');
    expect(stale).toBe(false);
    const snap = repo.getSnapshot(jobId);
    expect(snap?.job.status).toBe('running');
    expect(snap?.job.version).toBe(2);
  });

  it('snapshot survives reopen (new repo over same DB)', () => {
    const { jobId } = repo.accept({
      identityId,
      requestId: 'req-snap',
      goal: 'snapshot goal',
      steps: [
        { toolId: 'a', inputJson: '{}', position: 0 },
        { toolId: 'b', inputJson: '{}', position: 1, dependsOnPositions: [0] },
      ],
    });
    const repo2 = makeRepo(db);
    const snap = repo2.getSnapshot(jobId);
    expect(snap?.job.goal).toBe('snapshot goal');
    expect(snap?.steps.length).toBe(2);
  });

  it('persistArtifact creates versions; verifyArtifactBytes validates hash', () => {
    const { jobId } = repo.accept({
      identityId,
      requestId: 'req-art',
      goal: 'artifact goal',
      steps: [{ toolId: 'a', inputJson: '{}', position: 0 }],
    });
    const snap = repo.getSnapshot(jobId) as NonNullable<ReturnType<WorkRepository['getSnapshot']>>;
    const stepId = snap.steps[0]!.id;
    const { artifactId, version } = repo.persistArtifact(jobId, stepId, 'hello bytes', 'report', 'text/plain');
    expect(version).toBe(1);
    expect(repo.verifyArtifactBytes(artifactId, 1, 'hello bytes')).toBe(true);
    expect(repo.verifyArtifactBytes(artifactId, 1, 'wrong bytes')).toBe(false);
    const v2 = repo.persistArtifact(jobId, stepId, 'hello bytes v2', 'report', 'text/plain', artifactId);
    expect(v2.artifactId).toBe(artifactId);
    expect(v2.version).toBe(2);
    expect(repo.verifyArtifactBytes(artifactId, 2, 'hello bytes v2')).toBe(true);
  });

  it('accept with too many steps (32 cap via Zod) is bounded', () => {
    const steps = Array.from({ length: 33 }, (_, i) => ({ toolId: 'a', inputJson: '{}', position: i }));
    let threw = false;
    try {
      repo.accept({ identityId, requestId: 'req-too-many', goal: 'too many', steps });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
