/**
 * P18 — Voice Plumbing Refactor
 * WebAudioPlayback adapter implementing AudioPlayback using browser Web Audio API.
 * Preserves legacy jitter buffer logic and volume visualization.
 */

import type {
  AudioPlayback,
  AudioPlaybackConfig,
  AudioPlaybackCallbacks,
  AudioPlaybackState,
} from '../interfaces/audio-playback.js';
import type { AudioFormat } from '../interfaces/audio-capture.js';
import { base64ToFloat32 } from './resampler.js';

export class WebAudioPlayback implements AudioPlayback {
  private config: AudioPlaybackConfig;
  private callbacks: AudioPlaybackCallbacks | null = null;
  private state: AudioPlaybackState['state'] = 'idle';
  private error?: Error | undefined;

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private masterGain: GainNode | null = null;
  private dataArray: Uint8Array | null = null;

  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private isSpeaking = false;
  private checkSpeakingTimer: number | null = null;
  private bufferedDurationMs = 0;

  constructor(config: Partial<AudioPlaybackConfig> = {}) {
    this.config = {
      sampleRate: 24000,
      volume: 1.0,
      bufferAheadMs: 200,
      enableAnalyzer: true,
      ...config,
    };
  }

  public getState(): AudioPlaybackState {
    return {
      state: this.state,
      error: this.error,
      isSpeaking: this.isSpeaking,
      volumeLevel: this.getVolumeLevel(),
      bufferedDurationMs: this.bufferedDurationMs,
      playbackPositionMs: this.audioContext?.currentTime ? this.audioContext.currentTime * 1000 : 0,
    };
  }

  public async init(config?: Partial<AudioPlaybackConfig>): Promise<void> {
    if (config) {
      this.config = { ...this.config, ...config };
    }

    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) throw new Error('Web Audio API not supported');

      try {
        this.audioContext = this.config.sampleRate ? new AudioCtx({ sampleRate: this.config.sampleRate }) : new AudioCtx();
      } catch (e) {
        this.audioContext = new AudioCtx();
      }

      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.config.volume ?? 1.0;
      this.masterGain.connect(this.audioContext.destination);

      if (this.config.enableAnalyzer) {
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.8;
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) 
        this.analyser.connect(this.masterGain);
      }

      this.nextStartTime = this.audioContext.currentTime;
      this.state = 'idle';
    }
  }

  public setCallbacks(callbacks: AudioPlaybackCallbacks): void {
    this.callbacks = callbacks;
  }

  public async playChunk(
    data: ArrayBuffer | string,
    format: AudioFormat,
    options?: { sampleRate?: number; durationMs?: number },
  ): Promise<void> {
    if (!this.audioContext) await this.init();
    if (!this.audioContext) return;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    let float32Data: Float32Array;
    if (typeof data === 'string') {
      if (format !== 'pcm16_base64') throw new Error(`Format ${format} not supported in string format`);
      float32Data = base64ToFloat32(data);
    } else {
      // In a full implementation, handle raw pcm16 ArrayBuffer
      throw new Error(`ArrayBuffer playback not fully implemented in web adapter yet`);
    }

    if (float32Data.length === 0) return;

    const sampleRate = options?.sampleRate ?? this.config.sampleRate ?? 24000;
    const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;

    if (this.analyser) {
      source.connect(this.analyser);
    } else if (this.masterGain) {
      source.connect(this.masterGain);
    }

    const currentTime = this.audioContext.currentTime;
    // Jitter buffer gap protection
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime;
    }

    source.start(this.nextStartTime);
    const duration = audioBuffer.duration;
    this.nextStartTime += duration;
    this.bufferedDurationMs += Math.round(duration * 1000);
    this.activeSources.push(source);

    this.updateSpeakingState(true);

    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) {
        this.activeSources.splice(idx, 1);
      }
      this.bufferedDurationMs = Math.max(0, this.bufferedDurationMs - Math.round(duration * 1000));

      if (this.activeSources.length === 0 && this.audioContext &&
          this.audioContext.currentTime >= this.nextStartTime - 0.05) {
        this.updateSpeakingState(false);
      }
    };
  }

  private updateSpeakingState(speaking: boolean) {
    if (this.isSpeaking !== speaking) {
      this.isSpeaking = speaking;
      this.state = speaking ? 'playing' : 'idle';

      if (speaking) {
        this.callbacks?.onStart?.();
      } else {
        this.callbacks?.onEnd?.();
      }
      this.callbacks?.onSpeakingChange?.(speaking);
    }

    if (speaking) {
      if (this.checkSpeakingTimer) window.clearTimeout(this.checkSpeakingTimer);
      this.checkSpeakingTimer = window.setTimeout(() => {
        if (this.audioContext && this.audioContext.currentTime >= this.nextStartTime - 0.05) {
          this.updateSpeakingState(false);
        }
      }, (this.nextStartTime - (this.audioContext?.currentTime || 0)) * 1000 + 100);
    }
  }

  public interrupt(): void {
    const wasSpeaking = this.isSpeaking;
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // ignore already stopped
      }
    }
    this.activeSources = [];
    this.bufferedDurationMs = 0;

    if (this.audioContext) {
      this.nextStartTime = this.audioContext.currentTime;
    }
    this.updateSpeakingState(false);

    if (wasSpeaking) {
      this.state = 'stopped';
    }
  }

  public async pause(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'running') {
      await this.audioContext.suspend();
      this.state = 'paused';
    }
  }

  public async resume(): Promise<void> {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
      this.state = this.isSpeaking ? 'playing' : 'idle';
    }
  }

  public setVolume(volume: number): void {
    const v = Math.max(0, Math.min(1, volume));
    this.config.volume = v;
    if (this.masterGain) {
      this.masterGain.gain.value = v;
    }
  }

  public getVolumeLevel(): number {
    if (!this.analyser || !this.dataArray || !this.isSpeaking) return 0;
    this.analyser.getByteFrequencyData(this.dataArray as Uint8Array<ArrayBuffer>);
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i] ?? 0;
    }
    const avg = sum / this.dataArray.length;
    return Math.min(100, Math.round((avg / 255) * 100));
  }

  public getWaveformData(targetArray: Uint8Array): void {
    if (!this.analyser || !this.isSpeaking) {
      targetArray.fill(128); // @ts-ignore
      return;
    }
    this.analyser.getByteTimeDomainData(targetArray as Uint8Array<ArrayBuffer>);
  }

  public async dispose(): Promise<void> {
    this.interrupt();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
      this.audioContext = null;
    }
    this.state = 'idle';
    this.callbacks = null;
  }
}
