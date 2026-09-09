/**
 * When the interface makes a sound, and when it deliberately does not.
 *
 * ## One observer, no `cue()` calls in components
 *
 * Nothing in `src/ui/` knows this file exists. The cues are derived here from the
 * same authoritative readings everything else on screen is derived from — the
 * session phase, `dialogue.thinking`, `lastReply.status`, `voice.turnsSettled` — for
 * the same reason no component holds a palette of its own: a cue fired from a click
 * handler is a second opinion about what happened, and the two drift. A press that
 * the server then refuses is not a turn, and a turn she was *spoken* is a turn with
 * no press behind it at all.
 *
 * So every cue below is a transition in state that had to be correct anyway. If the
 * screen is right, the sound is right.
 *
 * ## Silence while the ear is open
 *
 * `micOpen` suppresses everything except the two cues that mark the ear opening and
 * closing. Two reasons, and the second is the one that decided it:
 *
 *  - `startCapture` asks for `echoCancellation`, which on most browsers covers the
 *    whole output device and would keep a cue out of the microphone. On the ones
 *    where it only covers WebRTC's own path, a 440 Hz note at three times the noise
 *    floor is `onSpeechStart` — the interface would barge in on her with its own
 *    chime.
 *  - Someone who has opened the microphone is talking. A sound over their sentence
 *    is the exact cheapness this set exists to avoid.
 *
 * ## Nothing fires on the first render
 *
 * Every observer holds the previous value in a ref and compares. A cue on mount
 * would mean a reload sounded like an event, and `threshold` — which does fire on
 * arrival — is a real transition out of `waking`, not a default.
 *
 * ## Why an unheard cue is not a bug
 *
 * A tab that has had no gesture cannot play audio, so arriving with a live session
 * plays nothing. That is the honest outcome: see `createSignature` for why a cue is
 * dropped rather than deferred.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { createSignature, type CueName, type SignatureHandle } from '../lib/audio/signature.js';
import type { ChatReply } from '../lib/api.js';
import type { Notice } from './notice.js';
import type { Phase } from './useSession.js';

/**
 * Where the preference lives.
 *
 * `localStorage` rather than the server: this is about the speakers in front of one
 * person, not about her. Storing it under her identity would mean the same setting
 * followed him onto a machine with no sound and a machine in a shared room.
 */
const STORAGE_KEY = 'madhurita.sound';

/** Off is stored explicitly; anything else, including nothing, means on. */
function storedPreference(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private browsing, or storage denied. The default stands rather than throwing
    // during a render.
    return true;
  }
}

/** The two cues that are allowed to sound while the microphone is open. */
function atTheEar(name: CueName): boolean {
  return name === 'listening' || name === 'unlistening';
}

export interface SignatureOptions {
  phase: Phase;
  /**
   * `dialogue.thinking` — a turn *this client sent* is outstanding.
   *
   * Narrower than `thinking` on purpose, and the distinction is the whole of `sent`:
   * words she was spoken were never sent by anything, so a cue for them would be
   * reporting a keystroke that did not happen.
   */
  sending: boolean;
  /** She is thinking, on either channel. Guards the outcome cues. */
  thinking: boolean;
  /** `dialogue.lastReply` — how the HTTP channel's own cycle went. */
  lastReply: ChatReply | undefined;
  /** `voice.turnsSettled` — the socket's stand-in for a resolved promise. */
  voiceTurns: number;
  /** `voice.saying` — non-empty when the turn that just settled produced words. */
  saying: string;
  /** `voice.open` — the microphone is open, so the interface stays quiet. */
  micOpen: boolean;
  dialogueNotice: Notice | undefined;
  voiceNotice: Notice | undefined;
}

export interface SignatureState {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
}

