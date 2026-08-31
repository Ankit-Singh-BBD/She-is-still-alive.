// ===================================================================
// BACKGROUND ATMOSPHERE — Cinematic photographic landscape
// ===================================================================
//
// A full-bleed ultra-HD still-frame that reads like a film plate rather
// than a gradient panel. Built entirely from layered radial / linear
// gradients, mix-blend-modes, backdrop-filters and one real-time canvas
// for specular water + light scattering.
//
// 4 astronomical scenes (sunrise / day / sunset / night) are picked from
// the backend world state; each is its own composite:
//   1. Sky stratification (zenith -> horizon -> ground glow)
//   2. Volumetric clouds drifting at three altitudes (parallax)
//   3. Celestial body with halation bloom + anisotropic lens flare
//   4. Three atmospheric ridges with rim light and rising haze
//   5. Water plane with a tapered caustic reflection column
//   6. Adaptive weather particles (rain, snow, mist, heat, stardust)
//
// The frame breathes slowly so it never feels frozen, while staying
// GPU-cheap. prefers-reduced-motion disables the drift via index.css.

import React, { useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  useTimeOfDay,
  useWeatherExpression,
  useWorldState,
  useWeather,
} from '../hooks/useUIState.js';

type Scene = 'sunrise' | 'day' | 'sunset' | 'night';

interface ScenicTheme {
  // Sky stratification (top -> bottom)
  skyZenith: string;
  skyHigh: string;
  skyMid: string;
  skyHorizon: string;
  skyGround: string;
  // Light scattering / atmospheric haze
  haze: string;
  flare: string;
  scatter: string;
  // Celestial body
  celestial: {
    type: 'sun' | 'moon';
    core: string;
    rim: string;
    halo: string;
    bloom: string;
    positionY: string;
    size: number;
  };
  // Mountain ridges (back -> front)
  ridges: Array<{ base: string; rim: string; haze: string }>;
  // Water plane
  water: { base: string; sun: string; sunFaint: string; shimmer: string };
  // Atmosphere
  cloud: string;
  star: string;
  ambient: string;
  exposure: number;
}

