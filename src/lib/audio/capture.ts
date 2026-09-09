/**
 * The microphone, and the decision the browser makes that the server cannot.
 *
 * ## Who decides she has heard enough
 *
 * This file does. `listen` and `hush` are sent from here, from a threshold read
 * off the waveform, because the browser is where the waveform is: no network hop,
 * no provider round-trip, and silence is never paid for because it never leaves
 * the machine. The live model's own automatic activity detection is switched off
 * server-side for the same reason — see `server/voice/live/transport.ts`.
 *
 * ## The pre-roll, which is the difference between "kal" and "al"
 *
 * A threshold can only fire after enough signal has arrived to cross it, so by the
 * time speech is detected its first consonant is already in the past. Plosives are
 * the worst case: `k`, `t` and `p` are most of their own energy in twenty
 * milliseconds. So the last `PREROLL_FRAMES` are always kept, and sending starts
 * with them rather than with the frame that tripped the threshold. Without it the
 * transcriber reliably eats the first syllable of every sentence and the fault
 * looks like the model's.
 *
 * ## Why the threshold adapts
 *
 * `rms` is uncalibrated: it moves with the operating system's input gain, the
 * microphone, and the room. A constant would be wrong on most machines — too low
 * in a café and a fan opens her ear all evening; too high on a quiet laptop and she
 * never hears anything. So the quietest recent level is tracked as a noise floor
 * and speech is "several times louder than the room", with an absolute floor
 * underneath so that true digital silence cannot be multiplied up into speech.
 *
 * ## Why the graph ends in a silent gain node
 *
 * An `AudioWorkletNode` whose output goes nowhere is not guaranteed to be pulled:
 * the graph processes what reaches the destination. Connecting it through a gain of
 * zero keeps it running and puts nothing on the speakers — which is the whole
 * requirement, since routing a microphone to a destination is a feedback loop.
 */

import { downsample, INPUT_SAMPLE_RATE, rms, toPcm16 } from './pcm.js';

/** Where the worklet is served from. See its own header for why it is not bundled. */
const WORKLET_URL = '/voice-capture-worklet.js';

/** The processor name it registers. Must match `registerProcessor` there. */
const WORKLET_NAME = 'madhurita-capture';

/** How much speech is kept from before the threshold fired. 4 × 32 ms ≈ 128 ms. */
const PREROLL_FRAMES = 4;

/**
 * How many consecutive loud frames open the ear. 2 × 32 ms ≈ 64 ms.
 *
 * One frame would be enough for a door closing. Much more than two and the
 * pre-roll has to grow to compensate, which delays the whole turn.
 */
const ONSET_FRAMES = 2;

/**
 * How long she keeps listening through quiet. 700 ms.
 *
 * This is the pause between clauses, not the pause between turns: a person saying
 * "kal subah… doctor ka reminder" leaves a gap in the middle that must not end the
 * turn. Long enough to hold a thought, short enough that the answer does not feel
 * late.
 */
const HANGOVER_MS = 700;

/** How much louder than the room counts as speech. */
const SPEECH_OVER_FLOOR = 3.5;

/**
 * The quietest level that can be speech at all, whatever the floor says.
 *
 * A muted or disconnected microphone reports an RMS of around 1e-7. Multiplying
 * that by `SPEECH_OVER_FLOOR` would make numerical noise cross its own threshold,
 * and she would spend the evening listening to nothing and thinking about it.
 */
const ABSOLUTE_FLOOR = 0.004;

/** How fast the floor follows the room down, and up. */
const FLOOR_FALL = 0.4;
const FLOOR_RISE = 0.01;

export interface CaptureHandlers {
  /** One frame of PCM16 at `INPUT_SAMPLE_RATE`, ready for the socket. */
  onFrame: (pcm16: Int16Array) => void;
  /** Speech began: send `listen`. */
  onSpeechStart: () => void;
  /** Speech ended: send `hush`. */
  onSpeechEnd: () => void;
  /**
   * The current level in `[0, 1]`, every frame, speaking or not.
   *
   * Called ~31 times a second and never batched or coalesced, because this is what
   * the visual layer breathes to and it is local: the number never crosses a
   * network, so there is nothing to be gained by sending it less often.
   */
  onLevel: (level: number) => void;
  onError: (error: Error) => void;
}

export interface CaptureOptions {
  /** Overrides the hangover, for a test that does not want to wait 700 ms. */
  readonly hangoverMs?: number | undefined;
}

export interface CaptureHandle {
  /** What the graph actually runs at, which may not be what was asked for. */
  readonly sampleRate: number;
  /** Whether frames are being suppressed. */
  readonly muted: boolean;
  /**
   * Stops sending without releasing the microphone.
   *
   * Muting rather than stopping, because stopping drops the `MediaStream` and the
   * next unmute shows the browser's permission indicator again — a tab that
   * flickers its microphone light every time someone toggles a button looks like it
   * is doing something it should not be. A mute mid-utterance ends the turn
   * properly, so the server is never left with an ear it thinks is open.
   */
  setMuted: (muted: boolean) => void;
  stop: () => Promise<void>;
}

/**
 * Why capture could not start, in a form the interface can say out loud.
 *
 * `getUserMedia` rejects with a `DOMException` whose `name` is the only reliable
 * part — the `message` is browser-specific prose. These four are the ones a person
 * can act on, and `unsupported` is the one they cannot.
 */
export type CaptureFailure =
  | 'denied'
  | 'no_microphone'
  | 'in_use'
  | 'unsupported'
  | 'unknown';

