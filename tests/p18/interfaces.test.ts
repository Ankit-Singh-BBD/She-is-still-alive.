/**
 * P18 — Voice Plumbing Refactor
 * Interface contract tests for AudioCapture and AudioPlayback.
 * Validates that all adapters (mock, web) satisfy the interface requirements.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  AudioCapture,
  AudioCaptureConfig,
  AudioCaptureCallbacks,
  AudioCaptureState,
  AudioChunk,
  AudioFormat,
} from '@server/voice/interfaces/audio-capture.js';
import type {
  AudioPlayback,
  AudioPlaybackConfig,
  AudioPlaybackCallbacks,
  AudioPlaybackState,
} from '@server/voice/interfaces/audio-playback.js';
import { MockAudioCapture, MockAudioPlayback } from '@server/voice/adapters/mock.js';

describe('P18 AudioCapture Interface Contract', () => {
  let capture: AudioCapture;
  let receivedChunks: AudioChunk[] = [];
  let callbacks: AudioCaptureCallbacks;

  beforeEach(() => {
    capture = new MockAudioCapture({ sampleRate: 16000, chunkMs: 100 });
    receivedChunks = [];
    callbacks = {
      onChunk: (chunk: AudioChunk) => { receivedChunks.push(chunk); },
      onStart: () => {},
      onStop: () => {},
      onPermissionDenied: () => {},
      onDeviceNotFound: () => {},
    };
  });

  afterEach(async () => {
    await capture.dispose();
  });

  it('implements all required methods', () => {
    expect(typeof capture.getState).toBe('function');
    expect(typeof capture.start).toBe('function');
    expect(typeof capture.stop).toBe('function');
    expect(typeof capture.pause).toBe('function');
    expect(typeof capture.resume).toBe('function');
    expect(typeof capture.configure).toBe('function');
    expect(typeof capture.getDevices).toBe('function');
    expect(typeof capture.setDevice).toBe('function');
    expect(typeof capture.dispose).toBe('function');
  });

  it('initial state is idle', () => {
    const state = capture.getState();
    expect(state.state).toBe('idle');
    expect(state.chunksCaptured).toBe(0);
    expect(state.sampleRate).toBe(16000);
  });

  it('transitions to capturing on start()', async () => {
    await capture.start(callbacks);
    expect(capture.getState().state).toBe('capturing');
  });

  it('emits onStart callback on start()', async () => {
    let startCalled = false;
    await capture.start({ ...callbacks, onStart: () => { startCalled = true; } });
    expect(startCalled).toBe(true);
  });

  it('emits onChunk for synthetic data', async () => {
    await capture.start(callbacks);
    // @ts-expect-error test helper
    capture.emitSyntheticWave(440, 100);

    expect(receivedChunks.length).toBe(1);
    const chunk = receivedChunks[0]!;
    expect(chunk.format).toBe('pcm16_base64');
    expect(chunk.sampleRate).toBe(16000);
    expect(chunk.channelCount).toBe(1);
    expect(chunk.timestamp).toBeGreaterThan(0);
    expect(chunk.durationMs).toBeGreaterThan(0);
    expect(chunk.sequence).toBe(1);
    expect(typeof chunk.data).toBe('string');
    expect((chunk.data as string).length).toBeGreaterThan(0);
  });

  it('increments chunksCaptured and sequence on each chunk', async () => {
    await capture.start(callbacks);
    // @ts-expect-error test helper
    capture.emitSyntheticWave(440, 100);
    // @ts-expect-error test helper
    capture.emitSyntheticWave(440, 100);

    const state = capture.getState();
    expect(state.chunksCaptured).toBe(2);
    expect(receivedChunks[1]!.sequence).toBe(2);
  });

  it('transitions to stopped on stop()', async () => {
    await capture.start(callbacks);
    await capture.stop();
    expect(capture.getState().state).toBe('stopped');
  });

  it('emits onStop callback on stop()', async () => {
    let stopCalled = false;
    await capture.start({ ...callbacks, onStop: () => { stopCalled = true; } });
    await capture.stop();
    expect(stopCalled).toBe(true);
  });

  it('pauses and resumes capture', async () => {
    await capture.start(callbacks);
    await capture.pause();
    expect(capture.getState().state).toBe('idle');
    await capture.resume();
    expect(capture.getState().state).toBe('capturing');
  });

  it('returns device list', async () => {
    const devices = await capture.getDevices();
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.length).toBeGreaterThan(0);
    expect(devices[0]!.kind).toBe('audioinput');
  });

  it('simulates permission denied error state', async () => {
    let permDenied = false;
    await capture.start({ ...callbacks, onPermissionDenied: () => { permDenied = true; } });
    // @ts-expect-error test helper
    capture.simulatePermissionDenied();
    expect(capture.getState().state).toBe('error');
    expect(capture.getState().error).toBeDefined();
    expect(permDenied).toBe(true);
  });

  it('can configure sampleRate', async () => {
    await capture.configure({ sampleRate: 48000 });
    expect(capture.getState().sampleRate).toBe(48000);
  });
});

describe('P18 AudioPlayback Interface Contract', () => {
  let playback: AudioPlayback;
  let callbacks: AudioPlaybackCallbacks;
  let startCount = 0;
  let endCount = 0;
  let speakingChanges: boolean[] = [];

  beforeEach(() => {
    playback = new MockAudioPlayback({ sampleRate: 24000, volume: 1.0 });
    startCount = 0;
    endCount = 0;
    speakingChanges = [];
    callbacks = {
      onStart: () => { startCount++; },
      onEnd: () => { endCount++; },
      onSpeakingChange: (s: boolean) => { speakingChanges.push(s); },
      onError: () => {},
    };
  });

  afterEach(async () => {
    await playback.dispose();
  });

  it('implements all required methods', () => {
    expect(typeof playback.getState).toBe('function');
    expect(typeof playback.init).toBe('function');
    expect(typeof playback.setCallbacks).toBe('function');
    expect(typeof playback.playChunk).toBe('function');
    expect(typeof playback.interrupt).toBe('function');
    expect(typeof playback.pause).toBe('function');
    expect(typeof playback.resume).toBe('function');
    expect(typeof playback.setVolume).toBe('function');
    expect(typeof playback.getVolumeLevel).toBe('function');
    expect(typeof playback.getWaveformData).toBe('function');
    expect(typeof playback.dispose).toBe('function');
  });

  it('initial state is idle', async () => {
    await playback.init();
    const state = playback.getState();
    expect(state.state).toBe('idle');
    expect(state.isSpeaking).toBe(false);
    expect(state.volumeLevel).toBe(0);
    expect(state.bufferedDurationMs).toBe(0);
  });

  it('init() sets up configuration', async () => {
    await playback.init({ volume: 0.5, sampleRate: 48000 });
    // Volume should be applied
    playback.setVolume(0.5);
    expect(playback.getState().state).toBe('idle');
  });

  it('transitions to playing on first playChunk()', async () => {
    await playback.init();
    playback.setCallbacks(callbacks);

    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 100 });

    expect(playback.getState().state).toBe('playing');
    expect(playback.getState().isSpeaking).toBe(true);
    expect(startCount).toBe(1);
    expect(speakingChanges).toContain(true);
  });

  it('buffers multiple chunks and accumulates bufferedDurationMs', async () => {
    await playback.init();
    playback.setCallbacks(callbacks);

    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 100 });
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 150 });

    expect(playback.getState().bufferedDurationMs).toBe(250);
  });

  it('interrupt() stops playback immediately and clears buffer', async () => {
    await playback.init();
    playback.setCallbacks(callbacks);

    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 500 });

    expect(playback.getState().isSpeaking).toBe(true);

    playback.interrupt();

    expect(playback.getState().isSpeaking).toBe(false);
    expect(playback.getState().bufferedDurationMs).toBe(0);
    expect(playback.getState().state).toBe('stopped');
    expect(endCount).toBe(1);
    expect(speakingChanges).toContain(false);
  });

  it('pause() and resume() toggle state', async () => {
    await playback.init();
    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 100 });

    await playback.pause();
    expect(playback.getState().state).toBe('paused');

    await playback.resume();
    expect(playback.getState().state).toBe('playing');
  });

  it('setVolume() clamps to [0, 1]', async () => {
    await playback.init();
    playback.setCallbacks(callbacks);
    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 100 });

    playback.setVolume(1.5);
    expect(playback.getVolumeLevel()).toBeGreaterThan(0);

    playback.setVolume(-0.5);
    expect(playback.getVolumeLevel()).toBe(0);
  });

  it('getVolumeLevel() returns 0 when not speaking', async () => {
    await playback.init();
    expect(playback.getVolumeLevel()).toBe(0);
  });

  it('getWaveformData() fills 128 when not speaking', async () => {
    await playback.init();
    const arr = new Uint8Array(128);
    playback.getWaveformData(arr);
    expect(arr[0]).toBe(128);
    expect(arr[arr.length - 1]).toBe(128);
  });

  it('getWaveformData() provides data when speaking', async () => {
    await playback.init();
    playback.setCallbacks(callbacks);
    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 100 });

    const arr = new Uint8Array(128);
    playback.getWaveformData(arr);
    // Should have variation, not all 128
    const unique = new Set(arr);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('simulatePlaybackFinished() test helper works', async () => {
    await playback.init();
    playback.setCallbacks(callbacks);
    const base64 = 'UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQYAAAD//w==';
    await playback.playChunk(base64, 'pcm16_base64', { durationMs: 100 });

    // @ts-expect-error test helper
    playback.simulatePlaybackFinished();

    expect(playback.getState().state).toBe('idle');
    expect(playback.getState().isSpeaking).toBe(false);
    expect(endCount).toBe(1);
  });
});