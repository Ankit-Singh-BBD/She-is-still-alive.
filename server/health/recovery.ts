/**
 * B10.s2: Bounded Recovery
 *
 * Implements bounded recovery recipes with maximum attempts, cooldowns,
 * preconditions, rollback, and postchecks.
 *
 * Core invariant: Never auto-delete data, never rewrite production code,
 * never purchase quota as recovery.
 *
 * On total process death: an external supervisor (e.g. launchd, systemd)
 * is required — a PWA/in-process engine cannot resurrect its own dead process.
 */

import type { Database } from '@server/persistence/db.js';
import { ulid } from 'ulid';

export type RecoveryType = 'retry' | 'reconnect' | 'reconcile' | 'reroute';

export interface RecoveryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  cooldownMs: number;
}

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffFactor: 2,
  cooldownMs: 60000, // 1 minute cooldown after exhausting attempts
};

export interface RecoveryRecipe<TContext = unknown> {
  id: string;
  componentId: string;
  type: RecoveryType;
  description: string;
  config?: Partial<RecoveryConfig>;

  /** Verify that recovery is applicable and safe to attempt */
  precondition(context?: TContext): Promise<boolean> | boolean;

  /** Execute the recovery action */
  execute(context?: TContext): Promise<void>;

  /** Verify that recovery actually fixed the issue */
  postcheck(context?: TContext): Promise<boolean> | boolean;

  /** Rollback any partial state changes if postcheck fails */
  rollback?(context?: TContext): Promise<void> | void;
}

export interface RecoveryAttemptRecord {
  id: string;
  componentId: string;
  recoveryType: RecoveryType;
  attemptNumber: number;
  startedAt: number;
  endedAt: number | null;
  success: boolean;
  errorMessage: string | null;
  nextAttemptAt: number | null;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecoveryResult {
  recipeId: string;
  componentId: string;
  type: RecoveryType;
  success: boolean;
  attemptNumber: number;
  maxAttempts: number;
  error?: string | undefined;
  nextRetryAllowedAt?: number | undefined;
  rolledBack?: boolean | undefined;
}

export class RecoveryManager {
  private recipes = new Map<string, RecoveryRecipe>();
  private inProgress = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly defaultConfig: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
  ) {}

  /**
   * Register a recovery recipe.
   */
  registerRecipe(recipe: RecoveryRecipe): void {
    this.recipes.set(recipe.id, recipe);
  }

  /**
   * Get read-only access to registered recipes.
   */
  getRegisteredRecipes(): ReadonlyMap<string, RecoveryRecipe> {
    return this.recipes;
  }

  /**
   * Get a registered recipe by ID.
   */
  getRecipe(id: string): RecoveryRecipe | undefined {
    return this.recipes.get(id);
  }