export class CaptureError extends Error {
  readonly failure: CaptureFailure;

  constructor(failure: CaptureFailure, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.failure = failure;
  }
}

/**
 * Opens the microphone and starts sending frames when there is speech in them.
 *
 * Rejects with a `CaptureError` when the microphone cannot be had. Everything
 * after that point is reported through `onError` instead, because a graph that has
 * already started has a `stop()` the caller is holding and must be allowed to run.
 */
export async function startCapture(
  handlers: CaptureHandlers,
  options: CaptureOptions = {},
): Promise<CaptureHandle> {
  if (typeof navigator === 'undefined' || navigator.mediaDevices === undefined) {
    throw new CaptureError('unsupported', 'This browser has no microphone access.');
  }
  if (typeof AudioContext === 'undefined') {
    throw new CaptureError('unsupported', 'This browser has no Web Audio.');
  }

  const stream = await openStream();

  // Asking for 16 kHz lets the browser resample in native code and skips our own
  // downsampler entirely on the machines that honour it. Where it is ignored,
  // `context.sampleRate` reports the truth and `downsample` handles the rest — so
  // both paths run the same code and the common one costs nothing.
  const context = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
  const captureRate = context.sampleRate;

  try {
    await context.audioWorklet.addModule(WORKLET_URL);
  } catch (error) {
    stopStream(stream);
    await context.close().catch(() => {});
    throw new CaptureError(
      'unsupported',
      error instanceof Error ? `The capture worklet did not load: ${error.message}` : 'The capture worklet did not load.',
    );
  }

  // A context created while the page has no gesture behind it starts suspended.
  // This is called from a press, so this is belt and braces — and cheap.
  if (context.state === 'suspended') await context.resume().catch(() => {});

  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  const silence = context.createGain();
  silence.gain.value = 0;

  source.connect(worklet);
  worklet.connect(silence);
  silence.connect(context.destination);

  const hangoverMs = options.hangoverMs ?? HANGOVER_MS;

  let floor = ABSOLUTE_FLOOR;
  let loudRun = 0;
  let speaking = false;
  let quietSince = 0;
  let muted = false;
  let stopped = false;
  const preroll: Int16Array[] = [];

  const endTurn = (): void => {
    if (!speaking) return;
    speaking = false;
    loudRun = 0;
    handlers.onSpeechEnd();
  };

  worklet.port.onmessage = (event: MessageEvent<Float32Array>): void => {
    if (stopped) return;
    const raw = event.data;
    const samples = downsample(raw, captureRate, INPUT_SAMPLE_RATE);
    const level = rms(samples);
    handlers.onLevel(muted ? 0 : level);

    if (muted) return;

    // The floor falls quickly toward a quiet room and rises slowly, so a long
    // sentence cannot drag it up to its own level and switch the ear off mid-word.
    floor =
      level < floor ? floor + (level - floor) * FLOOR_FALL : floor + (level - floor) * FLOOR_RISE;

    const threshold = Math.max(ABSOLUTE_FLOOR, floor * SPEECH_OVER_FLOOR);
    const loud = level > threshold;
    const frame = toPcm16(samples);

    if (loud) {
      loudRun += 1;
      quietSince = 0;
    } else {
      loudRun = 0;
    }

    if (!speaking) {
      preroll.push(frame);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
      if (loudRun < ONSET_FRAMES) return;

      speaking = true;
      handlers.onSpeechStart();
      // The held frames first, oldest first, and the current one is among them —
      // it was pushed above rather than sent separately, which is what keeps the
      // stream free of a duplicated or reordered frame at every turn boundary.
      for (const held of preroll) handlers.onFrame(held);
      preroll.length = 0;
      return;
    }

    handlers.onFrame(frame);

    if (loud) return;
    const now = Date.now();
    if (quietSince === 0) {
      quietSince = now;
      return;
    }
    if (now - quietSince >= hangoverMs) {
      quietSince = 0;
      endTurn();
    }
  };

  return {
    sampleRate: captureRate,
    get muted() {
      return muted;
    },
    setMuted(next: boolean): void {
      if (muted === next) return;
      muted = next;
      preroll.length = 0;
      // A mute in the middle of a sentence has to close the turn, or the server
      // holds an open ear that will never be told the speech ended.
      if (muted) endTurn();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      endTurn();
      worklet.port.onmessage = null;
      try {
        source.disconnect();
        worklet.disconnect();
        silence.disconnect();
      } catch {
        // Disconnecting a node twice throws and means nothing.
      }
      stopStream(stream);
      await context.close().catch(() => {});
    },
  };
}

/**
 * The one call that asks for permission.
 *
 * The three processing constraints are not cosmetic. `echoCancellation` is what
 * stops her own voice from the speakers being heard as speech: without it, the
 * first sentence she says opens the ear, that becomes barge-in, and she interrupts
 * herself in a loop. `noiseSuppression` keeps a fan below the threshold; without
 * it the adaptive floor climbs and quiet speech stops registering.
 */
async function openStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    throw asCaptureError(error);
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** `DOMException.name` is the reliable part; the message is browser prose. */
function asCaptureError(error: unknown): CaptureError {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CaptureError(
        'denied',
        'The microphone was refused. Allow it in the address bar and try again.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CaptureError('no_microphone', 'No microphone was found.');
    case 'NotReadableError':
    case 'AbortError':
      return new CaptureError('in_use', 'Something else is using the microphone.');
    default:
      return new CaptureError(
        'unknown',
        error instanceof Error ? error.message : 'The microphone could not be opened.',
      );
  }
}
