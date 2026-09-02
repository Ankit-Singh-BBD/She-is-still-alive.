import React from 'react';
import type { RuntimeState } from '@server/realtime/types.js';
import { VisualStateMapper } from '../state/visual-mapper.js';
import { LeftRail } from './LeftRail.js';
import { CenterStage } from './CenterStage.js';
import { RightDrawer } from './RightDrawer.js';
import { MobileSheet } from './MobileSheet.js';
import { useLiquidGlass, createGlassPaneStyle } from './liquid-glass.js';

export type ViewportMode = 'desktop' | 'tablet' | 'mobile';

export interface ShellLayoutProps {
  state: RuntimeState;
  viewport: ViewportMode;
  onNavigate?: (target: string) => void;
  activeRoute?: string;
}

export function ShellLayout(props: ShellLayoutProps): React.JSX.Element {
  const visual = VisualStateMapper.map(props.state);
  const glass = useLiquidGlass(visual.environment);

  // Liquid Glass panel style for side rails
  const railStyle = createGlassPaneStyle(glass, { elevated: true, rounded: 'large', padded: false });
  const centerStyle = createGlassPaneStyle(glass, { elevated: false, rounded: 'large', padded: false });

  if (props.viewport === 'mobile') {
    return (
      <main
        data-testid="shell-root"
        data-viewport="mobile"
        style={{
          position: 'relative',
          width: '100vw',
          height: '100vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <CenterStage visual={visual} state={props.state} viewport={props.viewport} />
        <MobileSheet visual={visual} onNavigate={props.onNavigate} activeRoute={props.activeRoute ?? '/'} />
      </main>
    );
  }

  return (
    <main
      data-testid="shell-root"
      data-viewport={props.viewport}
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: 'minmax(240px, 280px) 1fr minmax(280px, 360px)',
        gridTemplateRows: '1fr',
        gap: glass.panelGap,
        padding: glass.panelGap,
        boxSizing: 'border-box',
      }}
    >
      <aside data-testid="left-rail" style={{ ...railStyle, overflow: 'hidden' }}>
        <LeftRail onNavigate={props.onNavigate} activeRoute={props.activeRoute ?? '/'} />
      </aside>
      <section data-testid="center-stage" style={{ ...centerStyle, overflow: 'hidden' }}>
        <CenterStage visual={visual} state={props.state} viewport={props.viewport} />
      </section>
      <aside data-testid="right-drawer" style={{ ...railStyle, overflow: 'hidden' }}>
        <RightDrawer visual={visual} state={props.state} />
      </aside>
    </main>
  );
}
