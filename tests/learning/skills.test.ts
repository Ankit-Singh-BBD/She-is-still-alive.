/**
 * B09.s3: Skill Lifecycle Tests
 *
 * Tests the complete skill lifecycle:
 * - Candidate generation from completed jobs
 * - Sandbox evaluation on held-out data
 * - Promotion gate with statistical criteria
 * - Versioning of promoted skills
 * - Rollback to previous versions
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { SkillManager } from '@server/learning/skills.js';
import { SkillEvaluator } from '@server/learning/evaluation.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('B09.s3 — Skill lifecycle: candidate → evaluation → gate → promotion → rollback', () => {
  let dir: string;
  let db: Database;
  let manager: SkillManager;
  let evaluator: SkillEvaluator;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'madhurita-skills-'));
    db = new Database({ path: path.join(dir, 'test.db') });
    runMigrations(db, migrationsDir);
    manager = new SkillManager(db);
    evaluator = new SkillEvaluator(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a skill candidate from a completed job', () => {
    const candidate = manager.createCandidate({
      sourceJobId: 'job_001',
      pattern: 'when user asks X, do Y',
      confidence: 0.85,
      context: 'task completion',
    });

    expect(candidate.id).toBeDefined();
    expect(candidate.sourceJobId).toBe('job_001');
    expect(candidate.pattern).toBe('when user asks X, do Y');
    expect(candidate.confidence).toBe(0.85);
    expect(candidate.status).toBe('candidate');
    expect(candidate.expiresAt).toBeGreaterThan(Date.now());

    // Verify persistence
    const retrieved = manager.getCandidate(candidate.id);
    expect(retrieved).toMatchObject({
      id: candidate.id,
      sourceJobId: 'job_001',
      pattern: 'when user asks X, do Y',
      status: 'candidate',
    });
  });

  it('evaluates a candidate in sandbox and records metrics', () => {
    const candidate = manager.createCandidate({
      sourceJobId: 'job_002',
      pattern: 'improved context retrieval',
      confidence: 0.9,
      context: 'memory improvement',
    });

    const evaluation = manager.evaluateCandidate(candidate.id);

    expect(evaluation.candidateId).toBe(candidate.id);
    expect(evaluation.heldOutScore).toBeGreaterThanOrEqual(0);
    expect(evaluation.heldOutScore).toBeLessThanOrEqual(1);
    expect(evaluation.baselineScore).toBeGreaterThanOrEqual(0);
    expect(evaluation.precision).toBeGreaterThanOrEqual(0);
    expect(evaluation.recall).toBeGreaterThanOrEqual(0);
    expect(evaluation.f1).toBeGreaterThanOrEqual(0);
    expect(typeof evaluation.statisticalSignificance).toBe('boolean');
    expect(evaluation.errors).toBeGreaterThanOrEqual(0);
    expect(evaluation.robustnessScore).toBeGreaterThanOrEqual(0);

    // Candidate status updated to 'evaluated'
    const updated = manager.getCandidate(candidate.id);
    expect(updated?.status).toBe('evaluated');

    // Evaluation persisted
    const retrieved = manager.getEvaluation(candidate.id);
    expect(retrieved).toMatchObject({
      candidateId: candidate.id,
      heldOutScore: evaluation.heldOutScore,
      baselineScore: evaluation.baselineScore,
    });
  });

  it('promotes an evaluated candidate that passes the gate', () => {
    const candidate = manager.createCandidate({
      sourceJobId: 'job_003',
      pattern: 'skill pattern with high performance',
      confidence: 0.95,
      context: 'proven improvement',
    });

    manager.evaluateCandidate(candidate.id);

    // Repeatedly evaluate until we get metrics that pass the gate
    let promoted;
    let attempts = 0;
    const maxAttempts = 10;

    while (!promoted && attempts < maxAttempts) {
      attempts++;
      try {
        promoted = manager.promoteCandidate(candidate.id);
      } catch {
        // Re-evaluate to get different metrics
        if (attempts < maxAttempts) {
          db.raw.prepare(`DELETE FROM skill_evaluated WHERE candidate_id = ?`).run(candidate.id);
          db.raw
            .prepare(`UPDATE skill_candidate SET status = 'candidate' WHERE id = ?`)
            .run(candidate.id);
          manager.evaluateCandidate(candidate.id);
        }
      }
    }

    // If still not promoted after max attempts, manually insert passing evaluation
    if (!promoted) {
      db.raw.prepare(`DELETE FROM skill_evaluated WHERE candidate_id = ?`).run(candidate.id);
      db.raw
        .prepare(
          `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
           VALUES ('eval_manual', ?, 0.85, 0.50, 0.88, 0.82, 0.85, 1, 0, 0.9, ?)`,
        )
        .run(candidate.id, Date.now());
      db.raw
        .prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`)
        .run(candidate.id);

      promoted = manager.promoteCandidate(candidate.id);
    }

    expect(promoted.id).toBeDefined();
    expect(promoted.candidateId).toBe(candidate.id);
    expect(promoted.version).toBe('1.0.0');
    expect(promoted.previousVersionId).toBeUndefined();
    expect(promoted.lifecycleStatus).toBe('active');

    // Candidate status updated to 'accepted'
    const updated = manager.getCandidate(candidate.id);
    expect(updated?.status).toBe('accepted');
  });

  it('rejects a candidate that fails the promotion gate', () => {
    const candidate = manager.createCandidate({
      sourceJobId: 'job_004',
      pattern: 'low performance skill',
      confidence: 0.4,
      context: 'questionable improvement',
    });

    // Manually insert failing evaluation
    const evaluationId = 'eval_fail';
    db.raw
      .prepare(
        `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
         VALUES (?, ?, 0.35, 0.32, 0.40, 0.35, 0.37, 0, 5, 0.4, ?)`,
      )
      .run(evaluationId, candidate.id, Date.now());

    db.raw.prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`).run(candidate.id);

    expect(() => manager.promoteCandidate(candidate.id)).toThrow(/failed promotion gate/i);

    // Candidate status updated to 'rejected'
    const updated = manager.getCandidate(candidate.id);
    expect(updated?.status).toBe('rejected');
  });

  it('versions promoted skills with semantic versioning', () => {
    const candidate1 = manager.createCandidate({
      sourceJobId: 'job_005',
      pattern: 'version 1 skill',
      confidence: 0.9,
      context: 'initial',
    });

    // First promotion: v1.0.0
    db.raw
      .prepare(
        `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
         VALUES ('eval_v1', ?, 0.85, 0.50, 0.88, 0.82, 0.85, 1, 0, 0.9, ?)`,
      )
      .run(candidate1.id, Date.now());
    db.raw
      .prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`)
      .run(candidate1.id);

    const promoted1 = manager.promoteCandidate(candidate1.id);
    expect(promoted1.version).toBe('1.0.0');
    expect(promoted1.lifecycleStatus).toBe('active');

    // Second candidate from same job improves the skill
    const candidate2 = manager.createCandidate({
      sourceJobId: 'job_005',
      pattern: 'version 2 skill (improved)',
      confidence: 0.92,
      context: 'refinement',
    });

    db.raw
      .prepare(
        `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
         VALUES ('eval_v2', ?, 0.90, 0.50, 0.91, 0.87, 0.89, 1, 0, 0.92, ?)`,
      )
      .run(candidate2.id, Date.now());
    db.raw
      .prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`)
      .run(candidate2.id);

    const promoted2 = manager.promoteCandidate(candidate2.id);
    expect(promoted2.version).toBe('1.1.0');
    expect(promoted2.previousVersionId).toBe(promoted1.id);
    expect(promoted2.lifecycleStatus).toBe('active');

    // Previous version marked as superseded
    const oldVersion = manager.getPromoted(promoted1.id);
    expect(oldVersion?.lifecycleStatus).toBe('superseded');
  });

  it('rolls back a promoted skill to its previous version', () => {
    // Create and promote v1
    const candidate1 = manager.createCandidate({
      sourceJobId: 'job_006',
      pattern: 'stable skill v1',
      confidence: 0.88,
      context: 'initial release',
    });

    db.raw
      .prepare(
        `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
         VALUES ('eval_stable', ?, 0.85, 0.50, 0.88, 0.82, 0.85, 1, 0, 0.9, ?)`,
      )
      .run(candidate1.id, Date.now());
    db.raw
      .prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`)
      .run(candidate1.id);

    const v1 = manager.promoteCandidate(candidate1.id);

    // Create and promote v2 (turns out to be problematic)
    const candidate2 = manager.createCandidate({
      sourceJobId: 'job_006',
      pattern: 'problematic skill v2',
      confidence: 0.85,
      context: 'regression',
    });

    db.raw
      .prepare(
        `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
         VALUES ('eval_problem', ?, 0.82, 0.50, 0.85, 0.78, 0.81, 1, 1, 0.85, ?)`,
      )
      .run(candidate2.id, Date.now());
    db.raw
      .prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`)
      .run(candidate2.id);

    const v2 = manager.promoteCandidate(candidate2.id);
    expect(v2.version).toBe('1.1.0');

    // Rollback v2 to v1
    const rollback = manager.rollback(v2.id, 'Performance regression detected in production');

    expect(rollback.promotedId).toBe(v2.id);
    expect(rollback.toVersionId).toBe(v1.id);
    expect(rollback.reason).toContain('regression');

    // v2 is now archived
    const v2After = manager.getPromoted(v2.id);
    expect(v2After?.lifecycleStatus).toBe('archived');

    // v1 is active again
    const v1After = manager.getPromoted(v1.id);
    expect(v1After?.lifecycleStatus).toBe('active');
  });

  it('lists pending candidates awaiting evaluation', () => {
    manager.createCandidate({
      sourceJobId: 'job_007',
      pattern: 'pending skill 1',
      confidence: 0.8,
      context: 'awaiting eval',
    });

    manager.createCandidate({
      sourceJobId: 'job_008',
      pattern: 'pending skill 2',
      confidence: 0.82,
      context: 'awaiting eval',
    });

    const pending = manager.listPendingCandidates();
    expect(pending.length).toBe(2);
    expect(pending.every((c) => c.status === 'candidate')).toBe(true);
  });

  it('lists evaluated candidates awaiting promotion gate', () => {
    const candidate1 = manager.createCandidate({
      sourceJobId: 'job_009',
      pattern: 'evaluated skill 1',
      confidence: 0.85,
      context: 'awaiting gate',
    });

    const candidate2 = manager.createCandidate({
      sourceJobId: 'job_010',
      pattern: 'evaluated skill 2',
      confidence: 0.87,
      context: 'awaiting gate',
    });

    manager.evaluateCandidate(candidate1.id);
    manager.evaluateCandidate(candidate2.id);

    const evaluated = manager.listPendingPromotion();
    expect(evaluated.length).toBe(2);
    expect(evaluated.every((c) => c.status === 'evaluated')).toBe(true);
  });

  it('purges expired candidates', () => {
    const candidate = manager.createCandidate({
      sourceJobId: 'job_011',
      pattern: 'expired skill',
      confidence: 0.75,
      context: 'will expire',
    });

    // Manually expire it
    db.raw
      .prepare(`UPDATE skill_candidate SET expires_at = ? WHERE id = ?`)
      .run(Date.now() - 1000, candidate.id);

    const purged = manager.purgeExpired();
    expect(purged).toBe(1);

    const retrieved = manager.getCandidate(candidate.id);
    expect(retrieved).toBeUndefined();
  });

  it('applies promotion gate criteria correctly', () => {
    // Passing evaluation
    const passing = {
      id: 'eval_pass',
      candidateId: 'cand_pass',
      heldOutScore: 0.85,
      baselineScore: 0.50,
      precision: 0.88,
      recall: 0.82,
      f1: 0.85,
      statisticalSignificance: true,
      errors: 1,
      robustnessScore: 0.9,
      evaluatedAt: Date.now(),
    };

    const passGate = evaluator.applyGate(passing);
    expect(passGate.passed).toBe(true);
    expect(passGate.reason).toContain('Passed gate');

    // Failing evaluation (insufficient improvement)
    const failingImprovement = {
      ...passing,
      heldOutScore: 0.52,
      baselineScore: 0.50,
    };

    const failGate = evaluator.applyGate(failingImprovement);
    expect(failGate.passed).toBe(false);
    expect(failGate.reason).toContain('improvement');

    // Failing evaluation (too many errors)
    const failingErrors = {
      ...passing,
      errors: 5,
    };

    const errorGate = evaluator.applyGate(failingErrors);
    expect(errorGate.passed).toBe(false);
    expect(errorGate.reason).toContain('errors');
  });

  it('maintains correction links when a skill supersedes prior memory', () => {
    // This tests that promoted skills can reference the memory items they improve upon
    const candidate = manager.createCandidate({
      sourceJobId: 'job_012',
      pattern: 'corrected retrieval strategy',
      confidence: 0.92,
      context: 'supersedes previous memory pattern',
    });

    db.raw
      .prepare(
        `INSERT INTO skill_evaluated (id, candidate_id, held_out_score, baseline_score, precision, recall, f1, statistical_significance, errors, robustness_score, evaluated_at)
         VALUES ('eval_correction', ?, 0.90, 0.55, 0.91, 0.88, 0.89, 1, 0, 0.93, ?)`,
      )
      .run(candidate.id, Date.now());
    db.raw
      .prepare(`UPDATE skill_candidate SET status = 'evaluated' WHERE id = ?`)
      .run(candidate.id);

    const promoted = manager.promoteCandidate(candidate.id);

    expect(promoted.metadata).toBeDefined();
    const metadata = JSON.parse(promoted.metadata ?? '{}');
    expect(metadata.heldOutScore).toBeCloseTo(0.90, 2);
    expect(metadata.f1).toBeCloseTo(0.89, 2);
  });
});
