/**
 * Her ear, her mouth and the socket between them, held for as long as the room is.
 *
 * ## What this hook owns, and why it is one hook and not three
 *
 * The socket, the microphone and the speaker are not three independent things. A
 * frame captured with no socket open is wasted work; audio arriving with no speaker
 * built is silence the interface would report as speech; and the one decision that
 * matters most — barge-in — needs all three in the same scope, because it means
 * "the microphone heard speech, so stop the speaker *now* and tell the socket". Split
 * across three hooks that would be a chain of effects firing in an order React does
 * not promise.
 *
 * ## The microphone is not opened on mount
 *
 * `getUserMedia` shows a permission prompt, and a page that asks for a microphone
 * before being asked to is a page people close. It opens on a press and closes on
 * one, and while it is closed the socket is still open — she can still be typed to,
 * and she can still speak first.
 *
 * ## Barge-in happens locally first
 *
 * When the capture threshold fires while she is talking, `cancel` goes on the wire
 * *and* the queued audio is dropped here, in the same tick. Waiting for the server's
 * own `flush` to come back would leave her talking over the interruption for a
 * round trip — and the audio that is already scheduled in the output context is up
 * to a second ahead of the speaker, so it is not enough to merely stop sending.
 *
 * ## The level is not React state
 *
 * `onLevel` fires about thirty-one times a second and the speaker's own level is
 * read per animation frame. Putting either in `useState` would re-render the room at
 * audio rate to move one ring. `readLevel` is a stable function over refs: whoever
 * draws it reads it in their own loop and nothing above them re-renders at all.
 *
 * ## The sample-rate check is not paranoia
 *
 * `ready` reports what the server expects, and this client hard-codes the same two
 * numbers in `./audio/pcm.ts`. If they ever disagree, every symptom is a *model*
 * symptom — she mishears everything, or her voice comes out slow and deep — so the
 * mismatch is refused here with a sentence that names it, rather than left to be
 * debugged as a bad transcription.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SessionState } from '@server/voice/session.js';

import {
  CaptureError,
  startCapture,
  type CaptureHandle,
} from '../lib/audio/capture.js';
import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE } from '../lib/audio/pcm.js';
import { createPlayback, type PlaybackHandle } from '../lib/audio/playback.js';
import { openVoiceSocket, type VoiceReady, type VoiceSocket, type VoiceStatus } from '../lib/voice.js';
import type { Notice } from './notice.js';

export interface VoiceReading {
  status: VoiceStatus;
  /** Where her session is, as the server reports it. */
  session: SessionState;
  /** Whether an ear and a mouth exist behind the socket at all. */
  canHear: boolean;
  /** The microphone is open and frames are going out. */
  open: boolean;
  muted: boolean;
  /** True while she is producing audio, from the speaker rather than the server. */
  speaking: boolean;
  /** What she has heard of the current utterance. `''` between turns. */
  heard: string;
  /** The line she is saying, from `said`. `''` when she is not saying one. */
  saying: string;
  notice: Notice | undefined;
  clearNotice: () => void;
  /** Asks for the microphone. Failures land in `notice`; this never rejects. */
  start: () => Promise<void>;
  /** Closes the microphone. The socket stays open. */
  stop: () => void;
  setMuted: (muted: boolean) => void;
  /**
   * A typed turn she answers out loud, or `undefined` when she cannot.
   *
   * `undefined` rather than a function that returns `false`, because the caller has
   * to choose a channel and not merely handle a failure: with no ear and no mouth
   * the same words still belong on `POST /api/chat`, which answers in text. The
   * distinction is the whole reason `say` exists on the socket — see the header of
   * `server/voice/live/protocol.ts`.
   */
  sayAloud: ((text: string) => boolean) | undefined;
  /**
   * How many turns the socket has finished with. Only ever rises.
   *
   * The socket's stand-in for a resolved promise. `sayAloud` returns the moment the
   * frame is on the wire; the outcome arrives later as `said`, as `silent`, as an
   * error, or as the socket going away, and a caller that showed a turn optimistically
   * needs all four — a turn that waits on only the first two waits forever on the
   * other two.
   *
   * Counted rather than described, because the count is all a caller can act on: it
   * re-reads the transcript, which is authoritative about what actually happened.
   *
   * Two of the error codes that move this — the ear closing, a frame the server
   * refused — are not the end of a turn at all, so a turn outstanding at that moment
   * settles early. The cost is a transcript read a couple of seconds ahead of the
   * commit, which `cycleCommits` then repeats correctly; the alternative is matching
   * on error-code strings the compiler cannot check, and a refusal that leaves a turn
   * thinking forever.
   */
  turnsSettled: number;
  /** The louder of the microphone and the speaker, in `[0, 1]`. Read per frame. */
  readLevel: () => number;
}