export function BackgroundAtmosphere() {
  const { colors, timeOfDay, istHour } = useTimeOfDay();
  const weatherExpression = useWeatherExpression();
  const worldState = useWorldState();
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
          skyZenith: '#1b0b32',
          skyHigh: '#3a1148',
          skyMid: '#7a2a55',
          skyHorizon: '#d97a3a',
          skyGround: '#f6c172',
          haze: 'rgba(255, 196, 130, 0.55)',
          flare: 'rgba(255, 235, 175, 0.95)',
          scatter: 'rgba(255, 160, 92, 0.20)',
          celestial: {
            type: 'sun',
            core: '#fff4c2',
            rim: '#ffd07a',
            halo: 'rgba(255, 196, 130, 0.60)',
            bloom: 'rgba(255, 154, 92, 0.30)',
            positionY: '66%',
            size: 100,
          },
          ridges: [
            { base: '#3d1650', rim: 'rgba(255, 200, 140, 0.55)', haze: 'rgba(255, 170, 120, 0.34)' },
            { base: '#27093b', rim: 'rgba(255, 175, 110, 0.42)', haze: 'rgba(255, 150, 100, 0.24)' },
            { base: '#120525', rim: 'rgba(255, 130, 90, 0.34)', haze: 'rgba(255, 110, 80, 0.16)' },
          ],
          water: {
            base: 'rgba(22, 5, 38, 0.96)',
            sun: 'rgba(255, 184, 96, 0.55)',
            sunFaint: 'rgba(255, 184, 96, 0.16)',
            shimmer: 'rgba(255, 224, 170, 0.85)',
          },
          cloud: 'rgba(255, 196, 160, 0.50)',
          star: 'rgba(255, 230, 200, 0.80)',
          ambient: 'rgba(255, 154, 92, 0.06)',
          exposure: 0.94,
        };
      case 'day':
        return {
          skyZenith: '#0b2d5e',
          skyHigh: '#0e4d8a',
          skyMid: '#1f7ab8',
          skyHorizon: '#7ec8e6',
          skyGround: '#cfeaff',
          haze: 'rgba(170, 220, 255, 0.40)',
          flare: 'rgba(255, 255, 255, 0.95)',
          scatter: 'rgba(186, 230, 253, 0.18)',
          celestial: {
            type: 'sun',
            core: '#ffffff',
            rim: '#e0f4ff',
            halo: 'rgba(186, 230, 253, 0.62)',
            bloom: 'rgba(186, 230, 253, 0.30)',
            positionY: '24%',
            size: 118,
          },
          ridges: [
            { base: '#0f3a6b', rim: 'rgba(200, 235, 255, 0.55)', haze: 'rgba(170, 220, 255, 0.38)' },
            { base: '#082a4f', rim: 'rgba(140, 200, 235, 0.42)', haze: 'rgba(130, 190, 225, 0.26)' },
            { base: '#041a33', rim: 'rgba(110, 175, 215, 0.32)', haze: 'rgba(90, 160, 200, 0.16)' },
          ],
          water: {
            base: 'rgba(6, 30, 56, 0.96)',
            sun: 'rgba(186, 230, 253, 0.45)',
            sunFaint: 'rgba(186, 230, 253, 0.14)',
            shimmer: 'rgba(255, 255, 255, 0.85)',
          },
          cloud: 'rgba(255, 255, 255, 0.60)',
          star: 'rgba(255, 255, 255, 0.35)',
          ambient: 'rgba(150, 200, 255, 0.05)',
          exposure: 1.0,
        };
      case 'night':
        return {
          skyZenith: '#02030c',
          skyHigh: '#060a1f',
          skyMid: '#0c1130',
          skyHorizon: '#1a1640',
          skyGround: '#241a3f',
          haze: 'rgba(150, 160, 255, 0.24)',
          flare: 'rgba(220, 220, 255, 0.90)',
          scatter: 'rgba(120, 130, 220, 0.12)',
          celestial: {
            type: 'moon',
            core: '#f4f1ff',
            rim: '#cfc6ff',
            halo: 'rgba(200, 200, 255, 0.40)',
            bloom: 'rgba(140, 150, 240, 0.20)',
            positionY: '32%',
            size: 92,
          },
          ridges: [
            { base: '#0a0f24', rim: 'rgba(180, 200, 255, 0.30)', haze: 'rgba(120, 140, 220, 0.20)' },
            { base: '#06091a', rim: 'rgba(140, 170, 230, 0.22)', haze: 'rgba(80, 100, 200, 0.14)' },
            { base: '#02030a', rim: 'rgba(100, 130, 200, 0.18)', haze: 'rgba(50, 80, 180, 0.10)' },
          ],
          water: {
            base: 'rgba(2, 3, 12, 0.98)',
            sun: 'rgba(180, 200, 255, 0.40)',
            sunFaint: 'rgba(180, 200, 255, 0.12)',
            shimmer: 'rgba(220, 220, 255, 0.80)',
          },
          cloud: 'rgba(140, 150, 200, 0.24)',
          star: 'rgba(230, 235, 255, 0.95)',
          ambient: 'rgba(100, 110, 180, 0.04)',
          exposure: 0.80,
        };
      case 'sunset':
      default:
        return {
          skyZenith: '#1a0640',
          skyHigh: '#3d0d5e',
          skyMid: '#7a1a4c',
          skyHorizon: '#e8531e',
          skyGround: '#f3a352',
          haze: 'rgba(255, 130, 90, 0.58)',
          flare: 'rgba(255, 220, 150, 0.95)',
          scatter: 'rgba(244, 63, 94, 0.20)',
          celestial: {
            type: 'sun',
            core: '#fff1ad',
            rim: '#ffb073',
            halo: 'rgba(255, 160, 90, 0.62)',
            bloom: 'rgba(244, 63, 94, 0.32)',
            positionY: '68%',
            size: 104,
          },
          ridges: [
            { base: '#36054a', rim: 'rgba(255, 160, 100, 0.55)', haze: 'rgba(244, 90, 90, 0.34)' },
            { base: '#1c042e', rim: 'rgba(255, 120, 80, 0.42)', haze: 'rgba(220, 60, 80, 0.24)' },
            { base: '#0a0114', rim: 'rgba(255, 90, 70, 0.32)', haze: 'rgba(180, 40, 60, 0.16)' },
          ],
          water: {
            base: 'rgba(18, 2, 30, 0.97)',
            sun: 'rgba(255, 150, 90, 0.58)',
            sunFaint: 'rgba(255, 150, 90, 0.17)',
            shimmer: 'rgba(255, 220, 170, 0.85)',
          },
          cloud: 'rgba(255, 170, 130, 0.50)',
          star: 'rgba(255, 230, 200, 0.65)',
          ambient: 'rgba(244, 63, 94, 0.06)',
          exposure: 0.90,
        };
    }
  }, [scene]);

  // ---------------------------------------------------- canvas: water + sky
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

    // ----- starfield (night, faintly at sunrise/sunset) ---------------
    const starCount = scene === 'night' ? 190 : scene === 'day' ? 0 : 70;
    const stars = Array.from({ length: starCount }, () => ({
      x: Math.random(),
      y: Math.random() * 0.58,
      r: 0.25 + Math.random() * 1.05,
      phase: Math.random() * Math.PI * 2,
      speed: 0.5 + Math.random() * 1.6,
      twinkle: 0.35 + Math.random() * 0.65,
    }));

    // ----- adaptive weather particles ---------------------------------
    const mood = weatherExpression?.mood || 'pleasant';
    const isRain = mood === 'rainy' || mood === 'stormy';
    const isSnow = mood === 'cold';
    const isMist = mood === 'misty';
    const isHot = mood === 'hot';

    const particleCount = isRain
      ? mood === 'stormy'
        ? 120
        : 85
      : isSnow
      ? 58
      : isMist
      ? 42
      : 26;

    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * (isSnow ? 0.0009 : 0.0004),
      vy: isRain
        ? 0.0026 + Math.random() * 0.0026
        : isSnow
        ? 0.00035 + Math.random() * 0.0007
        : isHot
        ? -0.0006 - Math.random() * 0.0007
        : (Math.random() - 0.5) * 0.00022,
      size: isRain
        ? 0.6 + Math.random() * 0.7
        : isSnow
        ? 0.9 + Math.random() * 1.9
        : 0.4 + Math.random() * 1.4,
      alpha: 0.18 + Math.random() * 0.5,
      phase: Math.random() * Math.PI * 2,
    }));

    const render = () => {
      if (!reduceMotion) time += 0.016;
      ctx.clearRect(0, 0, width, height);

      const horizonY = height * 0.66;
      const reflectionWidth = Math.min(width * 0.36, 380);
      const rx = width / 2;

      // ---------- (A) tapered caustic reflection column ---------------
      const grad = ctx.createLinearGradient(0, horizonY, 0, height);
      grad.addColorStop(0, theme.water.sun);
      grad.addColorStop(0.55, theme.water.sunFaint);
      grad.addColorStop(1, 'rgba(0,0,0,0)');

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(rx - 7, horizonY);
      ctx.bezierCurveTo(
        rx - reflectionWidth * 0.52,
        horizonY + (height - horizonY) * 0.5,
        rx - reflectionWidth * 0.7,
        horizonY + (height - horizonY) * 0.78,
        rx - reflectionWidth * 0.52,
        height
      );
      ctx.lineTo(rx + reflectionWidth * 0.52, height);
      ctx.bezierCurveTo(
        rx + reflectionWidth * 0.7,
        horizonY + (height - horizonY) * 0.78,
        rx + reflectionWidth * 0.52,
        horizonY + (height - horizonY) * 0.5,
        rx + 7,
        horizonY
      );
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // ---------- (B) horizontal specular wavelets --------------------
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      const rippleRows = 24;
      for (let i = 0; i < rippleRows; i++) {
        const t = i / rippleRows;
        const y = horizonY + 5 + t * (height - horizonY - 5);
        const baseWidth = reflectionWidth * (0.07 + Math.pow(t, 0.72) * 0.98);
        const jitter = 1 + Math.sin(time * 1.4 + i * 0.72) * 0.14;
        const w = baseWidth * jitter;
        const alpha =
          (1 - t * 0.76) * (0.3 + Math.cos(time * 2.1 + i * 0.9) * 0.13);
        if (alpha <= 0) continue;
        ctx.strokeStyle = theme.water.shimmer;
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.lineWidth = 1 + (1 - t) * 1.7;
        ctx.shadowBlur = 9;
        ctx.shadowColor = theme.water.sun;
        ctx.beginPath();
        ctx.moveTo(rx - w / 2, y);
        ctx.lineTo(rx + w / 2, y);
        ctx.stroke();
      }
      ctx.restore();

      // ---------- (C) starfield --------------------------------------
      if (stars.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = theme.star;
        for (const s of stars) {
          const x = s.x * width;
          const y = s.y * height;
          const tw =
            (Math.sin(time * s.speed + s.phase) * 0.5 + 0.5) * s.twinkle;
          ctx.globalAlpha = tw;
          ctx.beginPath();
          ctx.arc(x, y, s.r, 0, Math.PI * 2);
          ctx.fill();
          if (s.r > 0.85 && tw > 0.62) {
            ctx.globalAlpha = tw * 0.35;
            ctx.fillRect(x - s.r * 5, y - 0.3, s.r * 10, 0.6);
            ctx.fillRect(x - 0.3, y - s.r * 5, 0.6, s.r * 10);
          }
        }
        ctx.restore();
      }

      // ---------- (D) weather particles ------------------------------
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
          ctx.strokeStyle = `rgba(186, 230, 253, ${0.5 * p.alpha})`;
          ctx.lineWidth = p.size;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + p.vx * 2000, y + p.vy * 2000);
          ctx.stroke();
        } else if (isSnow) {
          const pulse = p.size + Math.sin(time * 2 + p.phase) * 0.5;
          ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, pulse, 0, Math.PI * 2);
          ctx.fill();
        } else if (isMist) {
          ctx.fillStyle = `rgba(220, 230, 255, ${p.alpha * 0.35})`;
          ctx.beginPath();
          ctx.arc(x, y, p.size * 1.8, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.globalCompositeOperation = 'screen';
          ctx.fillStyle = theme.star;
          ctx.globalAlpha = p.alpha * 0.5;
          ctx.beginPath();
          ctx.arc(x, y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
          ctx.globalAlpha = 1;
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

  // ------------------------------------------------------------- ridges
  // Each ridge is a silhouette with a bright sun-catching rim, a dark
  // volumetric body and rising atmospheric haze at its foot.
  const ridgePaths = [
    'M0,208L80,168L164,194L262,148L360,198L462,158L560,204L664,174L780,208L882,164L1000,198L1102,168L1220,204L1322,178L1440,198L1440,320L0,320Z',
    'M0,148L102,198L220,138L322,208L420,168L540,224L662,178L780,234L900,194L1020,238L1140,204L1260,248L1360,218L1440,248L1440,320L0,320Z',
    'M0,88L120,148L240,108L360,178L480,138L600,208L720,158L840,224L960,178L1080,234L1200,194L1322,244L1440,208L1440,320L0,320Z',
  ];

  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden select-none z-0">
      {/* ============ 1. The base photograph ========================= */}
      <AnimatePresence mode="sync">
        <motion.div
          key={`scene-${scene}`}
          className="absolute inset-0"
          initial={{ opacity: 0, scale: 1.03 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.6, ease: 'easeInOut' }}
        >
          {/* Sky stratification: zenith -> horizon -> ground */}
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(180deg,
                ${theme.skyZenith} 0%,
                ${theme.skyHigh} 22%,
                ${theme.skyMid} 48%,
                ${theme.skyHorizon} 74%,
                ${theme.skyGround} 92%,
                ${theme.water.base} 100%)`,
            }}
          />

          {/* Slow breathing ambient wash */}
          <div
            className="absolute inset-0 animate-atmo-breathe"
            style={{ background: theme.ambient, mixBlendMode: 'soft-light' }}
          />

          {/* Wide horizon scatter (Rayleigh bleed near the light source) */}
          <div
            className="absolute inset-x-0"
            style={{
              top: '30%',
              height: '76%',
              background: `radial-gradient(62% 78% at 50% ${
                theme.celestial.type === 'sun' ? '48%' : '30%'
              }, ${theme.scatter} 0%, transparent 72%)`,
              mixBlendMode: 'screen',
            }}
          />

          {/* Volumetric clouds — three altitudes drifting at parallax speeds */}
          <div className="absolute inset-x-[-18%] top-[4%] h-[42%] animate-cloud-slow">
            <div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(58% 48% at 28% 58%, ${theme.cloud} 0%, transparent 66%),
                             radial-gradient(44% 38% at 66% 38%, ${theme.cloud} 0%, transparent 70%),
                             radial-gradient(34% 30% at 88% 68%, ${theme.cloud} 0%, transparent 70%)`,
                filter: 'blur(26px)',
                mixBlendMode: 'soft-light',
                opacity: 0.9,
              }}
            />
          </div>
          <div className="absolute inset-x-[-22%] top-[18%] h-[36%] animate-cloud-mid">
            <div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(50% 44% at 16% 58%, ${theme.cloud} 0%, transparent 70%),
                             radial-gradient(40% 34% at 50% 30%, ${theme.cloud} 0%, transparent 72%),
                             radial-gradient(30% 28% at 80% 64%, ${theme.cloud} 0%, transparent 70%)`,
                filter: 'blur(42px)',
                mixBlendMode: 'screen',
                opacity: 0.5,
              }}
            />
          </div>
          <div className="absolute inset-x-[-12%] top-[34%] h-[30%] animate-cloud-fast">
            <div
              className="absolute inset-0"
              style={{
                background: `radial-gradient(46% 34% at 22% 50%, ${theme.cloud} 0%, transparent 70%),
                             radial-gradient(38% 30% at 62% 60%, ${theme.cloud} 0%, transparent 70%)`,
                filter: 'blur(58px)',
                mixBlendMode: 'soft-light',
                opacity: 0.65,
              }}
            />
          </div>

          {/* ============ Sun / Moon with halation + lens flare ======== */}
          <div
            className="absolute left-1/2"
            style={{ top: theme.celestial.positionY }}
          >
            {/* Giant photographic halation */}
            <div
              className="absolute animate-flare-pulse"
              style={{
                width: '150vmin',
                height: '150vmin',
                left: 0,
                top: 0,
                transform: 'translate(-50%, -50%)',
                background: `radial-gradient(circle at center,
                  ${theme.celestial.bloom} 0%,
                  ${theme.celestial.halo} 20%,
                  transparent 56%)`,
                mixBlendMode: 'screen',
                filter: 'blur(6px)',
              }}
            />
            {/* Tight intense bloom around the disk */}
            <div
              className="absolute"
              style={{
                width: '46vmin',
                height: '46vmin',
                left: 0,
                top: 0,
                transform: 'translate(-50%, -50%)',
                background: `radial-gradient(circle at center,
                  ${theme.flare} 0%,
                  ${theme.celestial.halo} 28%,
                  transparent 68%)`,
                mixBlendMode: 'screen',
                filter: 'blur(3px)',
              }}
            />
            {/* Anisotropic horizontal flare streak */}
            <div
              className="absolute"
              style={{
                left: 0,
                top: 0,
                width: '170vmin',
                height: 5,
                transform: 'translate(-50%, -50%)',
                background: `linear-gradient(90deg, transparent 0%, ${theme.celestial.halo} 42%, ${theme.flare} 50%, ${theme.celestial.halo} 58%, transparent 100%)`,
                mixBlendMode: 'screen',
                filter: 'blur(4px)',
                opacity: 0.55,
              }}
            />
            {/* The disk — a shaded sphere, not a flat circle */}
            <div
              className="absolute rounded-full"
              style={{
                width: theme.celestial.size,
                height: theme.celestial.size,
                left: 0,
                top: 0,
                transform: 'translate(-50%, -50%)',
                background:
                  theme.celestial.type === 'moon'
                    ? `radial-gradient(circle at 38% 34%,
                        ${theme.celestial.core} 0%,
                        ${theme.celestial.rim} 58%,
                        #0d0a26 100%)`
                    : `radial-gradient(circle at 40% 36%,
                        #ffffff 0%,
                        ${theme.celestial.core} 30%,
                        ${theme.celestial.rim} 68%,
                        rgba(255, 170, 90, 0.55) 100%)`,
                boxShadow: `0 0 70px ${theme.celestial.bloom}, 0 0 150px ${theme.celestial.halo}`,
              }}
            >
              {/* Specular highlight on the body */}
              <div
                className="absolute rounded-full"
                style={{
                  inset: '12%',
                  background:
                    'radial-gradient(circle at 36% 30%, rgba(255,255,255,0.6), transparent 62%)',
                  mixBlendMode: 'screen',
                }}
              />
              {/* Lunar maria */}
              {theme.celestial.type === 'moon' && (
                <>
                  <span className="absolute rounded-full" style={{ width: 9, height: 9, left: '30%', top: '30%', background: 'rgba(120,110,180,0.30)' }} />
                  <span className="absolute rounded-full" style={{ width: 6, height: 6, left: '60%', top: '46%', background: 'rgba(120,110,180,0.26)' }} />
                  <span className="absolute rounded-full" style={{ width: 5, height: 5, left: '45%', top: '62%', background: 'rgba(120,110,180,0.22)' }} />
                  <span className="absolute rounded-full" style={{ width: 4, height: 4, left: '70%', top: '26%', background: 'rgba(120,110,180,0.20)' }} />
                </>
              )}
            </div>
          </div>

          {/* ============ Mountain ridges (atmospheric perspective) ==== */}
          {theme.ridges.map((r, i) => (
            <div
              key={`ridge-${scene}-${i}`}
              className="absolute inset-x-0 pointer-events-none"
              style={{
                bottom: `${26 - i * 5}%`,
                height: `${34 - i * 6}%`,
                zIndex: 10 + i,
              }}
            >
              <svg
                viewBox="0 0 1440 320"
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full"
              >
                <defs>
                  <linearGradient
                    id={`ridge-body-${scene}-${i}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={r.rim} stopOpacity="0.9" />
                    <stop offset="5%" stopColor={r.base} stopOpacity="0.86" />
                    <stop offset="45%" stopColor={r.base} stopOpacity="0.98" />
                    <stop offset="100%" stopColor={r.base} stopOpacity="1" />
                  </linearGradient>
                  {/* haze rising from the foot of the ridge -> depth */}
                  <linearGradient
                    id={`ridge-haze-${scene}-${i}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor={r.haze} stopOpacity="0" />
                    <stop offset="55%" stopColor={r.haze} stopOpacity="0.22" />
                    <stop offset="100%" stopColor={r.haze} stopOpacity="0.55" />
                  </linearGradient>
                  {/* directional light from the celestial body */}
                  <linearGradient
                    id={`ridge-light-${scene}-${i}`}
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="0"
                  >
                    <stop offset="0%" stopColor={r.haze} stopOpacity="0.05" />
                    <stop offset="50%" stopColor={r.rim} stopOpacity="0.28" />
                    <stop offset="100%" stopColor={r.haze} stopOpacity="0.05" />
                  </linearGradient>
                </defs>
                <path d={ridgePaths[i]} fill={`url(#ridge-body-${scene}-${i})`} />
                <path
                  d={ridgePaths[i]}
                  fill="none"
                  stroke={r.rim}
                  strokeWidth="1.25"
                  strokeOpacity="0.75"
                  vectorEffect="non-scaling-stroke"
                />
                <path
                  d={ridgePaths[i]}
                  fill={`url(#ridge-light-${scene}-${i})`}
                  style={{ mixBlendMode: 'screen' }}
                />
                <path d={ridgePaths[i]} fill={`url(#ridge-haze-${scene}-${i})`} />
              </svg>
            </div>
          ))}

          {/* ============ Water plane ================================== */}
          <div
            className="absolute inset-x-0 bottom-0"
            style={{ height: '34%', background: theme.water.base, zIndex: 14 }}
          >
            {/* depth shading */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'linear-gradient(180deg, rgba(255,255,255,0.06) 0%, rgba(0,0,0,0.45) 100%)',
                mixBlendMode: 'overlay',
              }}
            />
            {/* micro surface texture, slowly shimmering */}
            <div
              className="absolute inset-0 animate-water-shimmer"
              style={{
                background:
                  'repeating-linear-gradient(89deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 9px)',
                mixBlendMode: 'screen',
                opacity: 0.4,
              }}
            />
            {/* shoreline haze where water meets the near ridge */}
            <div
              className="absolute inset-x-0 top-0 h-24"
              style={{
                background: `linear-gradient(180deg, ${theme.ridges[2].haze} 0%, transparent 100%)`,
                mixBlendMode: 'screen',
                opacity: 0.6,
              }}
            />
          </div>
        </motion.div>
      </AnimatePresence>

      {/* ============ 2. Live canvas: water specular + sky + weather === */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 16 }}
      />

      {/* ============ 3. Photographic finishing passes ================= */}
      <div
        className="absolute inset-0 cine-vignette pointer-events-none"
        style={{ zIndex: 17, opacity: 0.85 }}
      />
      <div
        className="absolute inset-0 cine-grain pointer-events-none"
        style={{ zIndex: 18 }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          zIndex: 19,
          background:
            theme.exposure < 1
              ? `rgba(0, 0, 0, ${(1 - theme.exposure).toFixed(2)})`
              : 'rgba(255, 244, 226, 0.03)',
          mixBlendMode: theme.exposure < 1 ? 'multiply' : 'screen',
        }}
      />
    </div>
  );
}
