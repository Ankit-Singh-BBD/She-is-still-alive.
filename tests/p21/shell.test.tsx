/**
 * P21 — UI Shell Refactor (M15)
 * Tests for VisualStateMapper and Shell layout components
 *
 * Per Build Book Part XVII (UI Shell) and Part XVIII (Visual Architecture).
 */

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { VisualStateMapper } from '@client/components/state/visual-mapper.js';
import { ShellLayout } from '@client/components/shell/ShellLayout.js';
import { CenterStage } from '@client/components/shell/CenterStage.js';
import { RightDrawer } from '@client/components/shell/RightDrawer.js';
import { LeftRail } from '@client/components/shell/LeftRail.js';
import { MobileSheet } from '@client/components/shell/MobileSheet.js';
import type { RuntimeState } from '@server/realtime/types.js';

function createInitialState(): RuntimeState {
  return {
    version: 1,
    identity: {
      id: 'owner-1',
      kind: 'owner',
      displayName: 'Ankit',
      enrolledAt: 0,
      lastSeenAt: 0,
      status: 'active',
    },
    presence: {
      activeActor: 'owner-1',
      recentActors: ['owner-1'],
      sessionStartedAt: 0,
    },
    environment: {
      timeOfDay: 'day',
      weather: { condition: 'clear' },
      location: { lat: 0, lng: 0 },
      derivedPalette: { primary: '#001f3f', secondary: '#39cccc', accent: '#ffdc00' },
    },
    cognitive: {
      currentStage: 'PERCEIVE',
      cycleId: 'cycle-1',
      cycleStartedAt: 0,
      lastCompletedStage: 'PERSIST',
      attention: {},
    },
    voice: {
      live: 'disconnected',
      energy: 0,
      ttsEnergy: 0,
      frequencyBands: [],
      voiceId: 'madhurita-1',
    },
    memory: {
      episodicCount: 0,
      semanticCount: 0,
      preferenceCount: 0,
      habitCount: 0,
      relationshipCount: 0,
      learnedPatternCount: 0,
      lastConsolidationAt: 0,
    },
    loops: { activeCount: 0, pausedCount: 0 },
    tasks: { pendingCount: 0, runningCount: 0, failedCount: 0 },
    pendingActions: [],
    lastMutation: { eventId: '', type: '', timestamp: 0 },
  };
}

