// ===================================================================
// BACKGROUND ATMOSPHERE - Time-of-day + Weather Adaptation
// ===================================================================
//
// Creates immersive background that adapts to:
// - Time of day (morning/afternoon/evening/night)
// - Weather (hot/cold/rainy/stormy/pleasant)
// - Season (summer/monsoon/autumn/winter)
//
// Visual effects:
// - Gradient layering with smooth transitions
// - Particle effects (rain, snow, heat shimmer)
// - Atmospheric blur and glow
// - Subtle animation for life

import { useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { useTimeOfDay, useWeatherExpression, useWorldState } from '../hooks/useUIState.js';

export function BackgroundAtmosphere() {
  const { colors, timeOfDay } = useTimeOfDay();
  const weatherExpression = useWeatherExpression();
  const worldState = useWorldState();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Render weather particles (rain, heat shimmer, etc.)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let particles: any[] = [];

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    // Particle behavior based on weather
    const particleCount = weatherExpression.mood === 'stormy' ? 80 :
                          weatherExpression.mood === 'rainy' ? 60 :
                          weatherExpression.mood === 'cold' ? 40 : 30;

    const initParticles = () => {
      particles = Array.from({ length: particleCount }, () => createParticle());
    };

    const createParticle = () => {
      const { mood } = weatherExpression;

      if (mood === 'rainy' || mood === 'stormy') {
        // Rain drops - falling
        return {
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: 0,
          vy: 4 + Math.random() * 3, // Falling speed
          size: 1 + Math.random() * 2,
          opacity: 0.3 + Math.random() * 0.3,
          type: 'rain',
        };
      } else if (mood === 'cold') {
        // Snow/ice crystals - slow falling
        return {
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.5,
          vy: 0.5 + Math.random() * 1,
          size: 2 + Math.random() * 3,
          opacity: 0.4 + Math.random() * 0.3,
          type: 'snow',
          rotation: Math.random() * Math.PI * 2,
        };
      } else if (mood === 'hot') {
        // Heat shimmer - rising
        return {
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.3,
          vy: -1 - Math.random() * 1.5, // Rising
          size: 3 + Math.random() * 4,
          opacity: 0.1 + Math.random() * 0.2,
          type: 'heat',
        };
      } else {
        // Floating particles (mild, pleasant)
        return {
          x: Math.random() * canvas.width,
          y: Math.random() * canvas.height,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          size: 2 + Math.random() * 3,
          opacity: 0.15 + Math.random() * 0.15,
          type: 'float',
        };
      }
    };

    initParticles();

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        // Reset particles when out of bounds
        if (p.type === 'rain' && p.y > canvas.height) {
          p.y = -10;
          p.x = Math.random() * canvas.width;
        } else if (p.type === 'snow' && p.y > canvas.height) {
          p.y = -10;
          p.x = Math.random() * canvas.width;
          p.rotation = Math.random() * Math.PI * 2;
        } else if (p.type === 'heat' && p.y < -10) {
          p.y = canvas.height + 10;
          p.x = Math.random() * canvas.width;
        } else if (p.type === 'float') {
          // Wrap around
          if (p.x < 0) p.x = canvas.width;
          if (p.x > canvas.width) p.x = 0;
          if (p.y < 0) p.y = canvas.height;
          if (p.y > canvas.height) p.y = 0;
        }

        // Draw particle
        ctx.save();

        if (p.type === 'rain') {
          // Rain drop - thin line
          ctx.strokeStyle = `rgba(${parseInt(weatherExpression.colors.secondary.slice(1, 3), 16)}, ${parseInt(weatherExpression.colors.secondary.slice(3, 5), 16)}, ${parseInt(weatherExpression.colors.secondary.slice(5, 7), 16)}, ${p.opacity})`;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + p.vx * 2, p.y + p.vy * 2);
          ctx.stroke();
        } else if (p.type === 'snow') {
          // Snow - small circle with glow
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
          ctx.shadowBlur = 4;
          ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
          ctx.beginPath();
          ctx.arc(0, 0, p.size, 0, Math.PI * 2);
          ctx.fill();
        } else if (p.type === 'heat') {
          // Heat shimmer - soft glow
          const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
          gradient.addColorStop(0, `rgba(255, 150, 100, ${p.opacity})`);
          gradient.addColorStop(1, 'rgba(255, 150, 100, 0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
        } else {
          // Floating particle - soft circle
          const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
          gradient.addColorStop(0, `rgba(${parseInt(weatherExpression.colors.accent.slice(1, 3), 16)}, ${parseInt(weatherExpression.colors.accent.slice(3, 5), 16)}, ${parseInt(weatherExpression.colors.accent.slice(5, 7), 16)}, ${p.opacity})`);
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(p.x - p.size, p.y - p.size, p.size * 2, p.size * 2);
        }

        ctx.restore();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [weatherExpression]);

  // Get gradient classes based on time + weather
  const getGradient = () => {
    const { mood } = weatherExpression;

    if (mood === 'hot') {
      return 'from-red-600/20 via-orange-500/15 to-amber-600/10';
    } else if (mood === 'cold') {
      return 'from-blue-600/25 via-indigo-500/20 to-violet-600/15';
    } else if (mood === 'rainy' || mood === 'stormy') {
      return 'from-slate-700/30 via-gray-600/20 to-zinc-700/15';
    } else if (mood === 'misty') {
      return 'from-gray-500/20 via-slate-400/15 to-zinc-500/10';
    } else {
      return colors.bg;
    }
  };

  const getSecondaryGradient = () => {
    const { timeOfDay } = useTimeOfDay();

    if (timeOfDay === 'night') {
      return 'from-indigo-900/40 via-purple-900/30 to-blue-900/20';
    } else if (timeOfDay === 'morning') {
      return 'from-orange-400/20 via-amber-300/15 to-yellow-400/10';
    } else if (timeOfDay === 'evening') {
      return 'from-pink-600/20 via-orange-500/15 to-purple-600/10';
    } else {
      return 'from-cyan-400/20 via-blue-400/15 to-sky-500/10';
    }
  };

  return (
    <div className="fixed inset-0 -z-50 overflow-hidden pointer-events-none">
      {/* Primary gradient layer */}
      <motion.div
        className={`absolute inset-0 bg-gradient-to-br ${getGradient()}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 2 }}
      />

      {/* Secondary gradient layer */}
      <motion.div
        className={`absolute inset-0 bg-gradient-to-tr ${getSecondaryGradient()}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.6 }}
        transition={{ duration: 2.5, delay: 0.3 }}
      />

      {/* Animated light orbs */}
      <div className="absolute inset-0">
        <motion.div
          className="absolute w-[600px] h-[600px] rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, ${weatherExpression.colors.primary}40, transparent 70%)`,
            top: '20%',
            left: '15%',
          }}
          animate={{
            x: [0, 100, 0],
            y: [0, 50, 0],
            scale: [1, 1.1, 1],
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        <motion.div
          className="absolute w-[500px] h-[500px] rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, ${weatherExpression.colors.secondary}35, transparent 70%)`,
            bottom: '15%',
            right: '20%',
          }}
          animate={{
            x: [0, -80, 0],
            y: [0, -40, 0],
            scale: [1, 1.15, 1],
          }}
          transition={{
            duration: 25,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />

        <motion.div
          className="absolute w-[400px] h-[400px] rounded-full blur-3xl"
          style={{
            background: `radial-gradient(circle, ${weatherExpression.colors.accent}30, transparent 70%)`,
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
          }}
          animate={{
            scale: [1, 1.2, 1],
            opacity: [0.4, 0.7, 0.4],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: 'easeInOut',
          }}
        />
      </div>

      {/* Storm lightning effect */}
      {weatherExpression.mood === 'stormy' && (
        <motion.div
          className="absolute inset-0 bg-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0, 0.15, 0, 0, 0.2, 0] }}
          transition={{
            duration: 4,
            repeat: Infinity,
            repeatDelay: 6,
            times: [0, 0.3, 0.35, 0.4, 0.7, 0.75, 1],
          }}
        />
      )}

      {/* Weather particle canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: 'none' }}
      />

      {/* Vignette overlay */}
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/30" />
    </div>
  );
}
