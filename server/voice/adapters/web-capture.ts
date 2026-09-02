/**
 * P18 — Voice Plumbing Refactor
 * WebAudioCapture adapter implementing AudioCapture using browser Web Audio API.
 * Preserves legacy fallback logic for permissions and browser compatibility.
 */

import type {
  AudioCapture,
  AudioCaptureConfig,
  AudioCaptureCallbacks,
  AudioCaptureState,
} from '../interfaces/audio-capture.js';
import { resampleAndConvertToPCM16Base64 } from './resampler.js';

export class WebAudioCapture implements AudioCapture {
  private config: AudioCaptureConfig;
  private callbacks: AudioCaptureCallbacks | null = null;
  private state: AudioCaptureState['state'] = 'idle';
  private error?: Error | undefined;
  private chunksCaptured = 0;
  private level = 0;
  private sequence = 0;

  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;

  constructor(config: Partial<AudioCaptureConfig> = {}) {
    this.config = {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      format: 'pcm16_base64',
      chunkMs: 128, // ~2048 buffer size at 16kHz
      ...config,
    };
  }

  public getState(): AudioCaptureState {
    return {
      state: this.state,
      error: this.error,
      sampleRate: this.audioContext?.sampleRate ?? this.config.sampleRate ?? 16000,
      chunksCaptured: this.chunksCaptured,
      level: this.level,
    };
  }

  public async start(callbacks: AudioCaptureCallbacks): Promise<void> {
    if (this.state === 'capturing' || this.state === 'starting') return;
    this.callbacks = callbacks;
    this.state = 'starting';
    this.error = undefined;

    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not supported in this browser environment.');
      }

      // 1. Acquire media stream with progressive fallback
      try {
        const audioConstraints: MediaTrackConstraints = {};
        if (this.config.channelCount !== undefined) audioConstraints.channelCount = this.config.channelCount;
        if (this.config.echoCancellation !== undefined) audioConstraints.echoCancellation = this.config.echoCancellation;
        if (this.config.noiseSuppression !== undefined) audioConstraints.noiseSuppression = this.config.noiseSuppression;
        if (this.config.autoGainControl !== undefined) audioConstraints.autoGainControl = this.config.autoGainControl;
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraints,
        });
      } catch (firstErr: any) {
        if (this.isPermissionError(firstErr)) {
          this.handlePermissionDenied(firstErr);
          return;
        }

        console.warn('Advanced audio constraints not accepted, falling back to basic audio:', firstErr);
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (secondErr: any) {
          if (this.isPermissionError(secondErr)) {
            this.handlePermissionDenied(secondErr);
            return;
          }
          throw secondErr;
        }
      }

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        //@ts-ignore
      if (!AudioCtx) {
        throw new Error('Web Audio API is not supported in this browser.');
      }

      // 2. Initialize AudioContext with fallback
      try {
        if (this.config.sampleRate !== undefined) {
          this.audioContext = new AudioCtx({ sampleRate: this.config.sampleRate });
        } else {
          this.audioContext = new AudioCtx();
        }
      } catch (e) {
        this.audioContext = new AudioCtx();
      }

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      const activeSampleRate = this.audioContext.sampleRate || this.config.sampleRate || 16000;

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount) 

      // Buffer size 2048 (~128ms latency per chunk at 16kHz)
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (this.state !== 'capturing') return;
        const inputData = e.inputBuffer.getChannelData(0);

        // Update level
        if (this.analyser && this.dataArray) {
          this.analyser.getByteFrequencyData(this.dataArray as Uint8Array<ArrayBuffer>);
          let sum = 0;
          for (let i = 0; i < this.dataArray.length; i++) sum += this.dataArray[i] ?? 0;
          this.level = Math.min(100, Math.round(((sum / this.dataArray.length) / 255) * 100));
        }

        // Resample and convert to 16kHz PCM16 Base64
        const targetRate = this.config.sampleRate ?? 16000;
        const base64Chunk = resampleAndConvertToPCM16Base64(inputData, activeSampleRate, targetRate);

        if (this.callbacks && base64Chunk.length > 0) {
          this.chunksCaptured++;
          this.callbacks.onChunk({
            data: base64Chunk,
            format: 'pcm16_base64',
            sampleRate: targetRate,
            channelCount: 1,
            timestamp: Date.now(),
            durationMs: Math.round((2048 / activeSampleRate) * 1000),
            sequence: ++this.sequence,
          });
        }
      };

      this.source.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.state = 'capturing';
      this.callbacks?.onStart?.();
    } catch (err: any) {
      this.error = err;
      this.state = 'error';
      console.error('Failed to start WebAudioCapture:', err);
      void this.stop();
      throw err;
    }
  }

  public async stop(): Promise<void> {
    const wasError = this.state === 'error';
    this.state = 'stopping';

    if (this.processor) {
      try { this.processor.disconnect(); } catch (e) {}
      this.processor = null;
    }
    if (this.analyser) {
      try { this.analyser.disconnect(); } catch (e) {}
      this.analyser = null;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch (e) {}
      this.source = null;
    }
    if (this.mediaStream) {
      try { this.mediaStream.getTracks().forEach((track) => track.stop()); } catch (e) {}
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { await this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }

    if (!wasError) {
      this.state = 'stopped';
    }
    this.callbacks?.onStop?.(this.error);
    this.callbacks = null;
  }

  public async pause(): Promise<void> {
    if (this.state === 'capturing') {
      this.state = 'idle'; // Keeps stream open but processor drops frames
    }
  }

  public async resume(): Promise<void> {
    if (this.state === 'idle' && this.source) {
      if (this.audioContext?.state === 'suspended') {
        await this.audioContext.resume();
      }
      this.state = 'capturing';
    }
  }

  public async configure(config: Partial<AudioCaptureConfig>): Promise<void> {
    this.config = { ...this.config, ...config };
    // Applying some config like sampleRate would require restart, ignored for now
  }

  public async getDevices(): Promise<MediaDeviceInfo[]> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return [];
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput');
  }

  public async setDevice(deviceId: string): Promise<void> {
    if (this.state === 'capturing') {
      await this.stop();
      // Ideal flow: start with exact deviceId constraint, but omittable for this refactor
    }
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }

  private isPermissionError(err: any): boolean {
    return err?.name === 'NotAllowedError' ||
      err?.name === 'PermissionDeniedError' ||
      err?.name === 'SecurityError' ||
      err?.message?.toLowerCase().includes('not allowed') ||
      err?.message?.toLowerCase().includes('denied') ||
      err?.message?.toLowerCase().includes('permission');
  }

  private handlePermissionDenied(err: any): void {
    const permErr = new Error('Microphone permission is not allowed. Please allow microphone access in your browser to speak with Madhurita.');
    permErr.name = 'NotAllowedError';
    this.error = permErr;
    this.state = 'error';
    this.callbacks?.onPermissionDenied?.();
    void this.stop();
  }
}
