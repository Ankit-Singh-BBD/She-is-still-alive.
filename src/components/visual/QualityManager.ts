import type { QualityConfig, QualityTier } from '../state/visual-state.js';
import type { ViewportMode } from '../shell/ShellLayout.js';

export class QualityManager {
  /**
   * Determine initial quality tier from device capabilities and viewport.
   * Part XVIII.14 & XVIII.29
   */
  public static selectInitialTier(viewport: ViewportMode): QualityTier {
    if (viewport === 'mobile') return 'LOW';
    if (viewport === 'tablet') return 'MEDIUM';

    // Desktop: inspect DPR / hardware concurrency if available
    if (typeof window !== 'undefined') {
      const dpr = window.devicePixelRatio || 1;
      const cores = navigator.hardwareConcurrency || 4;
      if (dpr >= 2 && cores >= 8) {
        return 'ULTRA';
      }
    }
    return 'HIGH';
  }

  public static getTierConfig(tier: QualityTier, prefersReducedMotion: boolean = false): QualityConfig {
    const scale = prefersReducedMotion ? 0.3 : 1.0;
    switch (tier) {
      case 'ULTRA':
        return {
          tier: 'ULTRA',
          dprCap: 2.0,
          particleCount: Math.floor(150 * scale),
          waterQuality: 'full',
          postEnabled: !prefersReducedMotion,
          shadowEnabled: true,
        };
      case 'HIGH':
        return {
          tier: 'HIGH',
          dprCap: 1.75,
          particleCount: Math.floor(100 * scale),
          waterQuality: 'full',
          postEnabled: !prefersReducedMotion,
          shadowEnabled: true,
        };
      case 'MEDIUM':
        return {
          tier: 'MEDIUM',
          dprCap: 1.5,
          particleCount: Math.floor(50 * scale),
          waterQuality: 'reduced',
          postEnabled: false,
          shadowEnabled: false,
        };
      case 'LOW':
      default:
        return {
          tier: 'LOW',
          dprCap: 1.25,
          particleCount: Math.max(10, Math.floor(25 * scale)),
          waterQuality: 'simplified',
          postEnabled: false,
          shadowEnabled: false,
        };
    }
  }

  /**
   * Safe downgrade step when frame budget is consistently breached.
   */
  public static downgradeTier(current: QualityTier): QualityTier {
    if (current === 'ULTRA') return 'HIGH';
    if (current === 'HIGH') return 'MEDIUM';
    if (current === 'MEDIUM') return 'LOW';
    return 'LOW';
  }
}
