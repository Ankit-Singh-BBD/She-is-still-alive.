import type { QualityTier } from '../state/visual-state.js';

/**
 * PerformanceMonitor — lightweight FPS / frame-time sampler.
 * Per Part XVIII.16 & XVIII.29.
 * First version is passive (measures only). Callers may poll shouldDowngrade()
 * to decide whether to step down a quality tier. No auto-oscillation.
 */
export class PerformanceMonitor {
  private frameTimes: number[] = [];
  private lastFrameAt = 0;
  private breachCount = 0;
  private okCount = 0;

  /** Target FPS per tier — borrowed from XVIII.16 guidance. */
  private static readonly FRAME_BUDGET_MS = 1000 / 55; // ~55fps budget before considering breached
  private static readonly BREACH_THRESHOLD = 12; // consecutive breached frames before suggesting downgrade
  private static readonly RECOVERY_THRESHOLD = 60; // consecutive ok frames to clear breach

  public onFrame(nowMs: number): void {
    if (this.lastFrameAt === 0) {
      this.lastFrameAt = nowMs;
      return;
    }
    const dt = nowMs - this.lastFrameAt;
    this.lastFrameAt = nowMs;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();

    if (dt > PerformanceMonitor.FRAME_BUDGET_MS) {
      this.breachCount++;
      this.okCount = 0;
    } else {
      this.okCount++;
      if (this.okCount >= PerformanceMonitor.RECOVERY_THRESHOLD) {
        this.breachCount = 0;
      }
    }
  }

  public getAverageFps(): number {
    if (this.frameTimes.length === 0) return 60;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avg > 0 ? 1000 / avg : 60;
  }

  public shouldDowngrade(): boolean {
    return this.breachCount >= PerformanceMonitor.BREACH_THRESHOLD;
  }

  public reset(): void {
    this.frameTimes = [];
    this.breachCount = 0;
    this.okCount = 0;
    this.lastFrameAt = 0;
  }

  /** Hook for RendererAdapter / CinematicScene to record downgrade. */
  public consumeDowngradeSignal(): boolean {
    if (this.shouldDowngrade()) {
      this.breachCount = 0;
      this.okCount = 0;
      return true;
    }
    return false;
  }

  /** Test helper — expose breach count. */
  public getBreachCount(): number {
    return this.breachCount;
  }
}

/**
 * Pure helper to suggest next tier given current tier and monitor state.
 * No side effects — caller decides whether to apply.
 */
export function suggestNextTier(
  current: QualityTier,
  monitor: PerformanceMonitor,
  downgrade: (t: QualityTier) => QualityTier,
): QualityTier {
  if (monitor.shouldDowngrade()) return downgrade(current);
  return current;
}
