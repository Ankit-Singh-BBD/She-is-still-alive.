/**
 * Her voice, and the clock that decides when each piece of it is heard.
 *
 * ## Why the chunks are scheduled and not just played
 *
 * Audio arrives from the provider in pieces of whatever size the network chose,
 * twenty-odd times a second. Calling `start()` on each as it lands would place
 * every one at "now", and "now" moves while JavaScript is doing something else —
 * so consecutive pieces overlap or leave holes, and a sentence comes out with a
 * stutter in it that sounds exactly like a bad model.
 *
 * Instead a cursor is kept in the context's own clock. Each chunk is scheduled at
 * the cursor and the cursor advances by that chunk's duration. The result is
 * sample-accurate: the pieces abut with no gap regardless of when they arrived or
 * what the main thread was busy with, because the audio thread already holds the
 * whole schedule.
 *
 * ## Why the cursor starts ahead of now
 *
 * `SCHEDULE_LEAD` is the jitter buffer, and it is the one real latency trade in
 * this file. Zero means the first chunk is scheduled at a time that has already
 * passed by the time the audio thread looks — which is a truncated first syllable.
 * Large means she answers late. 90 ms is roughly one network hiccup and below the
 * threshold where a reply feels delayed.
 *
 * ## Why this context is not capture's context
 *
 * The live model transcribes 16 kHz and synthesises 24 kHz. An `AudioContext` has
 * one sample rate, and playing 24 kHz samples through a context that believes it is
 * running at 16 kHz stretches her voice by half — she becomes a slower, deeper,
 * different person. Two contexts is the cost of the provider's asymmetry.
 *
 * ## Why `flush` exists and what it is really for
 *
 * Barge-in. When someone speaks over her, the server sends `flush` and the audio
 * already scheduled must not be heard — including the part that is seconds into the
 * future and would otherwise arrive after she has been interrupted, answering a
 * question nobody is still asking. Stopping the sources is the only way to unsay
 * something that has already been handed to the audio thread.
 */

import { fromPcm16, OUTPUT_SAMPLE_RATE, rms } from './pcm.js';

/** How far ahead of the clock the first chunk of a turn is placed. */
const SCHEDULE_LEAD = 0.09;

/**
 * How much of the tail is examined for the level the interface breathes to.
 *
 * 2048 samples at 24 kHz is 85 ms — long enough that the number does not flicker
 * between syllables, short enough to still fall on the consonants.
 */
const ANALYSER_FFT = 2048;

export interface PlaybackHandlers {
  /**
   * Everything queued has finished being heard.
   *
   * Not the same event as the server's `turn_end`, and the difference matters: the
   * server says that when the provider stopped sending, while up to
   * `SCHEDULE_LEAD` plus whatever is buffered is still ahead of the speaker. An
   * interface that returned to "listening" on `turn_end` would show her waiting
   * while she is still audibly talking.
   */
  onDrained?: (() => void) | undefined;
}

export interface PlaybackHandle {
  /** What the output context actually runs at. */
  readonly sampleRate: number;
  /** Whether anything is currently scheduled and unfinished. */
  readonly speaking: boolean;
  /**
   * PCM16 little-endian bytes straight off the socket, at `OUTPUT_SAMPLE_RATE`.
   *
   * Takes bytes rather than samples because that is what a binary WebSocket frame
   * is, and a chunk boundary lands wherever the network put it — including on an
   * odd byte, which `fromPcm16` is written to survive.
   */
  enqueue: (bytes: Uint8Array) => void;
  /** Drops everything scheduled and not yet heard. Barge-in, `cancel`, drift. */
  flush: () => void;
  /** The current output level in `[0, 1]`, for the visual layer to read. */
  level: () => number;
  stop: () => Promise<void>;
}

/**
 * Builds the output path, or `undefined` where there is no Web Audio.
 *
 * `undefined` rather than a throw, and rather than a silent no-op object: in jsdom
 * there is no `AudioContext`, and the honest answer to "can she be heard here" is
 * no. The voice client checks and stops asking for audio, the same way
 * `openPresenceStream` degrades when `EventSource` is missing. A no-op object
 * would let a caller believe a mouth exists and never find out otherwise.
 */
export function createPlayback(handlers: PlaybackHandlers = {}): PlaybackHandle | undefined {
  if (typeof AudioContext === 'undefined') return undefined;

  const context = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
  const outputRate = context.sampleRate;

  const analyser = context.createAnalyser();
  analyser.fftSize = ANALYSER_FFT;
  analyser.connect(context.destination);
  // Allocated once. `level()` is called from a render loop, and a fresh array per
  // frame at 60 Hz is garbage the collector then has to pause the animation for.
  const tail = new Float32Array(ANALYSER_FFT);

  /** The sources that have been scheduled and have not reported `ended`. */
  const live = new Set<AudioBufferSourceNode>();

  /** Where in the context's clock the next chunk goes. */
  let cursor = 0;
  let stopped = false;

  const drained = (): void => {
    if (live.size > 0) return;
    cursor = 0;
    handlers.onDrained?.();
  };

  /**
   * Unsays everything that has been handed to the audio thread.
   *
   * A named function rather than a method on the returned object, because `stop`
   * calls it and a `this.flush()` there would break the moment a caller wrote
   * `const { stop } = playback`.
   */
  const flush = (): void => {
    // Snapshotted, because `stop()` fires `onended` synchronously in some
    // browsers and mutating the set while iterating it is how you get a source
    // that is never disconnected.
    const scheduled = [...live];
    live.clear();
    cursor = 0;
    for (const source of scheduled) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished. Stopping it again throws and means nothing.
      }
      source.disconnect();
    }
  };

  return {
    sampleRate: outputRate,
    get speaking() {
      return live.size > 0;
    },

    enqueue(bytes: Uint8Array): void {
      if (stopped) return;
      const samples = fromPcm16(bytes);
      if (samples.length === 0) return;

      // A context can be suspended by the browser at any time — a backgrounded
      // tab, or a page that never had a gesture. Not awaited: the schedule below
      // is in the context's own clock, which does not advance while suspended, so
      // the chunks stay in order and simply start being heard once it resumes.
      if (context.state === 'suspended') void context.resume().catch(() => {});

      const buffer = context.createBuffer(1, samples.length, outputRate);
      buffer.copyToChannel(samples, 0);

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);

      // A cursor behind the clock means the queue ran dry — the network stalled
      // mid-sentence, or this is the first chunk of a turn. Either way the only
      // options are a gap or a chunk scheduled in the past, and a chunk in the
      // past is played truncated, which loses samples rather than delaying them.
      const now = context.currentTime;
      const at = cursor > now ? cursor : now + SCHEDULE_LEAD;
      cursor = at + buffer.duration;

      live.add(source);
      source.onended = (): void => {
        live.delete(source);
        source.disconnect();
        drained();
      };
      source.start(at);
    },

    flush,

    level(): number {
      if (stopped || live.size === 0) return 0;
      analyser.getFloatTimeDomainData(tail);
      return rms(tail);
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      flush();
      analyser.disconnect();
      await context.close().catch(() => {});
    },
  };
}
