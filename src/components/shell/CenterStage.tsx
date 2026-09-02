import React, { useEffect, useState } from 'react';
import type { RuntimeState } from '@server/realtime/types.js';
import type { VisualState } from '../state/visual-state.js';
import { AudioReactiveController } from '../visual/AudioReactiveController.js';
import { CinematicScene } from '../visual/CinematicScene.js';
import type { ViewportMode } from './ShellLayout.js';
import { useLiquidGlass } from './liquid-glass.js';

export interface CenterStageProps {
  visual: VisualState;
  state: RuntimeState;
  audioAnalyser?: AnalyserNode | null;
  viewport?: ViewportMode;
}

export function CenterStage(props: CenterStageProps): React.JSX.Element {
  const { visual, state, audioAnalyser = null, viewport = 'desktop' } = props;
  const glass = useLiquidGlass(visual.environment);

  // Audio controller instance — kept outside React state to avoid allocations / re-renders
  const [audioController] = useState(() => new AudioReactiveController());

  useEffect(() => {
    // Only one analyser for now; in a real app, mic and TTS might be separate
    audioController.setMicAnalyser(audioAnalyser);
    audioController.setTtsAnalyser(null);
  }, [audioAnalyser, audioController]);

  // Snapshot poller
  const [snapshot, setSnapshot] = useState(() => audioController.update(0));
  const [time, setTime] = useState(0);

  useEffect(() => {
    let handle: number;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = (now - last) / 1000.0;
      last = now;
      setTime((t) => t + delta);
      // We do set state here to pass to the scene, but CinematicScene components
      // can read from it. In a fully optimized architecture, we'd pass a mutable ref to the scene
      // and read it inside useFrame. For simplicity + purity we'll use state at 60fps for now,
      // which React 18 concurrent can handle if lightweight.
      setSnapshot(audioController.update(delta));
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [audioController]);

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#02040a', // Baseline dark, cinematic scene covers this
        overflow: 'hidden',
      }}
    >
      {/* P23 Cinematic Scene (replaces legacy BackgroundAtmosphere + isolated MadhuritaOrb) */}
      <CinematicScene
        visual={visual}
        viewport={viewport}
        audio={snapshot}
        time={time}
      />

      {/* Optical Center: The Orb Container (Kept for tests / accessibility anchors) */}
      <div
        data-testid="orb-optical-center"
        aria-label="Madhurita visual representation"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '260px',
          height: '260px',
          pointerEvents: 'none',
          zIndex: 10,
        }}
      >
        <div data-testid="orb-mesh-container" style={{ width: '100%', height: '100%' }} />
      </div>

      {/* State Badge with Photographic Liquid Glass Shadows */}
      <footer
        style={{
          position: 'absolute',
          bottom: viewport === 'mobile' ? '120px' : '40px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
          zIndex: 20,
        }}
      >
        <span
          data-testid="stage-indicator"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: glass.chipPadding,
            borderRadius: glass.borderRadiusLarge,
            background: glass.background,
            border: glass.border,
            backdropFilter: glass.backdropBlur,
            WebkitBackdropFilter: glass.backdropBlur,
            boxShadow: glass.shadowElevated,
            fontSize: '12px',
            fontWeight: 500,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: glass.textOnGlass,
            textShadow: '0 1px 3px rgba(0,0,0,0.5)',
            position: 'relative',
            isolation: 'isolate',
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              backgroundColor: visual.orb.emissionColor,
              boxShadow: `0 0 10px ${visual.orb.emissionColor}, 0 0 4px ${visual.orb.emissionColor}`,
            }}
          />
          {state.voice.live !== 'disconnected' ? state.voice.live : state.cognitive.currentStage}
        </span>
      </footer>
    </div>
  );
}
