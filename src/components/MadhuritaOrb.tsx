// ===================================================================
// MADHURITA ORB - Emotion-Driven Expressive Core
// ===================================================================
//
// The orb is Madhurita's physical expression - it morphs, breathes, and
// radiates emotion based on:
// - Cognitive state (engagement, focus, confidence)
// - Weather sensation (hot, cold, pleasant, rainy, stormy)
// - Time of day (morning warmth, night coolness)
// - Live state (idle, listening, speaking, processing)
//
// Features:
// - Morphing core with breathing animation
// - Particle system (20-50 particles orbiting)
// - Aura rings (3-5 concentric, color-matched)
// - Emotion-driven color palette
// - Weather-reactive behavior
// - Audio waveform when voice active
// - Click interaction with ripple effect

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useEmotions, useWeatherExpression, useTimeOfDay } from '../hooks/useUIState.js';
import { LiveState } from '../types.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

interface MadhuritaOrbProps {
  state?: LiveState;
  size?: number; // Diameter in pixels
  onClick?: () => void;
  streamer?: AudioStreamer;
  player?: AudioPlayer;
  className?: string;
}

export function MadhuritaOrb({
  state = 'disconnected',
  size = 200,
  onClick,
  streamer,
  player,
  className = '',
}: MadhuritaOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const emotions = useEmotions();
  const weatherExpression = useWeatherExpression();
  const { timeOfDay, colors: timeColors } = useTimeOfDay();
  const [isHovered, setIsHovered] = useState(false);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number; createdAt: number }>>([]);

  // Determine orb color based on state + emotions + weather
  const getOrbColors = () => {
    // Voice states take priority
    if (state === 'speaking') {
      return {
        core: weatherExpression.colors.primary,
        glow: weatherExpression.colors.secondary,
        accent: weatherExpression.colors.accent,
        intensity: 1.0,
      };
    }

    if (state === 'listening') {
      return {
        core: '#60A5FA', // Blue
        glow: '#3B82F6',
        accent: '#93C5FD',
        intensity: 0.9,
      };
    }

    if (state === 'connecting') {
      return {
        core: '#FBBF24', // Amber
        glow: '#F59E0B',
        accent: '#FCD34D',
        intensity: 0.7,
      };
    }

    // Idle - blend weather + time of day + emotions
    return {
      core: weatherExpression.colors.primary,
      glow: weatherExpression.colors.secondary,
      accent: weatherExpression.colors.accent,
      intensity: 0.5 + (emotions.engagement / 200),
    };
  };

  const orbColors = getOrbColors();

  // Calculate breathing speed based on weather + engagement
  const breathingDuration = 4 / (weatherExpression.breathingSpeed * (1 + emotions.engagement / 200));

  // Particle animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let particles: any[] = [];
    let rotation = 0;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    // Number of particles based on state
    const particleCount = state === 'speaking' ? 40 :
                          state === 'listening' ? 30 :
                          state === 'connecting' ? 25 : 20;

    const initParticles = () => {
      particles = Array.from({ length: particleCount }, (_, i) => {
        const angle = (i / particleCount) * Math.PI * 2;
        const orbitRadius = size * 0.35;

        return {
          angle,
          orbitRadius: orbitRadius + (Math.random() - 0.5) * 20,
          speed: 0.005 + Math.random() * 0.01,
          size: 1 + Math.random() * 2,
          opacity: 0.4 + Math.random() * 0.4,
          phase: Math.random() * Math.PI * 2,
        };
      });
    };

    initParticles();

    let audioData: Uint8Array | null = null;
    if (state === 'listening' || state === 'speaking') {
      audioData = new Uint8Array(128);
    }

    const render = () => {
      ctx.clearRect(0, 0, size, size);

      const centerX = size / 2;
      const centerY = size / 2;
      const orbRadius = size * 0.25;

      // Get audio data
      if (state === 'listening' && streamer && audioData) {
        streamer.getWaveformData(audioData);
      } else if (state === 'speaking' && player && audioData) {
        player.getWaveformData(audioData);
      }

      rotation += 0.005 * weatherExpression.breathingSpeed;

      // Draw particles orbiting
      for (const p of particles) {
        p.angle += p.speed * weatherExpression.breathingSpeed;
        const x = centerX + Math.cos(p.angle + rotation) * p.orbitRadius;
        const y = centerY + Math.sin(p.angle + rotation) * p.orbitRadius;

        // Particle behavior based on weather
        let yOffset = 0;
        if (weatherExpression.particleBehavior === 'rising') {
          yOffset = -((Date.now() * 0.05) % 10); // Rising effect
        } else if (weatherExpression.particleBehavior === 'falling') {
          yOffset = ((Date.now() * 0.05) % 10); // Falling effect
        } else if (weatherExpression.particleBehavior === 'chaotic') {
          yOffset = Math.sin(Date.now() * 0.01 + p.phase) * 5; // Erratic
        }

        // Draw particle
        ctx.save();
        ctx.translate(x, y + yOffset);

        const pulseSize = p.size + Math.sin(Date.now() * 0.003 + p.phase) * 0.5;

        // Glow
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, pulseSize * 3);
        gradient.addColorStop(0, `${orbColors.accent}${Math.floor(p.opacity * 255).toString(16).padStart(2, '0')}`);
        gradient.addColorStop(1, `${orbColors.accent}00`);
        ctx.fillStyle = gradient;
        ctx.fillRect(-pulseSize * 3, -pulseSize * 3, pulseSize * 6, pulseSize * 6);

        // Core
        ctx.fillStyle = `${orbColors.core}${Math.floor(p.opacity * 255).toString(16).padStart(2, '0')}`;
        ctx.beginPath();
        ctx.arc(0, 0, pulseSize, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      }

      // Draw audio-reactive ring (if voice active)
      if (audioData && (state === 'listening' || state === 'speaking')) {
        ctx.save();
        ctx.translate(centerX, centerY);

        const points = 64;
        ctx.beginPath();

        for (let i = 0; i <= points; i++) {
          const angle = (i / points) * Math.PI * 2;
          const index = Math.floor((i / points) * (audioData.length / 2));
          const v = audioData[index] / 128.0;
          const audioRadius = orbRadius + (v - 1.0) * 25;

          const x = Math.cos(angle) * audioRadius;
          const y = Math.sin(angle) * audioRadius;

          if (i === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.closePath();
        ctx.strokeStyle = `${orbColors.accent}AA`;
        ctx.lineWidth = 2;
        ctx.shadowBlur = 20;
        ctx.shadowColor = orbColors.glow;
        ctx.stroke();
        ctx.restore();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [size, state, streamer, player, weatherExpression, orbColors]);

  // Click ripple effect
  const handleClick = (e: React.MouseEvent) => {
    if (!onClick) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const id = Date.now();
    setRipples(prev => [...prev, { id, x, y, createdAt: Date.now() }]);

    setTimeout(() => {
      setRipples(prev => prev.filter(r => r.id !== id));
    }, 1000);

    onClick();
  };

  // Scale based on emotions (engagement = larger)
  const baseScale = 1 + (emotions.engagement / 500);
  const hoverScale = isHovered ? 1.05 : 1;
  const activeScale = state === 'speaking' ? 1.08 : state === 'listening' ? 1.05 : 1;

  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Outer aura rings - 5 concentric rings */}
      {[0, 1, 2, 3, 4].map((ringIndex) => {
        const ringSize = size * (0.3 + ringIndex * 0.12);
        const ringOpacity = orbColors.intensity * (1 - ringIndex * 0.15);
        const delay = ringIndex * 0.4;

        return (
          <motion.div
            key={`ring-${ringIndex}`}
            className="absolute rounded-full pointer-events-none"
            style={{
              width: ringSize,
              height: ringSize,
              border: `1.5px solid ${orbColors.glow}${Math.floor(ringOpacity * 255).toString(16).padStart(2, '0')}`,
              boxShadow: `0 0 ${20 + ringIndex * 10}px ${orbColors.glow}${Math.floor(ringOpacity * 0.5 * 255).toString(16).padStart(2, '0')}`,
            }}
            animate={{
              scale: [1, 1.1, 1],
              opacity: [ringOpacity * 0.6, ringOpacity, ringOpacity * 0.6],
            }}
            transition={{
              duration: 3 + delay,
              repeat: Infinity,
              ease: 'easeInOut',
              delay,
            }}
          />
        );
      })}

      {/* Particle canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: size, height: size }}
      />

      {/* Central orb - breathing + interactive */}
      <motion.button
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="relative z-10 rounded-full focus:outline-none focus:ring-4 focus:ring-white/20"
        style={{
          width: size * 0.5,
          height: size * 0.5,
          background: 'transparent',
          border: 'none',
          cursor: onClick ? 'pointer' : 'default',
        }}
        animate={{
          scale: [baseScale * activeScale, baseScale * activeScale * 1.08, baseScale * activeScale],
        }}
        transition={{
          duration: breathingDuration,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        whileHover={{ scale: baseScale * activeScale * hoverScale }}
        whileTap={{ scale: baseScale * activeScale * 0.95 }}
      >
        {/* Glass shell */}
        <div
          className="absolute inset-0 rounded-full backdrop-blur-2xl border border-white/30 glass-inset"
          style={{
            background: `linear-gradient(135deg, ${orbColors.core}40, ${orbColors.glow}30)`,
            boxShadow: `0 8px 32px ${orbColors.glow}60, inset 0 0 30px ${orbColors.accent}40`,
          }}
        />

        {/* Inner gradient core */}
        <motion.div
          className="absolute inset-[10%] rounded-full"
          style={{
            background: `radial-gradient(circle at 30% 30%, ${orbColors.core}, ${orbColors.glow}, ${orbColors.accent})`,
          }}
          animate={{
            opacity: [0.7, 1, 0.7],
          }}
          transition={{
            duration: breathingDuration * 0.7,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        {/* Central highlight */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle at 30% 25%, rgba(255,255,255,0.6), transparent 40%)',
            mixBlendMode: 'overlay',
          }}
        />

        {/* Shiver effect when cold */}
        {weatherExpression.mood === 'cold' && (
          <motion.div
            className="absolute inset-0 rounded-full"
            style={{ background: 'rgba(180, 200, 255, 0.1)' }}
            animate={{ x: [-1, 1, -1, 1, 0] }}
            transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 2 }}
          />
        )}

        {/* Heat shimmer effect */}
        {weatherExpression.mood === 'hot' && (
          <motion.div
            className="absolute inset-0 rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(255,150,100,0.3), transparent 70%)',
            }}
            animate={{ scale: [1, 1.3, 1], opacity: [0.5, 0.8, 0.5] }}
            transition={{ duration: 1, repeat: Infinity }}
          />
        )}
      </motion.button>

      {/* Click ripples */}
      {ripples.map(ripple => (
        <motion.div
          key={ripple.id}
          className="absolute rounded-full pointer-events-none"
          style={{
            left: ripple.x,
            top: ripple.y,
            width: 0,
            height: 0,
            background: `${orbColors.accent}40`,
            transform: 'translate(-50%, -50%)',
          }}
          initial={{ width: 0, height: 0, opacity: 0.8 }}
          animate={{ width: size, height: size, opacity: 0 }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}