describe('P21 VisualStateMapper (Part XVIII.12, XVIII.19)', () => {
  it('is a pure function — same input yields equal output', () => {
    const s1 = createInitialState();
    const s2 = createInitialState();
    const v1 = VisualStateMapper.map(s1);
    const v2 = VisualStateMapper.map(s2);
    expect(v1).toEqual(v2);
  });

  it('derives orb baseColor from environment palette, not a hardcoded value', () => {
    const s = createInitialState();
    s.environment.derivedPalette = { primary: '#abcdef', secondary: '#123456', accent: '#fedcba' };
    const v = VisualStateMapper.map(s);
    expect(v.orb.baseColor).toBe('#abcdef');
  });

  it('emits #ff3333 emission when voice is in error state', () => {
    const s = createInitialState();
    s.voice.live = 'error';
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('error');
    expect(v.orb.emissionColor).toBe('#ff3333');
  });

  it('emits secondary palette when in processing (thinking) state', () => {
    const s = createInitialState();
    s.voice.live = 'thinking';
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('processing');
    expect(v.orb.emissionColor).toBe(s.environment.derivedPalette.secondary);
  });

  it('uses speaking palette behavior at >0 audio energy', () => {
    const s = createInitialState();
    s.voice.live = 'speaking';
    s.voice.ttsEnergy = 0.6;
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('speaking');
    expect(v.orb.waveformAmplitude).toBe(0.6);
    expect(v.orb.energyLevel).toBeCloseTo(0.9, 2);
  });

  it('clamps energyLevel at 1.0', () => {
    const s = createInitialState();
    s.voice.live = 'speaking';
    s.voice.energy = 1.0;
    s.voice.ttsEnergy = 1.0;
    const v = VisualStateMapper.map(s);
    expect(v.orb.energyLevel).toBeLessThanOrEqual(1.0);
  });

  it('night environment darkens lighting intensity', () => {
    const s = createInitialState();
    s.environment.timeOfDay = 'night';
    const v = VisualStateMapper.map(s);
    expect(v.environment.lightingIntensity).toBe(0.3);
  });

  it('sunset/sunrise reduces lighting intensity', () => {
    const s = createInitialState();
    s.environment.timeOfDay = 'sunset';
    const v = VisualStateMapper.map(s);
    expect(v.environment.lightingIntensity).toBe(0.7);
  });

  it('stormy/rainy/fog further reduces lighting intensity', () => {
    const s = createInitialState();
    s.environment.timeOfDay = 'day';
    s.environment.weather.condition = 'stormy';
    const v = VisualStateMapper.map(s);
    expect(v.environment.lightingIntensity).toBe(0.6);
  });

  it('idles when voice disconnected and cognitive at PERCEIVE', () => {
    const s = createInitialState();
    s.voice.live = 'disconnected';
    s.cognitive.currentStage = 'PERCEIVE';
    s.cognitive.cycleStartedAt = 0;
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('idle');
  });

  it('falls back to cognitive stage when voice is disconnected and cognition is active', () => {
    const s = createInitialState();
    s.voice.live = 'disconnected';
    s.cognitive.currentStage = 'REASON';
    s.cognitive.cycleStartedAt = 1;
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('processing');
  });

  it('listening voice state produces listening activity mode', () => {
    const s = createInitialState();
    s.voice.live = 'listening';
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('listening');
  });

  it('connecting voice state produces connecting activity mode', () => {
    const s = createInitialState();
    s.voice.live = 'connecting';
    const v = VisualStateMapper.map(s);
    expect(v.orb.activityMode).toBe('connecting');
  });

  it('ui glassOpacity is 0.8 at night vs 0.6 daytime', () => {
    const day = createInitialState();
    day.environment.timeOfDay = 'day';
    expect(VisualStateMapper.map(day).ui.glassOpacity).toBe(0.6);

    const night = createInitialState();
    night.environment.timeOfDay = 'night';
    expect(VisualStateMapper.map(night).ui.glassOpacity).toBe(0.8);
  });

  it('passes through timeOfDay unchanged in environment visual state', () => {
    const s = createInitialState();
    s.environment.timeOfDay = 'sunrise';
    const v = VisualStateMapper.map(s);
    expect(v.environment.timeOfDay).toBe('sunrise');
  });

  it('VisualState object has orb, environment, ui sub-shapes', () => {
    const s = createInitialState();
    const v = VisualStateMapper.map(s);
    expect(v).toHaveProperty('orb');
    expect(v).toHaveProperty('environment');
    expect(v).toHaveProperty('ui');
  });
});

describe('P21 ShellLayout (Part XVII.2, XVII.4)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders three columns on desktop', () => {
    const state = createInitialState();
    render(<ShellLayout state={state} viewport="desktop" />);
    expect(screen.getByTestId('left-rail')).toBeTruthy();
    expect(screen.getByTestId('center-stage')).toBeTruthy();
    expect(screen.getByTestId('right-drawer')).toBeTruthy();
  });

  it('collapses to single column + mobile sheet on mobile', () => {
    const state = createInitialState();
    render(<ShellLayout state={state} viewport="mobile" />);
    expect(screen.getByTestId('mobile-sheet')).toBeTruthy();
    expect(screen.queryByTestId('left-rail')).toBeNull();
    expect(screen.queryByTestId('right-drawer')).toBeNull();
  });

  it('marks data-viewport on root correctly', () => {
    const state = createInitialState();
    const { rerender } = render(<ShellLayout state={state} viewport="desktop" />);
    expect(screen.getByTestId('shell-root').getAttribute('data-viewport')).toBe('desktop');
    rerender(<ShellLayout state={state} viewport="mobile" />);
    expect(screen.getByTestId('shell-root').getAttribute('data-viewport')).toBe('mobile');
  });
});