export function useSignature({
  phase,
  sending,
  thinking,
  lastReply,
  voiceTurns,
  saying,
  micOpen,
  dialogueNotice,
  voiceNotice,
}: SignatureOptions): SignatureState {
  const [enabled, setEnabledState] = useState(storedPreference);

  /**
   * The handle, and whether it has been asked for.
   *
   * Two refs rather than one, because `createSignature` returns `undefined` where
   * there is no Web Audio and that is a permanent answer — a single ref would ask
   * again on every cue and build nothing, forever.
   */
  const handle = useRef<SignatureHandle | undefined>(undefined);
  const built = useRef(false);

  // Read through refs so `cue` keeps one identity for the life of the hook. It is a
  // dependency of nine effects; a new function per render would re-run all of them
  // on every keystroke in the composer.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const micRef = useRef(micOpen);
  micRef.current = micOpen;

  const cue = useCallback((name: CueName): void => {
    if (!enabledRef.current) return;
    if (micRef.current && !atTheEar(name)) return;
    // Built on the first cue, not on mount: a context created before any gesture
    // starts suspended, and some browsers log about it on every load.
    if (!built.current) {
      built.current = true;
      handle.current = createSignature();
    }
    handle.current?.cue(name);
  }, []);

  useEffect(
    () => () => {
      void handle.current?.stop();
      handle.current = undefined;
      built.current = false;
    },
    [],
  );

  const setEnabled = useCallback((next: boolean): void => {
    setEnabledState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // The setting still holds for this visit, which is the part that matters now.
    }
  }, []);

  // Arriving. `useSession` always starts at `waking`, so this is a real transition on
  // every visit — including a reload straight into a live session, where it is the
  // one cue that says the door was already open.
  const phaseRef = useRef(phase);
  useEffect(() => {
    const previous = phaseRef.current;
    phaseRef.current = phase;
    if (phase === 'room' && previous !== 'room') cue('threshold');
  }, [phase, cue]);

  // Words left this client. `useDialogue` sets `thinking` before the request goes out
  // on the HTTP path and before `awaitingVoice` on the socket, so this is the
  // keystroke rather than the answer — which is the whole point of a send cue.
  const sendingRef = useRef(sending);
  useEffect(() => {
    const previous = sendingRef.current;
    sendingRef.current = sending;
    if (sending && !previous) cue('sent');
  }, [sending, cue]);

  // The HTTP channel's outcome, and the one place a cue reads a cycle's own verdict.
  // Identity is the signal rather than any field: `api.chat` returns a fresh object
  // per cycle, so two consecutive replies that happen to be equal are still two.
  const replyRef = useRef(lastReply);
  useEffect(() => {
    const previous = replyRef.current;
    replyRef.current = lastReply;
    if (lastReply === undefined || lastReply === previous) return;
    // `degraded` and `failed` both get the descending pair. She answered either way —
    // `failed` still returns a reply — and the interval is the only thing that says
    // it was not clean, which is `cycleWords`' job to say in prose.
    cue(lastReply.status === 'completed' ? 'answered' : 'degraded');
  }, [lastReply, cue]);

  // The socket's outcome. `turnsSettled` rises on all four of them, so `thinking` is
  // the guard: a reconnection while nobody is waiting also settles, and a cue there
  // would report a turn that did not exist.
  //
  // `saying` separates the two outcomes that produced words from the two that did
  // not. It is read through a ref because `onSaid` sets it in the same batch as the
  // counter, so by the time this runs it is already the settled turn's line. The one
  // case it reads wrong is an error arriving after a spoken line has been drawn:
  // that plays `answered`, and the notice cue below plays over it.
  const sayingRef = useRef(saying);
  sayingRef.current = saying;
  const voiceTurnsRef = useRef(voiceTurns);
  useEffect(() => {
    const previous = voiceTurnsRef.current;
    voiceTurnsRef.current = voiceTurns;
    if (voiceTurns <= previous || !thinking) return;
    cue(sayingRef.current === '' ? 'silent' : 'answered');
    // `thinking` is deliberately not a dependency: it is a guard read at the moment
    // the counter moves, and listing it would fire this again on the render that
    // clears it, for a turn already reported.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceTurns, cue]);

  // The ear. Both cues bypass the `micOpen` gate — see the header — and `unlistening`
  // is held to the room so that leaving does not sound like closing a microphone.
  const micOpenRef = useRef(micOpen);
  useEffect(() => {
    const previous = micOpenRef.current;
    micOpenRef.current = micOpen;
    if (micOpen === previous) return;
    if (micOpen) cue('listening');
    else if (phase === 'room') cue('unlistening');
    // `phase` is a guard, not a trigger: leaving the room closes the microphone and
    // changes the phase in the same commit, and depending on it would re-fire here on
    // the next phase change with the microphone already shut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micOpen, cue]);

  // Both notice channels, watched apart. `Presence` draws both lines rather than
  // arbitrating between them, and this does the same: two things went wrong is not
  // one thing going wrong, and `MIN_GAP` collapses the pair into one sound anyway.
  const dialogueNoticeRef = useRef(dialogueNotice);
  useEffect(() => {
    const previous = dialogueNoticeRef.current;
    dialogueNoticeRef.current = dialogueNotice;
    if (dialogueNotice !== undefined && dialogueNotice !== previous) cue('trouble');
  }, [dialogueNotice, cue]);

  const voiceNoticeRef = useRef(voiceNotice);
  useEffect(() => {
    const previous = voiceNoticeRef.current;
    voiceNoticeRef.current = voiceNotice;
    if (voiceNotice !== undefined && voiceNotice !== previous) cue('trouble');
  }, [voiceNotice, cue]);

  return { enabled, setEnabled };
}
