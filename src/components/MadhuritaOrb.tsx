// ===================================================================
// MADHURITA ORB - High-Fidelity Luminous Glass Core & Reactive Audio Waveform
// ===================================================================
//
// Perfectly circular, glass-like luminous orb with soft inner glow,
// translucent depth, subtle bloom, and thin bright specular rim.
// Features:
// - Real-time responsive horizontal audio soundwave slicing through the orb
// - Concentric acoustic ripple rings reacting to voice telemetry
// - 6 distinct voice states (Idle, Listening, Thinking, Speaking, Processing, Error)
// - Organic spring physics & multi-harmonic waveforms (no repetitive looping)
// - 100% responsive across desktop, tablet, and mobile with zero distortion

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

  // Main Canvas Render Loop (Luminous sphere + horizontal slicing soundwave + particles + ripples)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);

    // Audio data buffers
    const audioBuffer = new Uint8Array(64);
    let smoothedVolume = 0;

    // Nebula stardust particle system
    const particleCount = activeState === 'speaking' ? 36 : activeState === 'listening' ? 28 : activeState === 'thinking' ? 44 : 20;
    const particles = Array.from({ length: particleCount }, (_, i) => {
      const angle = (i / particleCount) * Math.PI * 2 + Math.random() * 0.5;
      const dist = (size * 0.18) + Math.random() * (size * 0.18);
      return {
        angle,
        dist,
        speed: (0.003 + Math.random() * 0.007) * (activeState === 'thinking' ? 2.5 : 1),
        radius: 1 + Math.random() * 2,
        alpha: 0.3 + Math.random() * 0.5,
        wobblePhase: Math.random() * Math.PI * 2,
      };
    });

    const render = () => {
      time += 0.02 * stateTheme.pulseSpeed;

      // Extract real audio telemetry if active
      let rawVolume = 0;
      if (activeState === 'listening' && streamer) {
        streamer.getWaveformData(audioBuffer);
        let sum = 0;
        for (let i = 0; i < audioBuffer.length; i++) {
          sum += Math.abs(audioBuffer[i] - 128);
        }
        rawVolume = sum / (audioBuffer.length * 128);
      } else if (activeState === 'speaking' && player) {
        player.getWaveformData(audioBuffer);
        let sum = 0;
        for (let i = 0; i < audioBuffer.length; i++) {
          sum += Math.abs(audioBuffer[i] - 128);
        }
        rawVolume = sum / (audioBuffer.length * 128);
      } else if (activeState === 'thinking') {
        rawVolume = 0.2 + Math.sin(time * 3) * 0.12;
      } else if (activeState === 'processing') {
        rawVolume = 0.15 + Math.cos(time * 4) * 0.08;
      }

      // Smooth volume with spring damping
      smoothedVolume += (rawVolume - smoothedVolume) * 0.18;

      // Ensure canvas matches high-DPI dimensions
      const width = size;
      const height = size;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);
      }

      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const orbRadius = (size * 0.28) * (1 + smoothedVolume * 0.12);

      // --- 1. Outer Multi-Layer Radiant Bloom Halo ---
      const outerGlow = ctx.createRadialGradient(cx, cy, orbRadius * 0.6, cx, cy, orbRadius * 1.8);
      outerGlow.addColorStop(0, stateTheme.glow);
      outerGlow.addColorStop(0.5, stateTheme.ambientRing);
      outerGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = outerGlow;
      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius * 1.8, 0, Math.PI * 2);
      ctx.fill();

      // --- 2. Concentric Acoustic Aura Rings ---
      const ringCount = activeState === 'listening' || activeState === 'speaking' ? 3 : 2;
      for (let r = 0; r < ringCount; r++) {
        const ringProgress = ((time * 0.4 + r * 0.33) % 1);
        const ringRad = orbRadius * (1.15 + ringProgress * 0.55 + (activeState === 'listening' ? smoothedVolume * 0.6 : 0));
        const ringAlpha = Math.max(0, (1 - ringProgress) * 0.45 * (activeState === 'idle' ? 0.3 : 1));

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, ringRad, 0, Math.PI * 2);
        ctx.strokeStyle = stateTheme.accent;
        ctx.globalAlpha = ringAlpha;
        ctx.lineWidth = 1.2;
        ctx.shadowBlur = 8;
        ctx.shadowColor = stateTheme.primary;
        ctx.stroke();
        ctx.restore();
      }

      // --- 3. Internal Nebula Stardust Particles ---
      ctx.save();
      for (const p of particles) {
        p.angle += p.speed;
        const currentDist = p.dist + Math.sin(time + p.wobblePhase) * 6;
        const px = cx + Math.cos(p.angle) * currentDist;
        const py = cy + Math.sin(p.angle) * currentDist;

        // Clip particles to sphere interior
        const distFromCenter = Math.hypot(px - cx, py - cy);
        if (distFromCenter < orbRadius * 0.92) {
          ctx.beginPath();
          ctx.arc(px, py, p.radius, 0, Math.PI * 2);
          ctx.fillStyle = stateTheme.accent;
          ctx.globalAlpha = p.alpha * (1 - distFromCenter / orbRadius);
          ctx.shadowBlur = 6;
          ctx.shadowColor = stateTheme.primary;
          ctx.fill();
        }
      }
      ctx.restore();

      // --- 4. Main Glass Luminous Sphere Core ---
      ctx.save();
      // Base Sphere Gradient
      const coreGrad = ctx.createRadialGradient(
        cx - orbRadius * 0.28,
        cy - orbRadius * 0.28,
        orbRadius * 0.05,
        cx,
        cy,
        orbRadius
      );
      coreGrad.addColorStop(0, stateTheme.accent);
      coreGrad.addColorStop(0.35, stateTheme.primary);
      coreGrad.addColorStop(0.75, stateTheme.secondary);
      coreGrad.addColorStop(1, 'rgba(15, 23, 42, 0.85)');

      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius, 0, Math.PI * 2);
      ctx.fillStyle = coreGrad;
      ctx.fill();

      // Inner depth shadow
      const innerShadow = ctx.createRadialGradient(cx, cy, orbRadius * 0.5, cx, cy, orbRadius);
      innerShadow.addColorStop(0, 'rgba(255, 255, 255, 0)');
      innerShadow.addColorStop(0.85, 'rgba(0, 0, 0, 0.2)');
      innerShadow.addColorStop(1, 'rgba(0, 0, 0, 0.65)');
      ctx.fillStyle = innerShadow;
      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius, 0, Math.PI * 2);
      ctx.fill();

      // Specular Top-Left Glass Highlight Arc
      const highlightGrad = ctx.createRadialGradient(
        cx - orbRadius * 0.35,
        cy - orbRadius * 0.35,
        orbRadius * 0.02,
        cx - orbRadius * 0.35,
        cy - orbRadius * 0.35,
        orbRadius * 0.65
      );
      highlightGrad.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
      highlightGrad.addColorStop(0.4, 'rgba(255, 255, 255, 0.25)');
      highlightGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = highlightGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius * 0.95, 0, Math.PI * 2);
      ctx.fill();

      // Thin Ultra-Crisp Specular Rim
      ctx.beginPath();
      ctx.arc(cx, cy, orbRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.shadowBlur = 12;
      ctx.shadowColor = stateTheme.primary;
      ctx.stroke();
      ctx.restore();

      // --- 5. Real-Time Horizontal Audio Waveform Slicing Line ---
      ctx.save();
      const waveWidth = orbRadius * 2.1;
      const waveStartX = cx - waveWidth / 2;
      const wavePoints = 48;
      const step = waveWidth / wavePoints;

      ctx.beginPath();
      for (let i = 0; i <= wavePoints; i++) {
        const x = waveStartX + i * step;
        const relX = (x - cx) / (waveWidth / 2); // -1 to 1
        const envelope = Math.max(0, 1 - relX * relX); // parabolic window

        let waveY = 0;
        if (activeState === 'speaking' || activeState === 'listening') {
          const bufIndex = Math.min(audioBuffer.length - 1, Math.floor((i / wavePoints) * audioBuffer.length));
          const audioVal = ((audioBuffer[bufIndex] - 128) / 128) * (smoothedVolume * 45 + 8);
          const organicOsc = Math.sin(time * 4 + i * 0.4) * 3;
          waveY = (audioVal + organicOsc) * envelope;
        } else if (activeState === 'thinking') {
          waveY = Math.sin(time * 6 + i * 0.6) * (10 * envelope) * (0.6 + smoothedVolume);
        } else if (activeState === 'processing') {
          waveY = Math.cos(time * 8 + i * 0.8) * (8 * envelope);
        } else {
          // Idle calm harmonic wave
          waveY = (Math.sin(time * 2 + i * 0.3) * 2.5 + Math.cos(time * 3 + i * 0.5) * 1.5) * envelope;
        }

        const y = cy + waveY;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }

      // Outer wave glow
      ctx.strokeStyle = stateTheme.accent;
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 14;
      ctx.shadowColor = stateTheme.glow;
      ctx.stroke();

      // Bright inner filament
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.0;
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [size, activeState, streamer, player, stateTheme]);

  // Click ripple interaction
  const handleClick = (e: React.MouseEvent) => {
    if (!onClick) return;
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
      className={`relative flex flex-col items-center justify-center select-none ${className}`}
      style={{
        width: size,
        height: size,
        maxWidth: '100%',
        aspectRatio: '1 / 1',
      }}
    >
      {/* Dynamic Background Atmospheric Aura Halo */}
      <motion.div
        className="absolute inset-0 rounded-full pointer-events-none"
        animate={{
          scale: activeState === 'speaking' || activeState === 'listening' ? [1, 1.06, 1] : [1, 1.02, 1],
          opacity: [0.65, 0.9, 0.65],
        }}
        transition={{
          duration: stateTheme.pulseSpeed * 2.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        style={{
          background: `radial-gradient(circle, ${stateTheme.glow} 0%, rgba(0,0,0,0) 68%)`,
        }}
      />

      {/* Main Glass Canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: size, height: size }}
      />

      {/* Interactive Click Hitbox Sphere */}
      <motion.button
        type="button"
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="relative z-10 rounded-full cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/30"
        style={{
          width: size * 0.6,
          height: size * 0.6,
          background: 'transparent',
          border: 'none',
        }}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        aria-label={`Madhurita ${stateTheme.title} state`}
      >
        {/* Click Ripples */}
        {ripples.map((ripple) => (
          <motion.span
            key={ripple.id}
            className="absolute rounded-full pointer-events-none"
            style={{
              left: ripple.x,
              top: ripple.y,
              width: 0,
              height: 0,
              background: stateTheme.glow,
              border: `1.5px solid ${stateTheme.accent}`,
              transform: 'translate(-50%, -50%)',
            }}
            initial={{ width: 0, height: 0, opacity: 0.8 }}
            animate={{ width: size * 0.9, height: size * 0.9, opacity: 0 }}
            transition={{ duration: 0.85, ease: 'easeOut' }}
          />
        ))}
      </motion.button>

      {/* Optional State Label & Subtitle Banner */}
      {showStateLabel && (
        <div className="absolute -bottom-8 flex flex-col items-center pointer-events-none">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeState}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2 }}
              className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-black/40 backdrop-blur-md border border-white/10"
            >
              <span
                className="w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: stateTheme.primary }}
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
