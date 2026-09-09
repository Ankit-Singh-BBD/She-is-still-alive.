/**
 * The interface's own small voice: eight cues, none of them a second long.
 *
 * ## Why this is not `playback.ts`
 *
 * That file is *her* mouth — 24 kHz PCM off a socket, scheduled sample-accurately
 * against a cursor because a gap in it sounds like a bad model. This one is the
 * room's: eight short synthesised gestures that report what the interface just did.
 * They share nothing but the Web Audio API. Putting them in one context would tie
 * a UI click to the sample rate the provider happens to synthesise at, and would
 * mean a `flush` for barge-in silenced the cue that said the barge-in landed.
 *
 * ## Synthesised, not sampled
 *
 * Eight audio files would be eight requests, a cache story, and about 200 KB for
 * roughly four seconds of sound. Every cue here is one to three sine or triangle
 * notes with an envelope, which is a few hundred bytes of table and no dependency —
 * and it means the character of the whole set is six numbers at the top of this
 * file rather than something baked into assets nobody can edit.
 *
 * ## Why the notes are all from one scale
 *
 * Two cues can overlap: a turn is sent, and the refusal arrives before the first
 * one has decayed. Every frequency below is drawn from one A-minor pentatonic set,
 * so any pair of them is consonant and an overlap sounds like one instrument rather
 * than like two notifications colliding. That is the whole of the "signature": it is
 * the same small set of pitches every time, in a different order.
 *
 * ## Loudness
 *
 * `MASTER` is the one number that matters and it is deliberately very low. This is
 * furniture, not feedback — it should be noticeable in a quiet room and inaudible
 * over anything else. Nothing here ever plays while she is speaking loudly, because
 * her voice runs through a different context at a normal level.
 */

/** Every cue the interface can play. Named for what happened, not for how it sounds. */
export type CueName =
  /** Crossing from the door into the room. The only cue with three notes. */
  | 'threshold'
  /** A turn left this client, on either channel. */
  | 'sent'
  /** She answered, and the cycle was clean. */
  | 'answered'
  /** She thought and chose not to speak. A finished turn, and not the same as silence. */
  | 'silent'
  /** She answered, but a stage fell back. Descending, because it is less than clean. */
  | 'degraded'
  /** A refusal or a fault was raised. The lowest cue in the set. */
  | 'trouble'
  /** The microphone opened. */
  | 'listening'
  /** The microphone closed. */
  | 'unlistening';

/**
 * Peak of the whole path. Every cue's own gain is a fraction of this.
 *
 * 0.055 is about −25 dBFS, which in a quiet room is present and in a room with
 * anything else happening is gone. Raising it is the single change that would make
 * this set feel cheap, so it is one constant and not a per-cue decision.
 */
const MASTER = 0.055;

/** Softens the two triangle notes. Sines pass it untouched, which is the point. */
const CUTOFF = 2400;

/**
 * Seconds of ramp into each note.
 *
 * Not zero. A gain that steps from silence to its peak is a click — a discontinuity
 * the speaker reproduces as a broadband tick — and a click is the exact sound of a
 * cheap interface. 12 ms is inaudible as an attack and removes it completely.
 */
const ATTACK = 0.012;

/**
 * Where each envelope decays to.
 *
 * `exponentialRampToValueAtTime` cannot be given zero, so the tail lands here and
 * the oscillator is stopped just after. Low enough to be silence at this master gain.
 */
const FLOOR = 0.0005;

/**
 * The shortest gap between two cues, in seconds.
 *
 * Not a debounce on any one cue — every cue below is worth hearing once. This is
 * the guard against a pile-up: several notices raised in one tick would otherwise
 * schedule a dozen oscillators on the same instant, which is loud in a way none of
 * the individual gains predict.
 */
const MIN_GAP = 0.04;

/** One note of one cue. Absolute values, so a cue is a table and not a program. */
interface Tone {
  /** Hz where the note starts. */
  from: number;
  /** Hz where it ends. Equal to `from` for a note that does not bend. */
  to: number;
  /** Seconds after the cue begins. */
  at: number;
  /** Seconds the envelope lasts, `ATTACK` included. */
  hold: number;
  /** Peak of this note's own envelope, as a fraction of `MASTER`. */
  gain: number;
  type: OscillatorType;
}

/**
 * A note, with the two fields that are usually the default left out.
 *
 * `to` defaults to `from` and `type` to `sine`, which is the shape of all but four
 * notes in the table — so writing them out would bury the two that bend and the two
 * that need body under the ten that do not.
 */
function tone(
  from: number,
  spec: { at: number; hold: number; gain: number; to?: number; type?: OscillatorType },
): Tone {
  return {
    from,
    to: spec.to ?? from,
    at: spec.at,
    hold: spec.hold,
    gain: spec.gain,
    type: spec.type ?? 'sine',
  };
}

/**
 * The whole set. A-minor pentatonic, so any two of these overlapping is a chord.
 *
 * The shape of each one carries its meaning rather than its volume doing it: rising
 * for something opening, descending for something less than it should be, one
 * unresolved note for a turn that ended without words.
 */
