// ===================================================================
// MADHURITA ORB — Volumetric glass sphere with live audio waveform
// ===================================================================
//
// A perfectly spherical body of luminous glass that belongs to the
// photographic environment behind it: it refracts the landscape through
// `backdrop-filter`, catches a Fresnel rim from the scene light, holds a
// nebula of stardust inside, and is sliced horizontally by a real-time
// audio waveform driven by voice telemetry.
//
// Architecture (back -> front):
//   1. Ambient aura bloom (radial-gradient, breathing)
//   2. Counter-rotating caustic rings (refracted light on glass)
//   3. Glass body — layered DIVs: backdrop-filter refraction +
//      radial-gradient shading + inset/outset box-shadows
//   4. Canvas: internal stardust nebula, acoustic pulse rings and the
//      horizontal waveform slicing through the equator
//   5. Fresnel rim, specular highlights and contact shadow
//   6. Interactive hitbox with click ripples
//
// 6 voice states (idle, listening, thinking, speaking, processing, error)
// each drive colour, pulse rate, particle count and waveform behaviour.
// Idle blends with live weather + time-of-day so the orb matches the sky.

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useEmotions, useWeatherExpression, useTimeOfDay } from '../hooks/useUIState.js';
import { LiveState } from '../types.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

export type OrbVoiceState = LiveState | 'idle' | 'thinking' | 'processing' | 'error';

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

