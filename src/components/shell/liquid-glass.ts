import type { EnvironmentVisualState } from '../state/visual-state.js';

/**
 * Liquid Glass Material System
 * Part XVII + XVIII — Unified glass material language derived from EnvironmentVisualState
 *
 * One shared material definition for all UI chrome:
 * - left rail
 * - right drawer
 * - memory panel
 * - tasks panel
 * - search panel
 * - calendar panel
 * - settings panel
 * - identity panel
 * - mobile sheets
 * - composer/input
 * - quick action chips
 * - buttons
 * - status pills
 * - action controls
 * - confirmation sheets
 * - floating tool/action elements
 */

// ──────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT-AWARE TINT DERIVATION
// ──────────────────────────────────────────────────────────────────────────────

interface GlassTint {
  /** Subtle background tint from environment palette */
  backgroundTint: string;
  /** Edge highlight color */
  edgeHighlight: string;
  /** Border color */
  borderColor: string;
  /** Inner surface highlight */
  innerHighlight: string;
  /** Shadow color */
  shadowColor: string;
  /** Soft reflection color */
  reflectionColor: string;
}

/**
 * Derives glass tint from authoritative EnvironmentVisualState.
 * No hardcoded themes — uses timeOfDay, weather, palette to compute.
 */
export function deriveGlassTint(env: EnvironmentVisualState): GlassTint {
  const { timeOfDay, palette, weather, lightingIntensity } = env;

  // Base opacity derived from lighting intensity
  // Thinner, more translucent glass for cinematic feel
  const baseAlpha = Math.max(0.02, Math.min(0.08, lightingIntensity * 0.06));
  const highlightAlpha = Math.max(0.02, Math.min(0.06, lightingIntensity * 0.05));
  const edgeAlpha = Math.max(0.04, Math.min(0.12, lightingIntensity * 0.08));

  // Weather modulation
  const isOvercast = weather === 'stormy' || weather === 'rainy' || weather === 'fog' || weather === 'snow';
  const weatherMul = isOvercast ? 0.7 : 1.0;

  // Time-of-day tint derivation from palette
  let tintHue: number;
  let tintSat: number;
  let tintLight: number;

  switch (timeOfDay) {
    case 'night': {
      // Cool indigo/blue from primary + secondary
      const c = hexToHsl(palette.primary);
      tintHue = c.h;
      tintSat = Math.min(0.35, c.s * 0.5);
      tintLight = Math.max(0.08, c.l * 0.3);
      break;
    }
    case 'sunrise': {
      // Warm peach/gold from accent
      const c = hexToHsl(palette.accent);
      tintHue = c.h;
      tintSat = Math.min(0.25, c.s * 0.4);
      tintLight = Math.min(0.92, c.l * 1.1);
      break;
    }
    case 'sunset': {
      // Warm amber/orange from accent
      const c = hexToHsl(palette.accent);
      tintHue = c.h;
      tintSat = Math.min(0.3, c.s * 0.5);
      tintLight = Math.min(0.85, c.l * 0.9);
      break;
    }
    default: { // day
      // Clean neutral/cyan from secondary
      const c = hexToHsl(palette.secondary);
      tintHue = c.h;
      tintSat = Math.min(0.15, c.s * 0.3);
      tintLight = Math.min(0.95, c.l * 1.05);
      break;
    }
  }

  // Apply weather modulation
  tintSat *= weatherMul;
  tintLight *= weatherMul;

  const tintColor = `hsla(${Math.round(tintHue)}, ${Math.round(tintSat * 100)}%, ${Math.round(tintLight * 100)}%, ${baseAlpha})`;
  const edgeColor = `hsla(${Math.round(tintHue)}, ${Math.round(tintSat * 100)}%, ${Math.round(Math.min(1, tintLight * 2.0) * 100)}%, ${edgeAlpha})`;
  const highlightColor = `hsla(${Math.round(tintHue)}, ${Math.round(tintSat * 100)}%, ${Math.round(Math.min(1, tintLight * 1.8) * 100)}%, ${highlightAlpha})`;
  const innerColor = `hsla(${Math.round(tintHue)}, ${Math.round(Math.max(0, tintSat * 0.5) * 100)}%, ${Math.round(Math.min(1, tintLight * 2.0) * 100)}%, ${Math.max(0.015, highlightAlpha * 0.8)})`;
  const shadowColor = `rgba(0, 0, 0, ${Math.min(0.6, 0.15 + lightingIntensity * 0.25)})`;
  const reflectionColor = `hsla(${Math.round(tintHue)}, ${Math.round(tintSat * 100)}%, ${Math.round(Math.min(1, tintLight * 1.5) * 100)}%, ${Math.max(0.015, highlightAlpha * 0.5)})`;

  return {
    backgroundTint: tintColor,
    edgeHighlight: edgeColor,
    borderColor: edgeColor,
    innerHighlight: innerColor,
    shadowColor,
    reflectionColor,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// GLASS MATERIAL TOKENS
// ──────────────────────────────────────────────────────────────────────────────

export interface LiquidGlassTokens {
  // Surface
  background: string;
  backdropBlur: string;
  backdropSaturation: string;

  // Borders & Edges
  border: string;
  borderWidth: string;
  borderRadius: string;
  borderRadiusLarge: string;
  borderRadiusSmall: string;

  // Highlights
  edgeHighlight: string;
  innerHighlight: string;

  // Depth
  shadow: string;
  shadowElevated: string;
  reflection: string;

  // Interaction states
  hoverOverlay: string;
  activeOverlay: string;
  focusRing: string;
  disabledOpacity: number;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textOnGlass: string;

  // Component-specific
  panelPadding: string;
  panelGap: string;
  controlHeight: string;
  controlPadding: string;
  chipPadding: string;
  transition: string;
  transitionSpring: string;

  // Z-index layers
  zBase: number;
  zRaised: number;
  zOverlay: number;
  zModal: number;
}

/**
 * Generates complete Liquid Glass token set from environment state.
 */
export function createLiquidGlassTokens(env: EnvironmentVisualState): LiquidGlassTokens {
  const tint = deriveGlassTint(env);
  const isNight = env.timeOfDay === 'night';
  const isLowLight = env.lightingIntensity < 0.5;

  return {
    // Surface — thin, translucent, environment-aware
    background: tint.backgroundTint,
    backdropBlur: 'blur(24px) saturate(140%)',
    backdropSaturation: 'saturate(140%)',

    // Borders — hairline, variable brightness
    border: `1px solid ${tint.borderColor}`,
    borderWidth: '1px',
    borderRadius: '16px',
    borderRadiusLarge: '24px',
    borderRadiusSmall: '10px',

    // Highlights — subtle, asymmetric
    edgeHighlight: tint.edgeHighlight,
    innerHighlight: tint.innerHighlight,

    // Depth — restrained, layered with refined diffusion
    shadow: `0 2px 16px ${tint.shadowColor}, inset 0 1px 0 ${tint.innerHighlight}`,
    shadowElevated: `0 8px 32px ${tint.shadowColor}, inset 0 1px 0 ${tint.innerHighlight}, 0 0 0 1px ${tint.edgeHighlight}`,
    reflection: `linear-gradient(180deg, ${tint.reflectionColor} 0%, transparent 70%)`,

    // Interaction — glass-like physical response
    hoverOverlay: `hsla(0, 0%, 100%, ${isLowLight ? 0.04 : 0.03})`,
    activeOverlay: `hsla(0, 0%, 0%, ${isLowLight ? 0.06 : 0.04})`,
    focusRing: `0 0 0 2px ${tint.edgeHighlight}, 0 0 8px ${tint.reflectionColor}`,
    disabledOpacity: 0.45,

    // Text — adaptive contrast
    textPrimary: 'rgba(255, 255, 255, 0.95)',
    textSecondary: 'rgba(255, 255, 255, 0.7)',
    textMuted: 'rgba(255, 255, 255, 0.45)',
    textOnGlass: isNight ? 'rgba(255, 255, 255, 0.92)' : 'rgba(255, 255, 255, 0.88)',

    // Layout
    panelPadding: '20px',
    panelGap: '16px',
    controlHeight: '40px',
    controlPadding: '0 16px',
    chipPadding: '8px 14px',
    transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
    transitionSpring: 'all 0.35s cubic-bezier(0.16, 1, 0.3, 1)',

    // Z-layers
    zBase: 10,
    zRaised: 20,
    zOverlay: 100,
    zModal: 200,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// HOOK FOR REACT COMPONENTS
// ──────────────────────────────────────────────────────────────────────────────

import { useMemo } from 'react';

/**
 * React hook to access Liquid Glass tokens derived from VisualState.
 * Recomputes only when environment changes.
 */
export function useLiquidGlass(env: EnvironmentVisualState): LiquidGlassTokens {
  return useMemo(() => createLiquidGlassTokens(env), [
    env.timeOfDay,
    env.weather,
    env.lightingIntensity,
    env.palette.primary,
    env.palette.secondary,
    env.palette.accent,
  ]);
}

// ──────────────────────────────────────────────────────────────────────────────
// BASE GLASS PANE STYLE FACTORY
// ──────────────────────────────────────────────────────────────────────────────

export interface GlassPaneOptions {
  elevated?: boolean;
  padded?: boolean;
  rounded?: 'small' | 'medium' | 'large';
  interactive?: boolean;
  disabled?: boolean;
}

export function createGlassPaneStyle(
  tokens: LiquidGlassTokens,
  options: GlassPaneOptions = {}
): React.CSSProperties {
  const { elevated = false, padded = true, rounded = 'medium', interactive = false, disabled = false } = options;

  const radius = rounded === 'small' ? tokens.borderRadiusSmall
    : rounded === 'large' ? tokens.borderRadiusLarge
    : tokens.borderRadius;

  const padding = padded ? tokens.panelPadding : 0;

  const style: React.CSSProperties = {
    backgroundColor: tokens.background,
    backdropFilter: tokens.backdropBlur,
    WebkitBackdropFilter: tokens.backdropBlur,
    border: tokens.border,
    borderRadius: radius,
    boxShadow: elevated ? tokens.shadowElevated : tokens.shadow,
    padding,
    transition: tokens.transitionSpring,
    color: tokens.textPrimary,
    position: 'relative',
    isolation: 'isolate',
    opacity: disabled ? tokens.disabledOpacity : 1,
  };

  // Add inner highlight as pseudo-element would be cleaner but inline works
  if (interactive && !disabled) {
    style.cursor = 'pointer';
  }

  return style;
}

/**
 * Creates interaction state modifiers for glass controls.
 */
export function createGlassInteractionStyles(
  tokens: LiquidGlassTokens,
  state: 'idle' | 'hover' | 'active' | 'focus' | 'disabled'
): React.CSSProperties {
  switch (state) {
    case 'hover':
      return {
        backgroundColor: tokens.background,
        boxShadow: tokens.shadowElevated,
        transform: 'translateY(-1px)',
      };
    case 'active':
      return {
        backgroundColor: tokens.activeOverlay,
        boxShadow: tokens.shadow,
        transform: 'translateY(0) scale(0.99)',
      };
    case 'focus':
      return {
        boxShadow: `${tokens.shadowElevated}, ${tokens.focusRing}`,
        outline: 'none',
      };
    case 'disabled':
      return {
        opacity: tokens.disabledOpacity,
        cursor: 'not-allowed',
      };
    default:
      return {};
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ──────────────────────────────────────────────────────────────────────────────

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }

  return { h, s, l };
}
