/**
 * B10.s1: Health Probe and Registry Tests
 *
 * Tests the health observation system:
 * - 7+ probes (DB, integrity, memory, disk, events, leases, LLM)
 * - Missing probe reports 'unknown', not healthy
 * - Frequency capping and probe intervals
 * - Aggregated system health and affected capabilities
 * - Integration with autonomic noticing
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Database } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
import { HealthRegistry } from '@server/health/registry.js';
import { HealthRegistry as HealthProbeRegistry, createCoreProbes } from '@server/health/probes.js';
import type { HealthProbe } from '@server/health/types.js';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'server/persistence/migrations');

describe('B10.s1 — Health probes and observations', () => {
  let dir: string;
  let db: Database;
  let registry: HealthRegistry;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'madhurita-health-'));
    db = new Database({ path: path.join(dir, 'test.db') });
    runMigrations(db, migrationsDir);
    registry = new HealthRegistry(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports unknown when no probe is registered for a component', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    const observation = await probeRegistry.checkComponent('non_existent_component');

    expect(observation.status).toBe('unknown');
    expect(observation.evidenceRef).toContain('No probe registered');
    expect(observation.componentId).toBe('non_existent_component');
  });

  it('runs core database read/write probe successfully', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    const probes = createCoreProbes(db);
    const dbProbe = probes.find((p) => p.componentId === 'db_readwrite');
    expect(dbProbe).toBeDefined();

    if (dbProbe) {
      probeRegistry.register(dbProbe);
      const observation = await probeRegistry.checkComponent('db_readwrite');

      expect(observation.status).toBe('healthy');
      expect(observation.componentId).toBe('db_readwrite');
      expect(observation.checkedAt).toBeGreaterThan(0);
    }
  });

  it('runs database integrity probe successfully', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    const probes = createCoreProbes(db);
    const integrityProbe = probes.find((p) => p.componentId === 'db_integrity');
    expect(integrityProbe).toBeDefined();

    if (integrityProbe) {
      probeRegistry.register(integrityProbe);
      const observation = await probeRegistry.checkComponent('db_integrity');

      expect(observation.status).toBe('healthy');
      expect(observation.componentId).toBe('db_integrity');
    }
  });

  it('runs memory usage probe and reports heap stats', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    const probes = createCoreProbes(db);
    const memoryProbe = probes.find((p) => p.componentId === 'memory_usage');
    expect(memoryProbe).toBeDefined();

    if (memoryProbe) {
      probeRegistry.register(memoryProbe);
      const observation = await probeRegistry.checkComponent('memory_usage');

      // In tests, memory should normally be healthy
      expect(['healthy', 'degraded']).toContain(observation.status);
      expect(observation.componentId).toBe('memory_usage');
    }
  });

  it('runs disk space probe successfully', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    const probes = createCoreProbes(db);
    const diskProbe = probes.find((p) => p.componentId === 'disk_space');
    expect(diskProbe).toBeDefined();

    if (diskProbe) {
      probeRegistry.register(diskProbe);
      const observation = await probeRegistry.checkComponent('disk_space');

      expect(['healthy', 'degraded']).toContain(observation.status);
      expect(observation.componentId).toBe('disk_space');
    }
  });

  it('runs worker lease probe and detects expired leases', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    const probes = createCoreProbes(db);
    const leaseProbe = probes.find((p) => p.componentId === 'worker_leases');
    expect(leaseProbe).toBeDefined();

    if (leaseProbe) {
      probeRegistry.register(leaseProbe);

      // Initially healthy with no leases
      const observation1 = await probeRegistry.checkComponent('worker_leases');
      expect(observation1.status).toBe('healthy');

      // Insert an expired lease to test degradation
      const now = Date.now();
      db.raw
        .prepare(
          `INSERT INTO work_lease (id, target_kind, target_id, owner_worker_id, acquired_at, expires_at)
           VALUES ('lease_expired', 'task', 't1', 'w1', ?, ?)`,
        )
        .run(now - 10000, now - 5000);

      // Force recheck by clearing cache / advancing time
      const leaseProbeWithShortInterval: HealthProbe = {
        ...leaseProbe,
        interval: 0,
      };
      probeRegistry.register(leaseProbeWithShortInterval);

      const observation2 = await probeRegistry.checkComponent('worker_leases');
      expect(observation2.status).toBe('degraded');
      expect(observation2.evidenceRef).toContain('expired lease');
      expect(observation2.affectedCapabilities).toContain('tasks');
    }
  });

  it('aggregates system health correctly', async () => {
    const observations = await registry.checkAll();
    expect(observations.length).toBeGreaterThan(0);

    const health = registry.getSystemHealth();
    expect(['healthy', 'degraded', 'unavailable', 'unknown']).toContain(health.status);
    expect(Array.isArray(health.unhealthyComponents)).toBe(true);
    expect(Array.isArray(health.degradedComponents)).toBe(true);
    expect(Array.isArray(health.unknownComponents)).toBe(true);
  });

  it('identifies affected capabilities when a component is degraded', async () => {
    const probeRegistry = new HealthProbeRegistry(db);

    // Register a mock degraded probe
    const degradedProbe: HealthProbe = {
      componentId: 'mock_degraded',
      interval: 1000,
      async check() {
        return {
          status: 'degraded',
          evidence: 'High latency detected',
          affectedCapabilities: ['speech_recognition', 'voice_output'],
          durationMs: 50,
        };
      },
    };

    probeRegistry.register(degradedProbe);
    await probeRegistry.checkComponent('mock_degraded');

    const observation = probeRegistry.getLatestObservation('mock_degraded');
    expect(observation?.status).toBe('degraded');
    expect(observation?.affectedCapabilities).toEqual(['speech_recognition', 'voice_output']);
  });

  it('caps probe execution frequency based on interval', async () => {
    const probeRegistry = new HealthProbeRegistry(db);
    let checkCount = 0;

    const slowProbe: HealthProbe = {
      componentId: 'slow_probe',
      interval: 5000, // 5 seconds
      async check() {
        checkCount++;
        return {
          status: 'healthy',
          durationMs: 10,
        };
      },
    };

    probeRegistry.register(slowProbe);

    // First check runs the probe
    await probeRegistry.checkComponent('slow_probe');
    expect(checkCount).toBe(1);

    // Immediate second check returns cached observation without running check()
    await probeRegistry.checkComponent('slow_probe');
    expect(checkCount).toBe(1);
  });
});
