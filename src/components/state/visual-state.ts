import type { TimeOfDay, RuntimeState, WeatherSnapshot } from '@server/realtime/types.js';

export type QualityTier = 'ULTRA' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface OrbVisualState {
  baseColor: string;
  emissionColor: string;
  energyLevel: number;
  activityMode: 'idle' | 'listening' | 'speaking' | 'processing' | 'error' | 'connecting';
  waveformAmplitude: number;
  // PBR material parameters (XVIII.4)
  ior: number;
  transmission: number;
  thickness: number;
  fresnelPower: number;
  // Audio-reactive bands (XVIII.6, XVIII.27)
  audioBands: {
    low: number;
    mid: number;
    high: number;
  };
  voiceIntensity: number;
}

export interface EnvironmentVisualState {
  palette: {
    primary: string;
    secondary: string;
    accent: string;
  };
  lightingIntensity: number;
  atmosphereColor: string;
  timeOfDay: TimeOfDay;
  weather: WeatherSnapshot['condition'];
  // Scene lighting (XVIII.10, XVIII.11)
  sunDirection: [number, number, number];
  sunColor: string;
  fogDensity: number;
  fogColor: string;
}

export interface UiVisualState {
  glassOpacity: number;
}

export interface QualityConfig {
  tier: QualityTier;
  dprCap: number;
  particleCount: number;
  waterQuality: 'full' | 'reduced' | 'simplified' | 'minimal';
  postEnabled: boolean;
  shadowEnabled: boolean;
}

export interface VisualState {
  orb: OrbVisualState;
  environment: EnvironmentVisualState;
  ui: UiVisualState;
  quality: QualityConfig;
}