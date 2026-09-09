/**
 * The four conversions between a browser's audio and the wire's.
 *
 * These are the only pure functions in the voice path, and every bug in them wears a
 * costume. A downsampler that decimates instead of averaging sounds like a bad
 * microphone. A `toPcm16` that scales both signs by 32768 turns the loudest moment of
 * every word into a click. A `fromPcm16` that reads in host byte order works on every
 * machine anyone tests on and produces white noise on a big-endian one. An `rms` that
 * measured peak instead of energy would hear a keyboard as speech and interrupt her.
 *
 * So each test below asserts the arithmetic that the costume hides, and names the
 * symptom it would otherwise be mistaken for. This file replaces
 * `tests/p18/resampler.test.ts`, which tested a base64 pipeline that no longer exists:
 * our socket carries PCM16 as binary frames in both directions, so the round trip under
 * test is `Float32 → Int16 → bytes → Float32` with nothing textual in the middle.
 */

import { describe, expect, it } from 'vitest';

import {
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  downsample,
  fromPcm16,
  rms,
  toPcm16,
} from '../../src/lib/audio/pcm.js';

/** `toPcm16` then the byte layout a binary WebSocket frame would carry. */
function onTheWire(samples: Float32Array): Uint8Array {
  const pcm = toPcm16(samples);
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** The full round trip, as `capture.ts` sends it and `playback.ts` receives it. */
function roundTrip(samples: Float32Array): Float32Array {
  return fromPcm16(onTheWire(samples));
}

describe('the rates the two ends agree on', () => {
  it('names 16 kHz in and 24 kHz out', () => {
    // Hard-coded in three places by necessity — here, in the client, and in the live
    // transport — and checked against the server's `ready` frame at runtime by
    // `useVoice`. Playing her 24 kHz voice through a 16 kHz context stretches it by
    // half, which reads as a different, slower person rather than as arithmetic.
    expect(INPUT_SAMPLE_RATE).toBe(16_000);
    expect(OUTPUT_SAMPLE_RATE).toBe(24_000);
  });
});

describe('downsample', () => {
  it('returns the input untouched when there is nothing to do', () => {
    const input = new Float32Array([0.5, -0.5, 0.25]);
    // Identity by reference, not by value: a 16 kHz microphone is common and copying
    // its buffer 125 times a second to change nothing is the kind of waste that only
    // shows up as battery.
    expect(downsample(input, 16_000, 16_000)).toBe(input);
    expect(downsample(input, 16_000, 24_000)).toBe(input);
  });

  it('averages rather than decimates on a whole ratio', () => {
    // Twelve samples at 48 kHz to four at 16 kHz, each output the mean of three. If
    // this picked every third sample instead, the two assertions below would read
    // 0.6 and 0.4 as well — so the input is shaped to make averaging distinguishable:
    // the third group's mean is not any of its members.
    const input = new Float32Array([0.6, 0.6, 0.6, 0.4, 0.4, 0.4, -0.3, 0.0, 0.3, 0.8, 0.8, 0.8]);
    const output = downsample(input, 48_000, 16_000);

    expect(output.length).toBe(4);
    expect(output[0]).toBeCloseTo(0.6, 5);
    expect(output[1]).toBeCloseTo(0.4, 5);
    expect(output[2]).toBeCloseTo(0, 5);
    expect(output[3]).toBeCloseTo(0.8, 5);
  });

  it('folds nothing back into the speech band', () => {
    // The reason averaging is not a preference. This is a 20 kHz tone at 48 kHz —
    // above everything a 16 kHz channel can represent. Averaged, it cancels to nearly
    // nothing, which is what a low-pass is for. Decimated, it would alias down to
    // 4 kHz at full amplitude and sit in the middle of the voice she has to transcribe.
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin((2 * Math.PI * 20_000 * i) / 48_000);
    }
    expect(rms(downsample(input, 48_000, 16_000))).toBeLessThan(0.35);
    expect(rms(input)).toBeGreaterThan(0.6);
  });

  it('handles a ratio that is not a whole number', () => {
    // 44.1 kHz is what most consumer hardware actually reports, and 44100/16000 is
    // 2.75625 — so the box boundaries land between samples and the group sizes
    // alternate between two and three. The length has to come out right anyway and no
    // sample may leave the representable range.
    const input = new Float32Array(441);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / 44_100) * 0.5;
    }
    const output = downsample(input, 44_100, 16_000);

    expect(output.length).toBe(160);
    for (const sample of output) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });

  it('leaves no gap where a box boundary lands between samples', () => {
    // A ramp, because the failure this catches is invisible in a tone. Each output is
    // the mean of a group of two or three consecutive samples, so on strictly
    // increasing input the output must be strictly increasing too — a boundary that
    // went backwards, repeated a group, or emptied one (the `count > 0` branch returns
    // zero) all break that. Checked at the awkward ratio rather than a clean one.
    const ramp = new Float32Array(441);
    for (let i = 0; i < ramp.length; i += 1) ramp[i] = (i + 1) / ramp.length;
    const output = downsample(ramp, 44_100, 16_000);

    for (let i = 1; i < output.length; i += 1) expect(output[i]!).toBeGreaterThan(output[i - 1]!);
    // And the ends are inside the input's own range, which is what says the first
    // group started at the beginning and the last one ended at the end.
    expect(output[0]!).toBeGreaterThan(ramp[0]!);
    expect(output[output.length - 1]!).toBeLessThan(ramp[ramp.length - 1]!);
    expect(output[output.length - 1]!).toBeGreaterThan(ramp[ramp.length - 4]!);
  });

  it('has nothing to say about an empty buffer', () => {
    expect(downsample(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });
});