describe('P21 CenterStage (Part XVII, XVIII.21)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders the orb optical center', () => {
    const state = createInitialState();
    const visual = VisualStateMapper.map(state);
    render(<CenterStage visual={visual} state={state} />);
    expect(screen.getByTestId('orb-optical-center')).toBeTruthy();
    expect(screen.getByTestId('orb-mesh-container')).toBeTruthy();
  });

  it('shows voice live state when not disconnected', () => {
    const state = createInitialState();
    state.voice.live = 'speaking';
    const visual = VisualStateMapper.map(state);
    render(<CenterStage visual={visual} state={state} />);
    const indicator = screen.getByTestId('stage-indicator');
    expect(indicator.textContent).toContain('speaking');
  });

  it('falls back to cognitive stage label when voice is disconnected', () => {
    const state = createInitialState();
    state.voice.live = 'disconnected';
    state.cognitive.currentStage = 'REASON';
    const visual = VisualStateMapper.map(state);
    render(<CenterStage visual={visual} state={state} />);
    const indicator = screen.getByTestId('stage-indicator');
    expect(indicator.textContent).toContain('REASON');
  });
});

describe('P21 RightDrawer (Context Panel)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders environment and cognition cards', () => {
    const state = createInitialState();
    const visual = VisualStateMapper.map(state);
    render(<RightDrawer visual={visual} state={state} />);
    expect(screen.getByTestId('env-context-card')).toBeTruthy();
    expect(screen.getByTestId('cog-context-card')).toBeTruthy();
  });

  it('displays current weather condition', () => {
    const state = createInitialState();
    state.environment.weather.condition = 'stormy';
    const visual = VisualStateMapper.map(state);
    render(<RightDrawer visual={visual} state={state} />);
    const envCard = screen.getByTestId('env-context-card');
    expect(envCard.textContent).toContain('stormy');
  });
});

describe('P21 LeftRail (Navigation)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('renders nav buttons for each route', () => {
    const onNavigate = vi.fn();
    render(<LeftRail activeRoute="/" onNavigate={onNavigate} />);
    expect(screen.getAllByRole('button').length).toBeGreaterThanOrEqual(5);
  });

  it('invokes onNavigate with route when a button is clicked', () => {
    const onNavigate = vi.fn();
    render(<LeftRail activeRoute="/" onNavigate={onNavigate} />);
    const memoryBtn = screen.getByRole('button', { name: /Memory/i });
    fireEvent.click(memoryBtn);
    expect(onNavigate).toHaveBeenCalledWith('/memory');
  });

  it('marks active route button visually', () => {
    render(<LeftRail activeRoute="/tasks" />);
    const activeBtn = screen.getByRole('button', { name: /Tasks/i }) as HTMLButtonElement;
    expect(activeBtn.style.background).not.toBe('transparent');
  });
});

describe('P21 MobileSheet (Responsive Layout)', () => {
  beforeEach(() => {
    cleanup();
  });

  it('starts in collapsed state', () => {
    const state = createInitialState();
    const visual = VisualStateMapper.map(state);
    render(<MobileSheet visual={visual} activeRoute="/" />);
    const sheet = screen.getByTestId('mobile-sheet') as HTMLElement;
    expect(sheet.style.height).toBe('80px');
  });

  it('expands on handle click', () => {
    const state = createInitialState();
    const visual = VisualStateMapper.map(state);
    render(<MobileSheet visual={visual} activeRoute="/" />);
    const handle = screen.getByTestId('mobile-sheet-handle');
    fireEvent.click(handle);
    const sheet = screen.getByTestId('mobile-sheet') as HTMLElement;
    expect(sheet.style.height).toBe('60vh');
  });
});

describe('P21 VisualState Architectural Authority (XVIII.0, XVIII.20)', () => {
  it('mapper does not mutate its input state', () => {
    const s = createInitialState();
    const beforeVersion = s.version;
    const beforeVoice = s.voice.live;
    VisualStateMapper.map(s);
    expect(s.version).toBe(beforeVersion);
    expect(s.voice.live).toBe(beforeVoice);
  });

  it('returns fresh visual objects on each call (no shared state)', () => {
    const s = createInitialState();
    const a = VisualStateMapper.map(s);
    const b = VisualStateMapper.map(s);
    expect(a).not.toBe(b);
    expect(a.orb).not.toBe(b.orb);
  });
});
