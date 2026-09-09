/**
 * The microphone, as one dot that breathes with what it hears.
 *
 * ## Why the level is written to a custom property and not to state
 *
 * The ring follows the waveform, which moves about thirty-one times a second while
 * she listens and every frame while she talks. A `useState` there would re-render
 * the room at audio rate to change one number. So the loop lives here, reads
 * `voice.readLevel()` — a stable function over refs — and writes `--level` on the
 * button. React never learns that anything moved, and the compositor does the rest.
 *
 * The loop runs only while there is something to show, and not at all when the
 * platform has asked for reduced motion: a ring that pulses to a voice is
 * decoration, and the state it decorates is already carried by `data-open` and
 * `data-speaking`.
 *
 * ## Why it disappears rather than greys out
 *
 * `canHear: false` is not a microphone that is unavailable right now — it is a
 * server with no ear and no mouth, because `FLAG_VOICE` is off or there is no key.
 * A disabled control implies "later"; there is no later without a restart. The
 * composer beside it still works, so nothing is lost by the dot not being there.
 */

import { useEffect, useRef, type ReactElement } from 'react';

import { useMotionAllowed } from '../state/useReducedMotion.js';
import type { VoiceReading } from '../state/useVoice.js';

/** What the dot says out loud, since a pulsing circle is not readable. */
function micWords(voice: VoiceReading): string {
  if (!voice.open) return 'Let her hear you';
  if (voice.muted) return 'She cannot hear you — unmute';
  if (voice.speaking) return 'She is speaking. Speak to interrupt her.';
  return 'She is listening. Stop letting her hear you.';
}

export function Mic({ voice }: { voice: VoiceReading }): ReactElement | null {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const motion = useMotionAllowed();
  // Pulled out of `voice` so the effect below depends on the one stable thing it
  // uses. Depending on `voice` would restart the loop on every partial transcript —
  // about thirty times a second — to read a function that never changes.
  const { readLevel } = voice;
  const moving = motion && (voice.open || voice.speaking);

  useEffect(() => {
    const element = buttonRef.current;
    if (element === null) return;
    if (!moving) {
      element.style.setProperty('--level', '0');
      return;
    }
    let frame = 0;
    const tick = (): void => {
      // Square-rooted, because loudness is logarithmic and a linear RMS spends most
      // of its range looking like silence. This is the same reason a level meter is
      // never linear.
      element.style.setProperty('--level', Math.sqrt(readLevel()).toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      element.style.setProperty('--level', '0');
    };
  }, [moving, readLevel]);

  if (!voice.canHear) return null;

  const words = micWords(voice);
  return (
    <button
      className="plain mic"
      ref={buttonRef}
      type="button"
      onClick={() => {
        if (!voice.open) void voice.start();
        else voice.stop();
      }}
      onContextMenu={(event) => {
        // Right-click mutes without closing, which keeps the browser's microphone
        // indicator steady — see `setMuted` in `src/lib/audio/capture.ts` for why
        // that matters. Prevented so the platform menu does not also open.
        if (!voice.open) return;
        event.preventDefault();
        voice.setMuted(!voice.muted);
      }}
      disabled={voice.status !== 'live'}
      data-open={voice.open ? 'true' : 'false'}
      data-muted={voice.muted ? 'true' : 'false'}
      data-speaking={voice.speaking ? 'true' : 'false'}
      title={words}
      aria-label={words}
      aria-pressed={voice.open}
    >
      <span className="mic-dot" />
    </button>
  );
}

/**
 * One dim line: what she is hearing, or what she is saying.
 *
 * Live rather than committed. The transcript holds what stage 12 wrote and cannot
 * show a half-finished sentence; this is the half-finished sentence, and it is gone
 * the moment the real one lands. `aria-live="polite"` so a screen reader follows the
 * words without being interrupted mid-utterance.
 */
export function VoiceLine({ voice }: { voice: VoiceReading }): ReactElement | null {
  const text = voice.heard !== '' ? voice.heard : voice.saying;
  if (text === '') return null;
  return (
    <p className="voice-line" data-from={voice.heard !== '' ? 'him' : 'her'} aria-live="polite">
      {text}
    </p>
  );
}
