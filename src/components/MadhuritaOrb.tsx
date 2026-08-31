// ===================================================================
// MADHURITA ORB — Real-Time 3D WebGL / R3F Cinematic Experience
// ===================================================================
//
// Built with React Three Fiber (R3F), Three.js, GLSL, and Web Audio API:
//   - Outer Glass Sphere: Physical transmission, IOR 1.45, iridescence, clearcoat
//   - Inner Energy Core: Custom GLSL ShaderMaterial nebula & vortex
//   - Equator Waveform Ring: Dynamic 128-vertex 3D soundwave driven by real audio
//   - Acoustic Ripple Rings: Expansive concentric sound pulses
//   - Post-Processing: ACES Filmic ToneMapping & Selective Bloom
//   - Time-of-Day Lighting Palettes (NIGHT, SUNRISE, DAY, SUNSET)
//   - 6 Voice states (Listening, Thinking, Speaking, Processing, Idle, Error)

import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment } from '@react-three/drei';
import { EffectComposer, Bloom, ToneMapping } from '@react-three/postprocessing';
import { motion, AnimatePresence } from 'motion/react';
import { useTimeOfDay, useWeatherExpression } from '../hooks/useUIState.js';
import { LiveState } from '../types.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

export type OrbVoiceState = LiveState | 'idle' | 'thinking' | 'processing' | 'error';
export type TimePeriod = 'night' | 'sunrise' | 'day' | 'sunset';

interface MadhuritaOrbProps {
  state?: OrbVoiceState;
  size?: number; // Diameter in pixels
  onClick?: () => void;
  streamer?: AudioStreamer;
  player?: AudioPlayer;
  className?: string;
  showStateLabel?: boolean;
  isThinking?: boolean;
}

// -------------------------------------------------------------------
// GLSL Shaders for Inner Volumetric Nebula Core
// -------------------------------------------------------------------
const coreVertexShader = `
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const coreFragmentShader = `
  uniform float uTime;
  uniform float uAudioVolume;
  uniform vec3 uColorPrimary;
  uniform vec3 uColorSecondary;
  uniform vec3 uColorAccent;
  uniform float uVoiceState; // 0=idle, 1=listening, 2=thinking, 3=speaking, 4=processing, 5=error

  varying vec3 vNormal;
  varying vec3 vPosition;
  varying vec2 vUv;

  // Simplex-style 3D noise
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  void main() {
    vec3 pos = vPosition * 2.2;
    float timeSpeed = 0.45;
    if (uVoiceState > 1.5 && uVoiceState < 3.5) timeSpeed = 1.2; // faster during thinking/speaking

    // Flowing turbulence nebula noise
    float n1 = snoise(pos + vec3(0.0, uTime * timeSpeed, 0.0));
    float n2 = snoise(pos * 2.0 - vec3(uTime * timeSpeed * 0.8, 0.0, uTime * 0.4));
    float combinedNoise = (n1 * 0.6 + n2 * 0.4);

    // Radial falloff from core center
    float dist = length(vPosition) / 0.85;
    float coreFalloff = smoothstep(1.0, 0.1, dist);

    // Color gradient mixing
    vec3 color = mix(uColorSecondary, uColorPrimary, combinedNoise * 0.5 + 0.5);
    color = mix(color, uColorAccent, pow(clamp(n2, 0.0, 1.0), 2.0) * (0.8 + uAudioVolume * 1.5));

    // Internal starburst spike
    float spike = exp(-dist * 8.0) * (1.2 + uAudioVolume * 2.0);
    color += vec3(1.0) * spike * 0.45;

    float alpha = clamp((coreFalloff * 0.85 + spike * 0.5) * (0.6 + combinedNoise * 0.4), 0.0, 0.95);
    gl_FragColor = vec4(color, alpha);
  }
