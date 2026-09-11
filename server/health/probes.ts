/**
 * B10.s1: Health Probes
 *
 * Component health checks with evidence, affected capabilities, and bounded frequency.
 * A missing probe reports 'unknown', not 'healthy'.
 */

import type { Database } from '@server/persistence/db.js';
import { ulid } from 'ulid';
import type {
  HealthObservation,
  HealthProbe,
  HealthCheckResult,
  HealthStatus,
} from './types.js';

const CHECK_INTERVAL_MS = 60 * 1000; // 1 minute default
const PROBE_TIMEOUT_MS = 5000; // 5 seconds

export class HealthRegistry {
  private probes = new Map<string, HealthProbe>();
  private lastChecks = new Map<string, number>();

  constructor(private readonly db: Database) {}

  /**
   * Register a health probe for a component.
   */
  register(probe: HealthProbe): void {
    this.probes.set(probe.componentId, probe);
  }

  /**
   * Run a single probe and record the observation.
   */
  async checkComponent(componentId: string): Promise<HealthObservation> {
    const probe = this.probes.get(componentId);

    if (!probe) {
      // Missing probe is 'unknown', not healthy
      return this.recordObservation({
        componentId,
        status: 'unknown',
        evidence: 'No probe registered for this component',
        affectedCapabilities: [],
        durationMs: 0,
      });
    }

    const lastCheck = this.lastChecks.get(componentId) ?? 0;
    const now = Date.now();

    // Respect probe frequency cap
    if (now - lastCheck < probe.interval) {
      const existing = this.getLatestObservation(componentId);
      if (existing) return existing;
    }

    this.lastChecks.set(componentId, now);

    try {
      const timeout = probe.timeout ?? PROBE_TIMEOUT_MS;
      const result = await Promise.race([
        probe.check(),
        new Promise<HealthCheckResult>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), timeout),
        ),
      ]);

      return this.recordObservation({ ...result, componentId });
    } catch (err) {
      return this.recordObservation({
        componentId,
        status: 'unavailable',
        evidence: err instanceof Error ? err.message : 'Health check failed',
        affectedCapabilities: [],
        durationMs: 0,
      });
    }
  }

  /**
   * Check all registered probes.
   */
  async checkAll(): Promise<HealthObservation[]> {
    const results: HealthObservation[] = [];

    for (const componentId of this.probes.keys()) {
      try {
        const observation = await this.checkComponent(componentId);
        results.push(observation);
      } catch {
        // Continue checking other probes even if one fails
        results.push(
          this.recordObservation({
            componentId,
            status: 'unavailable',
            evidence: 'Probe execution failed',
            affectedCapabilities: [],
            durationMs: 0,
          }),
        );
      }
    }

    return results;
  }

  /**
   * Get latest observation for a component.
   */
  getLatestObservation(componentId: string): HealthObservation | undefined {
    const row = this.db.raw
      .prepare(
        `SELECT * FROM health_observation WHERE component_id = ? ORDER BY checked_at DESC LIMIT 1`,
      )
      .get(componentId) as
      | {
          id: string;
          component_id: string;
          checked_at: number;
          status: string;
          evidence_ref: string | null;
          affected_capabilities: string | null;
          next_check_at: number | null;
          created_at: number;
        }
      | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      componentId: row.component_id,
      checkedAt: row.checked_at,
      status: row.status as HealthStatus,
      evidenceRef: row.evidence_ref ?? undefined,
      affectedCapabilities: row.affected_capabilities
        ? JSON.parse(row.affected_capabilities)
        : undefined,
      nextCheckAt: row.next_check_at ?? undefined,
      createdAt: row.created_at,
    };
  }

  /**
   * Get all component health statuses.
   */
  getAllObservations(): HealthObservation[] {
    const rows = this.db.raw
      .prepare(
        `SELECT ho.* FROM health_observation ho
         INNER JOIN (
           SELECT component_id, MAX(checked_at) as max_checked
           FROM health_observation
           GROUP BY component_id
         ) latest ON ho.component_id = latest.component_id AND ho.checked_at = latest.max_checked`,
      )
      .all() as Array<{
      id: string;
      component_id: string;
      checked_at: number;
      status: string;
      evidence_ref: string | null;
      affected_capabilities: string | null;
      next_check_at: number | null;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      componentId: row.component_id,
      checkedAt: row.checked_at,
      status: row.status as HealthStatus,
      evidenceRef: row.evidence_ref ?? undefined,
      affectedCapabilities: row.affected_capabilities
        ? JSON.parse(row.affected_capabilities)
        : undefined,
      nextCheckAt: row.next_check_at ?? undefined,
      createdAt: row.created_at,
    }));
  }

  private recordObservation(result: HealthCheckResult & { componentId: string }): HealthObservation {
    const now = Date.now();
    const id = ulid();
    const probe = this.probes.get(result.componentId);

    const observation: HealthObservation = {
      id,
      componentId: result.componentId,
      checkedAt: now,
      status: result.status,
      evidenceRef: result.evidence,
      affectedCapabilities: result.affectedCapabilities,
      nextCheckAt: probe ? now + probe.interval : undefined,
      createdAt: now,
    };

    this.db.raw
      .prepare(
        `INSERT INTO health_observation (id, component_id, checked_at, status, evidence_ref, affected_capabilities, next_check_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        observation.id,
        observation.componentId,
        observation.checkedAt,
        observation.status,
        observation.evidenceRef ?? null,
        observation.affectedCapabilities ? JSON.stringify(observation.affectedCapabilities) : null,
        observation.nextCheckAt ?? null,
        observation.createdAt,
      );

    // Record in history for trend analysis
    const historyId = ulid();
    this.db.raw
      .prepare(
        `INSERT INTO health_check_history (id, component_id, checked_at, status, evidence, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        historyId,
        result.componentId,
        now,
        result.status,
        result.evidence ?? null,
        result.durationMs,
        now,
      );

    return observation;
  }
}

