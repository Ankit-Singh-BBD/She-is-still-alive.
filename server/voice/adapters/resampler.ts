/**
 * P18 — Voice Plumbing Refactor
 * Audio format conversion and resampling utilities.
 * Pure functions with zero external dependencies, runnable in both Browser and Node.
 */

/**
 * Robust averaging downsampler from any source sample rate to PCM16 Base64.
 * Matches legacy AudioStreamer algorithm for exact bitwise parity.
 */
export function resampleAndConvertToPCM16Base64(
  inputBuffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16000,
): string {
  if (inputBuffer.length === 0) return '';

  let samples: Float32Array;

  if (inputSampleRate === outputSampleRate) {
    samples = inputBuffer;
  } else {
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.round(inputBuffer.length / ratio);
    samples = new Float32Array(outputLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < samples.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
        const val = inputBuffer[i];
        if (val !== undefined) {
          accum += val;
          count++;
        }
      }
      samples[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
  }

  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Clamp sample between -1.0 and 1.0
    const sample = samples[i] ?? 0;
    const s = Math.max(-1, Math.min(1, sample));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  // Cross-environment Base64 encoding
  return encodeArrayBufferToBase64(pcm16.buffer);
}

/**
 * Converts Base64 PCM16 into Float32Array with minimal allocation overhead.
 * Matches legacy AudioPlayer algorithm for exact bitwise parity.
 */
export function base64ToFloat32(base64: string): Float32Array {
  if (!base64 || typeof base64 !== 'string') return new Float32Array(0);
  try {
    const cleanBase64 = base64.replace(/\s+/g, '');
    // Validate base64 format (must be valid base64 chars with padding)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64) || cleanBase64.length % 4 !== 0) {
      return new Float32Array(0);
    }
    const bytes = decodeBase64ToUint8Array(cleanBase64);
    if (bytes.byteLength % 2 !== 0) return new Float32Array(0);

    const int16Array = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const numSamples = int16Array.length;
    const float32Array = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const s = int16Array[i] ?? 0;
      float32Array[i] = s < 0 ? s / 32768 : s / 32767;
    }
    return float32Array;
  } catch (err) {
    console.warn('Failed to parse base64 audio PCM16 chunk:', err);
    return new Float32Array(0);
  }
}

/**
 * Converts PCM16 ArrayBuffer directly to Float32Array.
 */
export function pcm16ToFloat32(pcm16Buffer: ArrayBuffer): Float32Array {
  const int16Array = new Int16Array(pcm16Buffer);
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    const s = int16Array[i] ?? 0;
    float32Array[i] = s < 0 ? s / 32768 : s / 32767;
  }
  return float32Array;
}

/**
 * Cross-platform Base64 encoder for ArrayBuffer / Uint8Array.
 */
export function encodeArrayBufferToBase64(buffer: ArrayBufferLike): string {
  const uint8 = new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(uint8).toString('base64');
  }
  let binary = '';
  const CHUNK_SIZE = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
    const chunk = uint8.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Cross-platform Base64 decoder returning Uint8Array.
 */
export function decodeBase64ToUint8Array(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(base64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len) 
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
