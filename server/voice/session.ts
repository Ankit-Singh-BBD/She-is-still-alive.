/**
 * The voice session's state, and the single place a transition is legal or not.
 *
 * ## Why this type is not a private detail of the voice subsystem
 *
 * `SessionState` is the word three layers use for one fact.
 * `server/voice/live/protocol.ts` sends it to the browser as `{t:'state'}`,
 * `server/realtime/types.ts` re-exports it as `VoiceLiveState` inside
 * `RuntimeState`, and `src/state/useVoice.ts` holds it in React state. A state this
 * machine can reach is therefore a state the interface must be able to show, which
 * is why the union is short — and why `'error'` is no longer in it.
 *
 * ## Why an illegal transition throws
 *
 * Every caller is `server/voice/live/session.ts`, and every transition it asks for
 * follows from something that already happened: a socket opened, the provider
 * committed a transcript, a line finished streaming. So an illegal transition is
 * not bad input arriving from outside — it is the voice orchestrator having lost
 * track of where it is, and the honest answer to that is to fail loudly rather than
 * hold the old state and go on reporting it to the browser as if it were true. Same
 * rule the cycle follows when a stage throws: say so, name it, never paper over it.
 *
 * ## Why there is no `'error'` state
 *
 * There was one, worked by `onError`, `retry` and `reset`, and no production path
 * ever reached any of them — the only callers were tests. That is not an unwired
 * feature; it is the design saying something. In `server/voice/live/session.ts` a
 * provider that will not connect, a transport that faults, and a provider that hangs
 * up are all deliberately *non-fatal*: the transport is dropped, the browser is sent
 * `{t:'error', code, message, fatal:false}`, and the session stays `listening`
 * because typed turns genuinely do still work. Entering an `'error'` state there
 * would have put `broken` into `RuntimeState` while she was still answering — a
 * worse lie than the one the state was meant to prevent. The failure *is* reported;
 * it is reported on the channel that can carry a code and a reason.
 *
 * So the state is gone rather than kept for later. If a failure ever arrives that
 * genuinely ends a session without closing its socket, it earns the state back in
 * the same change that produces it.
 *
 * ## Why a callback and not an EventEmitter
 *
 * There is exactly one subscriber and there always will be: `VoiceSession`, which
 * fans each transition out to the browser and to the event bus. An `EventEmitter`
 * bought nothing for that and cost the payload its type — the old code asserted the
 * shape with `as` on the way out and re-declared it inline on the way in, so the two
 * halves were never checked against each other. One callback is checked at both ends.
 */

export type SessionState =
  | 'disconnected'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking';

export interface SessionStateChangeEvent {
  readonly previous: SessionState;
  readonly current: SessionState;
  /** Always present: every transition below names what caused it. */
  readonly reason: string;
}

/**
 * Which transitions exist. The table is the design, so each edge says why it is
 * there; an edge that is absent is one the orchestrator must never ask for.
 */
const TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = {
  /** Nothing happens to a closed session but opening it. */
  disconnected: ['connecting'],
  /** The provider answers, or the caller gives up waiting for it. */
  connecting: ['listening', 'disconnected'],
  /**
   * `speaking` without passing through `thinking` is her speaking first — the
   * autonomic loop starting a cycle nobody asked for. A documented property of
   * hers, not a stray edge.
   */
  listening: ['thinking', 'speaking', 'disconnected'],
  /** `listening` again is a cycle that chose not to speak: a decision, not a failure. */
  thinking: ['listening', 'speaking', 'disconnected'],
  /**
   * `thinking` is barge-in — the user cut in and the next cycle began before the
   * line she was already saying had finished.
   */
  speaking: ['listening', 'thinking', 'disconnected'],
};

export class LiveSessionStateMachine {
  private current: SessionState = 'disconnected';
  private readonly onTransition: ((change: SessionStateChangeEvent) => void) | undefined;

  /**
   * @param onTransition Called synchronously after each accepted transition.
   *   Optional because a machine whose transitions only need to be *correct* — which
   *   is what most of its tests check — has nothing to tell anyone.
   */
  constructor(onTransition?: (change: SessionStateChangeEvent) => void) {
    this.onTransition = onTransition;
  }

  get state(): SessionState {
    return this.current;
  }

  /** The provider is being dialled. */
  start(): void {
    this.transitionTo('connecting', 'start');
  }

  /** The provider answered, or there is no ear and typed turns are what is left. */
  onConnected(): void {
    this.transitionTo('listening', 'connected');
  }

  /** The utterance ended, so a cycle is about to run over what was heard. */
  onSpeechEnd(): void {
    this.transitionTo('thinking', 'speech_end');
  }

  /** The cycle finished and authorized no line. She is allowed to stay quiet. */
  onThinkingFinished(): void {
    this.transitionTo('listening', 'thinking_finished_no_speech');
  }

  /** An authorized line has started reaching the speaker. */
  onTtsStart(): void {
    this.transitionTo('speaking', 'tts_start');
  }

  /** That line finished, was cancelled, or drifted and was flushed. */
  onTtsEnd(): void {
    this.transitionTo('listening', 'tts_end');
  }

  /** Safe from any state, including `disconnected`, where it does nothing. */
  stop(): void {
    this.transitionTo('disconnected', 'stop');
  }

  private transitionTo(next: SessionState, reason: string): void {
    // Asking for the state it is already in is not an error and is not news — the
    // orchestrator guards several of these calls on state it read a moment ago, and
    // a no-op event would still have gone out over the socket.
    if (this.current === next) return;

    if (!TRANSITIONS[this.current].includes(next)) {
      throw new Error(`Illegal state transition from '${this.current}' to '${next}'`);
    }

    const previous = this.current;
    this.current = next;
    this.onTransition?.({ previous, current: next, reason });
  }
}
