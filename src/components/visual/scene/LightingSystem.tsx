import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import type { EnvironmentVisualState } from '../../state/visual-state.js';
import { useRendererTier } from '../RendererAdapter.js';

export interface LightingSystemProps {
  environment: EnvironmentVisualState;
}

/**
 * Shared lighting context. All scene modules (orb, water, environment) read
 * the same directional + ambient intensities so reflections and shading stay
 * physically consistent (Part XVIII.4, XVIII.9).
 */
export function LightingSystem({ environment }: LightingSystemProps): React.JSX.Element {
  const { config } = useRendererTier();
  const sunRef = useRef<THREE.DirectionalLight | null>(null);
  const ambientRef = useRef<THREE.AmbientLight | null>(null);

  const sunDirection = useMemo<[number, number, number]>(
    () => environment.sunDirection,
    [environment.sunDirection],
  );
  const sunColor = useMemo(() => new THREE.Color(environment.sunColor), [environment.sunColor]);
  const ambientColor = useMemo(
    () => new THREE.Color(environment.palette.secondary),
    [environment.palette.secondary],
  );

  // Smoothly retarget sun direction when time-of-day changes — avoids
  // a hard cut when the EnvironmentState transitions.
  const targetDir = useRef<THREE.Vector3>(new THREE.Vector3(...sunDirection));
  useEffect(() => {
    targetDir.current.set(...sunDirection);
  }, [sunDirection]);

  useFrame((_state, delta) => {
    if (!sunRef.current) return;
    const k = Math.min(1, delta * 1.5);
    sunRef.current.position.lerp(targetDir.current, k);
    if (sunRef.current.target) {
      sunRef.current.target.position.lerp(new THREE.Vector3(0, 0, 0), k);
      sunRef.current.target.updateMatrixWorld();
    }
  });

  return (
    <group data-testid="lighting-system">
      <ambientLight
        ref={ambientRef}
        color={ambientColor}
        intensity={0.4 * environment.lightingIntensity}
      />
      <directionalLight
        ref={sunRef}
        color={sunColor}
        intensity={1.2 * environment.lightingIntensity}
        position={sunDirection}
        castShadow={config.shadowEnabled}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={0.5}
        shadow-camera-far={40}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
      />
      {/* Rim / fill — keeps the orb visible against a dark night sky. */}
      <hemisphereLight
        color={sunColor}
        groundColor={ambientColor}
        intensity={0.25 * environment.lightingIntensity}
      />
    </group>
  );
}
