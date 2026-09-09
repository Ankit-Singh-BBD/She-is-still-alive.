/**
 * The whole interface, in four states.
 *
 * ## Why the field is rendered here and not inside each screen
 *
 * `PresenceCanvas` sits outside the phase switch, so walking from the door into the
 * room does not unmount it. That is not a micro-optimisation: unmounting it would
 * destroy a WebGL2 context and build a new one, browsers cap how many of those a page
 * may have alive, and the visible result would be the room going black for a frame at
 * the exact moment someone has just been let in.
 *
 * ## The palette is written to `<html>`, not to a provider
 *
 * `applyPalette` sets fourteen custom properties on the document element, and the
 * stylesheet transitions them there. A React context would mean re-rendering every
 * component that reads a colour each time the sky changed, to produce a result CSS
 * gives for free — and it could not transition, because a custom property only
 * animates on the element that sets it.
 *
 * The effect depends on the palette object, which is a fresh identity on every state
 * frame. That is deliberate and cheap: writing a property to the value it already
 * holds is not a style change, so it neither repaints nor restarts the transition.
 *
 * ## `theme-color` is kept in step
 *
 * The one piece of the platform's own chrome this page can reach. Without it the
 * phone's status bar stays at the value in `index.html` while the room warms into
 * sunset, and the seam is visible on every scroll.
 *
 * ## Why the voice socket is opened here
 *
 * For the same reason the field is rendered here: one per page, and outliving the
 * screens. `useVoice` holds a `WebSocket`, a capture `AudioContext` and an output
 * `AudioContext`, and the browser counts all three. Opening it inside `Presence` would
 * tear the whole chain down and rebuild it on any re-mount, which for audio means a
 * dropped syllable rather than a dropped frame.
 *
 * It is also what lets a typed sentence be answered out loud: `useDialogue` takes the
 * socket's `say` as its transport when one exists, and both hooks have to be in the
 * same scope for that to be a parameter rather than a context.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { applyPalette, paletteVars } from '../lib/palette.js';
import { useDialogue } from '../state/useDialogue.js';
import { usePlace } from '../state/usePlace.js';
import { usePresence } from '../state/usePresence.js';
import { useMotionAllowed } from '../state/useReducedMotion.js';
import { useSession, type SessionState } from '../state/useSession.js';
import { useSignature } from '../state/useSignature.js';
import { useVoice } from '../state/useVoice.js';
import { PresenceCanvas } from '../visual/PresenceCanvas.js';
import { moodFrom } from '../visual/mood.js';
import { Ledger } from './Ledger.js';
import { Notice } from './Notice.js';
import { Presence } from './Presence.js';
import { Threshold } from './Threshold.js';

/**
 * The moment before `GET /api/hello` answers. Her name and nothing else — there is
 * genuinely nothing known yet, and a spinner would be an animation standing in for
 * information that is about a hundred milliseconds away.
 */
function Waking(): ReactElement {
  return (
    <div className="threshold">
      <span className="threshold-name">Madhurita</span>
    </div>
  );
}

/**
 * `GET /api/hello` did not answer. The only screen that admits the interface cannot
 * do anything for you, because without that one response "set her up" and "let me in"
 * are indistinguishable and guessing between them would mean typing a passphrase into
 * nothing.
 */
function Unreachable({ session }: { session: SessionState }): ReactElement {
  return (
    <div className="threshold">
      <div className="threshold-column">
        <span className="threshold-name">Madhurita</span>
        <div>
          <h1 className="threshold-line">She is not answering.</h1>
          <p className="threshold-under">
            This page loaded, so the interface is here. Her server is not — nothing was able to
            reach it, and until it does there is nothing to log in to.
          </p>
        </div>
        <button className="pill" type="button" onClick={session.retry}>
          Try her again
        </button>
        <Notice notice={session.notice} />
      </div>
    </div>
  );
}

export function App(): ReactElement {
  const session = useSession();
  const active = session.phase === 'room';

  const presence = usePresence({ active, onExpire: session.expire });
  const voice = useVoice({ active });
  // The stream is handed to the transcript because she can speak without being
  // spoken to. `usePresence` owns the one `EventSource` and counts the cycles that
  // commit on it; `useDialogue` re-reads whenever that count moves, so a turn from
  // a cycle this client never started still reaches the screen.
  //
  // `speak` and `turnsSettled` are the same arrangement for the socket: it is the
  // faster and more capable channel for a typed turn when she has a mouth, because
  // she answers that turn out loud, and it reports its own outcomes rather than
  // resolving a promise.
  const dialogue = useDialogue({
    active,
    onExpire: session.expire,
    cycleCommits: presence.cycleCommits,
    speak: voice.sayAloud,
    voiceTurns: voice.turnsSettled,
  });
  const place = usePlace({ active });
  const motion = useMotionAllowed();
  const [ledgerOpen, setLedgerOpen] = useState(false);

  // Either channel. `dialogue.thinking` is only this client's own outstanding turn;
  // the session state is her, thinking about whatever reached her — including a
  // sentence she was spoken, which puts nothing on screen until it commits.
  const thinking = dialogue.thinking || voice.session === 'thinking';

  // The interface's own small voice. Nothing below this line calls it: it derives
  // every cue from the readings already on this page, for the same reason the palette
  // is written to `<html>` rather than threaded through a provider. See its header.
  const sound = useSignature({
    phase: session.phase,
    sending: dialogue.thinking,
    thinking,
    lastReply: dialogue.lastReply,
    voiceTurns: voice.turnsSettled,
    saying: voice.saying,
    micOpen: voice.open,
    dialogueNotice: dialogue.notice,
    voiceNotice: voice.notice,
  });

  const mood = useMemo(
    () =>
      moodFrom({
        state: presence.state,
        status: presence.status,
        thinking,
      }),
    [presence.state, presence.status, thinking],
  );

  const palette = presence.state?.environment.derivedPalette;
  useEffect(() => {
    if (palette === undefined) return;
    applyPalette(palette);
    const ground = paletteVars(palette)['--ground'];
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null && ground !== undefined) meta.setAttribute('content', ground);
  }, [palette]);

  return (
    <>
      <PresenceCanvas mood={mood} motion={motion} />

      <div className="stage">
        {session.phase === 'waking' ? <Waking /> : null}
        {session.phase === 'unreachable' ? <Unreachable session={session} /> : null}
        {session.phase === 'door' ? <Threshold session={session} /> : null}
        {session.phase === 'room' ? (
          <Presence
            hello={session.hello}
            state={presence.state}
            status={presence.status}
            dialogue={dialogue}
            voice={voice}
            thinking={thinking}
            place={place}
            busy={session.busy}
            onLeave={() => void session.leave()}
            onOpenLedger={() => setLedgerOpen(true)}
          />
        ) : null}
      </div>

      <Ledger
        open={ledgerOpen}
        onClose={() => setLedgerOpen(false)}
        state={presence.state}
        status={presence.status}
        absentAtBoot={session.hello?.absentAtBoot ?? []}
        sound={sound}
      />
    </>
  );
}
