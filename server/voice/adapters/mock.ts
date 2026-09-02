/**
 * P18 — Voice Plumbing Refactor
 * Mock AudioCapture & AudioPlayback adapters for Node testing and CI.
 */

import type {
  AudioCapture,
  AudioCaptureConfig,
  AudioCaptureCallbacks,
  AudioCaptureState,
  AudioChunk,
} from '../interfaces/audio-capture.js';
import type {
  AudioPlayback,
  AudioPlaybackConfig,
  AudioPlaybackCallbacks,
  AudioPlaybackState,
} from '../interfaces/audio-playback.js';
import type { AudioFormat } from '../interfaces/audio-capture.js';
import { resampleAndConvertToPCM16Base64, base64ToFloat32 } from './resampler.js';

export class MockAudioCapture implements AudioCapture {
  private config: AudioCaptureConfig;
  private callbacks: AudioCaptureCallbacks | null = null;
  private state: AudioCaptureState['state'] = 'idle';
  private error?: Error | undefined;
  private chunksCaptured = 0;
  private sampleRate = 16000;
  private level = 0;
  private timer: NodeJS.Timeout | null = null;
  private sequence = 0;

  constructor(config: Partial<AudioCaptureConfig> = {}) {
    this.config = {
      sampleRate: 16000,
      channelCount: 1,
      format: 'pcm16_base64',
      chunkMs: 100,
      ...config,
    };
    this.sampleRate = this.config.sampleRate ?? 16000;
  }

  public getState(): AudioCaptureState {
    return {
      state: this.state,
      error: this.error,
      sampleRate: this.sampleRate,
      chunksCaptured: this.chunksCaptured,
      level: this.level,
    };
  }

  public async start(callbacks: AudioCaptureCallbacks): Promise<void> {
    if (this.state === 'capturing') return;
    this.callbacks = callbacks;
    this.state = 'capturing';
    this.error = undefined;
    this.callbacks.onStart?.();
  }

  public async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopped') return;
    this.state = 'stopped';
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.callbacks?.onStop?.();
  }

  public async pause(): Promise<void> {
    if (this.state === 'capturing') {
      this.state = 'idle';
    }
  }

  public async resume(): Promise<void> {
    if (this.state === 'idle' && this.callbacks) {
      this.state = 'capturing';
    }
  }

  public async configure(config: Partial<AudioCaptureConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    if (config.sampleRate) {
      this.sampleRate = config.sampleRate;
    }
  }

  public async getDevices(): Promise<MediaDeviceInfo[]> {
    return [
      {
        deviceId: 'default',
        groupId: 'mock-group',
        kind: 'audioinput',
        label: 'Mock Microphone',
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ];
  }

  public async setDevice(_deviceId: string): Promise<void> {
    // No-op for mock
  }

  public async dispose(): Promise<void> {
    await this.stop();
    this.callbacks = null;
  }

  // --- Testing Test Helpers ---
  public emitChunk(chunk: AudioChunk): void {
    if (this.state !== 'capturing' || !this.callbacks) return;
    this.chunksCaptured++;
    this.callbacks.onChunk(chunk);
  }

  public emitSyntheticWave(frequencyHz = 440, durationMs = 100): void {
    if (this.state !== 'capturing' || !this.callbacks) return;
    const numSamples = Math.round((this.sampleRate * durationMs) / 1000);
    const floatBuffer = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      floatBuffer[i] = Math.sin((2 * Math.PI * frequencyHz * i) / this.sampleRate) * 0.8;
    }

    const base64 = resampleAndConvertToPCM16Base64(floatBuffer, this.sampleRate, this.sampleRate);
    this.emitChunk({
      data: base64,
      format: 'pcm16_base64',
      sampleRate: this.sampleRate,
      channelCount: 1,
      timestamp: Date.now(),
      durationMs,
      sequence: ++this.sequence,
    });
  }

  public simulatePermissionDenied(): void {
    this.error = new Error('Microphone permission denied');
    this.state = 'error';
    this.callbacks?.onPermissionDenied?.();
  }
}

