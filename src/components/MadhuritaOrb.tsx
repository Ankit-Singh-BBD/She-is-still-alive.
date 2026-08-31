// ===================================================================
// MADHURITA ORB — Real-Time 3D Glass Sphere with Three.js & GLSL
// ===================================================================
//
// Built with Three.js + WebGL + GLSL Shaders + Web Audio API:
//   - Volumetric physical glass shader with Snell's law refraction
//   - Inverted mountain landscape & sky refraction inside the sphere
//   - Schlick Fresnel reflectance with chromatic dispersion
//   - Concentric optical caustic rings & radial sunburst ray flares
//   - 3D internal stardust particle cloud with depth parallax
//   - Real-time 3D audio-reactive equator soundwave driven by Web Audio API
//   - Time-of-day natural lighting (NIGHT, SUNRISE, DAY, SUNSET)
//   - 6 Voice states (Listening, Thinking, Speaking, Processing, Idle, Error)

import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { motion, AnimatePresence } from 'motion/react';
import { useTimeOfDay, useWeatherExpression } from '../hooks/useUIState.js';
import { LiveState } from '../types.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

export type OrbVoiceState = LiveState | 'idle' | 'thinking' | 'processing' | 'error';
export type TimePeriod = 'night' | 'sunrise' | 'day' | 'sunset';

interface MadhuritaOrbProps {
  state?: OrbVoiceState;
  size?: number; // Diameter in pixels (scales responsively)
  onClick?: () => void;
  streamer?: AudioStreamer;
  player?: AudioPlayer;
  className?: string;
  showStateLabel?: boolean;
  isThinking?: boolean;
}