export function MadhuritaOrb({
  state = 'idle',
  size = 260,
  onClick,
  streamer,
  player,
  className = '',
  showStateLabel = false,
  isThinking = false,
}: MadhuritaOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const emotions = useEmotions();
  const weatherExpression = useWeatherExpression();
  const { timeOfDay } = useTimeOfDay();
  const [isHovered, setIsHovered] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; createdAt: number }>>([]);

  // Resolve active voice state
  const activeState: OrbVoiceState = useMemo(() => {
    if (isThinking) return 'thinking';
    if (state === 'disconnected') return 'idle';
    if (state === 'connecting') return 'processing';
    return state;
  }, [state, isThinking]);

  // Voice state visual styling configuration
  const stateTheme = useMemo(() => {
    switch (activeState) {
      case 'listening':
        return {
          title: 'Listening',
          subtitle: "I'm listening...",
          primary: '#38BDF8', // Sky blue
          secondary: '#0284C7',
          accent: '#BAE6FD',
          glow: 'rgba(56, 189, 248, 0.45)',
          ambientRing: 'rgba(56, 189, 248, 0.25)',
          waveColor: '#E0F2FE',
          pulseSpeed: 1.6,
        };
      case 'thinking':
        return {
          title: 'Thinking',
          subtitle: 'Let me think...',
          primary: '#A855F7', // Royal purple
          secondary: '#7E22CE',
          accent: '#E9D5FF',
          glow: 'rgba(168, 85, 247, 0.5)',
          ambientRing: 'rgba(168, 85, 247, 0.25)',
          waveColor: '#F3E8FF',
          pulseSpeed: 2.2,
        };
      case 'speaking':
        return {
          title: 'Speaking',
          subtitle: "Here's what I found...",
          primary: '#FB923C', // Warm golden orange
          secondary: '#EA580C',
          accent: '#FED7AA',
          glow: 'rgba(251, 146, 60, 0.55)',
          ambientRing: 'rgba(251, 146, 60, 0.28)',
          waveColor: '#FFF7ED',
          pulseSpeed: 1.4,
        };
      case 'processing':
        return {
          title: 'Processing',
          subtitle: 'Working on it...',
          primary: '#10B981', // Emerald green
          secondary: '#059669',
          accent: '#A7F3D0',
          glow: 'rgba(16, 185, 129, 0.45)',
          ambientRing: 'rgba(16, 185, 129, 0.22)',
          waveColor: '#ECFDF5',
          pulseSpeed: 1.8,
        };
      case 'error':
        return {
          title: 'Error',
          subtitle: 'Oops! Something went wrong.',
          primary: '#F43F5E', // Crimson rose
          secondary: '#BE123C',
          accent: '#FECDD3',
          glow: 'rgba(244, 63, 94, 0.45)',
          ambientRing: 'rgba(244, 63, 94, 0.2)',
          waveColor: '#FFF1F2',
          pulseSpeed: 0.8,
        };
      case 'idle':
      default:
        // Idle blends with current time of day & weather expression
        return {
          title: 'Idle',
          subtitle: 'Madhurita is ready',
          primary: weatherExpression?.colors?.primary || '#818CF8', // Silver-violet
          secondary: weatherExpression?.colors?.secondary || '#6366F1',
          accent: weatherExpression?.colors?.accent || '#C7D2FE',
          glow: 'rgba(129, 140, 248, 0.35)',
          ambientRing: 'rgba(129, 140, 248, 0.18)',
          waveColor: '#EEF2FF',
          pulseSpeed: 1.0,
        };
    }
  }, [activeState, weatherExpression]);

  // Geometry — the glass body occupies 62% of the box, leaving room for
  // the bloom halo and the waveform tails to breathe past its edges.
  const bodyDiameter = size * 0.62;
  const isVocal = activeState === 'listening' || activeState === 'speaking';

  // ---------------------------------------------------------------- canvas
  // Draws only what glass cannot: the internal stardust nebula, the
  // acoustic pulse rings and the horizontal waveform slice.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let animationFrameId = 0;
    let time = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    // Audio telemetry buffer (analyser.fftSize is 256 -> 128 bins)
    const audioBuffer = new Uint8Array(128);
    let smoothedVolume = 0;
    let hasAudio = false;

    // Internal nebula stardust
    const particleCount =
      activeState === 'speaking'
        ? 40
        : activeState === 'listening'
        ? 32
        : activeState === 'thinking'
        ? 48
        : 22;
    const orbRadiusBase = bodyDiameter / 2;
    const particles = Array.from({ length: particleCount }, (_, i) => {
      const angle = (i / particleCount) * Math.PI * 2 + Math.random() * 0.6;
      const dist = orbRadiusBase * (0.12 + Math.random() * 0.72);
      return {
        angle,
        dist,
        depth: 0.35 + Math.random() * 0.65, // fake z for parallax
        speed:
          (0.0025 + Math.random() * 0.006) *
          (activeState === 'thinking' ? 2.6 : 1) *
          (Math.random() > 0.5 ? 1 : -1),
        radius: 0.6 + Math.random() * 1.9,
        alpha: 0.25 + Math.random() * 0.55,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleAmp: 2 + Math.random() * 7,
      };
    });

    // Canvas sizing (HiDPI)
    const applySize = () => {
      const w = Math.max(1, Math.floor(size * dpr));
      const h = Math.max(1, Math.floor(size * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    applySize();

    const render = () => {
      if (!reduceMotion) time += 0.02 * stateTheme.pulseSpeed;

      // ---- real-time audio telemetry -----------------------------
      let rawVolume = 0;
      hasAudio = false;
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
        rawVolume = 0.2 + Math.sin(time * 3) * 0.12;
      } else if (activeState === 'processing') {
        rawVolume = 0.15 + Math.cos(time * 4) * 0.08;
      } else if (activeState === 'error') {
        rawVolume = 0.08;
      }

      // Spring-damped smoothing so the orb never jitters
      smoothedVolume += (rawVolume - smoothedVolume) * 0.16;

      applySize();
      const width = size;
      const height = size;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const orbRadius = orbRadiusBase * (1 + smoothedVolume * 0.06);

      // ---- 1. Concentric acoustic pulse rings ---------------------
      const ringCount = isVocal ? 3 : 2;
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let r = 0; r < ringCount; r++) {
        const progress = (time * 0.32 + r / ringCount) % 1;
        const ringRad =
          orbRadius *
          (1.04 + progress * 0.62 + (isVocal ? smoothedVolume * 0.55 : 0));
        const fade = 1 - progress;
        const ringAlpha =
          Math.max(0, fade * fade * 0.5 * (activeState === 'idle' ? 0.35 : 1));
        if (ringAlpha <= 0.002) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, ringRad, 0, Math.PI * 2);
        ctx.strokeStyle = stateTheme.accent;
        ctx.globalAlpha = ringAlpha;
        ctx.lineWidth = 1 + fade * 0.9;
        ctx.shadowBlur = 12;
        ctx.shadowColor = stateTheme.primary;
        ctx.stroke();
      }
      ctx.restore();

      // ---- 2. Internal nebula stardust (clipped to the sphere) ----
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius * 0.97, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalCompositeOperation = 'screen';
      for (const p of particles) {
        p.angle += p.speed;
        const wobble = Math.sin(time * 1.4 + p.wobblePhase) * p.wobbleAmp;
        const currentDist = p.dist + wobble;
        // squash vertically by depth to imply a 3D volume, not a disc
        const px = cx + Math.cos(p.angle) * currentDist;
        const py = cy + Math.sin(p.angle) * currentDist * (0.45 + p.depth * 0.55);

        const distFromCenter = Math.hypot(px - cx, py - cy);
        const edgeFade = Math.max(0, 1 - distFromCenter / (orbRadius * 0.96));
        if (edgeFade <= 0) continue;

        const r = p.radius * (0.55 + p.depth * 0.7) * (1 + smoothedVolume * 0.5);
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fillStyle = stateTheme.accent;
        ctx.globalAlpha = p.alpha * edgeFade * (0.5 + p.depth * 0.5);
        ctx.shadowBlur = 8;
        ctx.shadowColor = stateTheme.primary;
        ctx.fill();
      }
      ctx.restore();

      // ---- 3. Horizontal waveform slicing the equator -------------
      // Extends slightly past the glass edge, as light does when it
      // scatters out of a lens.
      ctx.save();
      const waveWidth = orbRadius * 2.34;
      const waveStartX = cx - waveWidth / 2;
      const wavePoints = 96;
      const step = waveWidth / wavePoints;

      const buildPath = () => {
        ctx.beginPath();
        for (let i = 0; i <= wavePoints; i++) {
          const x = waveStartX + i * step;
          const relX = (x - cx) / (waveWidth / 2); // -1 .. 1
          // smooth parabolic window so the wave dies at the tails
          const envelope = Math.max(0, 1 - relX * relX);
          const soft = Math.pow(envelope, 0.85);

          let waveY = 0;
          if (isVocal && hasAudio) {
            const bufIndex = Math.min(
              audioBuffer.length - 1,
              Math.floor((i / wavePoints) * audioBuffer.length)
            );
            const amp = smoothedVolume * (orbRadius * 0.62) + 5;
            const audioVal = ((audioBuffer[bufIndex] - 128) / 128) * amp;
            const organic = Math.sin(time * 4 + i * 0.22) * 2.4;
            waveY = (audioVal + organic) * soft;
          } else if (activeState === 'thinking') {
            waveY =
              (Math.sin(time * 5.5 + i * 0.28) * 9 +
                Math.sin(time * 2.6 + i * 0.11) * 5) *
              soft *
              (0.7 + smoothedVolume);
          } else if (activeState === 'processing') {
            waveY = Math.cos(time * 7 + i * 0.36) * 7.5 * soft;
          } else if (activeState === 'error') {
            // clipped square-ish glitch wave
            const s = Math.sin(time * 9 + i * 0.5);
            waveY = Math.sign(s) * Math.min(1, Math.abs(s) * 2.2) * 6 * soft;
          } else {
            // calm idle: two detuned harmonics, never repeating
            waveY =
              (Math.sin(time * 1.7 + i * 0.14) * 2.6 +
                Math.cos(time * 2.6 + i * 0.23) * 1.6) *
              soft;
          }

          const y = cy + waveY;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      };

      ctx.globalCompositeOperation = 'screen';

      // wide soft bloom under the wave
      buildPath();
      ctx.strokeStyle = stateTheme.glow;
      ctx.lineWidth = 7;
      ctx.globalAlpha = 0.5;
      ctx.shadowBlur = 22;
      ctx.shadowColor = stateTheme.primary;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      // coloured body of the wave
      buildPath();
      ctx.strokeStyle = stateTheme.waveColor;
      ctx.lineWidth = 2.2;
      ctx.globalAlpha = 0.85;
      ctx.shadowBlur = 14;
      ctx.shadowColor = stateTheme.glow;
      ctx.stroke();

      // bright inner filament
      buildPath();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 0.9;
      ctx.globalAlpha = 0.92;
      ctx.shadowBlur = 6;
      ctx.shadowColor = '#FFFFFF';
      ctx.stroke();
      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [size, bodyDiameter, activeState, isVocal, streamer, player, stateTheme]);

  // Click ripple interaction
  const handleClick = (e: React.MouseEvent) => {
    if (!onClick) return;
    // Parents often make the whole orb box clickable too — don't toggle twice.
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
      ref={containerRef}
      className={`relative flex items-center justify-center select-none ${className}`}
      style={{
        width: size,
        height: size,
        maxWidth: '100%',
        aspectRatio: '1 / 1',
      }}
    >
      {/* ============ 1. Ambient aura bloom ========================== */}
      <motion.div
        className="absolute rounded-full pointer-events-none"
        style={{
          width: size * 1.5,
          height: size * 1.5,
          background: `radial-gradient(circle,
            ${stateTheme.glow} 0%,
            ${stateTheme.ambientRing} 34%,
            rgba(0,0,0,0) 66%)`,
          filter: 'blur(14px)',
          mixBlendMode: 'screen',
        }}
        animate={{
          scale: isVocal ? [1, 1.08, 1] : [1, 1.03, 1],
          opacity: [0.55, 0.9, 0.55],
        }}
        transition={{
          duration: stateTheme.pulseSpeed * 2.6,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />

      {/* ============ 2. Counter-rotating caustic rings =============== */}
      <div
        className="absolute rounded-full pointer-events-none animate-caustic"
        style={{
          width: bodyDiameter * 1.34,
          height: bodyDiameter * 1.34,
          background: `conic-gradient(from 0deg,
            transparent 0deg,
            ${stateTheme.ambientRing} 40deg,
            transparent 110deg,
            transparent 190deg,
            ${stateTheme.ambientRing} 230deg,
            transparent 300deg)`,
          maskImage:
            'radial-gradient(circle, transparent 62%, #000 70%, #000 88%, transparent 96%)',
          WebkitMaskImage:
            'radial-gradient(circle, transparent 62%, #000 70%, #000 88%, transparent 96%)',
          filter: 'blur(5px)',
          mixBlendMode: 'screen',
          opacity: activeState === 'idle' ? 0.5 : 0.85,
        }}
      />
      <div
        className="absolute rounded-full pointer-events-none animate-caustic-rev"
        style={{
          width: bodyDiameter * 1.16,
          height: bodyDiameter * 1.16,
          background: `conic-gradient(from 120deg,
            transparent 0deg,
            ${stateTheme.accent} 26deg,
            transparent 78deg,
            transparent 220deg,
            ${stateTheme.accent} 250deg,
            transparent 300deg)`,
          maskImage:
            'radial-gradient(circle, transparent 76%, #000 84%, transparent 94%)',
          WebkitMaskImage:
            'radial-gradient(circle, transparent 76%, #000 84%, transparent 94%)',
          filter: 'blur(2.5px)',
          mixBlendMode: 'screen',
          opacity: 0.4,
        }}
      />

      {/* ============ 3. The glass body =============================== */}
      <motion.div
        className="absolute rounded-full animate-orb-float"
        style={{
          width: bodyDiameter,
          height: bodyDiameter,
          // Translucent shading so the landscape reads through the glass
          background: `
            radial-gradient(circle at 34% 28%,
              rgba(255,255,255,0.42) 0%,
              rgba(255,255,255,0.10) 18%,
              rgba(255,255,255,0.00) 34%),
            radial-gradient(circle at 50% 50%,
              ${hexToRgba(stateTheme.accent, 0.16)} 0%,
              ${hexToRgba(stateTheme.primary, 0.30)} 42%,
              ${hexToRgba(stateTheme.secondary, 0.44)} 76%,
              rgba(8, 11, 24, 0.55) 100%),
            radial-gradient(circle at 68% 82%,
              ${hexToRgba(stateTheme.primary, 0.28)} 0%,
              rgba(0,0,0,0) 52%)`,
          // The refraction: blur + saturate the scene behind the sphere
          backdropFilter: 'blur(22px) saturate(180%) brightness(1.08)',
          WebkitBackdropFilter: 'blur(22px) saturate(180%) brightness(1.08)',
          boxShadow: `
            inset 0 2px 22px rgba(255,255,255,0.30),
            inset 0 -18px 46px -18px ${hexToRgba(stateTheme.primary, 0.7)},
            inset 0 0 0 1px rgba(255,255,255,0.16),
            inset 0 -2px 3px rgba(0,0,0,0.35),
            0 0 40px ${stateTheme.glow},
            0 0 110px ${stateTheme.ambientRing},
            0 26px 60px -22px rgba(0,0,0,0.75)`,
          border: '1px solid rgba(255,255,255,0.14)',
        }}
        animate={{ scale: isVocal ? [1, 1.025, 1] : [1, 1.008, 1] }}
        transition={{
          duration: stateTheme.pulseSpeed * 2.2,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      >
        {/* Inner volumetric core glow — the light source inside */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            inset: '16%',
            background: `radial-gradient(circle at 50% 54%,
              ${hexToRgba(stateTheme.accent, 0.55)} 0%,
              ${hexToRgba(stateTheme.primary, 0.34)} 38%,
              rgba(0,0,0,0) 74%)`,
            filter: 'blur(10px)',
            mixBlendMode: 'screen',
          }}
        />

        {/* Terminator shading — bottom-right falls into shadow */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 72% 76%, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.10) 40%, rgba(0,0,0,0) 66%)',
            mixBlendMode: 'multiply',
          }}
        />

        {/* Fresnel rim — glass edges are always brighter than the body */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background: `radial-gradient(circle,
              rgba(255,255,255,0) 62%,
              ${hexToRgba(stateTheme.accent, 0.30)} 88%,
              rgba(255,255,255,0.72) 99%,
              rgba(255,255,255,0) 100%)`,
            mixBlendMode: 'screen',
          }}
        />

        {/* Rim light sweep — a specular travelling around the edge */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none overflow-hidden animate-rim-sweep"
          style={{
            background: `conic-gradient(from 0deg,
              transparent 0deg,
              rgba(255,255,255,0.55) 24deg,
              transparent 66deg,
              transparent 360deg)`,
            maskImage:
              'radial-gradient(circle, transparent 88%, #000 95%, transparent 100%)',
            WebkitMaskImage:
              'radial-gradient(circle, transparent 88%, #000 95%, transparent 100%)',
            mixBlendMode: 'screen',
            opacity: 0.7,
          }}
        />

        {/* Primary specular highlight — a soft blurred ellipse, top-left */}
        <div
          className="absolute pointer-events-none"
          style={{
            width: '34%',
            height: '22%',
            left: '17%',
            top: '13%',
            borderRadius: '9999px',
            background:
              'radial-gradient(ellipse at center, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.35) 45%, rgba(255,255,255,0) 100%)',
            filter: 'blur(4px)',
            transform: 'rotate(-22deg)',
            mixBlendMode: 'screen',
          }}
        />
        {/* Secondary tiny specular — the sharp catchlight */}
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            width: '8%',
            height: '6%',
            left: '26%',
            top: '19%',
            background: 'rgba(255,255,255,0.95)',
            filter: 'blur(1.5px)',
            mixBlendMode: 'screen',
          }}
        />
        {/* Bounce light from the water below the sphere */}
        <div
          className="absolute pointer-events-none"
          style={{
            width: '48%',
            height: '18%',
            left: '26%',
            bottom: '7%',
            borderRadius: '9999px',
            background: `radial-gradient(ellipse at center, ${hexToRgba(stateTheme.accent, 0.45)} 0%, rgba(255,255,255,0) 100%)`,
            filter: 'blur(7px)',
            mixBlendMode: 'screen',
          }}
        />
      </motion.div>

      {/* ============ 4. Live canvas (stardust + rings + waveform) ==== */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: size, height: size, mixBlendMode: 'screen' }}
      />

      {/* ============ 5. Contact shadow / reflection on the ground ==== */}
      <div
        className="absolute pointer-events-none"
        style={{
          width: bodyDiameter * 0.92,
          height: bodyDiameter * 0.16,
          bottom: size * 0.11,
          borderRadius: '9999px',
          background: `radial-gradient(ellipse at center, ${stateTheme.ambientRing} 0%, rgba(0,0,0,0) 72%)`,
          filter: 'blur(10px)',
          mixBlendMode: 'screen',
          opacity: 0.7,
        }}
      />

      {/* ============ 6. Interactive hitbox ========================== */}
      <motion.button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="absolute rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        style={{
          width: bodyDiameter,
          height: bodyDiameter,
          background: 'transparent',
          border: 'none',
          zIndex: 20,
        }}
        whileHover={{ scale: 1.035 }}
        whileTap={{ scale: 0.965 }}
        aria-label={`Madhurita ${stateTheme.title} state`}
      >
        {/* Hover Fresnel lift */}
        <motion.span
          className="absolute inset-0 rounded-full pointer-events-none"
          animate={{ opacity: isHovered ? 1 : 0 }}
          transition={{ duration: 0.25 }}
          style={{
            background: `radial-gradient(circle, rgba(255,255,255,0) 66%, ${hexToRgba(stateTheme.accent, 0.35)} 92%, rgba(255,255,255,0) 100%)`,
            mixBlendMode: 'screen',
          }}
        />
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
              background: `radial-gradient(circle, ${stateTheme.glow} 0%, rgba(0,0,0,0) 70%)`,
              border: `1.5px solid ${hexToRgba(stateTheme.accent, 0.6)}`,
              transform: 'translate(-50%, -50%)',
              mixBlendMode: 'screen',
            }}
            initial={{ width: 0, height: 0, opacity: 0.85 }}
            animate={{ width: size * 0.95, height: size * 0.95, opacity: 0 }}
            transition={{ duration: 0.85, ease: 'easeOut' }}
          />
        ))}
      </motion.button>

      {/* ============ 7. State label ================================= */}
      {showStateLabel && (
        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none z-30">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeState}
              initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: 0.25 }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full cine-chip whitespace-nowrap"
            >
              <span
                className="w-1.5 h-1.5 rounded-full animate-pulse"
                style={{
                  backgroundColor: stateTheme.primary,
                  boxShadow: `0 0 8px ${stateTheme.primary}`,
                }}
              />
              <span className="text-[12px] font-medium text-white/90">{stateTheme.title}</span>
              <span className="text-[11px] text-white/50">· {stateTheme.subtitle}</span>
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------
// Convert a #RRGGBB / #RGB / rgb(a) colour to an rgba() string so state
// palettes can be reused at arbitrary opacity inside gradients.
// -------------------------------------------------------------------
function hexToRgba(color: string, alpha: number): string {
  if (!color) return `rgba(255,255,255,${alpha})`;

  if (color.startsWith('rgba')) {
    return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
  }
  if (color.startsWith('rgb')) {
    return color.replace(/rgb\(([^)]+)\)/, `rgba($1,${alpha})`);
  }

  let hex = color.replace('#', '');
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (hex.length !== 6) return `rgba(255,255,255,${alpha})`;

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
