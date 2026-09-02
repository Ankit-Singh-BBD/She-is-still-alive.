/**
 * P23 — Background Atmosphere (M15)
 * Tests for BackgroundAtmosphere component
 *
 * Per Build Book Part XIX, Part XVIII.10-11, and Part XXVI.3.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import React from 'react';
import { BackgroundAtmosphere } from '@client/components/BackgroundAtmosphere.js';
import type { EnvironmentVisualState } from '@client/components/state/visual-state.js';

function createMockEnvironment(overrides: Partial<EnvironmentVisualState> = {}): EnvironmentVisualState {
  return {
    palette: {
      primary: '#0a0f1e',
      secondary: '#1a2a4a',
      accent: '#ff6b35',
    },
    lightingIntensity: 1.0,
    atmosphereColor: '#1a2a4a',
    timeOfDay: 'day',
    weather: 'clear',
    sunDirection: [0, 1, 0],
    sunColor: '#ffffff',
    fogDensity: 0.02,
    fogColor: '#88a0b8',
    ...overrides,
  };
}

// Mock ResizeObserver and requestAnimationFrame for jsdom
beforeEach(() => {
  // Polyfill ResizeObserver
  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };

  // Mock requestAnimationFrame / cancelAnimationFrame
  global.requestAnimationFrame = vi.fn((cb) => {
    return setTimeout(cb, 16) as unknown as number;
  });
  global.cancelAnimationFrame = vi.fn((id) => {
    clearTimeout(id);
  });

  // Mock canvas getContext
  HTMLCanvasElement.prototype.getContext = vi.fn((contextType: string) => {
    if (contextType === '2d') {
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        strokeRect: vi.fn(),
        beginPath: vi.fn(),
        arc: vi.fn(),
        fill: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        canvas: document.createElement('canvas'),
      } as unknown as CanvasRenderingContext2D;
    }
    return null;
  }) as any;

  // Mock canvas offsetWidth/offsetHeight
  Object.defineProperty(HTMLCanvasElement.prototype, 'offsetWidth', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'offsetHeight', {
    configurable: true,
    value: 600,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('P23 BackgroundAtmosphere Component (Part XIX, XVIII.10-11)', () => {
  describe('Palette Derivation from EnvironmentState', () => {
    it('uses derivedPalette.primary for skyTop gradient stop', () => {
      const env = createMockEnvironment({
        palette: { primary: '#123456', secondary: '#abcdef', accent: '#fedcba' },
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      expect(skyLayer).toBeTruthy();
      expect(skyLayer.style.background).toContain('#123456');
    });

    it('uses derivedPalette.secondary for skyMid gradient stop', () => {
      const env = createMockEnvironment({
        palette: { primary: '#111111', secondary: '#222222', accent: '#333333' },
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      expect(skyLayer.style.background).toContain('#222222');
    });

    it('uses derivedPalette.accent for horizon and water reflection', () => {
      const env = createMockEnvironment({
        palette: { primary: '#000000', secondary: '#111111', accent: '#ff9900' },
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const horizonLayer = container.querySelector('[data-testid="atmospheric-horizon"]') as HTMLElement;
      const waterLayer = container.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;
      const shimmerLayer = waterLayer.querySelector('div') as HTMLElement;

      expect(skyLayer.style.background).toContain('#ff9900');
      expect(horizonLayer.style.background).toContain('#ff9900');
      expect(shimmerLayer.style.background).toContain('#ff990044');
    });

    it('applies lightingIntensity to sky opacity and water reflection', () => {
      const envDay = createMockEnvironment({
        timeOfDay: 'day',
        lightingIntensity: 1.0,
      });
      const { container: containerDay } = render(<BackgroundAtmosphere environment={envDay} />);
      const skyDay = containerDay.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const waterDay = containerDay.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;

      // During day, lightingIntensity = 1.0, sky opacity should be 1.0 (Math.max(0.3, 1.0))
      expect(skyDay.style.opacity).toBe('1');

      // Water opacity should be Math.min(1.0, 1.0 + 0.2) = 1.0
      expect(waterDay.style.opacity).toBe('1');

      const envNight = createMockEnvironment({
        timeOfDay: 'night',
        lightingIntensity: 0.3,
      });
      const { container: containerNight } = render(<BackgroundAtmosphere environment={envNight} />);
      const skyNight = containerNight.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const waterNight = containerNight.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;

      // During night, lightingIntensity = 0.3, sky opacity should be 0.3 (Math.max(0.3, 0.3))
      expect(skyNight.style.opacity).toBe('0.3');

      // Water opacity should be Math.min(1.0, 0.3 + 0.2) = 0.5
      expect(waterNight.style.opacity).toBe('0.5');
    });
  });

  describe('Time-of-Day Transitions and Styling', () => {
    it('renders night gradient palette correctly', () => {
      const env = createMockEnvironment({
        timeOfDay: 'night',
        palette: { primary: '#050a18', secondary: '#0a1428', accent: '#1a3a5c' },
        lightingIntensity: 0.3,
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const horizonLayer = container.querySelector('[data-testid="atmospheric-horizon"]') as HTMLElement;
      const waterLayer = container.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;

      // Night sky: skyTop = primary, skyMid = secondary, horizon = accent with 44 alpha
      expect(skyLayer.style.background).toContain('#050a18');
      expect(skyLayer.style.background).toContain('#0a1428');
      expect(skyLayer.style.background).toContain('#1a3a5c44');

      // Night horizon haze
      expect(horizonLayer.style.background).toContain('rgba(10, 15, 30, 0.75)');

      // Night water: waterTop = primary + cc, waterBottom = #02040a
      expect(waterLayer.style.background).toContain('#050a18cc');
      expect(waterLayer.style.background).toContain('#02040a');
    });

    it('renders sunrise gradient palette correctly', () => {
      const env = createMockEnvironment({
        timeOfDay: 'sunrise',
        palette: { primary: '#2d1810', secondary: '#4a2c1a', accent: '#ff8844' },
        lightingIntensity: 0.7,
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const waterLayer = container.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;

      // Sunrise sky: accent at horizon
      expect(skyLayer.style.background).toContain('#ff8844');

      // Sunrise water: waterTop = accent + 88, waterBottom = primary + ee
      expect(waterLayer.style.background).toContain('#ff884488');
      expect(waterLayer.style.background).toContain('#2d1810ee');

      // Sunrise horizon haze
      const horizonLayer = container.querySelector('[data-testid="atmospheric-horizon"]') as HTMLElement;
      expect(horizonLayer.style.background).toContain('rgba(255, 180, 120, 0.25)');
    });

    it('renders sunset gradient palette correctly', () => {
      const env = createMockEnvironment({
        timeOfDay: 'sunset',
        palette: { primary: '#3d1a0d', secondary: '#5a2d15', accent: '#ff5522' },
        lightingIntensity: 0.7,
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const waterLayer = container.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;

      // Sunset sky: accent at horizon
      expect(skyLayer.style.background).toContain('#ff5522');

      // Sunset water: waterTop = accent + 99, waterBottom = primary + dd
      expect(waterLayer.style.background).toContain('#ff552299');
      expect(waterLayer.style.background).toContain('#3d1a0ddd');

      // Sunset horizon haze
      const horizonLayer = container.querySelector('[data-testid="atmospheric-horizon"]') as HTMLElement;
      expect(horizonLayer.style.background).toContain('rgba(255, 120, 80, 0.35)');
    });

    it('renders day gradient palette correctly', () => {
      const env = createMockEnvironment({
        timeOfDay: 'day',
        palette: { primary: '#0a1f3f', secondary: '#1a3a5c', accent: '#00aaff' },
        lightingIntensity: 1.0,
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const skyLayer = container.querySelector('[data-testid="atmospheric-sky"]') as HTMLElement;
      const waterLayer = container.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;

      // Day sky: accent at horizon
      expect(skyLayer.style.background).toContain('#00aaff');

      // Day water: waterTop = secondary + 99, waterBottom = primary + bb
      expect(waterLayer.style.background).toContain('#1a3a5c99');
      expect(waterLayer.style.background).toContain('#0a1f3fbb');

      // Day horizon haze
      const horizonLayer = container.querySelector('[data-testid="atmospheric-horizon"]') as HTMLElement;
      expect(horizonLayer.style.background).toContain('rgba(200, 220, 255, 0.2)');
    });

    it('transitions between timeOfDay with CSS transition styling', () => {
      const env = createMockEnvironment({ timeOfDay: 'day' });
      const { container, rerender } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      // Check transition styling is applied
      expect(root.style.transition).toContain('background 0.8s cubic-bezier(0.16, 1, 0.3, 1)');
      expect(root.style.transition).toContain('filter 0.8s ease-out');

      // Re-render with different timeOfDay
      rerender(<BackgroundAtmosphere environment={createMockEnvironment({ timeOfDay: 'sunset' })} />);
      expect(root.getAttribute('data-timeofday')).toBe('sunset');
    });

    it('applies timeOfDay and weather as data attributes', () => {
      const env = createMockEnvironment({
        timeOfDay: 'night',
        weather: 'stormy',
      });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-timeofday')).toBe('night');
      expect(root.getAttribute('data-weather')).toBe('stormy');
    });
  });

  describe('Particle System Selection', () => {
    it('selects snow particles when weather is snow', () => {
      const env = createMockEnvironment({ weather: 'snow' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('snow');
    });

    it('selects rain particles when weather is rainy', () => {
      const env = createMockEnvironment({ weather: 'rainy' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('rain');
    });

    it('selects rain particles when weather is stormy', () => {
      const env = createMockEnvironment({ weather: 'stormy' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('rain');
    });

    it('selects stardust particles when timeOfDay is night and weather is clear', () => {
      const env = createMockEnvironment({ timeOfDay: 'night', weather: 'clear' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('stardust');
    });

    it('selects embers particles when timeOfDay is sunset', () => {
      const env = createMockEnvironment({ timeOfDay: 'sunset', weather: 'clear' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('embers');
    });

    it('selects embers particles when timeOfDay is sunrise', () => {
      const env = createMockEnvironment({ timeOfDay: 'sunrise', weather: 'clear' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('embers');
    });

    it('selects pollen particles when timeOfDay is day and weather is clear', () => {
      const env = createMockEnvironment({ timeOfDay: 'day', weather: 'clear' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('pollen');
    });

    it('selects pollen particles when timeOfDay is day and weather is cloudy', () => {
      const env = createMockEnvironment({ timeOfDay: 'day', weather: 'cloudy' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('pollen');
    });

    it('selects pollen particles when timeOfDay is day and weather is fog', () => {
      const env = createMockEnvironment({ timeOfDay: 'day', weather: 'fog' });
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-particletype')).toBe('pollen');
    });
  });

  describe('Component Structure and Rendering', () => {
    it('renders all atmospheric layers in correct order', () => {
      const env = createMockEnvironment();
      const { container } = render(<BackgroundAtmosphere environment={env} />);

      const layers = [
        'atmospheric-sky',
        'atmospheric-horizon',
        'atmospheric-silhouette',
        'atmospheric-water-reflection',
        'atmospheric-particles',
      ];

      for (const layer of layers) {
        const el = container.querySelector(`[data-testid="${layer}"]`);
        expect(el).toBeTruthy();
      }
    });

    it('renders mountain silhouette with clipPath for depth cue', () => {
      const env = createMockEnvironment();
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const silhouette = container.querySelector('[data-testid="atmospheric-silhouette"]') as HTMLElement;

      expect(silhouette.style.clipPath).toContain('polygon');
      expect(silhouette.style.filter).toContain('blur(1.5px)');
      expect(silhouette.style.opacity).toBe('0.7');
    });

    it('renders water reflection with specular shimmer child', () => {
      const env = createMockEnvironment();
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const water = container.querySelector('[data-testid="atmospheric-water-reflection"]') as HTMLElement;
      const shimmer = water.querySelector('div') as HTMLElement;

      expect(shimmer).toBeTruthy();
      expect(shimmer.style.background).toContain('radial-gradient');
      expect(shimmer.style.filter).toContain('blur(16px)');
    });

    it('does not render canvas when enableParticles is false', () => {
      const env = createMockEnvironment();
      const { container } = render(
        <BackgroundAtmosphere environment={env} enableParticles={false} />
      );

      const canvas = container.querySelector('[data-testid="atmospheric-particles"]');
      expect(canvas).toBeFalsy();
    });

    it('renders canvas when enableParticles is true (default)', () => {
      const env = createMockEnvironment();
      const { container } = render(<BackgroundAtmosphere environment={env} />);

      const canvas = container.querySelector('[data-testid="atmospheric-particles"]');
      expect(canvas).toBeTruthy();
    });

    it('applies accessibility attributes correctly', () => {
      const env = createMockEnvironment();
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('role')).toBe('presentation');
      expect(root.getAttribute('aria-hidden')).toBe('true');
      expect(root.style.pointerEvents).toBe('none');
      expect(root.style.zIndex).toBe('0');
    });
  });

  describe('Component Lifecycle and Cleanup', () => {
    it('mounts without crashing', () => {
      const env = createMockEnvironment();
      const { container } = render(<BackgroundAtmosphere environment={env} />);
      expect(container).toBeTruthy();
    });

    it('unmounts cleanly and cancels animation frame', () => {
      const env = createMockEnvironment();
      const cancelSpy = vi.spyOn(global, 'cancelAnimationFrame');
      const { unmount } = render(<BackgroundAtmosphere environment={env} />);

      expect(cancelSpy).not.toHaveBeenCalled();
      unmount();
      expect(cancelSpy).toHaveBeenCalled();
    });

    it('removes resize listener on unmount', () => {
      const env = createMockEnvironment();
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      const { unmount } = render(<BackgroundAtmosphere environment={env} />);

      unmount();
      expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    });

    it('re-renders when environment props change', () => {
      const env = createMockEnvironment({ timeOfDay: 'day' });
      const { container, rerender } = render(<BackgroundAtmosphere environment={env} />);
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.getAttribute('data-timeofday')).toBe('day');

      const envNight = createMockEnvironment({ timeOfDay: 'night' });
      rerender(<BackgroundAtmosphere environment={envNight} />);
      expect(root.getAttribute('data-timeofday')).toBe('night');
    });

    it('applies custom className and style props', () => {
      const env = createMockEnvironment();
      const { container } = render(
        <BackgroundAtmosphere
          environment={env}
          className="custom-atmosphere"
          style={{ opacity: 0.5 }}
        />
      );
      const root = container.querySelector('[data-testid="background-atmosphere"]') as HTMLElement;

      expect(root.className).toContain('custom-atmosphere');
      expect(root.style.opacity).toBe('0.5');
    });
  });
});