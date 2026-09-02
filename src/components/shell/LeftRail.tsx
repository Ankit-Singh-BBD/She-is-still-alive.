import React from 'react';
import type { VisualState, EnvironmentVisualState } from '../state/visual-state.js';
import { useLiquidGlass, createGlassInteractionStyles } from './liquid-glass.js';

export interface LeftRailProps {
  activeRoute: string;
  onNavigate?: ((route: string) => void) | undefined;
  visual?: VisualState;
  environment?: EnvironmentVisualState;
}

const NAV_ITEMS = [
  { id: '/', label: 'Center Stage' },
  { id: '/memory', label: 'Memory' },
  { id: '/tasks', label: 'Tasks' },
  { id: '/loops', label: 'Autonomous Loops' },
  { id: '/settings', label: 'Settings' },
];

const DEFAULT_ENV: EnvironmentVisualState = {
  palette: { primary: '#080c18', secondary: '#1c2842', accent: '#60a5fa' },
  lightingIntensity: 1.0,
  atmosphereColor: '#1c2842',
  timeOfDay: 'day',
  weather: 'clear',
  sunDirection: [2, 5, 2],
  sunColor: '#fff5e6',
  fogDensity: 0.015,
  fogColor: '#1c2842',
};

export function LeftRail(props: LeftRailProps): React.JSX.Element {
  const env = props.visual?.environment ?? props.environment ?? DEFAULT_ENV;
  const glass = useLiquidGlass(env);

  return (
    <nav
      aria-label="Primary Navigation"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: glass.panelPadding,
        boxSizing: 'border-box',
      }}
    >
      <header style={{ marginBottom: '28px', paddingLeft: '8px' }}>
        <h1
          style={{
            margin: 0,
            fontSize: '18px',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: glass.textPrimary,
            textShadow: `0 2px 8px ${glass.edgeHighlight}`,
          }}
        >
          Madhurita
        </h1>
        <span
          style={{
            fontSize: '11px',
            color: glass.textMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          Autonomous Entity
        </span>
      </header>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {NAV_ITEMS.map((item) => {
          const isActive = props.activeRoute === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-route={item.id}
                onClick={() => props.onNavigate?.(item.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 16px',
                  borderRadius: glass.borderRadiusSmall,
                  border: isActive ? `1px solid ${glass.edgeHighlight}` : '1px solid transparent',
                  background: isActive ? glass.hoverOverlay : 'transparent',
                  color: isActive ? glass.textPrimary : glass.textSecondary,
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '14px',
                  cursor: 'pointer',
                  transition: glass.transition,
                  boxShadow: isActive ? `${glass.shadow}, 0 0 12px ${glass.innerHighlight}` : 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                {isActive && (
                  <span
                    style={{
                      width: '4px',
                      height: '14px',
                      borderRadius: '2px',
                      backgroundColor: env.palette.accent,
                      boxShadow: `0 0 8px ${env.palette.accent}`,
                    }}
                  />
                )}
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
