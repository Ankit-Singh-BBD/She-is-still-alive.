import React, { useState } from 'react';
import type { VisualState } from '../state/visual-state.js';
import { useLiquidGlass, createGlassPaneStyle } from './liquid-glass.js';

export interface MobileSheetProps {
  visual: VisualState;
  activeRoute: string;
  onNavigate?: ((route: string) => void) | undefined;
}

export function MobileSheet(props: MobileSheetProps): React.JSX.Element {
  const { visual, activeRoute, onNavigate } = props;
  const [isOpen, setIsOpen] = useState(false);
  const glass = useLiquidGlass(visual.environment);

  return (
    <div
      data-testid="mobile-sheet"
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        width: '100%',
        height: isOpen ? '60vh' : '80px',
        background: glass.background,
        backdropFilter: glass.backdropBlur,
        WebkitBackdropFilter: glass.backdropBlur,
        borderTop: glass.border,
        borderTopLeftRadius: glass.borderRadiusLarge,
        borderTopRightRadius: glass.borderRadiusLarge,
        boxShadow: `0 -8px 32px rgba(0,0,0,0.35), inset 0 1px 0 ${glass.innerHighlight}`,
        transition: 'height 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
      }}
    >
      <div
        data-testid="mobile-sheet-handle"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '100%',
          height: '40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
        }}
      >
        <div style={{ width: '36px', height: '4px', borderRadius: '2px', background: glass.edgeHighlight }} />
      </div>

      <div style={{ flex: 1, padding: `0 ${glass.panelPadding}`, opacity: isOpen ? 1 : 0, transition: 'opacity 0.2s', overflowY: 'auto' }}>
        <h2 style={{ fontSize: '16px', color: glass.textPrimary, margin: '0 0 16px 0', textShadow: `0 2px 4px rgba(0,0,0,0.5)` }}>Nav</h2>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {[
            { id: '/', label: 'Center Stage' },
            { id: '/memory', label: 'Memory' },
            { id: '/tasks', label: 'Tasks' },
            { id: '/loops', label: 'Autonomous Loops' },
            { id: '/settings', label: 'Settings' },
          ].map(item => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onNavigate?.(item.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 16px',
                  borderRadius: glass.borderRadiusSmall,
                  border: activeRoute === item.id ? `1px solid ${glass.innerHighlight}` : '1px solid transparent',
                  background: activeRoute === item.id ? glass.hoverOverlay : 'transparent',
                  color: activeRoute === item.id ? glass.textPrimary : glass.textSecondary,
                  fontSize: '14px',
                  fontWeight: activeRoute === item.id ? 600 : 400,
                  transition: glass.transition,
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