describe('toPcm16', () => {
  it('does not wrap full scale around to the loudest negative', () => {
    // The one that matters. Two's complement holds 32768 negative values and 32767
    // positive ones, so scaling `1.0` by 32768 overflows to −32768: the top of a loud
    // word becomes a bang. The asymmetric scale is what prevents it.
    const pcm = toPcm16(new Float32Array([1, -1]));
    expect(pcm[0]).toBe(32_767);
    expect(pcm[1]).toBe(-32_768);
  });

  it('clamps out-of-range samples instead of wrapping them', () => {
    // Nothing in the browser promises `[-1, 1]` — a gain node or a badly behaved
    // device can hand over more. Clamped, that distorts; unclamped, it wraps, and a
    // wrapped sample is a full-scale sign flip in the middle of a syllable.
    const pcm = toPcm16(new Float32Array([2, -2, 1.5, -1.5]));
    expect([...pcm]).toEqual([32_767, -32_768, 32_767, -32_768]);
  });

  it('leaves silence silent', () => {
    expect([...toPcm16(new Float32Array(4))]).toEqual([0, 0, 0, 0]);
  });
});

describe('fromPcm16', () => {
  it('reads little-endian regardless of the host', () => {
    // Written by hand rather than through an `Int16Array`, which would read in host
    // order and make this test agree with a broken implementation on every machine
    // it is likely to run on. `0x0100` little-endian is 256; big-endian it is 1.
    const bytes = new Uint8Array([0x00, 0x01]);
    expect(fromPcm16(bytes)[0]).toBeCloseTo(256 / 0x7fff, 6);
  });

  it('survives an odd byteOffset', () => {
    // `new Int16Array(buffer, 1, …)` throws `RangeError` on an unaligned offset, and
    // nothing stops a runtime from handing over a view that has one. `DataView` is
    // the reason this is a passing test rather than a crash in the speaker.
    const source = new Uint8Array(5);
    source[1] = 0x00;
    source[2] = 0x40; // 0x4000 → half scale
    source[3] = 0x00;
    source[4] = 0xc0; // 0xc000 → minus half scale
    const odd = new Uint8Array(source.buffer, 1, 4);

    const samples = fromPcm16(odd);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(0.5, 3);
    expect(samples[1]).toBeCloseTo(-0.5, 3);
  });

  it('drops a trailing half sample rather than failing', () => {
    // A chunk boundary is wherever the network put it, and the next frame does not
    // carry the other half of this byte. One lost sample at 24 kHz is 41 microseconds;
    // a thrown error would be the whole rest of the sentence.
    const samples = fromPcm16(new Uint8Array([0x00, 0x40, 0x7f]));
    expect(samples.length).toBe(1);
    expect(samples[0]).toBeCloseTo(0.5, 3);
  });

  it('hands the speaker a buffer it will accept', () => {
    // `AudioBuffer.copyToChannel` refuses a view over a `SharedArrayBuffer` and says
    // so in its own signature. This is the one function whose output goes there.
    expect(fromPcm16(new Uint8Array([0, 0])).buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('has nothing to say about an empty frame', () => {
    expect(fromPcm16(new Uint8Array(0)).length).toBe(0);
  });
});

describe('the round trip a spoken turn actually makes', () => {
  it('keeps a waveform within one quantisation step', () => {
    const original = new Float32Array(320);
    for (let i = 0; i < original.length; i += 1) {
      original[i] = Math.sin((2 * Math.PI * 440 * i) / INPUT_SAMPLE_RATE) * 0.7;
    }
    const decoded = roundTrip(original);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i += 1) {
      // PCM16's step is 1/32768 ≈ 0.00003. Anything looser than this is not
      // quantisation, it is a bug in the scaling.
      expect(decoded[i]!).toBeCloseTo(original[i]!, 4);
    }
  });

  it('returns full scale as full scale, both ways', () => {
    const decoded = roundTrip(new Float32Array([1, -1, 0]));
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe(-1);
    expect(decoded[2]).toBe(0);
  });

  it('survives the capture path end to end', () => {
    // What `capture.ts` does per render quantum: downsample from the device rate,
    // convert, send. Asserted against the averages rather than the source samples,
    // because averaging is the intended loss.
    const device = new Float32Array(480);
    for (let i = 0; i < device.length; i += 1) {
      device[i] = Math.sin((2 * Math.PI * 880 * i) / 48_000) * 0.6;
    }
    const decoded = roundTrip(downsample(device, 48_000, INPUT_SAMPLE_RATE));

    expect(decoded.length).toBe(160);
    for (let i = 0; i < decoded.length; i += 1) {
      expect(decoded[i]!).toBeCloseTo(mean(device.subarray(i * 3, i * 3 + 3)), 4);
    }
  });
});

describe('rms', () => {
  it('is zero for silence and one for full scale', () => {
    expect(rms(new Float32Array(128))).toBe(0);
    expect(rms(new Float32Array(128).fill(1))).toBeCloseTo(1, 6);
    expect(rms(new Float32Array(0))).toBe(0);
  });

  it('measures energy, not peak', () => {
    // The reason the threshold that reads this does not fire on a keyboard. One
    // full-scale sample in a quantum of 128 is a click; its peak is 1 and its RMS is
    // under a tenth, which is below anything `capture.ts` calls speech.
    const click = new Float32Array(128);
    click[64] = 1;
    expect(rms(click)).toBeCloseTo(Math.sqrt(1 / 128), 6);
    expect(rms(click)).toBeLessThan(0.1);
  });

  it('ignores the sign of the signal', () => {
    // Squared before summing, so a waveform and its inversion are equally loud. A
    // caller that averaged instead would read a symmetric tone as silence.
    const tone = new Float32Array(128);
    for (let i = 0; i < tone.length; i += 1) tone[i] = i % 2 === 0 ? 0.5 : -0.5;
    expect(rms(tone)).toBeCloseTo(0.5, 6);
    expect(mean(tone)).toBeCloseTo(0, 6);
  });
});

function mean(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample;
  return sum / samples.length;
}