export interface VoiceOptions {
  /** True while we are in the room. A socket at the door would close with 4401. */
  active: boolean;
}

export function useVoice({ active }: VoiceOptions): VoiceReading {
  const [status, setStatus] = useState<VoiceStatus>('connecting');
  const [session, setSession] = useState<SessionState>('disconnected');
  const [canHear, setCanHear] = useState(false);
  const [open, setOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [heard, setHeard] = useState('');
  const [saying, setSaying] = useState('');
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [turnsSettled, setTurnsSettled] = useState(0);

  const socketRef = useRef<VoiceSocket | undefined>(undefined);
  const playbackRef = useRef<PlaybackHandle | undefined>(undefined);
  const captureRef = useRef<CaptureHandle | undefined>(undefined);
  const micLevel = useRef(0);

  /**
   * Whether the rates in `ready` matched ours. Refused capture rather than a notice
   * alone, so the microphone cannot be opened into a channel that will mishear it.
   */
  const ratesAgree = useRef(true);

  useEffect(() => {
    if (!active) {
      setStatus('closed');
      setSession('disconnected');
      setCanHear(false);
      return;
    }

    let live = true;
    const playback = createPlayback({
      onDrained: () => {
        if (!live) return;
        setSpeaking(false);
        setSaying('');
      },
    });
    playbackRef.current = playback;

    /** One turn is over, however it ended. See `turnsSettled`. */
    const settle = (): void => {
      if (!live) return;
      setTurnsSettled((count) => count + 1);
    };

    const socket = openVoiceSocket({
      onStatus: (next) => {
        if (!live) return;
        setStatus(next);
        // A socket that is not live cannot be sending frames, and a microphone left
        // open across a reconnection would spend the gap capturing into nothing and
        // then resume mid-word into a session that never heard the beginning.
        if (next !== 'live') {
          closeMic();
          // Whatever she was thinking about is now unreachable: the reply would have
          // come back on this socket. A reconnection opens a new session.
          settle();
        }
      },
      onReady: (ready) => {
        if (!live) return;
        setSession(ready.state);
        setCanHear(ready.canHear);
        const mismatch = rateMismatch(ready);
        ratesAgree.current = mismatch === undefined;
        if (mismatch !== undefined) setNotice({ kind: 'trouble', message: mismatch, issues: [], retryAfterMs: undefined });
      },
      onState: (next) => {
        if (!live) return;
        setSession(next);
      },
      onHeard: (text, final) => {
        if (!live) return;
        // The partial is replaced, not appended: the provider re-sends the whole
        // utterance so far, and concatenating would stutter every word. `final`
        // clears rather than keeps, because from there the words belong to the
        // transcript that stage 12 committed.
        setHeard(final ? '' : text);
      },
      onSaid: (text) => {
        if (!live) return;
        setSaying(text);
        setSpeaking(true);
        // The words are committed — stage 12 ran inside the cycle that produced them
        // — so a turn waiting on this one can read the transcript now, before any
        // audio of it exists.
        settle();
      },
      onSilent: () => {
        if (!live) return;
        setSaying('');
        // She thought and chose not to speak. A finished turn, not a missing one.
        settle();
      },
      onAudio: (bytes) => {
        playback?.enqueue(bytes);
      },
      onFlush: () => {
        playback?.flush();
        if (!live) return;
        setSpeaking(false);
        setSaying('');
      },
      onTurnEnd: () => {
        // Deliberately not `setSpeaking(false)`: the provider has stopped sending,
        // and up to a second of her voice is still scheduled ahead of the speaker.
        // `onDrained` is the honest end of a spoken turn.
      },
      onError: (code, message, fatal) => {
        if (!live) return;
        setNotice({
          kind: fatal ? 'trouble' : 'refusal',
          message,
          issues: [code],
          retryAfterMs: undefined,
        });
        // Two of these end a turn — her think-rate refusal, and a cycle that threw —
        // and neither produces a `said` or a `silent`. See `turnsSettled` for why
        // this is unconditional rather than matched against the code.
        settle();
      },
    });
    socketRef.current = socket;

    function closeMic(): void {
      const capture = captureRef.current;
      if (capture === undefined) return;
      captureRef.current = undefined;
      micLevel.current = 0;
      void capture.stop();
      if (live) {
        setOpen(false);
        setMuted(false);
      }
    }

    return () => {
      live = false;
      closeMic();
      socket.close();
      socketRef.current = undefined;
      void playback?.stop();
      playbackRef.current = undefined;
      setSpeaking(false);
      setSaying('');
      setHeard('');
    };
  }, [active]);

  const start = useCallback(async (): Promise<void> => {
    const socket = socketRef.current;
    if (socket === undefined || captureRef.current !== undefined) return;
    if (socket.status !== 'live' || !ratesAgree.current) return;

    try {
      const capture = await startCapture({
        onFrame: (pcm16) => socketRef.current?.sendAudio(pcm16),
        onSpeechStart: () => {
          // Barge-in, locally and immediately. See the header.
          const playback = playbackRef.current;
          if (playback?.speaking === true) {
            socketRef.current?.cancel();
            playback.flush();
            setSpeaking(false);
            setSaying('');
          }
          socketRef.current?.listen();
        },
        onSpeechEnd: () => socketRef.current?.hush(),
        onLevel: (level) => {
          micLevel.current = level;
        },
        onError: (error) => {
          setNotice({
            kind: 'trouble',
            message: error.message,
            issues: [],
            retryAfterMs: undefined,
          });
        },
      });
      captureRef.current = capture;
      setOpen(true);
      setMuted(capture.muted);
    } catch (error) {
      setNotice({
        kind: error instanceof CaptureError && error.failure === 'denied' ? 'refusal' : 'trouble',
        message: error instanceof Error ? error.message : 'The microphone could not be opened.',
        issues: [],
        retryAfterMs: undefined,
      });
    }
  }, []);

  const stop = useCallback((): void => {
    const capture = captureRef.current;
    if (capture === undefined) return;
    captureRef.current = undefined;
    micLevel.current = 0;
    void capture.stop();
    setOpen(false);
    setMuted(false);
  }, []);

  const setMutedNow = useCallback((next: boolean): void => {
    const capture = captureRef.current;
    if (capture === undefined) return;
    capture.setMuted(next);
    setMuted(next);
  }, []);

  const readLevel = useCallback((): number => {
    const speaker = playbackRef.current?.level() ?? 0;
    return Math.max(micLevel.current, speaker);
  }, []);

  const sayAloud = useCallback((text: string): boolean => {
    const socket = socketRef.current;
    if (socket === undefined) return false;
    return socket.say(text);
  }, []);

  const clearNotice = useCallback(() => setNotice(undefined), []);

  return {
    status,
    session,
    canHear,
    open,
    muted,
    speaking,
    heard,
    saying,
    notice,
    clearNotice,
    start,
    stop,
    setMuted: setMutedNow,
    sayAloud: status === 'live' && canHear ? sayAloud : undefined,
    turnsSettled,
    readLevel,
  };
}

/**
 * Compares the rates the server named against the ones this client is built on.
 *
 * Returns a sentence, or `undefined` when they agree. A sentence rather than a
 * boolean because there is nothing a person can do about this and everything a
 * developer can: the numbers themselves are the whole content of the report.
 */
function rateMismatch(ready: VoiceReady): string | undefined {
  if (ready.inputSampleRate === INPUT_SAMPLE_RATE && ready.outputSampleRate === OUTPUT_SAMPLE_RATE) {
    return undefined;
  }
  return (
    `She is expecting ${String(ready.inputSampleRate)} Hz in and ` +
    `${String(ready.outputSampleRate)} Hz out; this page is built for ` +
    `${String(INPUT_SAMPLE_RATE)} and ${String(OUTPUT_SAMPLE_RATE)}. ` +
    'Voice is switched off rather than left to mishear everything.'
  );
}