const CUES: Record<CueName, readonly Tone[]> = {
  // Rising through the scale, and the only cue allowed to take most of a second.
  // It plays once per visit, at the moment the room appears.
  threshold: [
    tone(220.0, { at: 0.0, hold: 0.55, gain: 0.5, type: 'triangle' }),
    tone(329.63, { at: 0.05, hold: 0.5, gain: 0.42 }),
    tone(493.88, { at: 0.1, hold: 0.7, gain: 0.32 }),
  ],
  // Downward and gone in a tenth of a second. This fires on every keystroke that
  // sends, so it is the one cue that has to survive being heard a hundred times.
  sent: [tone(493.88, { at: 0.0, hold: 0.1, gain: 0.28, to: 440.0 })],
  // Up a fourth. The resolution `silent` deliberately does not have.
  answered: [
    tone(587.33, { at: 0.0, hold: 0.18, gain: 0.32 }),
    tone(880.0, { at: 0.055, hold: 0.3, gain: 0.24 }),
  ],
  // One note, held, going nowhere. She finished the turn and had nothing to say; an
  // interface that played `answered` here would be claiming words that do not exist.
  silent: [tone(329.63, { at: 0.0, hold: 0.34, gain: 0.2 })],
  // A descending minor third. Not an alarm — she did answer — but audibly not the
  // interval `answered` plays.
  degraded: [
    tone(440.0, { at: 0.0, hold: 0.16, gain: 0.28 }),
    tone(369.99, { at: 0.06, hold: 0.3, gain: 0.24 }),
  ],
  // The lowest pair in the set, and triangles, so it reads as present at a gain that
  // is no higher than the rest.
  trouble: [
    tone(293.66, { at: 0.0, hold: 0.18, gain: 0.32, type: 'triangle' }),
    tone(220.0, { at: 0.07, hold: 0.34, gain: 0.28, type: 'triangle' }),
  ],
  // A fifth up, short. Mirrored exactly by `unlistening`, because opening and closing
  // an ear are the same act in two directions and should not need to be learnt twice.
  listening: [
    tone(440.0, { at: 0.0, hold: 0.09, gain: 0.24 }),
    tone(659.25, { at: 0.045, hold: 0.16, gain: 0.2 }),
  ],
  unlistening: [
    tone(659.25, { at: 0.0, hold: 0.09, gain: 0.2 }),
    tone(440.0, { at: 0.045, hold: 0.18, gain: 0.22 }),
  ],
};

export interface SignatureHandle {
  /**
   * Plays one cue. Returns immediately, and never throws.
   *
   * Silent rather than queued when `MIN_GAP` has not elapsed, and silent rather than
   * deferred while the context is suspended — see `createSignature` for why the
   * second one is the right answer instead of a bug.
   */
  cue: (name: CueName) => void;
  stop: () => Promise<void>;
}

/**
 * Builds the cue path, or `undefined` where there is no Web Audio.
 *
 * `undefined` for the same reason `createPlayback` returns it: in jsdom there is no
 * `AudioContext`, and a no-op object would let a caller believe the interface has a
 * voice and never find out otherwise. Every caller here already has to hold the
 * handle as optional, so there is no branch to add.
 *
 * The context is built when this is called, and this is called on the first cue
 * rather than on mount — see `useSignature`. A context created before any gesture
 * starts `suspended`, and some browsers log a warning about it on every load.
 */
export function createSignature(): SignatureHandle | undefined {
  if (typeof AudioContext === 'undefined') return undefined;

  const context = new AudioContext();

  const master = context.createGain();
  master.gain.value = MASTER;

  const warmth = context.createBiquadFilter();
  warmth.type = 'lowpass';
  warmth.frequency.value = CUTOFF;
  warmth.Q.value = 0.7;

  master.connect(warmth);
  warmth.connect(context.destination);

  let stopped = false;
  /** The context clock at the last cue that actually played. See `MIN_GAP`. */
  let lastCueAt = Number.NEGATIVE_INFINITY;

  return {
    cue(name: CueName): void {
      if (stopped || context.state === 'closed') return;

      // Not awaited, as in `playback.ts`. The difference from that file is what a
      // suspended context means here: her voice is a stream that should be heard
      // whenever it can be, so it stays queued; a cue is a report about something
      // that happened a moment ago, and playing it late is worse than not at all.
      // The schedule below is against a clock that does not advance while suspended,
      // so the notes simply never arrive, which is the outcome this wants.
      if (context.state === 'suspended') void context.resume().catch(() => {});

      const now = context.currentTime;
      if (now - lastCueAt < MIN_GAP) return;
      lastCueAt = now;

      for (const note of CUES[name]) {
        const start = now + note.at;
        const end = start + note.hold;

        const osc = context.createOscillator();
        osc.type = note.type;
        osc.frequency.setValueAtTime(note.from, start);
        if (note.to !== note.from) osc.frequency.exponentialRampToValueAtTime(note.to, end);

        const envelope = context.createGain();
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(note.gain, start + ATTACK);
        envelope.gain.exponentialRampToValueAtTime(FLOOR, end);

        osc.connect(envelope);
        envelope.connect(master);
        // Disconnected on the way out rather than left to the collector: an
        // oscillator that has stopped is inaudible but its node is still in the
        // graph, and a long session is a few thousand cues.
        osc.onended = (): void => {
          osc.disconnect();
          envelope.disconnect();
        };
        osc.start(start);
        osc.stop(end + 0.02);
      }
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      master.disconnect();
      warmth.disconnect();
      await context.close().catch(() => {});
    },
  };
}
