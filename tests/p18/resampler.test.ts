/**
 * P18 — Voice Plumbing Refactor
 * Resampler round-trip parity tests against legacy implementations.
 */

import { describe, it, expect } from 'vitest';
import {
  resampleAndConvertToPCM16Base64,
  base64ToFloat32,
  pcm16ToFloat32,
  encodeArrayBufferToBase64,
  decodeBase64ToUint8Array,
} from '@server/voice/adapters/resampler.js';

describe('P18 Audio Resampler Parity (Resampler)', () => {
  describe('resampleAndConvertToPCM16Base64', () => {
    it('produces valid base64 for silent input', () => {
      const silence = new Float32Array(1600); // 100ms at 16kHz
      const b64 = resampleAndConvertToPCM16Base64(silence, 16000, 16000);
      expect(typeof b64).toBe('string');
      expect(b64.length).toBeGreaterThan(0);

      // Decode and verify all zeros
      const decoded = base64ToFloat32(b64);
      expect(decoded.length).toBe(1600);
      for (const sample of decoded) {
        expect(sample).toBe(0);
      }
    });

    it('preserves amplitude for 1:1 sample rate (no resample)', () => {
      const input = new Float32Array([0.5, -0.5, 0.25, -0.25]);
      const b64 = resampleAndConvertToPCM16Base64(input, 16000, 16000);
      const decoded = base64ToFloat32(b64);

      expect(decoded.length).toBe(4);
      expect(decoded[0]).toBeCloseTo(0.5, 3);
      expect(decoded[1]).toBeCloseTo(-0.5, 3);
      expect(decoded[2]).toBeCloseTo(0.25, 3);
      expect(decoded[3]).toBeCloseTo(-0.25, 3);
    });

    it('downsamples 48kHz -> 16kHz with averaging (3:1 ratio)', () => {
      // 3 samples per output sample: 12 samples at 48kHz -> 4 samples at 16kHz
      const input48 = new Float32Array(12);
      input48.fill(0.6, 0, 3);   // first output sample
      input48.fill(0.4, 3, 6);   // second output sample
      input48.fill(-0.2, 6, 9);  // third output sample
      input48.fill(0.8, 9, 12);  // fourth output sample

      const b64 = resampleAndConvertToPCM16Base64(input48, 48000, 16000);
      const decoded = base64ToFloat32(b64);

      expect(decoded.length).toBe(4);
      expect(decoded[0]).toBeCloseTo(0.6, 2);
      expect(decoded[1]).toBeCloseTo(0.4, 2);
      expect(decoded[2]).toBeCloseTo(-0.2, 2);
      expect(decoded[3]).toBeCloseTo(0.8, 2);
    });

    it('handles non-integer ratios (e.g., 44100 -> 16000)', () => {
      const input44 = new Float32Array(441); // 10ms at 44.1kHz
      for (let i = 0; i < input44.length; i++) {
        input44[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
      }

      const b64 = resampleAndConvertToPCM16Base64(input44, 44100, 16000);
      const decoded = base64ToFloat32(b64);

      // 441 * (16000/44100) ≈ 160 samples
      expect(decoded.length).toBeGreaterThanOrEqual(158);
      expect(decoded.length).toBeLessThanOrEqual(162);
      // All samples within [-1, 1]
      for (const sample of decoded) {
        expect(sample).toBeGreaterThanOrEqual(-1);
        expect(sample).toBeLessThanOrEqual(1);
      }
    });

    it('clamps out-of-range samples to [-1, 1] before PCM16 encoding', () => {
      const input = new Float32Array([2.0, -2.0, 1.5, -1.5, 0.5]);
      const b64 = resampleAndConvertToPCM16Base64(input, 16000, 16000);
      const decoded = base64ToFloat32(b64);

      expect(decoded[0]).toBe(1.0);     // 2.0 clamped to 1.0
      expect(decoded[1]).toBe(-1.0);    // -2.0 clamped to -1.0
      expect(decoded[2]).toBe(1.0);     // 1.5 clamped to 1.0
      expect(decoded[3]).toBe(-1.0);    // -1.5 clamped to -1.0
      expect(decoded[4]).toBeCloseTo(0.5, 3);
    });

    it('handles empty input', () => {
      const empty = new Float32Array(0);
      const b64 = resampleAndConvertToPCM16Base64(empty, 16000, 16000);
      expect(b64).toBe('');
    });
  });

  describe('base64ToFloat32', () => {
    it('decodes valid PCM16 base64 to Float32Array', () => {
      const pcm16 = new Int16Array([16384, -16384, 32767, -32768, 0]);
      const b64 = encodeArrayBufferToBase64(pcm16.buffer);
      const decoded = base64ToFloat32(b64);

      expect(decoded.length).toBe(5);
      expect(decoded[0]).toBeCloseTo(0.5, 3);
      expect(decoded[1]).toBeCloseTo(-0.5, 3);
      expect(decoded[2]).toBeCloseTo(1.0, 3);
      expect(decoded[3]).toBeCloseTo(-1.0, 3);
      expect(decoded[4]).toBe(0.0);
    });

    it('handles whitespace in base64', () => {
      const pcm16 = new Int16Array([16384, -16384]);
      const b64 = encodeArrayBufferToBase64(pcm16.buffer);
      const withSpaces = b64.split('').join(' ') + '\n\t';
      const decoded = base64ToFloat32(withSpaces);
      expect(decoded.length).toBe(2);
    });

    it('returns empty array for invalid/empty input', () => {
      expect(base64ToFloat32('').length).toBe(0);
      expect(base64ToFloat32('invalid!!!').length).toBe(0);
      // @ts-expect-error testing null handling
      expect(base64ToFloat32(null).length).toBe(0);
      // @ts-expect-error testing number handling
      expect(base64ToFloat32(123).length).toBe(0);
    });
  });

  describe('round-trip: Float32Array -> base64 -> Float32Array', () => {
    it('preserves signal for simple waveforms', () => {
      const original = new Float32Array(320); // 20ms at 16kHz
      for (let i = 0; i < original.length; i++) {
        original[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.7;
      }

      const b64 = resampleAndConvertToPCM16Base64(original, 16000, 16000);
      const decoded = base64ToFloat32(b64);

      expect(decoded.length).toBe(original.length);
      for (let i = 0; i < original.length; i++) {
        // Allow small quantization error from PCM16
        expect(decoded[i] ?? 0).toBeCloseTo(original[i] ?? 0, 2);
      }
    });

    it('preserves signal through resample chain (48k -> 16k -> decode)', () => {
      const original48 = new Float32Array(480);
      for (let i = 0; i < original48.length; i++) {
        original48[i] = Math.sin((2 * Math.PI * 880 * i) / 48000) * 0.6;
      }

      const b64 = resampleAndConvertToPCM16Base64(original48, 48000, 16000);
      const decoded = base64ToFloat32(b64);

      // Length should be 160 (480 * 16000/48000)
      expect(decoded.length).toBe(160);
      // Values are averages of 3 consecutive original samples; verify the
      // averaged value rather than a single source sample.
      for (let i = 0; i < decoded.length; i++) {
        let accum = 0; let count = 0;
        for (let j = i * 3; j < (i + 1) * 3 && j < original48.length; j++) {
          accum += original48[j] ?? 0;
          count++;
        }
        const expected = count > 0 ? accum / count : 0;
        expect(decoded[i] ?? 0).toBeCloseTo(expected, 2);
      }
    });
  });

  describe('cross-platform encoding/decoding', () => {
    it('encode/decode round-trip via Uint8Array', () => {
      const data = new Uint8Array([0, 1, 255, 128, 64]);
      const b64 = encodeArrayBufferToBase64(data.buffer);
      const decoded = decodeBase64ToUint8Array(b64);
      expect(decoded.length).toBe(data.length);
      for (let i = 0; i < data.length; i++) {
        expect(decoded[i]).toBe(data[i]);
      }
    });

    it('pcm16ToFloat32 direct conversion', () => {
      const pcm16 = new Int16Array([0, 16384, -16384, 32767, -32768]);
      const float32 = pcm16ToFloat32(pcm16.buffer);
      expect(float32[0]).toBe(0);
      expect(float32[1]).toBeCloseTo(0.5, 3);
      expect(float32[2]).toBeCloseTo(-0.5, 3);
      expect(float32[3]).toBeCloseTo(1.0, 3);
      expect(float32[4]).toBeCloseTo(-1.0, 3);
    });
  });
});