/**
 * Built-in health probes for core components.
 */
export function createCoreProbes(db: Database): HealthProbe[] {
  return [
    // 1. Database read/write probe
    {
      componentId: 'db_readwrite',
      interval: CHECK_INTERVAL_MS,
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          const testId = ulid();
          db.raw
            .prepare(`INSERT INTO health_check_history (id, component_id, checked_at, status, created_at) VALUES (?, 'test', ?, 'healthy', ?)`)
            .run(testId, start, start);
          db.raw.prepare(`DELETE FROM health_check_history WHERE id = ?`).run(testId);
          return {
            status: 'healthy',
            durationMs: Date.now() - start,
            affectedCapabilities: [],
          };
        } catch (err) {
          return {
            status: 'unavailable',
            evidence: err instanceof Error ? err.message : 'DB write failed',
            affectedCapabilities: ['memory', 'tasks', 'conversations'],
            durationMs: Date.now() - start,
          };
        }
      },
    },

    // 2. Database integrity probe
    {
      componentId: 'db_integrity',
      interval: CHECK_INTERVAL_MS * 5, // 5 minutes
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          const result = db.raw.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string };
          const isHealthy = result.integrity_check === 'ok';
          return {
            status: isHealthy ? 'healthy' : 'degraded',
            evidence: isHealthy ? undefined : result.integrity_check,
            affectedCapabilities: isHealthy ? [] : ['memory', 'tasks', 'conversations'],
            durationMs: Date.now() - start,
          };
        } catch (err) {
          return {
            status: 'unavailable',
            evidence: err instanceof Error ? err.message : 'Integrity check failed',
            affectedCapabilities: ['memory', 'tasks', 'conversations'],
            durationMs: Date.now() - start,
          };
        }
      },
    },

    // 3. Memory usage probe
    {
      componentId: 'memory_usage',
      interval: CHECK_INTERVAL_MS,
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          const usage = process.memoryUsage();
          const heapUsedMB = usage.heapUsed / 1024 / 1024;
          const heapTotalMB = usage.heapTotal / 1024 / 1024;
          const usagePercent = (heapUsedMB / heapTotalMB) * 100;

          let status: HealthStatus = 'healthy';
          let evidence: string | undefined;
          const affected: string[] = [];

          if (usagePercent > 95) {
            status = 'unavailable';
            evidence = `Critical heap usage at ${usagePercent.toFixed(1)}%`;
            affected.push('performance', 'stability');
          } else if (usagePercent > 90) {
            status = 'degraded';
            evidence = `Heap usage at ${usagePercent.toFixed(1)}%`;
            affected.push('performance');
          }

          return {
            status,
            evidence,
            affectedCapabilities: affected,
            durationMs: Date.now() - start,
          };
        } catch {
          return {
            status: 'unknown',
            evidence: 'Memory usage check failed',
            affectedCapabilities: [],
            durationMs: Date.now() - start,
          };
        }
      },
    },

    // 4. Disk space probe
    {
      componentId: 'disk_space',
      interval: CHECK_INTERVAL_MS * 10, // 10 minutes
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          const { statfs } = await import('node:fs/promises');
          const stats = await statfs(process.cwd());
          const availableGB = (stats.bavail * stats.bsize) / (1024 ** 3);
          const totalGB = (stats.blocks * stats.bsize) / (1024 ** 3);
          const usagePercent = ((totalGB - availableGB) / totalGB) * 100;

          let status: HealthStatus = 'healthy';
          let evidence: string | undefined;
          const affected: string[] = [];

          if (availableGB < 0.5 || usagePercent > 95) {
            status = 'unavailable';
            evidence = `Critical disk space: ${availableGB.toFixed(2)}GB available`;
            affected.push('memory', 'tasks', 'conversations');
          } else if (availableGB < 1) {
            status = 'degraded';
            evidence = `Low disk space: ${availableGB.toFixed(2)}GB available`;
            affected.push('memory', 'tasks');
          }

          return {
            status,
            evidence,
            affectedCapabilities: affected,
            durationMs: Date.now() - start,
          };
        } catch {
          return {
            status: 'unknown',
            evidence: 'Disk space check failed',
            affectedCapabilities: [],
            durationMs: Date.now() - start,
          };
        }
      },
    },

    // 5. Event delivery lag probe
    {
      componentId: 'event_delivery',
      interval: CHECK_INTERVAL_MS * 2, // 2 minutes
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          // Check if event_log has recent entries and measure lag
          const recent = db.raw
            .prepare(
              `SELECT occurred_at FROM event_log WHERE occurred_at > ? ORDER BY occurred_at DESC LIMIT 1`,
            )
            .get(Date.now() - 60000) as { occurred_at: number } | undefined;

          if (!recent) {
            return {
              status: 'healthy',
              evidence: 'No recent events (system idle)',
              affectedCapabilities: [],
              durationMs: Date.now() - start,
            };
          }

          const lag = Date.now() - recent.occurred_at;

          let status: HealthStatus = 'healthy';
          let evidence: string | undefined;
          const affected: string[] = [];

          if (lag > 30000) {
            status = 'unavailable';
            evidence = `Critical event lag ${(lag / 1000).toFixed(1)}s`;
            affected.push('realtime', 'conversations');
          } else if (lag > 10000) {
            status = 'degraded';
            evidence = `Event lag ${(lag / 1000).toFixed(1)}s`;
            affected.push('realtime');
          }

          return {
            status,
            evidence,
            affectedCapabilities: affected,
            durationMs: Date.now() - start,
          };
        } catch {
          return {
            status: 'unknown',
            evidence: 'Event delivery check failed',
            affectedCapabilities: [],
            durationMs: Date.now() - start,
          };
        }
      },
    },

    // 6. Worker lease health probe
    {
      componentId: 'worker_leases',
      interval: CHECK_INTERVAL_MS,
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          // Check for expired leases
          const expired = db.raw
            .prepare(`SELECT COUNT(*) as count FROM work_lease WHERE expires_at < ? AND released_at IS NULL`)
            .get(Date.now()) as { count: number };

          let status: HealthStatus = 'healthy';
          let evidence: string | undefined;
          const affected: string[] = [];

          if (expired.count > 0) {
            status = 'degraded';
            evidence = `${expired.count} expired lease(s) not released`;
            affected.push('tasks');
          }

          if (expired.count > 5) {
            status = 'unavailable';
            evidence = `${expired.count} expired leases blocking work`;
            affected.push('tasks', 'performance');
          }

          return {
            status,
            evidence,
            affectedCapabilities: affected,
            durationMs: Date.now() - start,
          };
        } catch {
          return {
            status: 'unknown',
            evidence: 'Worker lease check failed',
            affectedCapabilities: [],
            durationMs: Date.now() - start,
          };
        }
      },
    },

    // 7. LLM provider availability probe
    {
      componentId: 'llm_provider',
      interval: CHECK_INTERVAL_MS * 3, // 3 minutes
      async check(): Promise<HealthCheckResult> {
        const start = Date.now();
        try {
          // Check if API key is configured
          const hasKey = !!process.env['GEMINI_API_KEY'];

          if (!hasKey) {
            return {
              status: 'unavailable',
              evidence: 'No LLM API key configured',
              affectedCapabilities: ['cognition', 'conversations', 'tasks'],
              durationMs: Date.now() - start,
            };
          }

          // In a real implementation, this would ping the provider's health endpoint
          // For now, just check configuration
          return {
            status: 'healthy',
            affectedCapabilities: [],
            durationMs: Date.now() - start,
          };
        } catch {
          return {
            status: 'degraded',
            evidence: 'LLM provider check failed',
            affectedCapabilities: ['cognition'],
            durationMs: Date.now() - start,
          };
        }
      },
    },
  ];
}
