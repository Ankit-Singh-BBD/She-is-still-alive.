import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { EnvironmentVisualState } from '../../state/visual-state.js';
import type { AudioVisuals } from '../AudioReactiveController.js';
import { useRendererTier } from '../RendererAdapter.js';

export interface ParticlesProps {
  environment: EnvironmentVisualState;
  audio: AudioVisuals;
}

/**
 * Instanced GPU particle system (Part XVIII.11, XVIII.14):
 *  - Stardust (night + clear)
 *  - Embers (sunrise / sunset)
 *  - Pollen (day + clear/cloudy/fog)
 *  - Snow (snow weather)
 *  - Rain (rainy / stormy weather)
 *  - Tier-scaled particle counts (25 to 150)
 */
export function Particles({ environment, audio }: ParticlesProps): React.JSX.Element {
  const { config } = useRendererTier();
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  const particleType = useMemo(() => {
    const weather = environment.weather;
    const tod = environment.timeOfDay;
    if (weather === 'snow') return 'snow';
    if (weather === 'rainy' || weather === 'stormy') return 'rain';
    if (tod === 'night' && weather === 'clear') return 'stardust';
    if (tod === 'sunset' || tod === 'sunrise') return 'embers';
    return 'pollen';
  }, [environment.weather, environment.timeOfDay]);

  const count = config.particleCount;

  // Initial particle attributes
  const particleData = useMemo(() => {
    const positions: [number, number, number][] = [];
    const velocities: [number, number, number][] = [];
    const scales: number[] = [];

    for (let i = 0; i < count; i++) {
      positions.push([
        (Math.random() - 0.5) * 40,
        Math.random() * 20 - 5,
        (Math.random() - 0.5) * 40,
      ]);

      if (particleType === 'snow') {
        velocities.push([(Math.random() - 0.5) * 0.2, -(Math.random() * 0.5 + 0.2), (Math.random() - 0.5) * 0.2]);
        scales.push(Math.random() * 0.15 + 0.05);
      } else if (particleType === 'rain') {
        velocities.push([0, -(Math.random() * 2.0 + 1.5), 0]);
        scales.push(Math.random() * 0.3 + 0.1);
      } else if (particleType === 'embers') {
        velocities.push([(Math.random() - 0.5) * 0.3, Math.random() * 0.4 + 0.1, (Math.random() - 0.5) * 0.3]);
        scales.push(Math.random() * 0.1 + 0.03);
      } else {
        // Stardust / Pollen — gentle drift
        velocities.push([(Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.1]);
        scales.push(Math.random() * 0.08 + 0.02);
      }
    }
    return { positions, velocities, scales };
  }, [count, particleType]);

  // Color from particle type / palette
  const particleColor = useMemo(() => {
    if (particleType === 'embers') return new THREE.Color(environment.palette.accent);
    if (particleType === 'stardust') return new THREE.Color('#ffffff');
    if (particleType === 'snow') return new THREE.Color('#e0f0ff');
    if (particleType === 'rain') return new THREE.Color('#a0c0e0');
    return new THREE.Color(environment.palette.accent);
  }, [particleType, environment.palette.accent]);

  // Dummy object for matrix transforms
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, delta) => {
    if (!meshRef.current) return;

    for (let i = 0; i < count; i++) {
      const pos = particleData.positions[i];
      const vel = particleData.velocities[i];
      const scale = particleData.scales[i];

      if (!pos || !vel || scale === undefined) continue;

      pos[0] += vel[0] * delta * 5.0;
      pos[1] += vel[1] * delta * 5.0;
      pos[2] += vel[2] * delta * 5.0;

      // Wrap boundaries
      if (pos[1] < -5) pos[1] = 15;
      if (pos[1] > 15) pos[1] = -5;
      if (pos[0] < -20) pos[0] = 20;
      if (pos[0] > 20) pos[0] = -20;
      if (pos[2] < -20) pos[2] = 20;
      if (pos[2] > 20) pos[2] = -20;

      dummy.position.set(pos[0], pos[1], pos[2]);
      const audioScale = scale * (1.0 + audio.energy * 0.3);
      dummy.scale.set(audioScale, audioScale, audioScale);
      dummy.updateMatrix();

      meshRef.current.setMatrixAt(i, dummy.matrix);
    }
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, count]}
      data-testid="instanced-particles"
      data-particletype={particleType}
    >
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color={particleColor} transparent opacity={0.6} depthWrite={false} blending={particleType === 'stardust' ? 2 : particleType === 'embers' ? 2 : 1} fog />
    </instancedMesh>
  );
}