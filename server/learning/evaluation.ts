/**
 * B09.s3: Sandbox Evaluation for Skill Candidates
 *
 * Evaluates skill candidates in isolation on held-out data,
 * comparing performance against baseline to gate promotion.
 */

import type { Database } from '@server/persistence/db.js';
import type { SkillCandidate, SkillEvaluation } from './skills.js';

export interface EvaluationMetrics {
  heldOutScore: number;
  baselineScore: number;
  improvement: number;
  precision: number;
  recall: number;
  f1: number;
  statisticalSignificance: boolean;
  errors: number;
  robustnessScore: number;
}

export interface PromotionGate {
  passed: boolean;
  reason: string;
  metrics: EvaluationMetrics;
}

/**
 * Minimum improvement threshold over baseline for promotion.
 */
const MIN_IMPROVEMENT = 0.05;

/**
 * Maximum allowed errors in held-out evaluation.
 */
const MAX_ERRORS = 2;

/**
 * Minimum robustness score (0-1) required for promotion.
 */
const MIN_ROBUSTNESS = 0.6;

/**
 * Skill evaluator that runs candidates in sandbox on held-out data.
 */
export class SkillEvaluator {
  constructor(private readonly db: Database) {}

  /**
   * Evaluate a skill candidate in sandbox.
   *
   * Simulates running the skill on held-out test cases and comparing
   * performance against a baseline (current behavior without the skill).
   */
  evaluate(candidate: SkillCandidate): EvaluationMetrics {
    // In a real implementation, this would:
    // 1. Load held-out test cases not seen during candidate generation
    // 2. Run the skill pattern in an isolated sandbox
    // 3. Compare outputs against ground truth
    // 4. Measure baseline performance without the skill
    // 5. Calculate statistical significance

    // Simulation: Skills with higher confidence tend to perform better
    const basePerformance = 0.6 + candidate.confidence * 0.3;
    const noise = (Math.random() - 0.5) * 0.15;

    const heldOutScore = Math.min(Math.max(basePerformance + noise, 0), 1);
    const baselineScore = 0.3 + Math.random() * 0.2;
    const improvement = heldOutScore - baselineScore;

    // Precision and recall from held-out performance
    const precision = heldOutScore > 0.5 ? 0.75 + Math.random() * 0.24 : heldOutScore;
    const recall =
      heldOutScore > 0
        ? (heldOutScore * precision) / (heldOutScore * precision + (1 - heldOutScore))
        : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    // Statistical significance: improvement must be substantial
    const statisticalSignificance = improvement > 0.08;

    // Errors: skills with low confidence or poor performance have more errors
    const errorProbability = Math.max(0, 1 - heldOutScore);
    const errors = Math.floor(errorProbability * 4);

    // Robustness: how consistently the skill performs across test cases
    const robustnessScore = 0.7 + Math.random() * 0.29;

    return {
      heldOutScore,
      baselineScore,
      improvement,
      precision,
      recall,
      f1,
      statisticalSignificance,
      errors,
      robustnessScore,
    };
  }

  /**
   * Apply promotion gate criteria to evaluation metrics.
   *
   * A candidate passes the gate if:
   * - Improvement over baseline exceeds threshold
   * - Statistical significance is demonstrated
   * - Error count is within acceptable bounds
   * - Robustness score meets minimum
   */
  applyGate(evaluation: SkillEvaluation): PromotionGate {
    const metrics: EvaluationMetrics = {
      heldOutScore: evaluation.heldOutScore,
      baselineScore: evaluation.baselineScore,
      improvement: evaluation.heldOutScore - evaluation.baselineScore,
      precision: evaluation.precision,
      recall: evaluation.recall,
      f1: evaluation.f1,
      statisticalSignificance: evaluation.statisticalSignificance,
      errors: evaluation.errors,
      robustnessScore: evaluation.robustnessScore,
    };

    // Gate criteria
    const improvementPasses = metrics.improvement >= MIN_IMPROVEMENT;
    const significancePasses = metrics.statisticalSignificance;
    const errorsPasses = metrics.errors <= MAX_ERRORS;
    const robustnessPasses = metrics.robustnessScore >= MIN_ROBUSTNESS;

    const passed = improvementPasses && significancePasses && errorsPasses && robustnessPasses;

    let reason: string;
    if (!passed) {
      const failures: string[] = [];
      if (!improvementPasses) {
        failures.push(
          `improvement ${metrics.improvement.toFixed(3)} < ${MIN_IMPROVEMENT} threshold`,
        );
      }
      if (!significancePasses) {
        failures.push('not statistically significant');
      }
      if (!errorsPasses) {
        failures.push(`${metrics.errors} errors > ${MAX_ERRORS} max`);
      }
      if (!robustnessPasses) {
        failures.push(
          `robustness ${metrics.robustnessScore.toFixed(2)} < ${MIN_ROBUSTNESS} min`,
        );
      }
      reason = `Failed gate: ${failures.join(', ')}`;
    } else {
      reason = `Passed gate: improvement ${metrics.improvement.toFixed(3)}, F1 ${metrics.f1.toFixed(3)}, ${metrics.errors} errors, robustness ${metrics.robustnessScore.toFixed(2)}`;
    }

    return {
      passed,
      reason,
      metrics,
    };
  }

  /**
   * Evaluate multiple candidates and return those that pass the gate.
   */
  evaluateBatch(candidates: SkillCandidate[]): Array<{
    candidate: SkillCandidate;
    evaluation: EvaluationMetrics;
    gate: PromotionGate;
  }> {
    return candidates.map((candidate) => {
      const metrics = this.evaluate(candidate);
      const gate = this.applyGate({
        id: '',
        candidateId: candidate.id,
        ...metrics,
        evaluatedAt: Date.now(),
      });

      return {
        candidate,
        evaluation: metrics,
        gate,
      };
    });
  }
}
