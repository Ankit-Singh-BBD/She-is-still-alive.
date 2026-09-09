/**
 * Her ear's first millimetre: the only code that runs on the audio thread.
 *
 * A plain `.js` file in `public/` rather than a module under `src/`, and that is a
 * CSP decision, not laziness. The alternative is a `Blob` URL built at runtime,
 * which needs `blob:` in `script-src` — and `script-src 'self'` with no `blob:` is
 * the one directive in `securityHeaders` doing real work, because a generated
 * script source is exactly what turns a small injection into a large one. Served
 * from origin, this file needs no exception at all. `public/sw.js` is here for the
 * same reason.
 *
 * ## Why it does almost nothing
 *
 * `process()` runs every 128 samples — about 375 times a second at 48 kHz — on a
 * real-time thread where an allocation or a slow frame is an audible glitch. So
 * this batches and posts, and every conversion (downsample, PCM16, RMS) happens
 * on the main thread in `src/lib/audio/pcm.ts`, where it is typechecked and
 * tested. The arithmetic is a few thousand operations per batch; the main thread
 * does not notice it, and the audio thread must not be asked to carry code that
 * can be changed by someone who does not know that.
 *
 * ## Why it posts a copy
 *
 * `inputs[0][0]` is a view onto a buffer the graph reuses on the next quantum.
 * Posting it would send whatever it holds by the time the message is read, which
 * is a race that shows up as intermittent noise rather than as a bug. The batch is
 * a `Float32Array` this worklet owns, and it is transferred — the receiver takes
 * the memory, and a fresh one is allocated for the next batch.
 */

/** 512 samples: 32 ms at 16 kHz, 4 render quanta, ~31 messages a second. */
const BATCH_SAMPLES = 512;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(BATCH_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // No input is normal, not an error: it happens for a quantum or two while the
    // track is starting, and after it is muted. Returning true keeps the node
    // alive so capture resumes when the track does.
    if (channel === undefined) return true;

    let read = 0;
    while (read < channel.length) {
      const room = BATCH_SAMPLES - this.filled;
      const take = Math.min(room, channel.length - read);
      this.batch.set(channel.subarray(read, read + take), this.filled);
      this.filled += take;
      read += take;

      if (this.filled === BATCH_SAMPLES) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        // The buffer above is gone — transferred, not copied. Anything other than
        // a fresh allocation here reads as zeroes.
        this.batch = new Float32Array(BATCH_SAMPLES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('madhurita-capture', CaptureProcessor);
