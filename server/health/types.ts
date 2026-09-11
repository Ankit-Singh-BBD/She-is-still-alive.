/**
 * B10.s1: Health Observation Types
 *
 * Component health tracking with evidence, affected capabilities, and scheduling.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

export interface HealthObservation {
  id: string;
  componentId: string;
  checkedAt: number;
  status: HealthStatus;
  evidenceRef?: string | undefined;
  affectedCapabilities?: string[] | undefined;
  nextCheckAt?: number | undefined;
  createdAt: number;
}

export interface HealthCheckHistory {
  id: string;
  componentId: string;
  checkedAt: number;
  status: HealthStatus;
  evidence?: string;
  durationMs?: number;
  createdAt: number;
}

export interface HealthProbe {
  componentId: string;
  check(): Promise<HealthCheckResult>;
  interval: number;
  timeout?: number;
}

export interface HealthCheckResult {
  status: HealthStatus;
  evidence?: string | undefined;
  affectedCapabilities?: string[] | undefined;
  durationMs: number;
}

export interface ComponentHealth {
  componentId: string;
  lastChecked?: number;
  status: HealthStatus;
  evidenceRef?: string | undefined;
  affectedCapabilities?: string[] | undefined;
  nextCheckAt?: number | undefined;
}
