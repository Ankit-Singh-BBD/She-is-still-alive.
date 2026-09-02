import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { EnvironmentVisualState } from '../../state/visual-state.js';
import { useRendererTier } from '../RendererAdapter.js';

export interface EnvironmentProps {
  environment: EnvironmentVisualState;
}

/**
 * Cinematic environment (Part XVIII.3, XVIII.4, XVIII.10, XVIII.11).
 *
 * Composition (sky → mountain → horizon → lake) is the visual hero, not the
 * orb. This module owns:
 *
 *   1. Sky dome — physically-based gradient with sun disc and atmospheric
 *      scattering. Reads `sunDirection` so the sun tracks time of day.
 *   2. Sun disc — additive sprite shader so the sun itself is visible at
 *      sunset / sunrise / night (moon).
 *   3. Mountain ring — a curved ring of displaced low-poly mountains
 *      arranged around the camera. Not a single flat plane.
 *   4. Distance haze — exponential fog with color/density derived from
 *      `EnvironmentState` (not a CSS swap).
 *   5. Stars — additive points drawn at night.
 *
 * Photography-grade HDR equirectangular assets can be dropped in by
 * replacing the procedural skyMat with a CubeTexture / PMREM env map —
 * every downstream consumer already reads the same IBL pipeline via
 * `LightingSystem` and the `scene.environment` property.
 */
