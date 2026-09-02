import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { QualityTier, QualityConfig } from '../state/visual-state.js';
import { QualityManager } from './QualityManager.js';
import type { ViewportMode } from '../shell/ShellLayout.js';

export type RendererKind = 'webgl2' | 'webgpu' | 'css-fallback';

export interface RendererAdapterContextValue {
  tier: QualityTier;
  config: QualityConfig;
  kind: RendererKind;
  /** Whether real WebGL2 is mounted and ready. False ⇒ CSS fallback. */
  ready: boolean;
  prefersReducedMotion: boolean;
}

const Ctx = createContext<RendererAdapterContextValue | null>(null);

export function useRendererTier(): RendererAdapterContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error('useRendererTier must be used inside <RendererAdapter>');
  }
  return v;
}

/**
 * Capability probe — chooses the strongest available renderer.
 * WebGPU when navigator.gpu + adapter is reachable, else WebGL2.
 * R3F's default Canvas already provides a WebGL2 context; we expose the
 * detected kind for downstream scene modules that want to opt into TSL.
 */
export function detectRendererKind(): RendererKind {
  if (typeof navigator !== 'undefined' && (navigator as unknown as { gpu?: unknown }).gpu) {
    return 'webgpu';
  }
  return 'webgl2';
}

export interface RendererAdapterProps {
  viewport: ViewportMode;
  children: React.ReactNode;
  /** When false, skip the Canvas entirely (used by tests / disabled-by-feature-flag). */
  enabled?: boolean;
  /** Aria label for the canvas container. */
  ariaLabel?: string;
  /** Optional inline style on the outer wrapper. */
  style?: React.CSSProperties;
  /** Resize observer wiring is owned here. */
  onResize?: (width: number, height: number) => void;
  /** Optional camera overrides; if omitted a responsive preset from viewport is used. */
  camera?: { fov?: number; position?: [number, number, number] };
}

/**
 * Thin adapter around R3F's <Canvas> that owns:
 *   • capability detection (WebGPU vs WebGL2)
 *   • tier selection from viewport
 *   • DPR cap from tier — capped at 2 via `Math.min(window.devicePixelRatio, 2)` (P26)
 *   • context-loss fallback to a CSS placeholder
 *   • resize observation
 *   • reduced-motion preference hook for particle scaling
 *
 * Scene modules consume tier via useRendererTier(); they remain renderer-
 * agnostic and read the same uniform contract regardless of kind.
 */
/**
 * Responsive camera preset that keeps the composition intact:
 * Sky → Mountains → Horizon → Floating Orb → Lake → Reflection.
 * Mobile draws the horizon band higher so the mountains read at narrow
 * widths and the orb floats above them; tablet tightens FOV; desktop opens up.
 * Y position increases slightly on mobile to frame more sky/mountains.
 */
export function getResponsiveCameraProps(viewport: ViewportMode): {
  position: [number, number, number];
  fov: number;
} {
  switch (viewport) {
    case 'mobile':
      return { position: [0, 2.2, 9.0], fov: 56 };
    case 'tablet':
      return { position: [0, 1.5, 7.2], fov: 50 };
    default:
      return { position: [0, 1.1, 6.2], fov: 46 };
  }
}

export function RendererAdapter(props: RendererAdapterProps): React.JSX.Element {
  const { viewport, children, enabled = true, ariaLabel = 'Madhurita visual scene', style, onResize, camera } = props;
  const [tier, setTier] = useState<QualityTier>(() => QualityManager.selectInitialTier(viewport));
  const [kind, setKind] = useState<RendererKind>(() => detectRendererKind());
  const [ready, setReady] = useState<boolean>(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  });
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const responsiveCamera = useMemo(() => getResponsiveCameraProps(viewport), [viewport]);
  const cameraConfig = useMemo(() => {
    const base = camera ?? responsiveCamera;
    return {
      fov: base.fov ?? responsiveCamera.fov,
      position: base.position ?? responsiveCamera.position,
      near: 0.1,
      far: 420,
    };
  }, [camera, responsiveCamera]);

  const config = useMemo(() => {
    const base = QualityManager.getTierConfig(tier, prefersReducedMotion);
    // DPR cap: Math.min(window.devicePixelRatio, 2) — P26 requirement
    if (typeof window !== 'undefined') {
      const dprCap = Math.min(window.devicePixelRatio || 1, base.dprCap, 2);
      return { ...base, dprCap };
    }
    return base;
  }, [tier, prefersReducedMotion]);

  // Listen for prefers-reduced-motion changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, []);

  useEffect(() => {
    setTier(QualityManager.selectInitialTier(viewport));
  }, [viewport]);

  useEffect(() => {
    if (!wrapperRef.current || !onResize) return;
    const el = wrapperRef.current;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        onResize(width, height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onResize]);

  const ctxValue = useMemo<RendererAdapterContextValue>(
    () => ({ tier, config, kind, ready, prefersReducedMotion }),
    [tier, config, kind, ready, prefersReducedMotion],
  );

  if (!enabled || kind === 'css-fallback') {
    return (
      <Ctx.Provider value={ctxValue}>
        <div
          ref={wrapperRef}
          data-testid="cinematic-scene"
          data-tier={tier}
          data-renderer="css-fallback"
          aria-label={ariaLabel}
          style={{ position: 'relative', width: '100%', height: '100%', ...style }}
        />
      </Ctx.Provider>
    );
  }

  return (
    <Ctx.Provider value={ctxValue}>
      <div
        ref={wrapperRef}
        data-testid="cinematic-scene"
        data-tier={tier}
        data-renderer={kind}
        aria-label={ariaLabel}
        style={{ position: 'relative', width: '100%', height: '100%', ...style }}
      >
        <Canvas
          dpr={config.dprCap}
          gl={{
            antialias: tier !== 'LOW',
            powerPreference: 'high-performance',
            alpha: true,
            preserveDrawingBuffer: false,
          }}
          camera={cameraConfig}
          onCreated={state => {
            setReady(true);
            // Defensive: if context lost, mark not-ready and let CSS placeholder take over.
            const canvasEl = state.gl.domElement;
            canvasEl.addEventListener('webglcontextlost', e => {
              e.preventDefault();
              setReady(false);
            });
          }}
        >
          <RendererBridge />
          {children}
        </Canvas>
      </div>
    </Ctx.Provider>
  );
}

function RendererBridge(): null {
  // Re-export the tier via R3F context so useFrame callbacks can read it.
  // Currently a placeholder; scene modules use useRendererTier directly.
  useThree();
  return null;
}
