/**
 * B10.s1: Health Registry
 *
 * Manages health probes, aggregates observations, and provides health status
 * for the autonomic noticing system.
 */

import type { Database } from '@server/persistence/db.js';
import type { HealthObservation } from './types.js';
import { HealthRegistry as HealthProbeRegistry, createCoreProbes } from './probes.js';
import type { RecoveryResult } from './recovery.js';
import { RecoveryManager, createStandardRecipes } from './recovery.js';

export class HealthRegistry {
  private probeRegistry: HealthProbeRegistry;
  private recoveryManager: RecoveryManager;
  private lastFullCheck = 0;
  private checkIntervalMs = 30000; // 30 seconds for full system check

  constructor(private readonly db: Database) {
    this.probeRegistry = new HealthProbeRegistry(db);
    this.recoveryManager = new RecoveryManager(db);

    // Register core probes
    const coreProbes = createCoreProbes(db);
    for (const probe of coreProbes) {
      this.probeRegistry.register(probe);
    }

    // Register standard recovery recipes
    const standardRecipes = createStandardRecipes(db);
    for (const recipe of standardRecipes) {
      this.recoveryManager.registerRecipe(recipe);
    }
  }

  /**
   * Start periodic health checking. Returns the timer so the caller owns stopping it.
   *
   * A probe that never ran is why `HealthObservation` has an `unknown` status:
   * until this is called, `getAllObservations()` reports what the last process
   * managed to check and nothing more. `AppBundle.start()` is the one caller.
   */
  start(): NodeJS.Timeout {
    return setInterval(() => {
      void this.checkAll();
    }, this.checkIntervalMs);
  }

  /**
   * The recovery manager, for readers that need to know what has been tried.
   *
   * Exposed rather than duplicated: `server/goal/candidates.ts` puts a blocker on
   * a component whose bounded recovery has already been spent, and the only
   * honest source for "has this been tried" is the manager that tried it.
   */
  get recovery(): RecoveryManager {
    return this.recoveryManager;
  }

  /**
   * Perform a full health check of all registered components.
   */
  async checkAll(): Promise<HealthObservation[]> {
    const now = Date.now();

    // Avoid checking too frequently
    if (now - this.lastFullCheck < this.checkIntervalMs) {
      return this.getAllObservations();
    }

    this.lastFullCheck = now;
    return this.probeRegistry.checkAll();
  }

  /**
   * Get health observation for a specific component.
   */
  getObservation(componentId: string): HealthObservation | undefined {
    return this.probeRegistry.getLatestObservation(componentId);
  }

  /**
   * Get all current health observations.
   */
  getAllObservations(): HealthObservation[] {
    return this.probeRegistry.getAllObservations();
  }

  /**
   * Get overall system health status.
   */
  getSystemHealth(): {
    status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
    unhealthyComponents: string[];
    degradedComponents: string[];
    unknownComponents: string[];
  } {
    const observations = this.getAllObservations();

    const unhealthy: string[] = [];
    const degraded: string[] = [];
    const unknown: string[] = [];

    for (const obs of observations) {
      switch (obs.status) {
        case 'unavailable':
          unhealthy.push(obs.componentId);
          break;
        case 'degraded':
          degraded.push(obs.componentId);
          break;
        case 'unknown':
          unknown.push(obs.componentId);
          break;
        // healthy components are ignored
      }
    }

    // Determine overall status
    let status: 'healthy' | 'degraded' | 'unavailable' | 'unknown' = 'healthy';

    if (unhealthy.length > 0) {
      status = 'unavailable';
    } else if (degraded.length > 0) {
      status = 'degraded';
    } else if (unknown.length > 0) {
      status = 'unknown';
    }

    return {
      status,
      unhealthyComponents: unhealthy,
      degradedComponents: degraded,
      unknownComponents: unknown,
    };
  }

  /**
   * Check if a specific capability is affected by health issues.
   */
  isCapabilityAffected(capability: string): boolean {
    const observations = this.getAllObservations();

    for (const obs of observations) {
      if (obs.affectedCapabilities?.includes(capability)) {
        return obs.status === 'degraded' || obs.status === 'unavailable';
      }
    }

    return false;
  }

  /**
   * Attempt recovery for a component if health indicates degraded/unavailable.
   * Returns undefined if no recovery is needed or already in progress.
   */
  async attemptRecoveryForComponent(
    componentId: string,
  ): Promise<RecoveryResult | undefined> {
    const observation = this.probeRegistry.getLatestObservation(componentId);
    if (!observation || observation.status === 'healthy') {
      return undefined; // No recovery needed
    }

    // Map health status to recovery type
    let recipeId: string | undefined;

    if (observation.status === 'unavailable' || observation.status === 'degraded') {
      // Try to find a matching recipe
      for (const [id, recipe] of this.recoveryManager.getRegisteredRecipes()) {
        if (recipe.componentId === componentId) {
          recipeId = id;
          break;
        }
      }
    }

    if (!recipeId) {
      return undefined; // No recovery recipe for this component
    }

    return await this.recoveryManager.attemptRecovery(recipeId);
  }
}