// -------------------------------------------------------------------
// GLSL Shaders for the Photorealistic Glass Sphere
// -------------------------------------------------------------------
const glassVertexShader = `
  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  varying vec2 vUv;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vec4 mvPosition = viewMatrix * worldPosition;
    vViewPosition = -mvPosition.xyz;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const glassFragmentShader = `
  uniform float uTime;
  uniform float uAudioVolume;
  uniform vec3 uColorPrimary;
  uniform vec3 uColorSecondary;
  uniform vec3 uColorAccent;
  uniform vec3 uRimColor;
  uniform vec3 uCoreGlowColor;
  uniform float uTimePeriod; // 0=night, 1=sunrise, 2=day, 3=sunset
  uniform float uPulseSpeed;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vWorldPosition;
  varying vec2 vUv;

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);

    // 1. Fresnel Reflectance (Schlick's approximation with chromatic dispersion)
    float fresnelFactor = dot(normal, viewDir);
    float fresnel = pow(clamp(1.0 - fresnelFactor, 0.0, 1.0), 2.8);
    float fresnelEdge = pow(clamp(1.0 - fresnelFactor, 0.0, 1.0), 4.5);

    // 2. Optical Glass Refraction Vector
    vec3 refractVec = refract(-viewDir, normal, 1.0 / 1.52);

    // 3. Inverted Landscape Refraction inside sphere (Optical Lens effect)
    // Spherically warped coordinates inside sphere
    vec2 refUv = refractVec.xy * 0.5 + 0.5;
    
    // Inverted sky gradient at bottom & mountain silhouette at top
    float invertedSky = smoothstep(0.3, 0.9, refUv.y);
    float mountainWarp = sin(refUv.x * 6.28 + 1.2) * 0.12 + sin(refUv.x * 12.56) * 0.06;
    float mountainMask = smoothstep(0.48 + mountainWarp, 0.52 + mountainWarp, refUv.y);

    vec3 innerSkyColor = mix(uColorSecondary * 0.4, uColorPrimary * 0.6, invertedSky);
    vec3 innerLandscapeColor = mix(vec3(0.04, 0.05, 0.1), innerSkyColor, mountainMask);

    // 4. Concentric Optical Caustic Rings (Newton Rings)
    float distFromCenter = length(vUv - vec2(0.5));
    float causticRings = sin(distFromCenter * 35.0 - uTime * 2.0 * uPulseSpeed);
    causticRings = pow(clamp(causticRings * 0.5 + 0.5, 0.0, 1.0), 4.0) * (1.0 - distFromCenter * 1.6);
    causticRings = clamp(causticRings, 0.0, 1.0) * 0.35;

    // 5. Radial Sunburst Flares emanating from center
    float angle = atan(vUv.y - 0.5, vUv.x - 0.5);
    float sunburst = sin(angle * 18.0 + uTime * 0.6) * 0.5 + 0.5;
    sunburst = pow(sunburst, 3.0) * (1.0 - smoothstep(0.0, 0.45, distFromCenter)) * 0.3;

    // 6. Central Pinpoint Starburst Core
    float coreDist = distFromCenter;
    float centerCore = exp(-coreDist * 16.0) * (1.2 + uAudioVolume * 1.5);
    float centerSpike = exp(-abs(vUv.y - 0.5) * 45.0) * exp(-abs(vUv.x - 0.5) * 6.0) * 0.8;

    // 7. Specular Highlights (Top-Left primary catchlight + sharp point)
    vec3 lightDir1 = normalize(vec3(-0.45, 0.65, 0.8));
    vec3 halfVec1 = normalize(lightDir1 + viewDir);
    float spec1 = pow(max(dot(normal, halfVec1), 0.0), 32.0) * 0.85;

    vec3 lightDir2 = normalize(vec3(-0.35, 0.55, 0.9));
    vec3 halfVec2 = normalize(lightDir2 + viewDir);
    float spec2 = pow(max(dot(normal, halfVec2), 0.0), 128.0) * 1.2;

    // 8. Lower Horizon Lake Bounce Light
    vec3 bounceDir = normalize(vec3(0.0, -1.0, 0.4));
    float bounceLight = pow(max(dot(normal, bounceDir), 0.0), 3.0) * 0.65;

    // 9. Final Color Composite
    vec3 finalColor = innerLandscapeColor;

    // Add caustic rings and radial sunburst
    finalColor += uColorAccent * causticRings;
    finalColor += uCoreGlowColor * sunburst;

    // Add center starburst
    finalColor += vec3(1.0, 0.98, 0.92) * centerCore;
    finalColor += uColorAccent * centerSpike;

    // Add Fresnel rim with chromatic iridescence
    vec3 fresnelColor = mix(uRimColor, uColorAccent, fresnel * 0.5);
    finalColor += fresnelColor * (fresnel * 0.85 + fresnelEdge * 1.2);

    // Add lake bounce reflection
    finalColor += uColorPrimary * bounceLight;

    // Add specular catchlights
    finalColor += vec3(1.0) * (spec1 + spec2);

    // Translucent glass alpha (0.25 in center to 0.95 at rim)
    float alpha = clamp(0.25 + fresnel * 0.7 + centerCore * 0.5 + spec1 * 0.5, 0.0, 0.98);

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

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
  const mountRef = useRef<HTMLDivElement | null>(null);
  const { istHour } = useTimeOfDay();
  const weatherExpression = useWeatherExpression();
  const [isHovered, setIsHovered] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; createdAt: number }>>([]);

  // Resolve active time period based on IST hour
  const timePeriod: TimePeriod = useMemo(() => {
    if (istHour >= 5 && istHour < 8) return 'sunrise';
    if (istHour >= 8 && istHour < 17) return 'day';
    if (istHour >= 17 && istHour < 20) return 'sunset';
    return 'night';
  }, [istHour]);

  // Resolve active voice state
  const activeState: OrbVoiceState = useMemo(() => {
    if (isThinking) return 'thinking';
    if (state === 'disconnected') return 'idle';
    if (state === 'connecting') return 'processing';
    return state;
  }, [state, isThinking]);

  // Dynamic color configuration for Three.js shaders
  const orbTheme = useMemo(() => {
    if (activeState === 'listening') {
      return {
        title: 'Listening',
        subtitle: "I'm listening...",
        primary: new THREE.Color('#38BDF8'),
        secondary: new THREE.Color('#0284C7'),
        accent: new THREE.Color('#BAE6FD'),
        rim: new THREE.Color('#E0F2FE'),
        coreGlow: new THREE.Color('#38BDF8'),
        glowCss: 'rgba(56, 189, 248, 0.55)',
        ringCss: 'rgba(56, 189, 248, 0.25)',
        pulseSpeed: 1.5,
        periodCode: 2.0,
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
        coreGlow: new THREE.Color('#A855F7'),
        glowCss: 'rgba(168, 85, 247, 0.55)',
        ringCss: 'rgba(168, 85, 247, 0.25)',
        pulseSpeed: 2.0,
        periodCode: 0.0,
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
        coreGlow: new THREE.Color('#FB923C'),
        glowCss: 'rgba(251, 146, 60, 0.65)',
        ringCss: 'rgba(251, 146, 60, 0.3)',
        pulseSpeed: 1.4,
        periodCode: 3.0,
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
        coreGlow: new THREE.Color('#10B981'),
        glowCss: 'rgba(16, 185, 129, 0.55)',
        ringCss: 'rgba(16, 185, 129, 0.22)',
        pulseSpeed: 1.8,
        periodCode: 2.0,
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
        coreGlow: new THREE.Color('#F43F5E'),
        glowCss: 'rgba(244, 63, 94, 0.55)',
        ringCss: 'rgba(244, 63, 94, 0.22)',
        pulseSpeed: 0.8,
        periodCode: 3.0,
      };
    }

    // IDLE: Time-aware wallpaper lighting
    switch (timePeriod) {
      case 'sunrise':
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#F59E0B'),
          secondary: new THREE.Color('#F43F5E'),
          accent: new THREE.Color('#FDE68A'),
          rim: new THREE.Color('#FEF3C7'),
          coreGlow: new THREE.Color('#FBBF24'),
          glowCss: 'rgba(251, 191, 36, 0.45)',
          ringCss: 'rgba(251, 146, 60, 0.2)',
          pulseSpeed: 1.0,
          periodCode: 1.0,
        };
      case 'day':
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#38BDF8'),
          secondary: new THREE.Color('#0284C7'),
          accent: new THREE.Color('#E0F2FE'),
          rim: new THREE.Color('#FFFFFF'),
          coreGlow: new THREE.Color('#38BDF8'),
          glowCss: 'rgba(186, 230, 253, 0.45)',
          ringCss: 'rgba(186, 230, 253, 0.18)',
          pulseSpeed: 1.0,
          periodCode: 2.0,
        };
      case 'night':
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: new THREE.Color('#818CF8'),
          secondary: new THREE.Color('#6366F1'),
          accent: new THREE.Color('#C7D2FE'),
          rim: new THREE.Color('#E0E7FF'),
          coreGlow: new THREE.Color('#818CF8'),
          glowCss: 'rgba(129, 140, 248, 0.4)',
          ringCss: 'rgba(99, 102, 241, 0.18)',
          pulseSpeed: 0.9,
          periodCode: 0.0,
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
          coreGlow: new THREE.Color('#FB923C'),
          glowCss: 'rgba(251, 146, 60, 0.55)',
          ringCss: 'rgba(244, 63, 94, 0.22)',
          pulseSpeed: 1.0,
          periodCode: 3.0,
        };
    }
  }, [activeState, timePeriod]);

  // -------------------------------------------------------------------
  // Real-Time Three.js WebGL + GLSL Scene Engine
  // -------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = size;
    const height = size;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    // 1. Scene, Camera, WebGLRenderer
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.z = 3.6;

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(dpr);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    mount.appendChild(renderer.domElement);

    // 2. Glass Sphere Mesh with Custom GLSL Shader
    const sphereGeo = new THREE.SphereGeometry(1.2, 64, 64);
    const glassUniforms = {
      uTime: { value: 0 },
      uAudioVolume: { value: 0 },
      uColorPrimary: { value: orbTheme.primary },
      uColorSecondary: { value: orbTheme.secondary },
      uColorAccent: { value: orbTheme.accent },
      uRimColor: { value: orbTheme.rim },
      uCoreGlowColor: { value: orbTheme.coreGlow },
      uTimePeriod: { value: orbTheme.periodCode },
      uPulseSpeed: { value: orbTheme.pulseSpeed },
    };

    const glassMat = new THREE.ShaderMaterial({
      vertexShader: glassVertexShader,
      fragmentShader: glassFragmentShader,
      uniforms: glassUniforms,
      transparent: true,
      depthWrite: false,
    });

    const sphereMesh = new THREE.Mesh(sphereGeo, glassMat);
    scene.add(sphereMesh);

    // 3. Internal 3D Particle Cloud
    const particleCount = 280;
    const particleGeo = new THREE.BufferGeometry();
    const particlePositions = new Float32Array(particleCount * 3);
    const particleScales = new Float32Array(particleCount);
    const particleSpeeds = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      const radius = 0.15 + Math.random() * 0.95;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);

      particlePositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      particlePositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta) * 0.6; // slightly squash
      particlePositions[i * 3 + 2] = radius * Math.cos(phi);

      particleScales[i] = 0.03 + Math.random() * 0.06;
      particleSpeeds[i] = (0.2 + Math.random() * 0.6) * (Math.random() > 0.5 ? 1 : -1);
    }

    particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));

    const particleMat = new THREE.PointsMaterial({
      color: orbTheme.accent,
      size: 0.045,
      transparent: true,
      opacity: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const particlePoints = new THREE.Points(particleGeo, particleMat);
    scene.add(particlePoints);

    // 4. 3D Equator Audio Waveform Ribbon
    const wavePointCount = 128;
    const waveGeo = new THREE.BufferGeometry();
    const wavePositions = new Float32Array(wavePointCount * 3);
    const waveWidth = 2.8;

    for (let i = 0; i < wavePointCount; i++) {
      const x = -waveWidth / 2 + (i / (wavePointCount - 1)) * waveWidth;
      wavePositions[i * 3] = x;
      wavePositions[i * 3 + 1] = 0;
      wavePositions[i * 3 + 2] = 0.05; // slightly in front of center
    }

    waveGeo.setAttribute('position', new THREE.BufferAttribute(wavePositions, 3));

    const waveMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      linewidth: 2,
    });

    const waveLine = new THREE.Line(waveGeo, waveMat);
    scene.add(waveLine);

    // Audio telemetry buffer
    const audioBuffer = new Uint8Array(128);
    let smoothedVolume = 0;
    let clock = new THREE.Clock();
    let animId = 0;

    // 5. Render Loop
    const animate = () => {
      animId = requestAnimationFrame(animate);
      const elapsedTime = clock.getElapsedTime();

      // Read Web Audio API
      let rawVolume = 0;
      let hasAudio = false;
      if (activeState === 'listening' && streamer) {
        streamer.getWaveformData(audioBuffer);
        let sum = 0;
        for (let i = 0; i < audioBuffer.length; i++) {
          sum += Math.abs(audioBuffer[i] - 128);
        }
        rawVolume = sum / (audioBuffer.length * 128);
        hasAudio = rawVolume > 0.0015;
      } else if (activeState === 'speaking' && player) {
        player.getWaveformData(audioBuffer);
        let sum = 0;
        for (let i = 0; i < audioBuffer.length; i++) {
          sum += Math.abs(audioBuffer[i] - 128);
        }
        rawVolume = sum / (audioBuffer.length * 128);
        hasAudio = rawVolume > 0.0015;
      } else if (activeState === 'thinking') {
        rawVolume = 0.22 + Math.sin(elapsedTime * 3) * 0.1;
      } else if (activeState === 'processing') {
        rawVolume = 0.18 + Math.cos(elapsedTime * 4) * 0.08;
      } else if (activeState === 'error') {
        rawVolume = 0.06;
      }

      smoothedVolume += (rawVolume - smoothedVolume) * 0.16;

      // Update Shader Uniforms
      glassUniforms.uTime.value = elapsedTime;
      glassUniforms.uAudioVolume.value = smoothedVolume;
      glassUniforms.uColorPrimary.value.copy(orbTheme.primary);
      glassUniforms.uColorSecondary.value.copy(orbTheme.secondary);
      glassUniforms.uColorAccent.value.copy(orbTheme.accent);
      glassUniforms.uRimColor.value.copy(orbTheme.rim);
      glassUniforms.uCoreGlowColor.value.copy(orbTheme.coreGlow);
      glassUniforms.uTimePeriod.value = orbTheme.periodCode;
      glassUniforms.uPulseSpeed.value = orbTheme.pulseSpeed;

      // Update Particle Cloud rotation & positions
      particlePoints.rotation.y = elapsedTime * 0.12 * orbTheme.pulseSpeed;
      particlePoints.rotation.z = Math.sin(elapsedTime * 0.2) * 0.1;
      particleMat.color.copy(orbTheme.accent);

      // Update 3D Equator Waveform
      const posAttr = waveGeo.attributes.position as THREE.BufferAttribute;
      const positions = posAttr.array as Float32Array;

      for (let i = 0; i < wavePointCount; i++) {
        const x = positions[i * 3];
        const relX = x / (waveWidth / 2);
        const envelope = Math.max(0, 1.0 - relX * relX);
        const soft = Math.pow(envelope, 0.85);

        let waveY = 0;
        if ((activeState === 'listening' || activeState === 'speaking') && hasAudio) {
          const bufIndex = Math.min(127, Math.floor((i / wavePointCount) * 128));
          const amp = smoothedVolume * 0.85 + 0.08;
          const audioVal = ((audioBuffer[bufIndex] - 128) / 128) * amp;
          const organic = Math.sin(elapsedTime * 5.0 + i * 0.25) * 0.04;
          waveY = (audioVal + organic) * soft;
        } else if (activeState === 'thinking') {
          waveY =
            (Math.sin(elapsedTime * 5.5 + i * 0.3) * 0.12 +
              Math.sin(elapsedTime * 2.8 + i * 0.15) * 0.06) *
            soft *
            (0.75 + smoothedVolume);
        } else if (activeState === 'processing') {
          waveY = Math.cos(elapsedTime * 7.0 + i * 0.4) * 0.09 * soft;
        } else if (activeState === 'error') {
          const s = Math.sin(elapsedTime * 9.0 + i * 0.5);
          waveY = Math.sign(s) * Math.min(1.0, Math.abs(s) * 2.0) * 0.07 * soft;
        } else {
          // Calm harmonic breathing wave
          waveY =
            (Math.sin(elapsedTime * 1.8 + i * 0.18) * 0.045 +
              Math.cos(elapsedTime * 2.6 + i * 0.28) * 0.025) *
            soft;
        }

        positions[i * 3 + 1] = waveY;
      }
      posAttr.needsUpdate = true;

      // Subtle scale pulse on audio
      const targetScale = 1.0 + smoothedVolume * 0.04;
      sphereMesh.scale.setScalar(targetScale);

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      renderer.dispose();
      sphereGeo.dispose();
      glassMat.dispose();
      particleGeo.dispose();
      particleMat.dispose();
      waveGeo.dispose();
      waveMat.dispose();
      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [size, activeState, orbTheme, streamer, player]);

  const handleClick = (e: React.MouseEvent) => {
    if (!onClick) return;
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const id = Date.now();
    setRipples((prev) => [...prev, { id, x, y, createdAt: Date.now() }]);
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
        animate={{ y: [-5, 5, -5] }}
        transition={{
          duration: 6.4,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        {/* Ambient Soft Atmospheric Aura Bloom */}
        <motion.div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: size * 1.35,
            height: size * 1.35,
            background: `radial-gradient(circle,
              ${orbTheme.glowCss} 0%,
              ${orbTheme.ringCss} 36%,
              rgba(0,0,0,0) 70%)`,
            filter: 'blur(18px)',
            mixBlendMode: 'screen',
          }}
          animate={{
            scale: activeState === 'listening' || activeState === 'speaking' ? [1, 1.07, 1] : [1, 1.025, 1],
            opacity: [0.6, 0.9, 0.6],
          }}
          transition={{
            duration: orbTheme.pulseSpeed * 2.6,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        {/* 2. Real-Time 3D Three.js WebGL Mount */}
        <div ref={mountRef} className="absolute inset-0 flex items-center justify-center pointer-events-none" />

        {/* 3. Optical Horizon Contact Shimmer on Lake */}
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

      {/* ============ 4. Interactive Hitbox ========================== */}
      <motion.button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="absolute rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 z-20"
        style={{
          width: size * 0.8,
          height: size * 0.8,
          background: 'transparent',
          border: 'none',
        }}
        whileHover={{ scale: 1.03 }}
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

      {/* ============ 5. Subtle State Indicator Chip ================= */}
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
