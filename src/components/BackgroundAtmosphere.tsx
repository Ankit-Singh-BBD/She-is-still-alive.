import React, { useEffect, useRef, useMemo, useState } from 'react';
import type { EnvironmentVisualState } from './state/visual-state.js';

export interface BackgroundAtmosphereProps {
  environment: EnvironmentVisualState;
  className?: string;
  style?: React.CSSProperties;
  enableParticles?: boolean;
}

interface Particle {
  x: number;
  y: number;
  size: number;
  speedX: number;
  speedY: number;
  opacity: number;
  fadeSpeed: number;
  color: string;
}

/**
 * Procedural & Photographic Background Atmosphere Component
 *
 * Implements Build Book Part XIX & Part XVIII.10-11 & Part XXII.2 (Particle Scaling):
 * - Dynamic photographic sky & atmospheric scattering layers driven by derivedPalette.
 * - Distance-based aerial perspective with horizon & subtle mountain silhouette.
 * - Synthesized lake water reflection plane responding to lighting intensity.
 * - Autonomous procedural particle system (stardust, snow, rain mist, embers, pollen) scaled down with reduced-motion.
 * - Smooth CSS / canvas transition interpolation between timeOfDay and weather shifts.
 */
export function BackgroundAtmosphere({
  environment,
  className = '',
  style = {},
  enableParticles = true,
}: BackgroundAtmosphereProps): React.JSX.Element {
  const { palette, lightingIntensity, timeOfDay, weather } = environment;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState<boolean>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }
    return false;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, []);

  // Compute atmospheric gradient stops from authoritative derivedPalette
  const atmosphericGradients = useMemo(() => {
    switch (timeOfDay) {
      case 'night':
        return {
          skyTop: palette.primary,
          skyMid: palette.secondary,
          horizon: `${palette.accent}44`,
          waterTop: `${palette.primary}cc`,
          waterBottom: '#02040a',
          haze: 'rgba(10, 15, 30, 0.75)',
        };
      case 'sunrise':
        return {
          skyTop: palette.primary,
          skyMid: palette.secondary,
          horizon: palette.accent,
          waterTop: `${palette.accent}88`,
          waterBottom: `${palette.primary}ee`,
          haze: 'rgba(255, 180, 120, 0.25)',
        };
      case 'sunset':
        return {
          skyTop: palette.primary,
          skyMid: palette.secondary,
          horizon: palette.accent,
          waterTop: `${palette.accent}99`,
          waterBottom: `${palette.primary}dd`,
          haze: 'rgba(255, 120, 80, 0.35)',
        };
      case 'day':
      default:
        return {
          skyTop: palette.primary,
          skyMid: palette.secondary,
          horizon: palette.accent,
          waterTop: `${palette.secondary}99`,
          waterBottom: `${palette.primary}bb`,
          haze: 'rgba(200, 220, 255, 0.2)',
        };
    }
  }, [timeOfDay, palette]);

  // Determine particle type based on timeOfDay and weather
  const particleType = useMemo(() => {
    if (weather === 'snow') return 'snow';
    if (weather === 'rainy' || weather === 'stormy') return 'rain';
    if (timeOfDay === 'night') return 'stardust';
    if (timeOfDay === 'sunset' || timeOfDay === 'sunrise') return 'embers';
    return 'pollen';
  }, [timeOfDay, weather]);

  // Procedural Canvas Particle Engine
  useEffect(() => {
    if (!enableParticles) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.offsetWidth || window.innerWidth || 800);
    let height = (canvas.height = canvas.offsetHeight || window.innerHeight || 600);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = canvas.offsetWidth || window.innerWidth || 800;
      height = canvas.height = canvas.offsetHeight || window.innerHeight || 600;
    };

    window.addEventListener('resize', handleResize);

    const baseCount = particleType === 'rain' ? 80 : particleType === 'snow' ? 50 : 35;
    // Scale particles down on prefers-reduced-motion (Part XXII.2)
    const particleCount = prefersReducedMotion ? Math.max(8, Math.floor(baseCount * 0.3)) : baseCount;
    const particles: Particle[] = [];

    const createParticle = (): Particle => {
      const isSnow = particleType === 'snow';
      const isRain = particleType === 'rain';
      const isStardust = particleType === 'stardust';
      const isEmbers = particleType === 'embers';

      let color = 'rgba(255, 255, 255, 0.8)';
      if (isEmbers) color = palette.accent;
      else if (isStardust) color = 'rgba(200, 230, 255, 0.9)';
      else if (isRain) color = 'rgba(180, 210, 255, 0.5)';

      const speedFactor = prefersReducedMotion ? 0.2 : 1.0;

      return {
        x: Math.random() * width,
        y: Math.random() * height,
        size: isSnow ? Math.random() * 3 + 1 : isRain ? Math.random() * 2 + 1 : isStardust ? Math.random() * 1.5 + 0.5 : Math.random() * 2 + 0.8,
        speedX: (isRain ? -1 - Math.random() * 0.5 : isSnow ? Math.sin(Math.random() * 6) * 0.5 : (Math.random() - 0.5) * 0.4) * speedFactor,
        speedY: (isRain ? Math.random() * 8 + 6 : isSnow ? Math.random() * 1.5 + 0.5 : isEmbers ? -Math.random() * 0.8 - 0.2 : (Math.random() - 0.5) * 0.3) * speedFactor,
        opacity: Math.random() * 0.6 + 0.2,
        fadeSpeed: (Math.random() * 0.008 + 0.002) * (Math.random() > 0.5 ? 1 : -1) * speedFactor,
        color,
      };
    };

    for (let i = 0; i < particleCount; i++) {
      particles.push(createParticle());
    }

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        if (!p) continue;

        p.x += p.speedX;
        p.y += p.speedY;
        p.opacity += p.fadeSpeed;

        if (p.opacity > 0.8 || p.opacity < 0.1) {
          p.fadeSpeed = -p.fadeSpeed;
        }

        // Boundary wrap
        if (p.y > height) p.y = 0;
        if (p.y < 0) p.y = height;
        if (p.x > width) p.x = 0;
        if (p.x < 0) p.x = width;

        ctx.fillStyle = p.color;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.opacity * lightingIntensity));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [particleType, palette.accent, lightingIntensity, enableParticles, prefersReducedMotion]);

  return (
    <div
      data-testid="background-atmosphere"
      data-timeofday={timeOfDay}
      data-weather={weather}
      data-particletype={particleType}
      role="presentation"
      aria-hidden="true"
      className={className}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 0,
        transition: 'background 0.8s cubic-bezier(0.16, 1, 0.3, 1), filter 0.8s ease-out',
        ...style,
      }}
    >
      {/* 1. Sky & Celestial Atmospheric Gradient */}
      <div
        data-testid="atmospheric-sky"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '65%',
          background: `linear-gradient(180deg, ${atmosphericGradients.skyTop} 0%, ${atmosphericGradients.skyMid} 60%, ${atmosphericGradients.horizon} 100%)`,
          opacity: Math.max(0.3, lightingIntensity),
          transition: 'background 0.8s ease-in-out, opacity 0.8s ease-in-out',
        }}
      />

      {/* 2. Horizon Glow & Atmospheric Haze Layer */}
      <div
        data-testid="atmospheric-horizon"
        style={{
          position: 'absolute',
          top: '40%',
          left: 0,
          width: '100%',
          height: '35%',
          background: `radial-gradient(ellipse at 50% 60%, ${atmosphericGradients.horizon} 0%, ${atmosphericGradients.haze} 45%, transparent 85%)`,
          filter: 'blur(30px)',
          opacity: 0.85,
          transition: 'background 0.8s ease-in-out',
        }}
      />

      {/* 3. Mountain Silhouette Layer (Photographic depth cue) */}
      <div
        data-testid="atmospheric-silhouette"
        style={{
          position: 'absolute',
          top: '48%',
          left: 0,
          width: '100%',
          height: '18%',
          background: `linear-gradient(180deg, transparent 0%, rgba(5, 8, 18, 0.4) 40%, rgba(3, 5, 12, 0.85) 100%)`,
          clipPath: 'polygon(0% 100%, 0% 70%, 15% 45%, 35% 65%, 50% 30%, 65% 55%, 85% 25%, 100% 60%, 100% 100%)',
          filter: 'blur(1.5px)',
          opacity: 0.7,
        }}
      />

      {/* 4. Synthesized Lake Water Reflection Horizon Plane */}
      <div
        data-testid="atmospheric-water-reflection"
        style={{
          position: 'absolute',
          top: '62%',
          left: 0,
          width: '100%',
          height: '38%',
          background: `linear-gradient(180deg, ${atmosphericGradients.waterTop} 0%, ${atmosphericGradients.waterBottom} 100%)`,
          opacity: Math.min(1.0, lightingIntensity + 0.2),
          transition: 'background 0.8s ease-in-out',
        }}
      >
        {/* Subtle Water Horizon Specular Shimmer */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: '25%',
            width: '50%',
            height: '40%',
            background: `radial-gradient(ellipse at 50% 0%, ${palette.accent}44 0%, transparent 70%)`,
            filter: 'blur(16px)',
            opacity: 0.6 * lightingIntensity,
          }}
        />
      </div>

      {/* 5. Procedural Canvas Particle Layer */}
      {enableParticles && (
        <canvas
          ref={canvasRef}
          data-testid="atmospheric-particles"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
        />
      )}
    </div>
  );
}
