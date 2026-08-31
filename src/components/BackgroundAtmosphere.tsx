// ===================================================================
// BACKGROUND ATMOSPHERE - Real Astronomical Landscapes & Live Weather
// ===================================================================
//
// 4 Dynamic Scenic Backdrops derived from real astronomical data:
// 1. Sunrise: Golden dawn glow, morning sun rising above mountain silhouettes, lake mist
// 2. Day: Azure sky, brilliant daylight, lush mountain contours, sparkling water
// 3. Sunset: Fiery orange-magenta-purple gradient, setting sun on horizon, golden lake reflection
// 4. Night: Deep indigo-violet starfield, glowing crescent moon, moonlight water shimmer
//
// Features:
// - Multi-layer mountain ridges with atmospheric depth
// - Real-time canvas water specular reflection and ripple wavelets
// - Adaptive weather particles (rain, snow, heat shimmer, gentle float)
// - Full responsive scaling with zero layout shift

import React, { useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useTimeOfDay, useWeatherExpression, useWorldState, useWeather } from '../hooks/useUIState.js';

export function BackgroundAtmosphere() {
  const { colors, timeOfDay, istHour } = useTimeOfDay();
  const weatherExpression = useWeatherExpression();
  const worldState = useWorldState();
  const weather = useWeather();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Determine astronomical scene prioritizing real sunrise/sunset timestamps
  const scene = useMemo<'sunrise' | 'day' | 'sunset' | 'night'>(() => {
    if (weather?.sunriseIso && weather?.sunsetIso) {
      const now = Date.now();
      const sunriseTime = new Date(weather.sunriseIso).getTime();
      const sunsetTime = new Date(weather.sunsetIso).getTime();

      // Within 1.5 hours of sunrise
      if (Math.abs(now - sunriseTime) < 1.5 * 3600 * 1000) return 'sunrise';
      // Within 1.5 hours of sunset
      if (Math.abs(now - sunsetTime) < 1.5 * 3600 * 1000) return 'sunset';
      // Daylight
      if (now > sunriseTime && now < sunsetTime) return 'day';
      return 'night';
    }

    // Fallback to IST hour
    if (istHour >= 5 && istHour < 8) return 'sunrise';
    if (istHour >= 8 && istHour < 17) return 'day';
    if (istHour >= 17 && istHour < 20) return 'sunset';
    return 'night';
  }, [weather, istHour]);

  // Color schemes for the 4 scenic backdrops
  const scenicTheme = useMemo(() => {
    switch (scene) {
      case 'sunrise':
        return {
          skyGradient: 'from-[#1e102d] via-[#4a1c3d] to-[#d97706]',
          celestial: {
            type: 'sun',
            color: '#fef08a',
            halo: 'rgba(251, 191, 36, 0.45)',
            glow: 'rgba(245, 158, 11, 0.25)',
            positionY: '60%',
          },
          mountains: {
            far: '#3b1238',
            mid: '#270c2a',
            near: '#15061b',
          },
          water: {
            base: 'rgba(24, 7, 30, 0.95)',
            reflection: 'rgba(245, 158, 11, 0.35)',
          },
        };
      case 'day':
        return {
          skyGradient: 'from-[#0369a1] via-[#0284c7] to-[#38bdf8]',
          celestial: {
            type: 'sun',
            color: '#ffffff',
            halo: 'rgba(255, 255, 255, 0.65)',
            glow: 'rgba(186, 230, 253, 0.35)',
            positionY: '30%',
          },
          mountains: {
            far: '#075985',
            mid: '#0369a1',
            near: '#0c4a6e',
          },
          water: {
            base: 'rgba(8, 47, 73, 0.95)',
            reflection: 'rgba(56, 189, 248, 0.3)',
          },
        };
      case 'night':
        return {
          skyGradient: 'from-[#050814] via-[#090d24] to-[#1e1b4b]',
          celestial: {
            type: 'moon',
            color: '#f8fafc',
            halo: 'rgba(224, 231, 255, 0.3)',
            glow: 'rgba(165, 180, 252, 0.15)',
            positionY: '45%',
          },
          mountains: {
            far: '#0f172a',
            mid: '#090d1f',
            near: '#04060f',
          },
          water: {
            base: 'rgba(4, 6, 15, 0.98)',
            reflection: 'rgba(165, 180, 252, 0.2)',
          },
        };
      case 'sunset':
      default:
        return {
          skyGradient: 'from-[#2e0854] via-[#701a75] to-[#ea580c]',
          celestial: {
            type: 'sun',
            color: '#fef08a',
            halo: 'rgba(251, 146, 60, 0.55)',
            glow: 'rgba(244, 63, 94, 0.3)',
            positionY: '62%',
          },
          mountains: {
            far: '#4a044e',
            mid: '#2e0854',
            near: '#18042b',
          },
          water: {
            base: 'rgba(24, 4, 43, 0.96)',
            reflection: 'rgba(251, 146, 60, 0.45)',
          },
        };
    }
  }, [scene]);

  // Canvas Water Reflection & Weather Particles
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let time = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    // Weather particle initialization
    const particleCount =
      weatherExpression.mood === 'stormy'
        ? 70
        : weatherExpression.mood === 'rainy'
        ? 50
        : weatherExpression.mood === 'cold'
        ? 35
        : 25;

    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      vx: (Math.random() - 0.5) * (weatherExpression.mood === 'cold' ? 0.8 : 0.3),
      vy:
        weatherExpression.mood === 'rainy' || weatherExpression.mood === 'stormy'
          ? 6 + Math.random() * 4
          : weatherExpression.mood === 'cold'
          ? 1 + Math.random() * 1.5
          : weatherExpression.mood === 'hot'
          ? -1 - Math.random() * 1.2
          : (Math.random() - 0.5) * 0.4,
      size: 1 + Math.random() * 2.5,
      alpha: 0.2 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
    }));

    const render = () => {
      time += 0.02;
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const waterHorizonY = h * 0.72;

      // 1. Draw Water Specular Reflection Column
      const reflectionWidth = Math.min(w * 0.4, 320);
      const reflectionX = w / 2;

      const waterGrad = ctx.createLinearGradient(0, waterHorizonY, 0, h);
      waterGrad.addColorStop(0, scenicTheme.water.reflection);
      waterGrad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.save();
      ctx.fillStyle = waterGrad;
      ctx.beginPath();
      ctx.ellipse(reflectionX, waterHorizonY + (h - waterHorizonY) * 0.4, reflectionWidth / 2, (h - waterHorizonY) * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();

      // 2. Animated Specular Ripple Lines on Water
      const rippleCount = 18;
      for (let i = 0; i < rippleCount; i++) {
        const rowNorm = i / rippleCount;
        const ry = waterHorizonY + rowNorm * (h - waterHorizonY);
        const rWidth = (reflectionWidth * 0.3 + rowNorm * reflectionWidth * 0.9) * (1 + Math.sin(time * 2 + i) * 0.15);
        const rAlpha = (1 - rowNorm * 0.7) * 0.35 * (1 + Math.cos(time * 3 + i * 0.7) * 0.2);

        ctx.beginPath();
        ctx.moveTo(reflectionX - rWidth / 2, ry);
        ctx.lineTo(reflectionX + rWidth / 2, ry);
        ctx.strokeStyle = scenicTheme.celestial.color;
        ctx.globalAlpha = Math.max(0, rAlpha);
        ctx.lineWidth = 1 + rowNorm * 1.5;
        ctx.shadowBlur = 6;
        ctx.shadowColor = scenicTheme.celestial.halo;
        ctx.stroke();
      }
      ctx.restore();

      // 3. Weather Particles Simulation
      ctx.save();
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;

        if (p.y > h) p.y = 0;
        if (p.y < 0) p.y = h;
        if (p.x > w) p.x = 0;
        if (p.x < 0) p.x = w;

        ctx.beginPath();
        if (weatherExpression.mood === 'rainy' || weatherExpression.mood === 'stormy') {
          // Rain streaks
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + p.vx * 2, p.y + p.vy * 2.5);
          ctx.strokeStyle = 'rgba(186, 230, 253, 0.45)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          // Floating crystallites / stardust
          const pulse = p.size + Math.sin(time * 2 + p.phase) * 0.5;
          ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
          ctx.fillStyle = scenicTheme.celestial.color;
          ctx.globalAlpha = p.alpha;
          ctx.fill();
        }
      }
      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [scene, scenicTheme, weatherExpression]);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden select-none z-0">
      {/* 1. Dynamic Layered Sky Backdrop */}
      <motion.div
        key={`sky-${scene}`}
        className={`absolute inset-0 bg-gradient-to-b ${scenicTheme.skyGradient}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 1.5, ease: 'easeInOut' }}
      />

      {/* 2. Celestial Body (Sun/Moon) with Radiant Halo */}
      <div
        className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center pointer-events-none"
        style={{ top: scenicTheme.celestial.positionY }}
      >
        {/* Outer Radiant Glow */}
        <motion.div
          className="absolute w-72 h-72 rounded-full"
          animate={{ scale: [1, 1.08, 1], opacity: [0.7, 0.95, 0.7] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          style={{
            background: `radial-gradient(circle, ${scenicTheme.celestial.halo} 0%, ${scenicTheme.celestial.glow} 40%, rgba(0,0,0,0) 70%)`,
          }}
        />

        {/* Celestial Sphere */}
        <div
          className="w-20 h-20 rounded-full shadow-2xl"
          style={{
            backgroundColor: scenicTheme.celestial.color,
            boxShadow: `0 0 45px ${scenicTheme.celestial.halo}, 0 0 90px ${scenicTheme.celestial.glow}`,
          }}
        />
      </div>

      {/* 3. Multi-Layer Mountain Ridge Silhouettes (SVG Vectors) */}
      <div className="absolute inset-0 flex flex-col justify-end pointer-events-none">
        {/* Far Ridge */}
        <svg
          viewBox="0 0 1440 320"
          className="w-full h-auto max-h-[38vh] preserve-3d"
          style={{ fill: scenicTheme.mountains.far, opacity: 0.75 }}
          preserveAspectRatio="none"
        >
          <path d="M0,192L60,181.3C120,171,240,149,360,160C480,171,600,213,720,202.7C840,192,960,128,1080,133.3C1200,139,1320,213,1380,250.7L1440,288L1440,320L1380,320C1320,320,1200,320,1080,320C960,320,840,320,720,320C600,320,480,320,360,320C240,320,120,320,60,320L0,320Z" />
        </svg>

        {/* Mid Ridge */}
        <svg
          viewBox="0 0 1440 260"
          className="w-full h-auto max-h-[30vh] -mt-16 preserve-3d"
          style={{ fill: scenicTheme.mountains.mid, opacity: 0.88 }}
          preserveAspectRatio="none"
        >
          <path d="M0,96L80,112C160,128,320,160,480,149.3C640,139,800,85,960,85.3C1120,85,1280,139,1360,165.3L1440,192L1440,320L1360,320C1280,320,1120,320,960,320C800,320,640,320,480,320C320,320,160,320,80,320L0,320Z" />
        </svg>

        {/* Near Ridge & Shoreline */}
        <svg
          viewBox="0 0 1440 200"
          className="w-full h-auto max-h-[22vh] -mt-12 preserve-3d"
          style={{ fill: scenicTheme.mountains.near, opacity: 0.98 }}
          preserveAspectRatio="none"
        >
          <path d="M0,64L100,85.3C200,107,400,149,600,144C800,139,1000,85,1200,74.7C1300,69,1400,107,1440,128L1440,320L1400,320C1300,320,1200,320,1000,320C800,320,600,320,400,320C200,320,100,320,0,320Z" />
        </svg>

        {/* 4. Foreground Lake Water Surface */}
        <div
          className="w-full h-[28vh] relative"
          style={{ backgroundColor: scenicTheme.water.base }}
        >
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent" />
        </div>
      </div>

      {/* 5. Water Specular Reflection & Particle Canvas Overlay */}
      <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
    </div>
  );
}
