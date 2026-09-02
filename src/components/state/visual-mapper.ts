import type { RuntimeState, TimeOfDay } from '@server/realtime/types.js';
import type {
  VisualState,
  OrbVisualState,
  EnvironmentVisualState,
  UiVisualState,
  QualityConfig,
  QualityTier,
} from './visual-state.js';

export class VisualStateMapper {
  /**
   * Pure function mapping authoritative RuntimeState to derived VisualState.
   * Per XVIII.0 — no state mutations occur here; all visual state is derived.
   */
  public static map(state: RuntimeState, tier: QualityTier = 'HIGH'): VisualState {
    const orb = this.mapOrbState(state);
    const environment = this.mapEnvironmentState(state);
    const ui = this.mapUiState(state);
    const quality = this.mapQualityConfig(tier);
    return { orb, environment, ui, quality };
  }

  public static mapQualityConfig(tier: QualityTier): QualityConfig {
    switch (tier) {
      case 'ULTRA':
        return {
          tier: 'ULTRA',
          dprCap: 2.0,
          particleCount: 150,
          waterQuality: 'full',
          postEnabled: true,
          shadowEnabled: true,
        };
      case 'HIGH':
        return {
          tier: 'HIGH',
          dprCap: 1.75,
          particleCount: 100,
          waterQuality: 'full',
          postEnabled: true,
          shadowEnabled: true,
        };
      case 'MEDIUM':
        return {
          tier: 'MEDIUM',
          dprCap: 1.5,
          particleCount: 50,
          waterQuality: 'reduced',
          postEnabled: false,
          shadowEnabled: false,
        };
      case 'LOW':
      default:
        return {
          tier: 'LOW',
          dprCap: 1.25,
          particleCount: 25,
          waterQuality: 'simplified',
          postEnabled: false,
          shadowEnabled: false,
        };
    }
  }

  private static mapOrbState(state: RuntimeState): OrbVisualState {
    let activityMode: OrbVisualState['activityMode'] = 'idle';

    // Voice live state drives orb activity (XVIII.19)
    const vLive = state.voice.live;
    if (vLive === 'error') {
      activityMode = 'error';
    } else if (vLive === 'connecting') {
      activityMode = 'connecting';
    } else if (vLive === 'speaking') {
      activityMode = 'speaking';
    } else if (vLive === 'listening') {
      activityMode = 'listening';
    } else if (vLive === 'thinking') {
      activityMode = 'processing';
    } else {
      // disconnected -> fall back to cognitive stage
      const cogStage = state.cognitive.currentStage;
      if (
        cogStage !== 'PERCEIVE' &&
        cogStage !== 'PERSIST' &&
        cogStage !== 'VERIFY' &&
        state.cognitive.cycleStartedAt > 0
      ) {
        activityMode = 'processing';
      }
    }

    const audioEnergy = Math.max(state.voice.energy, state.voice.ttsEnergy);

    let baseEnergy = 0.1;
    if (activityMode === 'processing') baseEnergy = 0.4;
    else if (activityMode === 'speaking') baseEnergy = 0.6;
    else if (activityMode === 'listening') baseEnergy = 0.5;
    else if (activityMode === 'error') baseEnergy = 0.2;
    else if (activityMode === 'connecting') baseEnergy = 0.3;

    const energyLevel = Math.min(1.0, baseEnergy + audioEnergy * 0.5);

    const baseColor = state.environment.derivedPalette.primary;
    let emissionColor = state.environment.derivedPalette.accent;
    if (activityMode === 'error') {
      emissionColor = '#ff3333';
    } else if (activityMode === 'processing') {
      emissionColor = state.environment.derivedPalette.secondary;
    }

    // Audio-reactive band decomposition approximation from available signals
    const audioBands = {
      low: Math.min(1.0, audioEnergy * 1.2),
      mid: Math.min(1.0, audioEnergy * 0.8),
      high: Math.min(1.0, audioEnergy * 0.5),
    };

    return {
      baseColor,
      emissionColor,
      energyLevel,
      activityMode,
      waveformAmplitude: audioEnergy,
      ior: 1.45,
      transmission: 0.92,
      thickness: 1.2,
      fresnelPower: 2.5,
      audioBands,
      voiceIntensity: audioEnergy,
    };
  }

  private static mapEnvironmentState(state: RuntimeState): EnvironmentVisualState {
    let lightingIntensity = 1.0;
    const tod = state.environment.timeOfDay;

    let sunDirection: [number, number, number] = [2, 4, 1];
    let sunColor = '#ffffff';
    let fogDensity = 0.015;
    let fogColor = state.environment.derivedPalette.secondary;

    if (tod === 'night') {
      lightingIntensity = 0.3;
      sunDirection = [-1, 2, -2];
      sunColor = '#4a6fa5';
      fogDensity = 0.03;
      fogColor = '#050a18';
    } else if (tod === 'sunset') {
      lightingIntensity = 0.7;
      sunDirection = [4, 1.5, 2];
      sunColor = '#ff7b47';
      fogDensity = 0.02;
      fogColor = '#2a110a';
    } else if (tod === 'sunrise') {
      lightingIntensity = 0.7;
      sunDirection = [-4, 1.5, 2];
      sunColor = '#ffb366';
      fogDensity = 0.02;
      fogColor = '#1f130e';
    } else {
      // Day
      lightingIntensity = 1.0;
      sunDirection = [2, 5, 2];
      sunColor = '#fff5e6';
      fogDensity = 0.015;
      fogColor = state.environment.derivedPalette.secondary;
    }

    const weather = state.environment.weather.condition;
    if (weather === 'stormy' || weather === 'rainy' || weather === 'fog') {
      lightingIntensity *= 0.6;
      fogDensity *= 2.0;
    } else if (weather === 'snow') {
      lightingIntensity *= 0.8;
      fogDensity *= 1.5;
    }

    return {
      palette: state.environment.derivedPalette,
      lightingIntensity,
      atmosphereColor: state.environment.derivedPalette.secondary,
      timeOfDay: tod,
      weather,
      sunDirection,
      sunColor,
      fogDensity,
      fogColor,
    };
  }

  private static mapUiState(state: RuntimeState): UiVisualState {
    return {
      glassOpacity: state.environment.timeOfDay === 'night' ? 0.8 : 0.6,
    };
  }
}