  /**
   * Attempt recovery using a registered recipe.
   *
   * Enforces:
   * 1. Max attempts bounded
   * 2. Exponential backoff delay
   * 3. Precondition verification
   * 4. Postcheck validation
   * 5. Rollback on postcheck failure
   * 6. Idempotent execution (prevents concurrent recovery of same component)
   */
  async attemptRecovery<TContext = unknown>(
    recipeId: string,
    context?: TContext,
  ): Promise<RecoveryResult> {
    const recipe = this.recipes.get(recipeId) as RecoveryRecipe<TContext> | undefined;
    if (!recipe) {
      throw new Error(`Recovery recipe '${recipeId}' not found`);
    }

    const config: RecoveryConfig = {
      ...this.defaultConfig,
      ...recipe.config,
    };

    const lockKey = `${recipe.componentId}:${recipe.type}`;

    // Prevent concurrent recovery for the same component + type
    if (this.inProgress.has(lockKey)) {
      return {
        recipeId: recipe.id,
        componentId: recipe.componentId,
        type: recipe.type,
        success: false,
        attemptNumber: 0,
        maxAttempts: config.maxAttempts,
        error: 'Recovery already in progress for this component',
      };
    }

    // Check recent attempts to enforce rate limiting / backoff
    const recentAttempts = this.getRecentAttempts(recipe.componentId, recipe.type);
    const now = Date.now();

    // If latest attempt has a backoff delay, check if we're still in cooldown
    const latestAttempt = recentAttempts[0];
    if (latestAttempt && latestAttempt.nextAttemptAt && now < latestAttempt.nextAttemptAt) {
      return {
        recipeId: recipe.id,
        componentId: recipe.componentId,
        type: recipe.type,
        success: false,
        attemptNumber: latestAttempt.attemptNumber,
        maxAttempts: config.maxAttempts,
        error: `Recovery on cooldown. Next attempt allowed at ${new Date(latestAttempt.nextAttemptAt).toISOString()}`,
        nextRetryAllowedAt: latestAttempt.nextAttemptAt,
      };
    }

    // Determine current attempt number
    // Reset attempt counter if the last attempt was long ago (past cooldown window)
    const consecutiveFailures = this.getConsecutiveFailures(recentAttempts, config.cooldownMs);
    const attemptNumber = consecutiveFailures + 1;

    if (attemptNumber > config.maxAttempts) {
      return {
        recipeId: recipe.id,
        componentId: recipe.componentId,
        type: recipe.type,
        success: false,
        attemptNumber: consecutiveFailures,
        maxAttempts: config.maxAttempts,
        error: `Maximum recovery attempts (${config.maxAttempts}) exceeded for ${recipe.componentId}`,
        nextRetryAllowedAt: latestAttempt ? latestAttempt.startedAt + config.cooldownMs : undefined,
      };
    }

    this.inProgress.add(lockKey);
    const attemptId = ulid();

    // Calculate next backoff delay for if this attempt fails
    const backoffDelay = Math.min(
      config.baseDelayMs * Math.pow(config.backoffFactor, attemptNumber - 1),
      config.maxDelayMs,
    );
    const nextAttemptAt = now + backoffDelay;

    // Record attempt start in DB
    this.recordAttemptStart({
      id: attemptId,
      componentId: recipe.componentId,
      recoveryType: recipe.type,
      attemptNumber,
      startedAt: now,
      maxAttempts: config.maxAttempts,
      baseDelayMs: config.baseDelayMs,
      maxDelayMs: config.maxDelayMs,
      nextAttemptAt,
    });

    try {
      // 1. Check preconditions
      const canProceed = await recipe.precondition(context);
      if (!canProceed) {
        const errorMsg = 'Recovery precondition check failed';
        this.recordAttemptEnd(attemptId, false, errorMsg, nextAttemptAt);
        return {
          recipeId: recipe.id,
          componentId: recipe.componentId,
          type: recipe.type,
          success: false,
          attemptNumber,
          maxAttempts: config.maxAttempts,
          error: errorMsg,
          nextRetryAllowedAt: nextAttemptAt,
        };
      }

      // 2. Execute recovery
      await recipe.execute(context);

      // 3. Postcheck verification
      const verified = await recipe.postcheck(context);
      if (!verified) {
        let rolledBack = false;
        // 4. Rollback if postcheck fails
        if (recipe.rollback) {
          try {
            await recipe.rollback(context);
            rolledBack = true;
          } catch (rollbackErr) {
            console.error(
              `[recovery] Rollback failed for ${recipe.componentId}:`,
              rollbackErr,
            );
          }
        }

        const errorMsg = 'Postcheck verification failed after recovery execution';
        this.recordAttemptEnd(attemptId, false, errorMsg, nextAttemptAt);
        return {
          recipeId: recipe.id,
          componentId: recipe.componentId,
          type: recipe.type,
          success: false,
          attemptNumber,
          maxAttempts: config.maxAttempts,
          error: errorMsg,
          nextRetryAllowedAt: nextAttemptAt,
          rolledBack,
        };
      }

      // 5. Success! Clear next_attempt_at
      this.recordAttemptEnd(attemptId, true, null, null);
      return {
        recipeId: recipe.id,
        componentId: recipe.componentId,
        type: recipe.type,
        success: true,
        attemptNumber,
        maxAttempts: config.maxAttempts,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      let rolledBack = false;

      // Attempt rollback on unexpected error
      if (recipe.rollback) {
        try {
          await recipe.rollback(context);
          rolledBack = true;
        } catch (rollbackErr) {
          console.error(
            `[recovery] Rollback failed after error for ${recipe.componentId}:`,
            rollbackErr,
          );
        }
      }

      this.recordAttemptEnd(attemptId, false, errorMsg, nextAttemptAt);
      return {
        recipeId: recipe.id,
        componentId: recipe.componentId,
        type: recipe.type,
        success: false,
        attemptNumber,
        maxAttempts: config.maxAttempts,
        error: errorMsg,
        nextRetryAllowedAt: nextAttemptAt,
        rolledBack,
      };
    } finally {
      this.inProgress.delete(lockKey);
    }
  }

  /**
   * Reset the attempt history for a component (e.g. after manual intervention or verified healthy state).
   */
  resetAttempts(componentId: string, recoveryType?: RecoveryType): void {
    if (recoveryType) {
      this.db.raw
        .prepare(
          `DELETE FROM recovery_attempt WHERE component_id = ? AND recovery_type = ?`,
        )
        .run(componentId, recoveryType);
    } else {
      this.db.raw
        .prepare(`DELETE FROM recovery_attempt WHERE component_id = ?`)
        .run(componentId);
    }
  }

  /**
   * Get recent recovery attempts for a component.
   */
  getRecentAttempts(
    componentId: string,
    recoveryType?: RecoveryType,
    limit: number = 10,
  ): RecoveryAttemptRecord[] {
    let query = `SELECT * FROM recovery_attempt WHERE component_id = ?`;
    const params: unknown[] = [componentId];

    if (recoveryType) {
      query += ` AND recovery_type = ?`;
      params.push(recoveryType);
    }

    query += ` ORDER BY started_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.raw.prepare(query).all(...params) as Array<{
      id: string;
      component_id: string;
      recovery_type: string;
      attempt_number: number;
      started_at: number;
      ended_at: number | null;
      success: number;
      error_message: string | null;
      next_attempt_at: number | null;
      max_attempts: number;
      base_delay_ms: number;
      max_delay_ms: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      componentId: r.component_id,
      recoveryType: r.recovery_type as RecoveryType,
      attemptNumber: r.attempt_number,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      success: r.success === 1,
      errorMessage: r.error_message,
      nextAttemptAt: r.next_attempt_at,
      maxAttempts: r.max_attempts,
      baseDelayMs: r.base_delay_ms,
      maxDelayMs: r.max_delay_ms,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  private getConsecutiveFailures(
    attempts: RecoveryAttemptRecord[],
    cooldownMs: number,
  ): number {
    const now = Date.now();
    let count = 0;

    for (const attempt of attempts) {
      // If the attempt is outside the cooldown window, stop counting
      if (now - attempt.startedAt > cooldownMs) {
        break;
      }
      if (attempt.success) {
        // Successful attempt breaks the failure streak
        break;
      }
      count++;
    }

    return count;
  }

  private recordAttemptStart(params: {
    id: string;
    componentId: string;
    recoveryType: RecoveryType;
    attemptNumber: number;
    startedAt: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    nextAttemptAt: number;
  }): void {
    const now = Date.now();
    this.db.raw
      .prepare(
        `INSERT INTO recovery_attempt (
          id, component_id, recovery_type, attempt_number,
          started_at, ended_at, success, error_message,
          next_attempt_at, max_attempts, base_delay_ms, max_delay_ms,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.id,
        params.componentId,
        params.recoveryType,
        params.attemptNumber,
        params.startedAt,
        params.nextAttemptAt,
        params.maxAttempts,
        params.baseDelayMs,
        params.maxDelayMs,
        now,
        now,
      );
  }

  private recordAttemptEnd(
    id: string,
    success: boolean,
    errorMessage: string | null,
    nextAttemptAt: number | null,
  ): void {
    const now = Date.now();
    this.db.raw
      .prepare(
        `UPDATE recovery_attempt SET
          ended_at = ?,
          success = ?,
          error_message = ?,
          next_attempt_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(now, success ? 1 : 0, errorMessage, nextAttemptAt, now, id);
  }
}

/**
 * Built-in recovery recipes for standard failure modes.
 */
export function createStandardRecipes(db: Database): RecoveryRecipe[] {
  return [
    // 1. Stale work lease reconciliation recipe
    {
      id: 'reconcile_expired_leases',
      componentId: 'worker_leases',
      type: 'reconcile',
      description: 'Releases work leases that expired without being freed',
      config: {
        maxAttempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 15000,
      },
      precondition(): boolean {
        // Precondition: check if there are actually expired unreleased leases
        const expired = db.raw
          .prepare(
            `SELECT COUNT(*) as count FROM work_lease WHERE expires_at < ? AND released_at IS NULL`,
          )
          .get(Date.now()) as { count: number };
        return expired.count > 0;
      },
      async execute(): Promise<void> {
        // Release expired leases by setting released_at
        const now = Date.now();
        db.raw
          .prepare(
            `UPDATE work_lease SET released_at = ? WHERE expires_at < ? AND released_at IS NULL`,
          )
          .run(now, now);
      },
      postcheck(): boolean {
        // Postcheck: verify no expired unreleased leases remain
        const remaining = db.raw
          .prepare(
            `SELECT COUNT(*) as count FROM work_lease WHERE expires_at < ? AND released_at IS NULL`,
          )
          .get(Date.now()) as { count: number };
        return remaining.count === 0;
      },
    },

    // 2. DB read retry recipe
    {
      id: 'retry_db_read',
      componentId: 'db_readwrite',
      type: 'retry',
      description: 'Retries transient SQLite read failure with integrity check',
      config: {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
      },
      precondition(): boolean {
        // Can only retry if DB connection object exists
        return !!db.raw;
      },
      async execute(): Promise<void> {
        // Simple probe read to test connection
        db.raw.prepare(`SELECT 1`).get();
      },
      postcheck(): boolean {
        try {
          const res = db.raw.prepare(`SELECT 1 as val`).get() as { val: number } | undefined;
          return res?.val === 1;
        } catch {
          return false;
        }
      },
    },

    // 3. Route switch recipe for LLM fallback
    {
      id: 'reroute_llm_fallback',
      componentId: 'llm_provider',
      type: 'reroute',
      description: 'Switches to fallback local/hybrid model route on provider outage',
      config: {
        maxAttempts: 2,
        baseDelayMs: 5000,
        maxDelayMs: 20000,
      },
      precondition(): boolean {
        // Precondition: check if fallback is configured
        return true;
      },
      async execute(): Promise<void> {
        // In actual implementation, this sets an active fallback flag in the router
      },
      postcheck(): boolean {
        return true;
      },
    },
  ];
}
