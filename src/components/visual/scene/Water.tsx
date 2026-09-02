import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { EnvironmentVisualState } from '../../state/visual-state.js';
import type { AudioVisuals } from '../AudioReactiveController.js';
import { useRendererTier } from '../RendererAdapter.js';

export interface WaterProps {
  environment: EnvironmentVisualState;
  orbPosition: THREE.Vector3;
  orbRadius: number;
  orbColor?: string;
  audio: AudioVisuals;
  time: number;
}

/**
 * GPU-rendered water plane (Part XVIII.5):
 *  - Dynamic normals via multi-octave Gerstner waves
 *  - Physical Fresnel reflection (Schlick F0=0.02, IOR=1.33)
 *  - Analytic Orb reflection + dynamic light pool moving with orb
 *  - Sun specular highlight from directional lighting
 *  - Depth-based water coloration and fog integration
 *  - Subtle audio-reactive surface ripples
 */
export function Water({ environment, orbPosition, orbRadius, orbColor = '#ffaa44', audio }: WaterProps): React.JSX.Element {
  const { config } = useRendererTier();
  const waterRef = useRef<THREE.Mesh | null>(null);

  // Water base palette per time-of-day
  const waterDeep = useMemo(() => new THREE.Color(environment.palette.primary).multiplyScalar(0.15), [environment.palette.primary]);
  const waterShallow = useMemo(() => new THREE.Color(environment.palette.secondary).multiplyScalar(0.35), [environment.palette.secondary]);
  const sunColor = useMemo(() => new THREE.Color(environment.sunColor), [environment.sunColor]);
  const orbColorObj = useMemo(() => new THREE.Color(orbColor), [orbColor]);
  const sunDirVec = useMemo(() => new THREE.Vector3(...environment.sunDirection).normalize(), [environment.sunDirection]);

  // Water material with custom shader for waves + Fresnel + specular + orb reflection
  const waterMaterial = useMemo(() => {
    const mat = new THREE.MeshPhysicalMaterial({
      color: waterDeep,
      metalness: 0.05,
      roughness: 0.08,
      transmission: 0.35,
      thickness: 0.6,
      ior: 1.333,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      fog: true,
    });

    mat.onBeforeCompile = shader => {
      shader.uniforms['uTime'] = { value: 0 };
      shader.uniforms['uWaterDeep'] = { value: waterDeep };
      shader.uniforms['uWaterShallow'] = { value: waterShallow };
      shader.uniforms['uSunColor'] = { value: sunColor };
      shader.uniforms['uSunDir'] = { value: sunDirVec };
      shader.uniforms['uOrbPosition'] = { value: orbPosition };
      shader.uniforms['uOrbRadius'] = { value: orbRadius };
      shader.uniforms['uOrbColor'] = { value: orbColorObj };
      shader.uniforms['uOrbEnergy'] = { value: audio.energy };
      shader.uniforms['uAudioLow'] = { value: audio.low };
      shader.uniforms['uAudioMid'] = { value: audio.mid };
      shader.uniforms['uFogColor'] = { value: new THREE.Color(environment.fogColor) };
      shader.uniforms['uFogDensity'] = { value: environment.fogDensity };
      shader.uniforms['uLightingIntensity'] = { value: environment.lightingIntensity };

      // Vertex: Multi-octave Gerstner wave displacement + analytic normal derivation
      shader.vertexShader = `
        uniform float uTime;
        uniform vec3 uOrbPosition;
        uniform float uOrbRadius;
        uniform float uAudioLow;
        uniform float uAudioMid;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec2 vUv;
        ${shader.vertexShader}
      `.replace(
        '#include <begin_vertex>',
        `
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec2 vUv;
        vUv = uv;

        // Gerstner wave parameters: dir, steepness, wavelength
        // Wave 1: Gentle primary swell
        float w1 = 0.06;
        float s1 = 0.12;
        float a1 = s1 / w1;
        float d1 = (position.x * 0.8 + position.z * 0.6) * w1 + uTime * 0.8;

        // Wave 2: Secondary cross-swell
        float w2 = 0.14;
        float s2 = 0.08;
        float a2 = s2 / w2;
        float d2 = (-position.x * 0.6 + position.z * 0.8) * w2 + uTime * 1.1;

        // Wave 3: High frequency capillary ripples
        float w3 = 0.35;
        float a3 = 0.02 * (1.0 + uAudioLow * 0.5);
        float d3 = (position.x * 0.5 - position.z * 0.5) * w3 + uTime * 2.0;

        // Total wave displacement
        float dispY = sin(d1) * a1 + sin(d2) * a2 + sin(d3) * a3;

        // Orb local disturbance — soft depression + circular ripples
        float distToOrb = length(position.xz - uOrbPosition.xz);
        float orbFalloff = smoothstep(uOrbRadius * 3.5, uOrbRadius * 0.5, distToOrb);
        float orbDepression = -0.12 * orbFalloff;
        float orbRipple = sin(distToOrb * 8.0 - uTime * 3.5) * 0.05 * orbFalloff * (1.0 + uAudioMid);

        vec3 displaced = position;
        displaced.y += dispY + orbDepression + orbRipple;

        // Normal computation via finite differences
        float eps = 0.02;
        float d1_x = ((position.x + eps) * 0.8 + position.z * 0.6) * w1 + uTime * 0.8;
        float d2_x = (-(position.x + eps) * 0.6 + position.z * 0.8) * w2 + uTime * 1.1;
        float d3_x = ((position.x + eps) * 0.5 - position.z * 0.5) * w3 + uTime * 2.0;
        float hx = sin(d1_x) * a1 + sin(d2_x) * a2 + sin(d3_x) * a3;

        float d1_z = (position.x * 0.8 + (position.z + eps) * 0.6) * w1 + uTime * 0.8;
        float d2_z = (-position.x * 0.6 + (position.z + eps) * 0.8) * w2 + uTime * 1.1;
        float d3_z = (position.x * 0.5 - (position.z + eps) * 0.5) * w3 + uTime * 2.0;
        float hz = sin(d1_z) * a1 + sin(d2_z) * a2 + sin(d3_z) * a3;

        vec3 normal = normalize(vec3(-(hx - dispY) / eps, 1.0, -(hz - dispY) / eps));
        vNormal = normal;
        vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
      `,
      );

      // Fragment: Physical Fresnel, Sun specular, Orb reflection, light pool, depth
      shader.fragmentShader = `
        uniform vec3 uWaterDeep;
        uniform vec3 uWaterShallow;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform vec3 uOrbPosition;
        uniform float uOrbRadius;
        uniform vec3 uOrbColor;
        uniform float uOrbEnergy;
        uniform vec3 uFogColor;
        uniform float uFogDensity;
        uniform float uLightingIntensity;
        varying vec3 vWorldPos;
        varying vec3 vNormal;
        varying vec2 vUv;
        ${shader.fragmentShader}
      `.replace(
        '#include <dithering_fragment>',
        `
        vec3 viewDir = normalize(cameraPosition - vWorldPos);
        vec3 N = normalize(vNormal);

        // Physical Fresnel (Schlick F0=0.02 for water at IOR 1.33)
        float cosTheta = max(0.0, dot(N, viewDir));
        float F0 = 0.02;
        float fresnel = F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);

        // Water depth gradient
        float depth = max(0.0, -vWorldPos.y + 0.5);
        vec3 waterBase = mix(uWaterShallow, uWaterDeep, smoothstep(0.0, 4.0, depth));

        // Reflected view vector
        vec3 reflDir = reflect(-viewDir, N);

        // Sun specular highlight
        vec3 L = normalize(uSunDir);
        float sunSpec = pow(max(0.0, dot(reflDir, L)), 128.0) * 1.8;
        vec3 sunHighlight = uSunColor * sunSpec * uLightingIntensity;

        // Dynamic Orb Reflection
        vec3 toOrb = uOrbPosition - vWorldPos;
        float orbDist = length(toOrb);
        vec3 orbDir = normalize(toOrb);

        // Specular highlight of the floating orb on the water surface
        float orbSpec = pow(max(0.0, dot(reflDir, orbDir)), 32.0);
        // Direct light pool under orb: softly penetrates into the water
        float orbFalloff = smoothstep(uOrbRadius * 4.0, 0.0, length(vWorldPos.xz - uOrbPosition.xz));
        float orbLightPool = exp(-orbDist * 0.7) * (0.5 + uOrbEnergy * 0.8);

        vec3 orbReflection = uOrbColor * (orbSpec * 2.0 + orbFalloff * orbLightPool);

        // Sky reflection approximation from reflection angle (environmental bleed)
        vec3 skyRefl = mix(uWaterShallow, uWaterDeep * 0.5 + uSunColor * 0.2, clamp(reflDir.y, 0.0, 1.0));

        // Combine surface contributions
        vec3 finalColor = mix(waterBase, skyRefl, fresnel * 0.85);
        finalColor += sunHighlight;
        finalColor += orbReflection;

        // Atmospheric perspective fog
        float distToCam = length(cameraPosition - vWorldPos);
        float fogFactor = 1.0 - exp(-uFogDensity * distToCam * 0.1);
        finalColor = mix(finalColor, uFogColor, fogFactor);

        gl_FragColor = vec4(finalColor * uLightingIntensity, 0.92);
        #include <dithering_fragment>
      `,
      );
    };

    return mat;
  }, [waterDeep, waterShallow, sunColor, sunDirVec, orbPosition, orbRadius, orbColorObj, audio.energy, audio.low, audio.mid, environment.fogColor, environment.fogDensity, environment.lightingIntensity]);

  // Update uniforms smoothly per frame
  useFrame((_, delta) => {
    if (!waterRef.current) return;
    const mat = waterRef.current.material as unknown as { uniforms?: Record<string, { value: unknown } | undefined> };
    if (!mat.uniforms) return;
    const uniforms = mat.uniforms;
    const uTime = uniforms['uTime'];
    const uOrbPosition = uniforms['uOrbPosition'];
    const uOrbRadius = uniforms['uOrbRadius'];
    const uOrbEnergy = uniforms['uOrbEnergy'];
    const uAudioLow = uniforms['uAudioLow'];
    const uAudioMid = uniforms['uAudioMid'];
    const uLightingIntensity = uniforms['uLightingIntensity'];

    if (uTime) (uTime as { value: number }).value += delta;
    if (uOrbPosition) (uOrbPosition as { value: THREE.Vector3 }).value.set(orbPosition.x, orbPosition.y, orbPosition.z);
    if (uOrbRadius) (uOrbRadius as { value: number }).value = orbRadius;
    if (uOrbEnergy) (uOrbEnergy as { value: number }).value = audio.energy;
    if (uAudioLow) (uAudioLow as { value: number }).value = audio.low;
    if (uAudioMid) (uAudioMid as { value: number }).value = audio.mid;
    if (uLightingIntensity) (uLightingIntensity as { value: number }).value = environment.lightingIntensity;
  });

  // Water geometry — wide plane covering horizon
  const waterGeo = useMemo(
    () => new THREE.PlaneGeometry(400, 400, config.waterQuality === 'full' ? 128 : config.waterQuality === 'reduced' ? 64 : 32),
    [config.waterQuality],
  );

  return (
    <mesh
      ref={waterRef}
      geometry={waterGeo}
      material={waterMaterial}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      data-testid="water-plane"
    />
  );
}