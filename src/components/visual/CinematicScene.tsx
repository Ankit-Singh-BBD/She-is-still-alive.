import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { VisualState } from '../state/visual-state.js';
import type { AudioVisuals } from './AudioReactiveController.js';
import { RendererAdapter, getResponsiveCameraProps } from './RendererAdapter.js';
import type { ViewportMode } from '../shell/ShellLayout.js';

import { LightingSystem } from './scene/LightingSystem.js';
import { Environment } from './scene/Environment.js';
import { Water } from './scene/Water.js';
import { Orb } from './scene/Orb.js';
import { Particles } from './scene/Particles.js';
import { PostProcessing } from './scene/PostProcessing.js';

export interface CinematicSceneProps {
  visual: VisualState;
  viewport: ViewportMode;
  audio: AudioVisuals;
  time: number;
}

/**
 * Top-level scene orchestrator (Part XVIII.25, XVIII.33).
 * Composes Lighting, Environment, Water, Orb, Particles, and PostProcessing
 * within a single shared render context so reflection/lighting are unified.
 *
 * Adaptive composition (Part XVIII.13): the camera preset and orb vertical
 * placement both shift with viewport so the visual hero hierarchy
 * (Sky → Mountains → Horizon → Floating Orb → Lake → Reflection) is preserved
 * on desktop, tablet, and mobile.
 */
export function CinematicScene({ visual, viewport, audio, time }: CinematicSceneProps): React.JSX.Element {
  // Responsive camera preset from viewport (XVIII.13)
  const cameraPreset = useMemo(() => getResponsiveCameraProps(viewport), [viewport]);

  // Orb position adapts to viewport so it remains optically present
  // and centered against the horizon band. The orb group sits at +Y above
  // the water plane; we push it higher on mobile (so mountains don't crowd it)
  // and slightly lower on desktop (so the camera reads the lake reflection).
  const orbPosition = useMemo<[number, number, number]>(() => {
    if (viewport === 'mobile') return [0, 2.1, 0];
    if (viewport === 'tablet') return [0, 1.7, 0];
    return [0, 1.3, 0];
  }, [viewport]);

  // Orb scale adapts to viewport (smaller on mobile to preserve the lake band).
  const orbScale = useMemo(() => {
    if (viewport === 'mobile') return 0.72;
    if (viewport === 'tablet') return 0.85;
    return 1.0;
  }, [viewport]);

  const orbRadius = 1.0;
  const orbPosVec = useMemo(
    () => new THREE.Vector3(orbPosition[0], orbPosition[1], orbPosition[2]),
    [orbPosition],
  );

  return (
    <RendererAdapter
      viewport={viewport}
      camera={{ fov: cameraPreset.fov, position: cameraPreset.position }}
    >
      {/* Lighting Context */}
      <LightingSystem environment={visual.environment} />

      {/* Atmospheric Background & Mountains */}
      <Environment environment={visual.environment} />

      {/* Ocean / Lake */}
      <Water
        environment={visual.environment}
        orbPosition={orbPosVec}
        orbRadius={orbRadius}
        audio={audio}
        time={time}
      />

      {/* Central Glass Agent — position + scale adapt to viewport */}
      <Orb
        visual={visual.orb}
        audio={audio}
        time={time}
        scale={orbScale}
        position={orbPosition}
      />

      {/* Volumetric Effects */}
      <Particles environment={visual.environment} audio={audio} />

      {/* Lens Effects */}
      <PostProcessing />
    </RendererAdapter>
  );
}
