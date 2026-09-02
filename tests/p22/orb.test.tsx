/**
 * P22 — Orb R3F Finalization (M15)
 * Tests for MadhuritaOrb React Three Fiber implementation
 *
 * Per Build Book Part XVII, Part XVIII (Visual Architecture), and Part XXVI.3.
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { MadhuritaOrb } from '@client/components/MadhuritaOrb.js';
import type { OrbVisualState } from '@client/components/state/visual-state.js';

function createMockOrbState(overrides: Partial<OrbVisualState> = {}): OrbVisualState {
  return {
    baseColor: '#001f3f',
    emissionColor: '#ffdc00',
    energyLevel: 0.5,
    activityMode: 'idle',
    waveformAmplitude: 0.0,
    ior: 1.45,
    transmission: 0.92,
    thickness: 1.2,
    fresnelPower: 2.0,
    audioBands: { low: 0, mid: 0, high: 0 },
    voiceIntensity: 0,
    ...overrides,
  };
}

// Mock WebGL and WebGL2 contexts for jsdom environment
beforeEach(() => {
  // Mock ResizeObserver for R3F
  global.ResizeObserver = class ResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  };

  // Mock canvas getContext to avoid R3F crashing in jsdom
  HTMLCanvasElement.prototype.getContext = vi.fn((contextType: string) => {
    if (contextType === 'webgl' || contextType === 'webgl2' || contextType === 'experimental-webgl') {
      return {
        getExtension: vi.fn(),
        getParameter: vi.fn(() => 0),
        createTexture: vi.fn(),
        bindTexture: vi.fn(),
        texParameteri: vi.fn(),
        texImage2D: vi.fn(),
        clearColor: vi.fn(),
        clearDepth: vi.fn(),
        clear: vi.fn(),
        enable: vi.fn(),
        disable: vi.fn(),
        blendFunc: vi.fn(),
        viewport: vi.fn(),
        createShader: vi.fn(),
        shaderSource: vi.fn(),
        compileShader: vi.fn(),
        getShaderParameter: vi.fn(() => true),
        getShaderInfoLog: vi.fn(() => ''),
        createProgram: vi.fn(),
        attachShader: vi.fn(),
        linkProgram: vi.fn(),
        getProgramParameter: vi.fn(() => true),
        getProgramInfoLog: vi.fn(() => ''),
        useProgram: vi.fn(),
        createBuffer: vi.fn(),
        bindBuffer: vi.fn(),
        bufferData: vi.fn(),
        enableVertexAttribArray: vi.fn(),
        vertexAttribPointer: vi.fn(),
        drawArrays: vi.fn(),
        drawElements: vi.fn(),
        getUniformLocation: vi.fn(),
        uniform1f: vi.fn(),
        uniform2f: vi.fn(),
        uniform3f: vi.fn(),
        uniform4f: vi.fn(),
        uniformMatrix4fv: vi.fn(),
        canvas: document.createElement('canvas'),
      } as unknown as WebGLRenderingContext;
    }
    return null;
  }) as any;
});

afterEach(() => {
  cleanup();
});

describe('P22 MadhuritaOrb R3F Component (Part XVIII.19, XVIII.20)', () => {
  it('mounts without crashing in jsdom', () => {
    const visual = createMockOrbState();
    const { container } = render(<MadhuritaOrb visual={visual} />);
    expect(container).toBeTruthy();
  });

  it('renders the orb container with correct accessibility label', () => {
    const visual = createMockOrbState({ activityMode: 'listening' });
    const { getByRole } = render(<MadhuritaOrb visual={visual} />);
    const orb = getByRole('img');
    expect(orb.getAttribute('aria-label')).toBe('Madhurita orb: listening');
  });

  it('updates aria-label dynamically when activityMode changes', () => {
    const visual = createMockOrbState({ activityMode: 'speaking' });
    const { getByRole, rerender } = render(<MadhuritaOrb visual={visual} />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('Madhurita orb: speaking');

    rerender(<MadhuritaOrb visual={{ ...visual, activityMode: 'processing' }} />);
    expect(getByRole('img').getAttribute('aria-label')).toBe('Madhurita orb: processing');
  });

  it('unmounts cleanly without leaking references', () => {
    const visual = createMockOrbState();
    const { unmount } = render(<MadhuritaOrb visual={visual} />);
    expect(() => unmount()).not.toThrow();
  });

  it('renders with custom style and className props', () => {
    const visual = createMockOrbState();
    const { container } = render(
      <MadhuritaOrb
        visual={visual}
        className="custom-orb-class"
        style={{ opacity: 0.8 }}
      />
    );
    const orbDiv = container.firstChild as HTMLElement;
    expect(orbDiv.className).toContain('custom-orb-class');
    expect(orbDiv.style.opacity).toBe('0.8');
  });

  it('accepts audioAnalyser node without crashing', () => {
    const visual = createMockOrbState();
    const mockAnalyser = {
      frequencyBinCount: 128,
      getByteFrequencyData: vi.fn((array: Uint8Array) => {
        array.fill(128);
      }),
    } as unknown as AnalyserNode;

    const { container } = render(
      <MadhuritaOrb visual={visual} audioAnalyser={mockAnalyser} />
    );
    expect(container).toBeTruthy();
  });

  it('supports all 6 orb activity modes (Part XVIII.19)', () => {
    const modes: OrbVisualState['activityMode'][] = [
      'idle',
      'listening',
      'speaking',
      'processing',
      'error',
      'connecting',
    ];

    for (const mode of modes) {
      const visual = createMockOrbState({ activityMode: mode });
      const { getByRole, unmount } = render(<MadhuritaOrb visual={visual} />);
      expect(getByRole('img').getAttribute('aria-label')).toBe(`Madhurita orb: ${mode}`);
      unmount();
    }
  });

  it('handles zero energy and full energy boundary values', () => {
    const minEnergy = createMockOrbState({ energyLevel: 0.0, waveformAmplitude: 0.0 });
    const maxEnergy = createMockOrbState({ energyLevel: 1.0, waveformAmplitude: 1.0 });

    const { unmount: unmountMin } = render(<MadhuritaOrb visual={minEnergy} />);
    unmountMin();

    const { unmount: unmountMax } = render(<MadhuritaOrb visual={maxEnergy} />);
    unmountMax();
  });
});
