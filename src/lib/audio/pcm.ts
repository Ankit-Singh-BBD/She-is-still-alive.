/**
 * The four conversions between what a browser has and what the wire carries.
 *
 * Pure functions, no `AudioContext`, no `WebSocket`, no `Buffer` — which is why
 * they are testable in Node and why they live apart from the two files that use
 * them. Everything here is a hot path: `downsample` and `toPcm16` run on every
 * 128-sample render quantum, `fromPcm16` on every chunk she speaks.
 *
 * ## There is no base64 in this file, and that is the point
 *
 * The version this replaces (`server/voice/adapters/resampler.ts`) returned
 * base64 from the resampler and took base64 into the decoder, because the legacy
 * path put audio inside JSON. This one does not: our WebSocket carries PCM16 as
 * binary frames in both directions. 16 kHz mono PCM16 is 32 kB/s, and base64
 * costs a third more bytes plus a `JSON.parse` twenty times a second on both
 * ends. Base64 survives in exactly one place in the whole application — the
 * provider hop in `server/voice/live/transport.ts`, which requires it.
 *
 * ## Why 16 kHz in and 24 kHz out
 *
 * Not symmetry, and not a choice: the live model transcribes 16 kHz input and
 * synthesises 24 kHz output. Playing her 24 kHz voice through a context that
 * believes it is 16 kHz stretches it by half and she sounds like a different,
 * slower person — which is the one bug in this file that would be mistaken for a
 * model problem rather than an arithmetic one.
 */

/** What the ear expects. Mirrors `INPUT_SAMPLE_RATE` in the live transport. */
export const INPUT_SAMPLE_RATE = 16_000;

/** What the mouth produces. Mirrors `OUTPUT_SAMPLE_RATE` in the live transport. */
export const OUTPUT_SAMPLE_RATE = 24_000;

/**
 * Averages a Float32 buffer down to a lower sample rate.
 *
 * Box-averaging rather than picking every nth sample, which is what makes this a
 * downsampler and not an aliaser: a microphone at 48 kHz carries content up to
 * 24 kHz, and decimating without averaging folds everything above 8 kHz back down
 * into the speech band as a metallic buzz the transcriber then has to hear
 * through. Averaging is a crude low-pass, and crude is enough for a 16 kHz
 * mono voice channel.
 *
 * A rate at or below the target returns the input untouched — a `48000 → 48000`
 * call should cost nothing, and up-sampling is not something this needs to do.
 */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (input.length === 0) return new Float32Array(0);
  if (from <= to) return input;

  const ratio = from / to;
  const outputLength = Math.round(input.length / ratio);
  const output = new Float32Array(outputLength);

  let readFrom = 0;
  for (let i = 0; i < outputLength; i += 1) {
    const readTo = Math.min(Math.round((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = readFrom; j < readTo; j += 1) {
      sum += input[j] ?? 0;
      count += 1;
    }
    output[i] = count > 0 ? sum / count : 0;
    readFrom = readTo;
  }
  return output;
}

/**
 * Float32 `[-1, 1]` to signed 16-bit.
 *
 * The asymmetric scale — `0x8000` for negatives, `0x7fff` for positives — is not
 * a rounding preference. Two's complement holds one more negative value than
 * positive, so scaling both by 32768 makes a sample of exactly `1.0` overflow to
 * −32768: full-scale silence-to-loud becomes a click at the top of every loud
 * word. Clamping first means a caller's out-of-range sample distorts rather than
 * wraps, which is the difference between quiet clipping and a bang.
 */
export function toPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return pcm;
}

/**
 * Signed 16-bit little-endian bytes back to Float32 `[-1, 1]`.
 *
 * Takes bytes rather than an `Int16Array` because that is what arrives: a
 * `WebSocket` binary message is an `ArrayBuffer`, and a chunk boundary is wherever
 * the network put it.
 *
 * `DataView` rather than `new Int16Array(bytes.buffer, bytes.byteOffset, …)` for
 * two reasons that both bite in production. A view whose `byteOffset` is odd
 * makes the typed-array constructor throw `RangeError`, and there is nothing
 * stopping a runtime from handing over an odd offset. And `Int16Array` reads in
 * the host's byte order, so the same code would decode correctly on every machine
 * anyone tests on and produce white noise on a big-endian one. `getInt16(i, true)`
 * says little-endian and means it.
 *
 * An odd trailing byte is dropped rather than treated as an error: it is half a
 * sample, the next chunk does not carry its other half, and one lost sample at
 * 24 kHz is 41 microseconds.
 *
 * The return type names its backing buffer, which the other three functions here do
 * not need to. `AudioBuffer.copyToChannel` refuses a view over a
 * `SharedArrayBuffer` and says so in its own signature, and this is the one function
 * whose output goes there — so the guarantee is stated where it is made rather than
 * asserted with a cast at the call site.
 */
export function fromPcm16(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (sampleCount === 0) return new Float32Array(0);

  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    const value = view.getInt16(i * 2, true);
    samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return samples;
}

/**
 * Root mean square of a buffer, as a rough loudness in `[0, 1]`.
 *
 * The number the voice-activity threshold is compared against, and the number the
 * visual layer breathes to. RMS rather than peak because peak reacts to a single
 * sample — a keyboard click would register as speech — while RMS is energy over
 * the window and a click is one sample out of 128.
 *
 * Not calibrated to anything: it is the raw signal level, so a gain change in the
 * operating system moves it. That is why the threshold that reads it adapts to the
 * quietest recent level instead of trusting a constant.
 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}