`;

// -------------------------------------------------------------------
// 3D Scene Inside Canvas
// -------------------------------------------------------------------
interface SceneProps {
  orbTheme: any;
  activeState: OrbVoiceState;
  timePeriod: TimePeriod;
  streamer?: AudioStreamer;
  player?: AudioPlayer;
}

function OrbScene({
  orbTheme,
  activeState,
  timePeriod,
  streamer,
  player,
}: SceneProps) {
  const outerSphereRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.ShaderMaterial>(null);
  const waveLineRef = useRef<THREE.Line>(null);
  const particlesRef = useRef<THREE.Points>(null);
  const ripple1Ref = useRef<THREE.Mesh>(null);
  const ripple2Ref = useRef<THREE.Mesh>(null);
  const ripple3Ref = useRef<THREE.Mesh>(null);

  // Audio analysis buffer
  const audioBuffer = useMemo(() => new Uint8Array(128), []);
  const smoothedVolRef = useRef(0);

  // 128-point Equator Waveform Ring — BufferGeometry + Line object
  const waveGeometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const count = 128;
    const positions = new Float32Array(count * 3);
    const radius = 1.32;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);

  const waveLineObject = useMemo(() => {
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.Line(waveGeometry, mat);
    line.frustumCulled = false;
    return line;
  }, [waveGeometry]);

  // Internal 3D Stardust Particles
  const { particleGeometry, particleSpeeds } = useMemo(() => {
    const count = 220;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const r = 0.15 + Math.random() * 0.85;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);

      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.65;
      positions[i * 3 + 2] = r * Math.cos(phi);
      speeds[i] = (0.2 + Math.random() * 0.5) * (Math.random() > 0.5 ? 1 : -1);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return { particleGeometry: geo, particleSpeeds: speeds };
  }, []);

  // Uniforms for Inner ShaderMaterial
  const coreUniforms = useMemo(() => {
    let stateCode = 0.0;
    if (activeState === 'listening') stateCode = 1.0;
    if (activeState === 'thinking') stateCode = 2.0;
    if (activeState === 'speaking') stateCode = 3.0;
    if (activeState === 'processing') stateCode = 4.0;
    if (activeState === 'error') stateCode = 5.0;

    return {
      uTime: { value: 0 },
      uAudioVolume: { value: 0 },
      uColorPrimary: { value: orbTheme.primary },
      uColorSecondary: { value: orbTheme.secondary },
      uColorAccent: { value: orbTheme.accent },
      uVoiceState: { value: stateCode },
    };
  }, [orbTheme, activeState]);

  // Frame Loop Animation
  useFrame(({ clock }) => {
    const elapsedTime = clock.getElapsedTime();

    // 1. Web Audio API live telemetry
    let rawVolume = 0;
    let hasAudio = false;

    if (activeState === 'listening' && streamer) {
      streamer.getWaveformData(audioBuffer);
      let sum = 0;
      for (let i = 0; i < audioBuffer.length; i++) {
        sum += Math.abs(audioBuffer[i] - 128);
      }
      rawVolume = sum / (audioBuffer.length * 128);
      hasAudio = rawVolume > 0.002;
    } else if (activeState === 'speaking' && player) {
      player.getWaveformData(audioBuffer);
      let sum = 0;
      for (let i = 0; i < audioBuffer.length; i++) {
        sum += Math.abs(audioBuffer[i] - 128);
      }
      rawVolume = sum / (audioBuffer.length * 128);
      hasAudio = rawVolume > 0.002;
    } else if (activeState === 'thinking') {
      rawVolume = 0.2 + Math.sin(elapsedTime * 3.5) * 0.08;
    } else if (activeState === 'processing') {
      rawVolume = 0.16 + Math.cos(elapsedTime * 4.0) * 0.06;
    } else if (activeState === 'error') {
      rawVolume = 0.05;
    }

    smoothedVolRef.current += (rawVolume - smoothedVolRef.current) * 0.18;
    const vol = smoothedVolRef.current;

    // 2. Update Inner Core Shader Uniforms
    if (coreMatRef.current) {
      coreMatRef.current.uniforms.uTime.value = elapsedTime;
      coreMatRef.current.uniforms.uAudioVolume.value = vol;
      coreMatRef.current.uniforms.uColorPrimary.value.copy(orbTheme.primary);
      coreMatRef.current.uniforms.uColorSecondary.value.copy(orbTheme.secondary);
      coreMatRef.current.uniforms.uColorAccent.value.copy(orbTheme.accent);
    }

    // 3. Update Outer Glass Sphere
    if (outerSphereRef.current) {
      const scale = 1.0 + vol * 0.05;
      outerSphereRef.current.scale.setScalar(scale);
      outerSphereRef.current.rotation.y = elapsedTime * 0.08;
    }

    // 4. Update Stardust Particles
    if (particlesRef.current) {
      particlesRef.current.rotation.y = elapsedTime * 0.15 * orbTheme.pulseSpeed;
      particlesRef.current.rotation.z = Math.sin(elapsedTime * 0.25) * 0.08;
    }

    // 5. Update 3D Equator Waveform Ring
    if (waveLineRef.current) {
      if (waveLineRef.current.material) {
        (waveLineRef.current.material as THREE.LineBasicMaterial).color.copy(orbTheme.accent);
      }
      const posAttr = waveGeometry.attributes.position as THREE.BufferAttribute;
      const pos = posAttr.array as Float32Array;
      const count = 128;
      const baseRadius = 1.3;

      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        let waveDisplacement = 0;

        if ((activeState === 'listening' || activeState === 'speaking') && hasAudio) {
          const bufIdx = Math.floor((i / count) * 128);
          const rawSignal = (audioBuffer[bufIdx] - 128) / 128;
          const amp = vol * 0.8 + 0.06;
          waveDisplacement = rawSignal * amp + Math.sin(elapsedTime * 6.0 + i * 0.2) * 0.025;
        } else if (activeState === 'thinking') {
          waveDisplacement = Math.sin(elapsedTime * 5.0 + i * 0.35) * 0.06 * (1.0 + vol);
        } else if (activeState === 'processing') {
          waveDisplacement = Math.cos(elapsedTime * 6.5 + i * 0.45) * 0.05;
        } else if (activeState === 'error') {
          const s = Math.sin(elapsedTime * 8.0 + i * 0.5);
          waveDisplacement = Math.sign(s) * Math.min(1.0, Math.abs(s) * 2.0) * 0.04;
        } else {
          // Idle calm harmonic breathing wave
          waveDisplacement =
            (Math.sin(elapsedTime * 1.6 + i * 0.2) * 0.02 +
              Math.cos(elapsedTime * 2.4 + i * 0.3) * 0.015);
        }

        const r = baseRadius + waveDisplacement;
        pos[i * 3] = Math.cos(angle) * r;
        pos[i * 3 + 1] = waveDisplacement * 1.5; // slight 3D vertical displacement
        pos[i * 3 + 2] = Math.sin(angle) * r;
      }
      posAttr.needsUpdate = true;
    }

    // 6. Expand Acoustic Ripple Rings during voice active states
    const isVoiceActive = activeState === 'listening' || activeState === 'speaking';
    const rippleSpeed = 1.2;

    if (ripple1Ref.current && ripple2Ref.current && ripple3Ref.current) {
      if (isVoiceActive) {
        const t1 = (elapsedTime * rippleSpeed) % 2.0;
        const t2 = (elapsedTime * rippleSpeed + 0.66) % 2.0;
        const t3 = (elapsedTime * rippleSpeed + 1.33) % 2.0;

        ripple1Ref.current.scale.setScalar(1.3 + t1 * 0.7);
        ripple2Ref.current.scale.setScalar(1.3 + t2 * 0.7);
        ripple3Ref.current.scale.setScalar(1.3 + t3 * 0.7);

        (ripple1Ref.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t1 / 2.0) * 0.35);
        (ripple2Ref.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t2 / 2.0) * 0.35);
        (ripple3Ref.current.material as THREE.MeshBasicMaterial).opacity = Math.max(0, (1 - t3 / 2.0) * 0.35);
      } else {
        (ripple1Ref.current.material as THREE.MeshBasicMaterial).opacity = 0;
        (ripple2Ref.current.material as THREE.MeshBasicMaterial).opacity = 0;
        (ripple3Ref.current.material as THREE.MeshBasicMaterial).opacity = 0;
      }
    }
  });

  return (
    <>
      {/* 1. Time-of-Day Adaptive Lighting */}
      <ambientLight
        color={orbTheme.ambientLightColor}
        intensity={orbTheme.ambientIntensity}
      />
      <directionalLight
        position={[-3, 4, 3]}
        color={orbTheme.dirLightColor}
        intensity={orbTheme.dirIntensity}
      />
      <directionalLight
        position={[3, -2, -2]}
        color={orbTheme.secondary}
        intensity={0.35}
      />
      <pointLight
        position={[0, 0, 0]}
        color={orbTheme.accent}
        intensity={1.2}
        distance={4}
      />

      {/* 2. Inner Nebula Energy Core */}
      <mesh scale={0.88}>
        <sphereGeometry args={[1, 48, 48]} />
        <shaderMaterial
          ref={coreMatRef}
          vertexShader={coreVertexShader}
          fragmentShader={coreFragmentShader}
          uniforms={coreUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* 3. Internal 3D Stardust Particles */}
      <points ref={particlesRef} geometry={particleGeometry}>
        <pointsMaterial
          color={orbTheme.accent}
          size={0.04}
          transparent
          opacity={0.7}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </points>

      {/* 4. Outer Cinematic Glass Sphere */}
      <mesh ref={outerSphereRef}>
        <sphereGeometry args={[1.28, 64, 64]} />
        <meshPhysicalMaterial
          transmission={0.92}
          thickness={2.2}
          ior={1.45}
          roughness={0.03}
          metalness={0.0}
          iridescence={0.15}
          iridescenceIOR={1.3}
          clearcoat={1.0}
          clearcoatRoughness={0.05}
          envMapIntensity={orbTheme.envMapIntensity}
          color={orbTheme.rim}
          emissive={orbTheme.primary}
          emissiveIntensity={0.18}
          transparent
        />
      </mesh>

      {/* 5. Equator Audio Waveform Ring — 128-point live soundwave */}
      <primitive object={waveLineObject} ref={waveLineRef as any} />

      {/* 6. Concentric Acoustic Ripple Rings */}
      <mesh ref={ripple1Ref} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.0, 1.04, 64]} />
        <meshBasicMaterial
          color={orbTheme.accent}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={ripple2Ref} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.0, 1.04, 64]} />
        <meshBasicMaterial
          color={orbTheme.accent}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh ref={ripple3Ref} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.0, 1.04, 64]} />
        <meshBasicMaterial
          color={orbTheme.accent}
          transparent
          opacity={0}
          side={THREE.DoubleSide}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* 7. Post-Processing Bloom & ACES Tone Mapping */}
      <EffectComposer>
        <Bloom
          luminanceThreshold={0.72}
          intensity={0.45}
          levels={5}
          mipmapBlur
        />
        <ToneMapping />
      </EffectComposer>
    </>
  );
}

// -------------------------------------------------------------------
// MadhuritaOrb Component Export
// -------------------------------------------------------------------
export function MadhuritaOrb({
  state = 'idle',
  size = 340,
  onClick,
  streamer,
  player,
  className = '',
  showStateLabel = false,
  isThinking = false,
}: MadhuritaOrbProps) {
  const { istHour } = useTimeOfDay();
  const [isHovered, setIsHovered] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);

  // Time-of-day resolution
  const timePeriod: TimePeriod = useMemo(() => {
    if (istHour >= 5 && istHour < 8) return 'sunrise';
    if (istHour >= 8 && istHour < 17) return 'day';
    if (istHour >= 17 && istHour < 20) return 'sunset';
    return 'night';
  }, [istHour]);

  // Voice state resolution
  const activeState: OrbVoiceState = useMemo(() => {
    if (isThinking) return 'thinking';
    if (state === 'disconnected') return 'idle';
    if (state === 'connecting') return 'processing';
    return state;
  }, [state, isThinking]);

  // Theme palettes based on Time of Day & Voice State
  const orbTheme = useMemo(() => {
    if (activeState === 'listening') {
      return {
        title: 'Listening',
        subtitle: "I'm listening...",
        primary: new THREE.Color('#38BDF8'),
        secondary: new THREE.Color('#0284C7'),
        accent: new THREE.Color('#BAE6FD'),
        rim: new THREE.Color('#E0F2FE'),
        glowCss: 'rgba(56, 189, 248, 0.55)',
        ringCss: 'rgba(56, 189, 248, 0.25)',
        dirLightColor: '#BAE6FD',
        ambientLightColor: '#0C4A6E',
        dirIntensity: 0.8,
        ambientIntensity: 0.35,
        envMapIntensity: 0.9,
        pulseSpeed: 1.5,
      };
    }
    if (activeState === 'thinking') {
      return {
        title: 'Thinking',
        subtitle: 'Let me think...',
        primary: new THREE.Color('#A855F7'),
        secondary: new THREE.Color('#7E22CE'),
        accent: new THREE.Color('#E9D5FF'),
        rim: new THREE.Color('#F3E8FF'),
        glowCss: 'rgba(168, 85, 247, 0.55)',
        ringCss: 'rgba(168, 85, 247, 0.25)',
        dirLightColor: '#E9D5FF',
        ambientLightColor: '#3B0764',
        dirIntensity: 0.75,
        ambientIntensity: 0.3,
        envMapIntensity: 0.85,
        pulseSpeed: 2.0,
      };
    }
    if (activeState === 'speaking') {
      return {
        title: 'Speaking',
        subtitle: "Here's what I found...",
        primary: new THREE.Color('#FB923C'),
        secondary: new THREE.Color('#EA580C'),
        accent: new THREE.Color('#FED7AA'),
        rim: new THREE.Color('#FFF7ED'),
        glowCss: 'rgba(251, 146, 60, 0.65)',
        ringCss: 'rgba(251, 146, 60, 0.3)',
        dirLightColor: '#FED7AA',
        ambientLightColor: '#431407',
        dirIntensity: 0.9,
        ambientIntensity: 0.4,
        envMapIntensity: 0.95,
        pulseSpeed: 1.4,
      };
    }
    if (activeState === 'processing') {
      return {
        title: 'Processing',
        subtitle: 'Working on it...',
        primary: new THREE.Color('#10B981'),
        secondary: new THREE.Color('#059669'),
        accent: new THREE.Color('#A7F3D0'),
        rim: new THREE.Color('#ECFDF5'),
        glowCss: 'rgba(16, 185, 129, 0.55)',
        ringCss: 'rgba(16, 185, 129, 0.22)',
        dirLightColor: '#A7F3D0',
        ambientLightColor: '#064E3B',
        dirIntensity: 0.7,
        ambientIntensity: 0.3,
        envMapIntensity: 0.8,
        pulseSpeed: 1.8,
      };
    }
    if (activeState === 'error') {
      return {
        title: 'Error',
        subtitle: 'Oops! Something went wrong.',
        primary: new THREE.Color('#F43F5E'),
        secondary: new THREE.Color('#BE123C'),
        accent: new THREE.Color('#FECDD3'),
        rim: new THREE.Color('#FFF1F2'),
        glowCss: 'rgba(244, 63, 94, 0.55)',
        ringCss: 'rgba(244, 63, 94, 0.22)',
        dirLightColor: '#FECDD3',
        ambientLightColor: '#4C0519',
        dirIntensity: 0.6,
        ambientIntensity: 0.25,
        envMapIntensity: 0.7,
        pulseSpeed: 0.8,
      };
    }

    // IDLE: Time-of-day natural lighting palettes
    switch (timePeriod) {
      case 'sunrise':
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#F59E0B'),
          secondary: new THREE.Color('#F43F5E'),
          accent: new THREE.Color('#FDE68A'),
          rim: new THREE.Color('#FEF3C7'),
          glowCss: 'rgba(251, 191, 36, 0.45)',
          ringCss: 'rgba(251, 146, 60, 0.2)',
          dirLightColor: '#FFD6A5',
          ambientLightColor: '#451A03',
          dirIntensity: 0.75,
          ambientIntensity: 0.35,
          envMapIntensity: 0.85,
          pulseSpeed: 1.0,
        };
      case 'day':
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#38BDF8'),
          secondary: new THREE.Color('#0284C7'),
          accent: new THREE.Color('#E0F2FE'),
          rim: new THREE.Color('#FFFFFF'),
          glowCss: 'rgba(186, 230, 253, 0.45)',
          ringCss: 'rgba(186, 230, 253, 0.18)',
          dirLightColor: '#FFFFFF',
          ambientLightColor: '#0369A1',
          dirIntensity: 0.85,
          ambientIntensity: 0.45,
          envMapIntensity: 1.0,
          pulseSpeed: 1.0,
        };
      case 'night':
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#818CF8'),
          secondary: new THREE.Color('#6366F1'),
          accent: new THREE.Color('#C7D2FE'),
          rim: new THREE.Color('#E0E7FF'),
          glowCss: 'rgba(129, 140, 248, 0.4)',
          ringCss: 'rgba(99, 102, 241, 0.18)',
          dirLightColor: '#C7D2FE',
          ambientLightColor: '#1E1B4B',
          dirIntensity: 0.5,
          ambientIntensity: 0.25,
          envMapIntensity: 0.65,
          pulseSpeed: 0.9,
        };
      case 'sunset':
      default:
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#FB923C'),
          secondary: new THREE.Color('#EA580C'),
          accent: new THREE.Color('#FED7AA'),
          rim: new THREE.Color('#FFF7ED'),
          glowCss: 'rgba(251, 146, 60, 0.55)',
          ringCss: 'rgba(244, 63, 94, 0.22)',
          dirLightColor: '#FFEDD5',
          ambientLightColor: '#7C2D12',
          dirIntensity: 0.8,
          ambientIntensity: 0.35,
          envMapIntensity: 0.9,
          pulseSpeed: 1.0,
        };
    }
  }, [activeState, timePeriod]);

  const handleClick = (e: React.MouseEvent) => {
    if (!onClick) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = Date.now();
    setRipples((prev) => [...prev, { id, x, y }]);
    setTimeout(() => {
      setRipples((prev) => prev.filter((r) => r.id !== id));
    }, 900);
    onClick();
  };

  return (
    <div
      className={`relative flex items-center justify-center select-none ${className}`}
      style={{
        width: size,
        height: size,
        maxWidth: '100%',
        aspectRatio: '1 / 1',
      }}
    >
      {/* ============ 1. Natural Sinusoidal Lake Hover Motion ======== */}
      <motion.div
        className="relative w-full h-full flex items-center justify-center pointer-events-none"
        animate={{ y: [-4, 4, -4] }}
        transition={{
          duration: 6.4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        {/* Atmospheric Soft Aura Glow */}
        <motion.div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: size * 1.35,
            height: size * 1.35,
            background: `radial-gradient(circle,
              ${orbTheme.glowCss} 0%,
              ${orbTheme.ringCss} 36%,
              rgba(0,0,0,0) 70%)`,
            filter: 'blur(20px)',
            mixBlendMode: 'screen',
          }}
          animate={{
            scale: activeState === 'listening' || activeState === 'speaking' ? [1, 1.08, 1] : [1, 1.025, 1],
            opacity: [0.6, 0.85, 0.6],
          }}
          transition={{
            duration: orbTheme.pulseSpeed * 2.6,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        {/* ============ 2. Real-Time 3D R3F Canvas ===================== */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Canvas
            camera={{ position: [0, 0, 3.8], fov: 42 }}
            gl={{
              alpha: true,
              antialias: true,
              powerPreference: 'high-performance',
            }}
            dpr={[1, 2]}
          >
            <OrbScene
              orbTheme={orbTheme}
              activeState={activeState}
              timePeriod={timePeriod}
              streamer={streamer}
              player={player}
            />
          </Canvas>
        </div>

        {/* ============ 3. Optical Horizon Contact Shimmer ============ */}
        <div
          className="absolute pointer-events-none"
          style={{
            width: size * 0.76,
            height: size * 0.16,
            bottom: size * 0.08,
            borderRadius: '9999px',
            background: `radial-gradient(ellipse at center, ${orbTheme.ringCss} 0%, rgba(0,0,0,0) 72%)`,
            filter: 'blur(12px)',
            mixBlendMode: 'screen',
            opacity: 0.7,
          }}
        />
      </motion.div>

      {/* ============ 4. Interactive Hitbox Button =================== */}
      <motion.button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="absolute rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 z-20"
        style={{
          width: size * 0.82,
          height: size * 0.82,
          background: 'transparent',
          border: 'none',
        }}
        whileHover={{ scale: 1.025 }}
        whileTap={{ scale: 0.97 }}
        aria-label={`Madhurita ${orbTheme.title} state`}
      >
        {/* Click ripples */}
        {ripples.map((ripple) => (
          <motion.span
            key={ripple.id}
            className="absolute rounded-full pointer-events-none"
            style={{
              left: ripple.x,
              top: ripple.y,
              width: 0,
              height: 0,
              background: `radial-gradient(circle, ${orbTheme.glowCss} 0%, rgba(0,0,0,0) 70%)`,
              border: `1.5px solid ${orbTheme.glowCss}`,
              transform: 'translate(-50%, -50%)',
              mixBlendMode: 'screen',
            }}
            initial={{ width: 0, height: 0, opacity: 0.85 }}
            animate={{ width: size * 0.94, height: size * 0.94, opacity: 0 }}
            transition={{ duration: 0.85, ease: 'easeOut' }}
          />
        ))}
      </motion.button>

      {/* ============ 5. State Indicator Chip ======================== */}
      {showStateLabel && (
        <div className="absolute -bottom-7 left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none z-30">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeState}
              initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-1.5 px-3.5 py-1 rounded-full cine-chip whitespace-nowrap"
            >
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{
                  backgroundColor: `#${orbTheme.primary.getHexString()}`,
                  boxShadow: `0 0 8px #${orbTheme.primary.getHexString()}`,
                }}
              />
              <span className="text-[11.5px] font-medium text-white/90">{orbTheme.title}</span>
              <span className="text-[10.5px] text-white/50">· {orbTheme.subtitle}</span>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
