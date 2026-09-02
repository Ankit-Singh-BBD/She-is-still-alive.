/**
 * P18 — Voice Plumbing Refactor
 *
 * AudioPlayback interface — server-side abstraction for playing audio.
 * This is implemented by platform-specific adapters (Web, Node, React Native, etc.).
 * The legacy `AudioPlayer` class from `src/services/audioPlayer.ts` is wrapped
 * by an adapter implementing this interface.
 */

import type { AudioFormat } from './audio-capture.js';

export interface AudioPlaybackConfig {
  /** Target playback sample rate in Hz (default: 24000) */
  sampleRate?: number;
  /** Volume level (0.0 to 1.0, default: 1.0) */
  volume?: number;
  /** Buffer ahead duration in ms for smooth playback (default: 200) */
  bufferAheadMs?: number;
  /** Enable volume/waveform analyzer (default: true) */
  enableAnalyzer?: boolean;
}

export interface AudioPlaybackCallbacks {
  /** Called when playback starts (audio is emitting to speaker) */
  onStart?: () => void;
  /** Called when playback ends (all buffered audio finished) */
  onEnd?: () => void;
  /** Called when speaking state changes (for UI or state machine triggers) */
  onSpeakingChange?: (isSpeaking: boolean) => void;
  /** Called when an error occurs during playback */
  onError?: (error: Error) => void;
}

export interface AudioPlaybackState {
  /** Current playback state */
  state: 'idle' | 'buffering' | 'playing' | 'paused' | 'stopped' | 'error';
  /** Whether audio is currently emitting */
  isSpeaking: boolean;
  /** Error if state is 'error' */
  error?: Error | undefined;
  /** Current volume level (0-100) for UI visualization */
  volumeLevel: number;
  /** Total duration queued in ms */
  bufferedDurationMs: number;
  /** Current playback position in ms */
  playbackPositionMs: number;
}

/**
 * AudioPlayback interface — platform-agnostic audio output.
 *
 * Implementations:
 * - WebAudioPlayback: wraps legacy AudioPlayer (AudioContext + AudioBufferSourceNode)
 * - NodeAudioPlayback: uses speaker/node-speaker or ffplay/sox
 * - MockAudioPlayback: for automated testing in Node/CI environments
 */
export interface AudioPlayback {
  /** Get current state */
  getState(): AudioPlaybackState;

  /** Initialize the playback subsystem */
  init(config?: Partial<AudioPlaybackConfig>): Promise<void>;

  /** Register callbacks */
  setCallbacks(callbacks: AudioPlaybackCallbacks): void;

  /** Queue/play an audio chunk */
  playChunk(
    data: ArrayBuffer | string,
    format: AudioFormat,
    options?: { sampleRate?: number; durationMs?: number },
  ): Promise<void>;

  /** Interrupt playback immediately (clear all queued buffers and stop current sound) */
  interrupt(): void;

  /** Pause playback */
  pause(): Promise<void>;

  /** Resume playback */
  resume(): Promise<void>;

  /** Set output volume (0.0 to 1.0) */
  setVolume(volume: number): void;

  /** Get volume level (0-100) for real-time visualization */
  getVolumeLevel(): number;

  /** Get waveform time-domain data for visualizers/orb */
  getWaveformData(targetArray: Uint8Array): void;

  /** Stop and cleanup resources */
  dispose(): Promise<void>;
}

/**
 * Factory type for creating AudioPlayback instances.
 */
export type AudioPlaybackFactory = (config: AudioPlaybackConfig) => AudioPlayback;