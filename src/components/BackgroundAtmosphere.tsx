// ===================================================================
// BACKGROUND ATMOSPHERE — Photographic Mountain Lake Landscape
// ===================================================================
//
// 100% Photographic Realism with Live Lake Reflection of the Glass Orb:
//   - 4 Time-of-Day Photographic Scenes (Sunset, Night, Day, Sunrise)
//   - Realistic lake water reflection of the floating glass orb & soundwave
//   - Sinuous wavelet distortion, caustic light sparkles & longitudinal tapering
//   - Horizon celestial halo bloom harmonized with the floating sphere

import React, { useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  useTimeOfDay,
  useWeatherExpression,
  useWeather,
} from '../hooks/useUIState.js';

export type Scene = 'sunrise' | 'day' | 'sunset' | 'night';

interface ScenicTheme {
  image: string;
  bloomColor: string;
  haloColor: string;
  flareColor: string;
  celestialY: string;
  waterSunColor: string;
  waterShimmerColor: string;
  orbReflectionColor: string;
  ambientWash: string;
  exposure: number;
}

export function BackgroundAtmosphere() {
  const { istHour } = useTimeOfDay();
  const weatherExpression = useWeatherExpression();
  const weather = useWeather();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // -------------------------------------------------------------- scene
  const scene = useMemo<Scene>(() => {
    if (weather?.sunriseIso && weather?.sunsetIso) {
      const now = Date.now();
      const sunriseTime = new Date(weather.sunriseIso).getTime();
      const sunsetTime = new Date(weather.sunsetIso).getTime();
      if (Math.abs(now - sunriseTime) < 1.5 * 3600 * 1000) return 'sunrise';
      if (Math.abs(now - sunsetTime) < 1.5 * 3600 * 1000) return 'sunset';
      if (now > sunriseTime && now < sunsetTime) return 'day';
      return 'night';
    }
    if (istHour >= 5 && istHour < 8) return 'sunrise';
    if (istHour >= 8 && istHour < 17) return 'day';
    if (istHour >= 17 && istHour < 20) return 'sunset';
    return 'night';
  }, [weather, istHour]);

  // -------------------------------------------------------------- theme
  const theme = useMemo<ScenicTheme>(() => {
    switch (scene) {
      case 'sunrise':
        return {
          image: '/backgrounds/sunrise.jpg',
          bloomColor: 'rgba(255, 180, 110, 0.45)',
          haloColor: 'rgba(255, 210, 140, 0.65)',
          flareColor: 'rgba(255, 245, 200, 0.9)',
          celestialY: '58%',
          waterSunColor: 'rgba(255, 195, 120, 0.55)',
          waterShimmerColor: 'rgba(255, 240, 190, 0.85)',
          orbReflectionColor: 'rgba(254, 215, 170, 0.65)',
          ambientWash: 'rgba(255, 180, 120, 0.04)',
          exposure: 0.95,
        };
      case 'day':
        return {
          image: '/backgrounds/day.jpg',
          bloomColor: 'rgba(186, 230, 253, 0.35)',
          haloColor: 'rgba(224, 242, 254, 0.6)',
          flareColor: 'rgba(255, 255, 255, 0.95)',
          celestialY: '24%',
          waterSunColor: 'rgba(224, 242, 254, 0.45)',
          waterShimmerColor: 'rgba(255, 255, 255, 0.85)',
          orbReflectionColor: 'rgba(224, 242, 254, 0.55)',
          ambientWash: 'rgba(186, 230, 253, 0.03)',
          exposure: 1.0,
        };
      case 'night':
        return {
          image: '/backgrounds/night.jpg',
          bloomColor: 'rgba(140, 160, 240, 0.25)',
          haloColor: 'rgba(190, 210, 255, 0.45)',
          flareColor: 'rgba(230, 240, 255, 0.9)',
          celestialY: '28%',
          waterSunColor: 'rgba(180, 205, 255, 0.4)',
          waterShimmerColor: 'rgba(220, 235, 255, 0.8)',
          orbReflectionColor: 'rgba(199, 210, 254, 0.5)',
          ambientWash: 'rgba(99, 102, 241, 0.03)',
          exposure: 0.82,
        };
      case 'sunset':
      default:
        return {
          image: '/backgrounds/sunset.jpg',
          bloomColor: 'rgba(251, 146, 60, 0.55)',
          haloColor: 'rgba(253, 186, 116, 0.7)',
          flareColor: 'rgba(255, 237, 213, 0.95)',
          celestialY: '64%',
          waterSunColor: 'rgba(251, 146, 60, 0.65)',
          waterShimmerColor: 'rgba(254, 215, 170, 0.9)',
          orbReflectionColor: 'rgba(251, 146, 60, 0.7)',
          ambientWash: 'rgba(244, 63, 94, 0.05)',
          exposure: 0.92,
        };
    }
  }, [scene]);

  // ---------------------------------------------------- canvas: live lake reflection
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;

    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let time = 0;
    let width = window.innerWidth;
    let height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    // Starfield for night and dusk
    const starCount = scene === 'night' ? 80 : scene === 'sunset' ? 24 : 0;
    const stars = Array.from({ length: starCount }, () => ({
      x: Math.random(),
      y: Math.random() * 0.45,
      r: 0.4 + Math.random() * 0.9,
      phase: Math.random() * Math.PI * 2,
      speed: 0.8 + Math.random() * 1.4,
      twinkle: 0.4 + Math.random() * 0.6,
    }));

    // Weather particles
    const mood = weatherExpression?.mood || 'pleasant';
    const isRain = mood === 'rainy' || mood === 'stormy';
    const isSnow = mood === 'cold';

    const particleCount = isRain ? 65 : isSnow ? 40 : 16;
    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * (isSnow ? 0.0008 : 0.0003),
      vy: isRain ? 0.003 + Math.random() * 0.002 : isSnow ? 0.0004 + Math.random() * 0.0006 : (Math.random() - 0.5) * 0.0002,
      size: isRain ? 0.8 + Math.random() * 0.8 : isSnow ? 1.0 + Math.random() * 1.8 : 0.5 + Math.random() * 1.2,
      alpha: 0.2 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    }));

    const render = () => {
      if (!reduceMotion) time += 0.016;
      ctx.clearRect(0, 0, width, height);

      const horizonY = height * 0.58;
      const reflectionWidth = Math.min(width * 0.34, 380);
      const rx = width / 2;

      // ================================================================
      // 1. Realistic Sinuous Lake Reflection of the Glass Orb
      // ================================================================
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      // (A) Diffused soft contact glow on the water plane directly below the orb
      const contactGrad = ctx.createRadialGradient(rx, horizonY + 12, 0, rx, horizonY + 12, 90);
      contactGrad.addColorStop(0, theme.orbReflectionColor);
      contactGrad.addColorStop(0.5, theme.waterSunColor);
      contactGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = contactGrad;
      ctx.beginPath();
      ctx.ellipse(rx, horizonY + 12, 110, 24, 0, 0, Math.PI * 2);
      ctx.fill();

      // (B) Inverted Mirrored Glass Sphere Reflection Arc on Water
      const arcWidth = 140;
      const arcHeight = 35;
      const arcGrad = ctx.createLinearGradient(0, horizonY + 5, 0, horizonY + 45);
      arcGrad.addColorStop(0, theme.waterShimmerColor);
      arcGrad.addColorStop(0.6, theme.orbReflectionColor);
      arcGrad.addColorStop(1, 'transparent');
      ctx.strokeStyle = arcGrad;
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 14;
      ctx.shadowColor = theme.waterSunColor;
      ctx.beginPath();
      ctx.ellipse(rx, horizonY + 16, arcWidth / 2, arcHeight / 2, 0, 0, Math.PI);
      ctx.stroke();

      // (C) Sinuous Longitudinal Water Ripples Streaming Downward
      const rippleRows = 26;
      for (let i = 0; i < rippleRows; i++) {
        const t = i / rippleRows;
        const y = horizonY + 6 + t * (height - horizonY - 6);
        const baseWidth = reflectionWidth * (0.07 + Math.pow(t, 0.72) * 0.95);
        const sinWave = Math.sin(time * 1.5 + i * 0.75);
        const cosWave = Math.cos(time * 2.1 + i * 0.95);
        const jitter = 1 + sinWave * 0.15;
        const w = baseWidth * jitter;
        const offsetX = sinWave * (4 + t * 12);
        const alpha = (1 - t * 0.75) * (0.32 + cosWave * 0.15);
        if (alpha <= 0) continue;

        ctx.strokeStyle = theme.waterShimmerColor;
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.lineWidth = 1.0 + (1 - t) * 1.6;
        ctx.shadowBlur = 9;
        ctx.shadowColor = theme.waterSunColor;

        ctx.beginPath();
        ctx.moveTo(rx + offsetX - w / 2, y);
        ctx.bezierCurveTo(
          rx + offsetX - w * 0.25,
          y + sinWave * 2,
          rx + offsetX + w * 0.25,
          y - sinWave * 2,
          rx + offsetX + w / 2,
          y
        );
        ctx.stroke();

        // Extra specular glints near the center axis
        if (i % 3 === 0 && Math.abs(sinWave) > 0.4) {
          ctx.fillStyle = '#FFFFFF';
          ctx.globalAlpha = alpha * 0.7;
          ctx.beginPath();
          ctx.arc(rx + offsetX + (cosWave * w * 0.2), y, 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // ================================================================
      // 2. Starfield Twinkle (Night & Twilight)
      // ================================================================
      if (stars.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = '#FFFFFF';
        for (const s of stars) {
          const x = s.x * width;
          const y = s.y * height;
          const tw = (Math.sin(time * s.speed + s.phase) * 0.5 + 0.5) * s.twinkle;
          ctx.globalAlpha = tw;
          ctx.beginPath();
          ctx.arc(x, y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // ================================================================
      // 3. Weather Particles
      // ================================================================
      ctx.save();
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.y > 1) p.y = 0;
        if (p.y < 0) p.y = 1;
        if (p.x > 1) p.x = 0;
        if (p.x < 0) p.x = 1;
        const x = p.x * width;
        const y = p.y * height;

        if (isRain) {
          ctx.strokeStyle = `rgba(186, 230, 253, ${0.45 * p.alpha})`;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + p.vx * 1800, y + p.vy * 1800);
          ctx.stroke();
        } else if (isSnow) {
          ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = theme.waterShimmerColor;
          ctx.globalAlpha = p.alpha * 0.35;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
      }
      ctx.restore();

      raf = requestAnimationFrame(render);
    };
    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(raf);
    };
  }, [scene, theme, weatherExpression]);

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden select-none z-0">
      {/* ============ 1. Real Photographic Landscape Image ============ */}
      <AnimatePresence mode="sync">
        <motion.div
          key={`photographic-scene-${scene}`}
          className="absolute inset-0"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.4, ease: 'easeInOut' }}
        >
          {/* Photographic high-resolution landscape */}
          <img
            src={theme.image}
            alt={`${scene} landscape`}
            className="absolute inset-0 w-full h-full object-cover object-center filter brightness-[0.96] contrast-[1.04]"
          />

          {/* Gentle breathing ambient lighting */}
          <div
            className="absolute inset-0 animate-atmo-breathe pointer-events-none"
            style={{ background: theme.ambientWash, mixBlendMode: 'soft-light' }}
          />

          {/* Horizon celestial halo bloom — perfectly centered and harmonized with Orb */}
          <div
            className="absolute left-1/2 -translate-x-1/2 pointer-events-none"
            style={{
              top: theme.celestialY,
              width: '75vmin',
              height: '38vmin',
              transform: 'translate(-50%, -50%)',
              background: `radial-gradient(ellipse at center,
                ${theme.bloomColor} 0%,
                ${theme.haloColor} 28%,
                transparent 72%)`,
              mixBlendMode: 'screen',
              filter: 'blur(16px)',
              opacity: 0.7,
            }}
          />
        </motion.div>
      </AnimatePresence>

      {/* ============ 2. Real-time Lake Reflection Canvas Overlay ==== */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 10 }}
      />

      {/* ============ 3. Cinematic Vignette & Color Balance =========== */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 15,
          background: `
            radial-gradient(ellipse at 50% 48%, rgba(0,0,0,0) 42%, rgba(5,8,16,0.52) 86%, rgba(3,5,12,0.85) 100%),
            linear-gradient(180deg, rgba(3,5,14,0.38) 0%, rgba(0,0,0,0) 20%, rgba(0,0,0,0) 76%, rgba(3,5,14,0.58) 100%)
          `,
        }}
      />
    </div>
  );
}
