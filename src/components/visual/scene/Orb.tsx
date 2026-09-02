import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { OrbVisualState } from '../../state/visual-state.js';
import type { AudioVisuals } from '../AudioReactiveController.js';
import { useRendererTier } from '../RendererAdapter.js';

export interface OrbProps {
  visual: OrbVisualState;
  audio: AudioVisuals;
  time: number;
  scale?: number;
  position?: [number, number, number];
}

/**
 * 3D Optical Glass Orb implementation per Part XVIII.4:
 *  - Outer sphere: MeshPhysicalMaterial with real optical glass parameters:
 *      transmission, refraction, Fresnel, thickness, attenuation, clearcoat
 *  - Inner core: smaller luminous core with internal scattering depth
 *  - Equator ring: 128-point line loop displaced by real time-domain audio data
 *  - Floats above water with subtle harmonic bobbing and breathing
 *  - Restrained bloom and physical specular highlights
 */
export function Orb({ visual, audio, time, scale = 1.0, position = [0, 1.2, 0] }: OrbProps): React.JSX.Element {
  const { config } = useRendererTier();
  const groupRef = useRef<THREE.Group | null>(null);
  const outerRef = useRef<THREE.Mesh | null>(null);
  const innerRef = useRef<THREE.Mesh | null>(null);
  const equatorRef = useRef<THREE.Line<THREE.BufferGeometry, THREE.Material | THREE.Material[]> | null>(null);

  // Reusable vectors/colors to avoid per-frame allocations (XVIII.16)
  const baseColor = useMemo(() => new THREE.Color(visual.baseColor), [visual.baseColor]);
  const emissionColor = useMemo(() => new THREE.Color(visual.emissionColor), [visual.emissionColor]);

  // Equator ring geometry — 128 points
  const equatorPoints = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const count = 128;
    for (let i = 0; i <= count; i++) {
      const theta = (i / count) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(theta) * 1.015, 0, Math.sin(theta) * 1.015));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  // Outer glass material — true optical glass with physical transmission and attenuation
  const outerMaterial = useMemo(() => {
    return new THREE.MeshPhysicalMaterial({
      color: baseColor,
      emissive: emissionColor,
      emissiveIntensity: 0.12 * visual.energyLevel,
      transmission: visual.transmission, // 0.92
      opacity: 1.0,
      transparent: true,
      roughness: 0.03,
      metalness: 0.02,
      ior: visual.ior, // 1.45 (optical glass)
      thickness: visual.thickness, // 1.2
      attenuationColor: emissionColor,
      attenuationDistance: 1.5,
      specularIntensity: 1.0,
      specularColor: new THREE.Color('#ffffff'),
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      reflectivity: 0.9,
    });
  }, [baseColor, emissionColor, visual.energyLevel, visual.transmission, visual.ior, visual.thickness]);

  // Inner core material — luminous scattering depth
  const innerMaterial = useMemo(() => {
    return new THREE.MeshStandardMaterial({
      color: emissionColor,
      emissive: emissionColor,
      emissiveIntensity: 0.85 * visual.energyLevel,
      roughness: 0.35,
      metalness: 0.05,
      transparent: true,
      opacity: 0.9,
    });
  }, [emissionColor, visual.energyLevel]);

  // Equator line material
  const equatorMaterial = useMemo(() => {
    return new THREE.LineBasicMaterial({
      color: emissionColor,
      transparent: true,
      opacity: 0.9,
      linewidth: 2,
      blending: THREE.AdditiveBlending,
    });
  }, [emissionColor]);

  // Equator line object
  const equatorLine = useMemo(() => {
    return new THREE.Line(equatorPoints, equatorMaterial);
  }, [equatorPoints, equatorMaterial]);

  // Animate orb float + audio reactive breathing + equator wave
  useFrame((_, delta) => {
    // Float bobbing
    const bobOffset = Math.sin(time * 1.4) * 0.06;
    const currentY = position[1] + bobOffset;

    if (groupRef.current) {
      groupRef.current.position.set(position[0], currentY, position[2]);
      groupRef.current.scale.set(scale, scale, scale);
    }

    if (outerRef.current) {
      // Audio reactive breathing + low-frequency pulse
      const breathScale = 1.0 + Math.sin(time * 0.7) * 0.015 + audio.energy * 0.06;
      outerRef.current.scale.set(breathScale, breathScale, breathScale);
      outerRef.current.rotation.y += delta * 0.15;
    }

    if (innerRef.current) {
      // Inner core pulse driven by audio transient & bands
      const corePulse = 0.70 * (1.0 + audio.low * 0.15 + audio.transient * 0.25);
      innerRef.current.scale.set(corePulse, corePulse, corePulse);
      innerRef.current.rotation.y -= delta * 0.25;
      innerRef.current.rotation.z += delta * 0.1;
    }

    if (equatorRef.current) {
      equatorRef.current.rotation.y += delta * 0.4;

      // Update equator vertex displacement from time-domain audio data
      const positions = equatorRef.current.geometry.attributes['position'];
      if (positions) {
        const count = positions.count;
        const audioAmp = (audio.voiceIntensity > 0 ? audio.voiceIntensity : audio.energy) * 0.18;
        for (let i = 0; i < count; i++) {
          const theta = (i / count) * Math.PI * 2;
          const harmonic = Math.sin(theta * 5.0 + time * 7.0) * 0.6 + Math.cos(theta * 9.0 - time * 11.0) * 0.4;
          const wave = harmonic * audioAmp;
          const r = 1.015 + wave;
          positions.setXYZ(i, Math.cos(theta) * r, wave * 0.4, Math.sin(theta) * r);
        }
        positions.needsUpdate = true;
      }
    }
  });

  return (
    <group ref={groupRef} data-testid="orb-renderer">
      {/* Outer Glass Sphere */}
      <mesh
        ref={outerRef}
        geometry={new THREE.SphereGeometry(1.0, config.tier === 'ULTRA' ? 64 : 32, config.tier === 'ULTRA' ? 64 : 32)}
        material={outerMaterial}
        castShadow={config.shadowEnabled}
        data-testid="orb-outer-glass"
      />
      {/* Inner Luminous Core */}
      <mesh
        ref={innerRef}
        geometry={new THREE.SphereGeometry(0.70, 32, 32)}
        material={innerMaterial}
        data-testid="orb-inner-core"
      />
      {/* Equator Waveform Ring */}
      <primitive
        object={equatorLine}
        ref={equatorRef}
        data-testid="orb-equator-ring"
      />
    </group>
  );
}