export class MockAudioPlayback implements AudioPlayback {
  private config: AudioPlaybackConfig;
  private callbacks: AudioPlaybackCallbacks | null = null;
  private state: AudioPlaybackState['state'] = 'idle';
  private error?: Error | undefined;
  private isSpeaking = false;
  private volumeLevel = 0;
  private volume = 1.0;
  private queuedChunks: Array<{ data: ArrayBuffer | string; format: AudioFormat; durationMs: number }> = [];
  private bufferedDurationMs = 0;
  private playbackPositionMs = 0;

  constructor(config: Partial<AudioPlaybackConfig> = {}) {
    this.config = {
      sampleRate: 24000,
      volume: 1.0,
      bufferAheadMs: 200,
      enableAnalyzer: true,
      ...config,
    };
    this.volume = this.config.volume ?? 1.0;
  }

  public getState(): AudioPlaybackState {
    return {
      state: this.state,
      error: this.error,
      isSpeaking: this.isSpeaking,
      volumeLevel: this.getVolumeLevel(),
      bufferedDurationMs: this.bufferedDurationMs,
      playbackPositionMs: this.playbackPositionMs,
    };
  }

  public async init(config?: Partial<AudioPlaybackConfig>): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
      if (config.volume !== undefined) this.volume = config.volume;
    }
    this.state = 'idle';
  }

  public setCallbacks(callbacks: AudioPlaybackCallbacks): void {
    this.callbacks = callbacks;
  }

  public async playChunk(
    data: ArrayBuffer | string,
    format: AudioFormat,
    options?: { sampleRate?: number; durationMs?: number },
  ): Promise<void> {
    let duration = options?.durationMs ?? 0;
    if (duration === 0) {
      if (typeof data === 'string') {
        const floatData = base64ToFloat32(data);
        duration = Math.round((floatData.length / (options?.sampleRate ?? 24000)) * 1000);
      } else {
        duration = Math.round((data.byteLength / 2 / (options?.sampleRate ?? 24000)) * 1000);
      }
    }

    this.queuedChunks.push({ data, format, durationMs: duration });
    this.bufferedDurationMs += duration;

    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.state = 'playing';
      this.volumeLevel = 75;
      this.callbacks?.onStart?.();
      this.callbacks?.onSpeakingChange?.(true);
    }
  }

  public interrupt(): void {
    this.queuedChunks = [];
    this.bufferedDurationMs = 0;
    this.volumeLevel = 0;
    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.state = 'stopped';
      this.callbacks?.onSpeakingChange?.(false);
      this.callbacks?.onEnd?.();
    }
  }

  public async pause(): Promise<void> {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.volumeLevel = 0;
    }
  }

  public async resume(): Promise<void> {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.volumeLevel = 75;
    }
  }

  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  public getVolumeLevel(): number {
    return this.isSpeaking ? Math.round(this.volumeLevel * this.volume) : 0;
  }

  public getWaveformData(targetArray: Uint8Array): void {
    if (!this.isSpeaking) {
      targetArray.fill(128);
      return;
    }
    // Fill with synthetic sine wave data centered on 128
    for (let i = 0; i < targetArray.length; i++) {
      targetArray[i] = Math.round(128 + Math.sin(i / 4) * 60 * this.volume);
    }
  }

  public async dispose(): Promise<void> {
    this.interrupt();
    this.state = 'idle';
    this.callbacks = null;
  }

  // --- Testing Test Helpers ---
  public simulatePlaybackFinished(): void {
    this.queuedChunks = [];
    this.bufferedDurationMs = 0;
    this.volumeLevel = 0;
    if (this.isSpeaking) {
      this.isSpeaking = false;
      this.state = 'idle';
      this.callbacks?.onSpeakingChange?.(false);
      this.callbacks?.onEnd?.();
    }
  }
}
