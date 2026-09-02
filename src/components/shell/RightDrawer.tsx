import React from 'react';
import type { RuntimeState } from '@server/realtime/types.js';
import type { VisualState } from '../state/visual-state.js';
import { useLiquidGlass, createGlassPaneStyle } from './liquid-glass.js';

export interface RightDrawerProps {
  visual: VisualState;
  state: RuntimeState;
}

export function RightDrawer(props: RightDrawerProps): React.JSX.Element {
  const { visual, state } = props;
  const glass = useLiquidGlass(visual.environment);

  const cardStyle = createGlassPaneStyle(glass, {
    elevated: false,
    rounded: 'small',
    padded: true,
  });

  return (
    <aside
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: glass.panelPadding,
        boxSizing: 'border-box',
      }}
    >
      <header style={{ marginBottom: '20px' }}>
        <h2
          style={{
            margin: 0,
            fontSize: '13px',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: glass.textPrimary,
            textShadow: `0 1px 4px ${glass.edgeHighlight}`,
          }}
        >
          Context
        </h2>
      </header>

      <section style={{ display: 'flex', flexDirection: 'column', gap: glass.panelGap, overflowY: 'auto' }}>
        {/* Environment Info */}
        <div
          data-testid="env-context-card"
          style={{
            ...cardStyle,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: glass.textMuted, marginBottom: '8px', letterSpacing: '0.05em' }}>
            Environment
          </div>
          <div style={{ fontSize: '13px', color: glass.textPrimary, lineHeight: 1.4 }}>
            Weather: <span style={{ textTransform: 'capitalize' }}>{state.environment.weather.condition}</span><br />
            Time: <span style={{ textTransform: 'capitalize' }}>{state.environment.timeOfDay}</span>
          </div>
          {/* Visual palette indicator */}
          <div style={{ display: 'flex', gap: '6px', marginTop: '12px' }}>
            <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: visual.environment.palette.primary, border: `1px solid ${glass.edgeHighlight}` }} />
            <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: visual.environment.palette.secondary, border: `1px solid ${glass.edgeHighlight}` }} />
            <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: visual.environment.palette.accent, border: `1px solid ${glass.edgeHighlight}`, boxShadow: `0 0 6px ${visual.environment.palette.accent}` }} />
          </div>
        </div>

        {/* Cognitive Info */}
        <div
          data-testid="cog-context-card"
          style={{
            ...cardStyle,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ fontSize: '11px', textTransform: 'uppercase', color: glass.textMuted, marginBottom: '8px', letterSpacing: '0.05em' }}>
            Cognition
          </div>
          <div style={{ fontSize: '13px', color: glass.textPrimary, lineHeight: 1.4 }}>
            Stage: <span style={{ fontWeight: 600 }}>{state.cognitive.currentStage}</span>
          </div>
          <div style={{ fontSize: '12px', color: glass.textSecondary, marginTop: '4px' }}>
            Pending Actions: {state.pendingActions.length}
          </div>
        </div>
      </section>
    </aside>
  );
}