export function Environment({ environment }: EnvironmentProps): React.JSX.Element {
  const { config } = useRendererTier();
  const skyMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const sunMatRef = useRef<THREE.ShaderMaterial | null>(null);
  const starsRef = useRef<THREE.Points | null>(null);
  const starsMatRef = useRef<THREE.ShaderMaterial | null>(null);

  // Time-of-day-driven palette (read by sky shader)
  const sky = useMemo(() => {
    const top = new THREE.Color(environment.palette.primary);
    const mid = new THREE.Color(environment.palette.secondary);
    const horizon = new THREE.Color(environment.palette.accent);
    const sun = new THREE.Color(environment.sunColor);
    return { top, mid, horizon, sun };
  }, [environment.palette.primary, environment.palette.secondary, environment.palette.accent, environment.sunColor]);

  // Sun direction as a normalized Vector3 for shader uniforms
  const sunDirVec = useMemo(() => {
    const v = new THREE.Vector3(...environment.sunDirection).normalize();
    return v;
  }, [environment.sunDirection]);

  // ── Sky dome with sun disc + atmospheric scattering ─────────────────────
  const skyMat = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uSkyTop: { value: sky.top },
        uSkyMid: { value: sky.mid },
        uSkyHorizon: { value: sky.horizon },
        uSunDir: { value: sunDirVec },
        uSunColor: { value: sky.sun },
        uLightingIntensity: { value: environment.lightingIntensity },
        uTimeOfDay: { value: todIndex(environment.timeOfDay) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorldDir;
        varying vec3 vPosition;
        void main() {
          vPosition = position;
          vWorldDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSkyTop;
        uniform vec3 uSkyMid;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uLightingIntensity;
        uniform float uTimeOfDay;
        varying vec3 vWorldDir;
        varying vec3 vPosition;

        // ACES Film Tone Mapping approximation for natural cinematic highlights
        vec3 ACESFilm(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        void main() {
          vec3 dir = normalize(vWorldDir);
          float y = clamp(dir.y, -1.0, 1.0);

          // Multi-stop natural atmospheric sky gradient
          // Optical depth increases toward the horizon
          float horizonBand = smoothstep(-0.25, 0.02, y);
          float midBand     = smoothstep(0.02, 0.35, y);
          float zenithBand  = smoothstep(0.35, 0.85, y);

          vec3 col = mix(uSkyHorizon, uSkyMid, horizonBand);
          col = mix(col, uSkyTop, midBand);
          col = mix(col, uSkyTop * vec3(0.82, 0.88, 1.0), zenithBand * 0.4);

          // Atmospheric Rayleigh & Mie scattering around sun
          vec3 sunDirNorm = normalize(uSunDir);
          float sunDot = max(0.0, dot(dir, sunDirNorm));

          // Mie forward scattering (wide diffuse corona)
          float mieCorona = pow(sunDot, 6.0) * 0.35;
          // Inner solar flare
          float mieHalo   = pow(sunDot, 32.0) * 0.65;
          // Sun disc boundary
          float sunDisc   = smoothstep(0.9982, 0.9997, sunDot) * 1.5;

          vec3 sunLight = uSunColor * (mieCorona + mieHalo + sunDisc) * uLightingIntensity;
          col += sunLight;

          // Warm horizon glow during sunrise/sunset
          float horizonWarmFactor = smoothstep(0.25, -0.05, abs(y));
          vec3 horizonTint = mix(vec3(1.0), vec3(1.2, 1.05, 0.88), horizonWarmFactor * 0.25);
          col *= horizonTint;

          // Atmospheric perspective hazing near sea level (horizon mist)
          float mist = exp(-max(0.0, y) * 8.0) * 0.2;
          col = mix(col, uSkyHorizon * 1.1, mist);

          // Night celestial tone correction
          float nightMix = smoothstep(0.4, 1.0, uTimeOfDay);
          col = mix(col, col * vec3(0.4, 0.5, 0.75) + vec3(0.002, 0.005, 0.015), nightMix * 0.5);

          // Apply ACES cinematic tone mapping and exposure
          vec3 mapped = ACESFilm(col * (0.9 + uLightingIntensity * 0.25));
          gl_FragColor = vec4(mapped, 1.0);
        }
      `,
    });
    skyMatRef.current = mat;
    return mat;
  }, [sky.top, sky.mid, sky.horizon, sky.sun, sunDirVec, environment.lightingIntensity, environment.timeOfDay]);

  // ── Sun disc — additive billboard, always visible ───────────────────────
  const sunMat = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uColor: { value: sky.sun },
        uIntensity: { value: environment.lightingIntensity },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          // Place the sun far along the sun direction (project to a far plane).
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uIntensity;
        varying vec2 vUv;
        void main() {
          float d = distance(vUv, vec2(0.5));
          float core = smoothstep(0.5, 0.30, d);
          float halo = pow(smoothstep(0.5, 0.0, d), 3.0) * 0.4;
          float a = core + halo;
          gl_FragColor = vec4(uColor * uIntensity, a);
        }
      `,
    });
    sunMatRef.current = mat;
    return mat;
  }, [sky.sun, environment.lightingIntensity]);

  // Update sun direction in shader (sky + sun billboard)
  useEffect(() => {
    if (skyMatRef.current) {
      const u = skyMatRef.current.uniforms;
      u['uSunDir']!.value = sunDirVec;
      u['uTimeOfDay']!.value = todIndex(environment.timeOfDay);
      u['uLightingIntensity']!.value = environment.lightingIntensity;
    }
  }, [sunDirVec, environment.timeOfDay, environment.lightingIntensity]);

  // ── Mountain ring — multiple displaced low-poly arcs at varying radii ──
  const mountainGroup = useMemo(() => {
    const ringCount = 3;
    const mountainMaterials: THREE.Material[] = [];

    for (let r = 0; r < ringCount; r++) {
      const ringRadius = 60 + r * 22;
      const segments = config.waterQuality === 'full' ? 96 : 48;
      const heightScale = 6 + r * 4;

      // Build a curved ring of mountains as one geometry: each segment is a
      // triangle pair extruded upward, with the top vertex displaced by
      // layered noise. This gives a real silhouette, not a flat plane.
      const positions: number[] = [];
      const indices: number[] = [];
      const heights: number[] = [];

      for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * Math.PI * 2;
        const baseX = Math.cos(theta) * ringRadius;
        const baseZ = Math.sin(theta) * ringRadius;

        // Multi-octave noise for a varied ridge line
        const n1 = Math.sin(theta * 7.1 + r * 1.3) * 0.5 + 0.5;
        const n2 = Math.sin(theta * 13.7 + r * 2.7) * 0.5 + 0.5;
        const n3 = Math.sin(theta * 23.1 + r * 4.1) * 0.5 + 0.5;
        const ridge = (n1 * 0.55 + n2 * 0.30 + n3 * 0.15) * heightScale;

        // Two base vertices (low ground) + one peak vertex
        const halfWidth = 1.6 + r * 0.4;
        positions.push(baseX - Math.sin(theta) * halfWidth, -2, baseZ + Math.cos(theta) * halfWidth);
        positions.push(baseX + Math.sin(theta) * halfWidth, -2, baseZ - Math.cos(theta) * halfWidth);
        positions.push(baseX, -2 + ridge, baseZ);
        heights.push(ridge);
      }

      for (let i = 0; i < segments; i++) {
        const a = i * 3;
        const b = i * 3 + 1;
        const c = i * 3 + 2;
        const d = (i + 1) * 3;
        const e = (i + 1) * 3 + 1;
        const f = (i + 1) * 3 + 2;
        // Front face
        indices.push(a, b, c);
        // Connect to next segment
        indices.push(b, e, c);
        indices.push(c, e, f);
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();

      // Color: further rings are hazier and bluer (atmospheric perspective).
      const baseColor = new THREE.Color(environment.palette.primary)
        .multiplyScalar(0.18 + r * 0.08)
        .lerp(new THREE.Color(environment.fogColor), 0.2 + r * 0.18);

      const mat = new THREE.MeshStandardMaterial({
        color: baseColor,
        roughness: 0.95,
        metalness: 0.0,
        flatShading: true,
        fog: true,
      });
      mountainMaterials.push(mat);
      // Stash heights on the userData so JSX can iterate cleanly.
      (geo as THREE.BufferGeometry & { userData: { ringRadius: number; ring: number } }).userData = {
        ringRadius,
        ring: r,
      };
      // Attach to closure-scoped arrays
      (mountainMaterials as unknown as { geos: THREE.BufferGeometry[] }).geos = (
        mountainMaterials as unknown as { geos: THREE.BufferGeometry[] }
      ).geos || [];
      (mountainMaterials as unknown as { geos: THREE.BufferGeometry[] }).geos.push(geo);
    }

    return mountainMaterials as unknown as THREE.Material[] & {
      geos: THREE.BufferGeometry[];
      ringRadii: number[];
    };
  }, [environment.palette.primary, environment.fogColor, config.waterQuality]);

  // ── Stars (night only) ──────────────────────────────────────────────────
  const starsMat = useMemo(() => {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uOpacity: { value: nightFactor(environment.timeOfDay) * 0.9 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        varying float vPhase;
        uniform float uOpacity;
        void main() {
          vPhase = aPhase;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vPhase;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          float twinkle = 0.7 + 0.3 * sin(vPhase * 6.2831);
          gl_FragColor = vec4(vec3(1.0), a * twinkle * uOpacity);
        }
      `,
    });
    starsMatRef.current = mat;
    return mat;
  }, [environment.timeOfDay]);

  const starsGeo = useMemo(() => {
    const count = config.waterQuality === 'full' ? 800 : 300;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Distribute on upper hemisphere only
      const u = Math.random();
      const v = Math.random() * 0.55 + 0.45; // upper half
      const theta = u * Math.PI * 2;
      const phi = Math.acos(2 * v - 1);
      const r = 180;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      sizes[i] = Math.random() * 1.4 + 0.4;
      phases[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    return geo;
  }, [config.waterQuality]);

  // Update star opacity as time-of-day changes
  useEffect(() => {
    if (starsMatRef.current) {
      starsMatRef.current.uniforms['uOpacity']!.value = nightFactor(environment.timeOfDay) * 0.9;
    }
  }, [environment.timeOfDay]);

  // Sun billboard position (projected far along sun direction)
  const sunPos = useMemo(() => {
    return sunDirVec.clone().multiplyScalar(150);
  }, [sunDirVec]);

  return (
    <group data-testid="environment">
      {/* Distance fog: scene-wide exponential fog, NOT a CSS overlay. */}
      <fog attach="fog" args={[new THREE.Color(environment.fogColor), 8, environment.fogDensity > 0 ? 8 / environment.fogDensity : 80]} />

      {/* Sky dome with sun and atmospheric scattering */}
      <mesh material={skyMat} data-testid="sky-dome">
        <sphereGeometry args={[200, 64, 32]} />
      </mesh>

      {/* Sun billboard */}
      <mesh position={sunPos} material={sunMat} renderOrder={-1} data-testid="sun-disc">
        <planeGeometry args={[20, 20]} />
      </mesh>

      {/* Mountain ring — multiple layers with atmospheric perspective */}
      {Array.isArray(mountainGroup) &&
        (mountainGroup as unknown as { geos: THREE.BufferGeometry[] }).geos?.map((geo, i) => (
          <mesh
            key={i}
            geometry={geo}
            material={(mountainGroup as unknown as THREE.Material[])[i] as THREE.Material}
            data-testid={`mountains-ring-${i}`}
          />
        ))}

      {/* Stars at night */}
      <points ref={starsRef} geometry={starsGeo} material={starsMat} data-testid="stars" />
    </group>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function todIndex(t: EnvironmentVisualState['timeOfDay']): number {
  switch (t) {
    case 'night':
      return 1.0;
    case 'sunset':
    case 'sunrise':
      return 0.5;
    default:
      return 0.0;
  }
}

function nightFactor(t: EnvironmentVisualState['timeOfDay']): number {
  if (t === 'night') return 1.0;
  if (t === 'sunset' || t === 'sunrise') return 0.35;
  return 0.0;
}
