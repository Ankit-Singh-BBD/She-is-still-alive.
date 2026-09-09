/**
 * One voice session: her ear, her mind, her mouth, and the four gates that keep
 * the live model a faculty rather than the author of what she says.
 *
 * A turn runs in one direction only, and every step of it is on this side of the
 * wire:
 *
 *   mic frames → transport.sendAudio → onHeard(partial…) → onHeard(final)
 *     → runCycle({ source: 'audio' })  ← the twelve stages, on the reasoning model
 *     → stage 9's authorized line → {t:'said'} to the browser
 *     → transport.render(line) → onAudio(chunks) → the browser's speaker
 *
 * ## The four gates
 *
 * 1. **`voice:participate`**, once, when the socket opens. `mayBeHeardInVoice` is
 *    false for a guest, and until now nothing in the process ever asked: the
 *    permission existed, `server/authz/index.ts` honoured it, and no caller
 *    reached that branch. This is its caller. A denial closes the socket with
 *    `CLOSE_FORBIDDEN` rather than degrading, because there is no honest degraded
 *    form of "you may not be heard in voice".
 *
 * 2. **The drop rule.** `activityEnd` makes the live model answer on its own —
 *    there is no flag that asks for transcription without generation. So audio
 *    that arrives when no `render` is outstanding is counted and discarded. It is
 *    one `if` in `handleAudioFromModel`, and it is the difference between this
 *    application and a wrapper around a speech model.
 *
 * 3. **`voiceEnabled`**, per response, from stage 9. The line still reaches the
 *    transcript; it is simply not spoken. A draft can prefer silence aloud, and
 *    stage 9 is where that was decided.
 *
 * 4. **The drift check.** The mouth is asked to say one line. What it actually
 *    voiced comes back as `outputAudioTranscription`, and if that diverges from
 *    the authorized line the audio is flushed mid-sentence. A model that started
 *    improvising is a model speaking without authorization, however plausible it
 *    sounds.
 *
 * ## Why the browser channel is an interface
 *
 * `VoiceClientChannel` is three methods, so every test in
 * `tests/voice/live-session.test.ts` drives a real session with a real runtime and
 * a real database and no socket, no key and no network. The `ws` import lives in
 * `server/http/ws.ts` and nowhere else.
 *
 * ## What is deliberately not here
 *
 * No audio is persisted and no frame becomes a domain event. `EventBus.publish`
 * writes a row and awaits its handlers; at twenty frames a second in each
 * direction that is a disk-filling mistake. What is durable is what was *heard*
 * and what was *said* — two `voice.transcript` events per turn — plus the state
 * transitions. The samples themselves are transport.
 */

import { check } from '@server/authz/index.js';
import type { CognitiveRuntime } from '@server/cognition/runtime.js';
import type { CycleRecord } from '@server/cognition/types.js';
import type { ConversationRepository } from '@server/conversations/repository.js';
import type { EventBus } from '@server/events/event-bus.js';
import type { Identity } from '@server/identity/types.js';
import { toRomanHinglish } from '@server/lang/index.js';

import { LiveSessionStateMachine, type SessionState } from '../session.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  MAX_AUDIO_FRAME_BYTES,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';
import {
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  type LiveTransport,
  type LiveTransportCallbacks,
  type LiveTransportFactory,
  type LiveVoiceConfig,
} from './transport.js';

/**
 * How long a closed ear waits for the provider to finalise a transcript.
 *
 * `activityEnd` normally produces the final transcription within a few hundred
 * milliseconds. If it never comes — a dropped provider frame, a turn the model
 * decided was empty — the words already accumulated are used anyway. The
 * alternative is a session that heard a whole sentence and never thinks about it,
 * which from the user's chair is indistinguishable from her ignoring them.
 */
export const TRANSCRIPT_GRACE_MS = 2_500;

/**
 * How much of the authorized line must actually have been voiced.
 *
 * Checked once, when the turn ends, because a partial transcript legitimately
 * covers only part of the line while audio is still arriving. Two thirds rather
 * than all of it: the provider's transcription of its own speech drops the odd
 * word, and flushing a correct rendering over one missing token would make her
 * stutter for no reason.
 */
export const DRIFT_MIN_COVERAGE = 0.65;

/**
 * How many words the mouth may voice that were not in the line.
 *
 * Checked continuously, because this is the failure that must be caught *during*
 * the sentence — the model that answers the line instead of reading it starts
 * emitting unauthorized words immediately, and waiting for the turn to end would
 * mean the user has already heard them. A fixed floor of four absorbs
 * transcription noise on a short line; the ratio takes over on a long one.
 */
export const DRIFT_EXTRA_FLOOR = 4;
export const DRIFT_EXTRA_RATIO = 0.4;

/**
 * How long the ear may take to open before it is treated as absent.
 *
 * Not a tuning knob — it is the only thing standing between a rejected setup
 * message and a session that never finishes opening. `client.live.connect()` waits
 * for the provider's `setupComplete` and there is no path in the SDK that rejects
 * that promise, so a `config` the provider dislikes closes the socket with 1007 and
 * leaves the await pending for the life of the process. This was not hypothetical:
 * `proactivity` was a documented SDK field that `gemini-3.1-flash-live-preview`
 * answered with
 *
 *     1007  Unknown name "proactivity" at 'setup': Cannot find field.
 *
 * and the observable symptom was not an error anywhere — it was a browser sitting
 * on a socket that had authenticated and would never be sent `ready`.
 *
 * Ten seconds because a healthy connect settles in about half of one, and because
 * this delay is paid by a person looking at the screen waiting to be let in. When
 * it expires she loses the ear and keeps the session: `say` runs the same twelve
 * stages, which is the same trade the `catch` below makes.
 */
export const EAR_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The three things a session does to the browser.
 *
 * `sendAudio` takes raw bytes because that is what goes on the wire: PCM16 at
 * `OUTPUT_SAMPLE_RATE` as a binary frame, with no envelope to parse.
 */
export interface VoiceClientChannel {
  send(message: ServerMessage): void;
  sendAudio(pcm16: Uint8Array): void;
  close(code: number, reason: string): void;
}

/** The ear and the mouth, or `undefined` when there is no `GOOGLE_API_KEY`. */
export interface VoiceEar {
  readonly connect: LiveTransportFactory;
  readonly config: LiveVoiceConfig;
}

export interface VoiceSessionDeps {
  readonly identity: Identity;
  /** The HTTP session the upgrade authenticated as, for the audit trail. */
  readonly sessionId: string;
  readonly client: VoiceClientChannel;
  readonly runtime: CognitiveRuntime;
  readonly conversations: ConversationRepository;
  readonly eventBus: EventBus;
  readonly report: (what: string, error: unknown) => void;
  readonly ear: VoiceEar | undefined;
  /**
   * Whether another cycle may run right now.
   *
   * The socket must not be a way around the limiter the chat route obeys. Without
   * this, an authenticated caller who is rate-limited on `POST /api/chat` opens a
   * WebSocket and runs cycles without a bound — same runtime, same model spend,
   * same database, one gate missing. `undefined` means unlimited and exists for
   * tests, not for production.
   */
  readonly mayThink?: (() => { readonly allowed: boolean; readonly retryAfterMs: number }) | undefined;
  /** Overridden in tests so the grace timer does not make them wait. */
  readonly transcriptGraceMs?: number | undefined;
  /** Overridden in tests so a transport that never opens does not make them wait. */
  readonly earConnectTimeoutMs?: number | undefined;
}

/** Counters a test can read instead of inferring behaviour from timing. */
export interface VoiceSessionStats {
  /** Frames the model generated unbidden, which never reached a speaker. */
  readonly droppedFrames: number;
  /** Frames of authorized speech forwarded to the browser. */
  readonly voicedFrames: number;
  readonly turns: number;
  readonly drifts: number;
}

export class VoiceSession {
  private readonly fsm: LiveSessionStateMachine;
  private readonly deps: VoiceSessionDeps;
  private readonly graceMs: number;

  private transport: LiveTransport | undefined;
  private conversationId = '';
  private closed = false;

  /** True between `listen` and `hush`: the provider's ear is open. */
  private earOpen = false;
  /**
   * Words accumulated from `onHeard` for the utterance in progress, in whatever
   * script the provider chose — which for Hindi is Devanagari. Read it through
   * `transcript`, never directly.
   */
  private heard = '';
  /** Set when `hush` is waiting for a final transcript. */
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  /** The line handed to the mouth, or `undefined` when nothing is authorized. */
  private rendering: Rendering | undefined;

  private stats = { droppedFrames: 0, voicedFrames: 0, turns: 0, drifts: 0 };

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
    this.graceMs = deps.transcriptGraceMs ?? TRANSCRIPT_GRACE_MS;
    // Both destinations for every transition, in one place: the browser, which
    // renders it, and the event log, which `RuntimeState` is projected from.
    this.fsm = new LiveSessionStateMachine((change) => {
      this.deps.client.send({ t: 'state', state: change.current, reason: change.reason });
      this.publish('voice.state', { state: change.current, reason: change.reason });
    });
  }

  get state(): SessionState {
    return this.fsm.state;
  }

  get statistics(): VoiceSessionStats {
    return { ...this.stats };
  }

  /**
   * Authorize, open the conversation, open the ear if there is one, and tell the
   * browser what it may do.
   *
   * The authorization gate is first and is absolute. Everything after it degrades:
   * a session with no key still reaches `ready`, with `canHear: false`, and `say`
   * runs the same twelve stages a spoken turn would.
   */
  async open(): Promise<void> {
    const decision = check(this.deps.identity, 'voice:participate');
    if (!decision.allowed) {
      this.deps.client.send({
        t: 'error',
        code: 'voice_forbidden',
        message: decision.reason ?? 'This identity may not be heard in voice.',
        fatal: true,
      });
      this.deps.client.close(CLOSE_FORBIDDEN, 'voice:participate denied');
      this.closed = true;
      return;
    }

    this.conversationId = this.deps.conversations.openOrContinue(
      this.deps.identity.id,
      'voice',
    ).id;

    this.fsm.start();
    if (this.deps.ear !== undefined) {
      try {
        this.transport = await this.connectEar(this.deps.ear);
      } catch (error) {
        // A provider that will not connect costs her the ear, not the session:
        // `say` still works, so the honest move is to report it and carry on in
        // text rather than close a socket the user can still talk on.
        this.deps.report('voice live connect', error);
        this.deps.client.send({
          t: 'error',
          code: 'ear_unavailable',
          message: 'Her ear could not be opened. Typed turns still work.',
          fatal: false,
        });
      }
    }
    this.fsm.onConnected();

    this.deps.client.send({
      t: 'ready',
      state: this.fsm.state,
      inputSampleRate: INPUT_SAMPLE_RATE,
      outputSampleRate: OUTPUT_SAMPLE_RATE,
      canHear: this.transport !== undefined,
      conversationId: this.conversationId,
    });

    await this.publishAndWait('session.connected', {
      channel: 'voice',
      sessionId: this.deps.sessionId,
      conversationId: this.conversationId,
      canHear: this.transport !== undefined,
    });
  }

  /**
   * The ear, or a throw at the deadline.
   *
   * See `EAR_CONNECT_TIMEOUT_MS` for why a deadline exists at all. A transport that
   * turns up *after* it is closed rather than adopted: `ready` has already gone out
   * saying `canHear: false`, and a microphone that silently starts working a minute
   * later is a capability nobody was offered and nobody can see.
   */
  private async connectEar(ear: VoiceEar): Promise<LiveTransport> {
    const limit = this.deps.earConnectTimeoutMs ?? EAR_CONNECT_TIMEOUT_MS;
    const pending = ear.connect(ear.config, this.callbacks());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), limit);
    });

    const first = await Promise.race([pending, deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (first !== 'deadline') return first;

    void pending.then(
      (late) => {
        try {
          late.close();
        } catch (error) {
          this.deps.report('voice late ear close', error);
        }
      },
      // Its rejection is the same failure this throw already reports, and an
      // unhandled one would take the process down with it.
      () => {},
    );
    throw new Error(`the live voice session did not open within ${limit}ms`);
  }

  /** One JSON control frame from the browser. */
  async handle(message: ClientMessage): Promise<void> {
    if (this.closed) return;
    switch (message.t) {
      case 'listen':
        this.openEar();
        return;
      case 'hush':
        this.closeEar();
        return;
      case 'say':
        await this.think(message.text, 'text');
        return;
      case 'cancel':
        this.cancelSpeech('cancelled');
        return;
      case 'bye':
        await this.close(CLOSE_GOING_AWAY, 'client said bye');
        return;
    }
  }

  /**
   * One binary audio frame from the browser's microphone.
   *
   * Silently dropped when the ear was never opened. A client that streams without
   * `listen` is a client whose VAD is misbehaving, and answering every stray frame
   * with an error frame would put twenty messages a second on the socket to say so.
   */
  handleAudioFrame(frame: Uint8Array): void {
    if (this.closed || !this.earOpen) return;
    const transport = this.transport;
    if (transport === undefined) return;
    if (frame.byteLength > MAX_AUDIO_FRAME_BYTES) {
      this.deps.client.send({
        t: 'error',
        code: 'frame_too_large',
        message: `Audio frames must be at most ${MAX_AUDIO_FRAME_BYTES} bytes.`,
        fatal: false,
      });
      return;
    }
    // The one base64 conversion in the whole path, on the hop that requires it.
    transport.sendAudio(Buffer.from(frame).toString('base64'));
  }

  /** Close the provider session, publish the disconnect, and close the socket. */
  async close(code: number, reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearGrace();
    this.rendering = undefined;
    try {
      this.transport?.close();
    } catch (error) {
      this.deps.report('voice live close', error);
    }
    this.transport = undefined;
    this.fsm.stop();
    await this.publishAndWait('session.disconnected', {
      channel: 'voice',
      sessionId: this.deps.sessionId,
      conversationId: this.conversationId,
      reason,
      turns: this.stats.turns,
      droppedFrames: this.stats.droppedFrames,
      drifts: this.stats.drifts,
    });
    this.deps.client.close(code, reason);
  }

  // ── The ear ────────────────────────────────────────────────────────────────

  private openEar(): void {
    if (this.transport === undefined || this.earOpen) return;
    // Speech starting while she is mid-sentence is barge-in, not an error: a
    // person who starts talking over you expects you to stop.
    if (this.fsm.state === 'speaking') this.cancelSpeech('interrupted');
    this.clearGrace();
    this.heard = '';
    this.earOpen = true;
    this.transport.activityStart();
  }

  private closeEar(): void {
    if (this.transport === undefined || !this.earOpen) return;
    this.earOpen = false;
    this.transport.activityEnd();
    // The transcript closes with the turn the provider commits, which arrives
    // shortly. `TRANSCRIPT_GRACE_MS` is the bound on "shortly".
    this.graceTimer = setTimeout(() => {
      this.graceTimer = undefined;
      void this.thinkAboutWhatWasHeard();
    }, this.graceMs);
  }

  private clearGrace(): void {
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
  }

  /**
   * What was heard, in the script the rest of her reads.
   *
   * `gemini-3.1-flash-live-preview` transcribes spoken Hinglish into Devanagari —
   * "main theek hoon" comes back as "मैं ठीक हूं" — and nothing downstream can use
   * that. The intent vocabulary is Roman regexes, the memory rows are Roman because
   * she wrote them, and `bagOfWordsSimilarity` scores a stimulus by token overlap
   * against them, so a Devanagari transcript matched nothing and recalled on
   * importance and recency alone. See `server/lang/script.ts`.
   *
   * Applied on the way *out* rather than as the frames arrive, because a partial frame
   * can end mid-syllable: the provider may send "ठ" and then "ीक", and transliterating
   * each piece would give "tha" + "ik" instead of "thik". `this.heard` therefore keeps
   * the provider's own text, joined by `joinHeard` so that it is always a whole prefix
   * of the utterance, and every reader of it comes through here.
   */
  private get transcript(): string {
    return toRomanHinglish(this.heard).trim();
  }

  /**
   * Close the utterance: tell the browser it is closed, then think about it.
   *
   * Both paths that can close one end here — the provider committing its turn, and
   * the grace timer firing because it never did — and the `final` frame is sent from
   * this one place rather than from the callback, because the two paths disagreed
   * about it in a way only a real provider showed.
   *
   * `useVoice` clears its live transcript on `final` and on nothing else, and
   * `src/ui/Voice.tsx` prefers that transcript over the line she is speaking. So on
   * the grace path — no frame at all, before this — the browser kept his own words on
   * screen and never displayed her reply. And when the provider's commit arrived
   * *after* the grace timer had already consumed the utterance, the callback sent
   * `{final: true, text: ''}`: a frame stating she finished hearing nothing, for a
   * sentence she had just answered. Observed in the e2e voice probe, where the commit
   * lands a beat late every time.
   *
   * Exactly one `final` frame per utterance now, carrying the words that were
   * actually thought about, and none at all when there were none.
   */
  private async thinkAboutWhatWasHeard(): Promise<void> {
    const text = this.transcript;
    this.heard = '';
    if (text === '') return;
    this.deps.client.send({ t: 'heard', text, final: true });
    await this.think(text, 'audio');
  }

  // ── The mind ───────────────────────────────────────────────────────────────

  /**
   * One turn, from words to a spoken line.
   *
   * `source` is what actually happened rather than a convenience: it reaches the
   * `message` row and the audit trail, and `resolveConversationId` reads it. A
   * typed turn on the voice socket is a typed turn.
   *
   * The payload is `{ text }` for both, and that is not cosmetic. Stage 4's
   * `extractText` accepts *only* that shape — a bare string reads as no text at
   * all — so a spoken turn sent as a plain string would reach UNDERSTAND empty
   * and she would answer having been told nothing.
   */
  private async think(payload: string, source: 'audio' | 'text'): Promise<void> {
    if (this.closed) return;

    const verdict = this.deps.mayThink?.();
    if (verdict !== undefined && !verdict.allowed) {
      // Refused before any state change, so she stays listening rather than
      // sitting in `thinking` for a turn that will never happen.
      this.deps.client.send({
        t: 'error',
        code: 'too_many_requests',
        message: `That is faster than she can think. Try again in ${Math.ceil(verdict.retryAfterMs / 1000)}s.`,
        fatal: false,
      });
      return;
    }

    if (this.fsm.state === 'speaking') this.cancelSpeech('interrupted');
    if (this.fsm.state === 'listening') this.fsm.onSpeechEnd();

    if (source === 'audio') {
      this.publish('voice.transcript', { role: 'user', text: payload, final: true });
    }

    let cycle: CycleRecord;
    try {
      cycle = await this.deps.runtime.runCycle({
        source,
        payload: { text: payload },
        receivedAt: Date.now(),
        identityId: this.deps.identity.id,
        conversationId: this.conversationId,
        sessionId: this.deps.sessionId,
      });
    } catch (error) {
      this.deps.report('voice cycle', error);
      this.deps.client.send({
        t: 'error',
        code: 'cycle_failed',
        message: 'Something went wrong while she was thinking.',
        fatal: false,
      });
      this.backToListening();
      return;
    }

    this.stats.turns += 1;
    const response = cycle.response;
    const line = response?.text.trim() ?? '';

    // She thought and chose not to speak. A decision, not a failure — and the
    // reason `silent` exists as its own message rather than an empty `said`.
    if (line === '') {
      this.deps.client.send({ t: 'silent', cycleId: cycle.id });
      this.backToListening();
      return;
    }

    // The words reach the transcript before any audio exists, so nothing on
    // screen ever waits on synthesis — and a drifted rendering still leaves the
    // true line visible.
    this.deps.client.send({ t: 'said', text: line, cycleId: cycle.id });
    this.publish('voice.transcript', { role: 'assistant', text: line, final: true }, cycle.id);

    if (response?.voiceEnabled !== true || this.transport === undefined) {
      // Stage 9 authorized the words and not the voice, or there is no mouth.
      this.backToListening();
      return;
    }

    this.rendering = newRendering(line, cycle.id);
    this.fsm.onTtsStart();
    this.transport.render(line);
  }

  private backToListening(): void {
    if (this.fsm.state === 'thinking' || this.fsm.state === 'speaking') {
      this.fsm.onThinkingFinished();
    }
  }

  // ── The mouth ──────────────────────────────────────────────────────────────

  /**
   * Audio from the provider.
   *
   * The drop rule lives here. `rendering === undefined` means nothing is
   * authorized to be speaking, so these samples are the model's own unbidden
   * answer to what it heard — counted, so a test can prove they arrived, and
   * discarded, so no one hears them.
   */
  private handleAudioFromModel(base64: string): void {
    if (this.closed) return;
    if (this.rendering === undefined) {
      this.stats.droppedFrames += 1;
      return;
    }
    this.stats.voicedFrames += 1;
    this.deps.client.sendAudio(Buffer.from(base64, 'base64'));
  }

  /**
   * What the mouth says it just said.
   *
   * Compared against the authorized line as it streams, because the failure that
   * matters — a model answering the line rather than reading it — starts on the
   * first word, and by the end of the turn the user has already heard it.
   */
  private handleVoiced(text: string): void {
    const rendering = this.rendering;
    if (rendering === undefined || this.closed) return;
    absorb(rendering, text);
    if (driftsNow(rendering)) this.cutForDrift(rendering);
  }

  private handleModelTurnEnd(reason: 'complete' | 'interrupted'): void {
    const rendering = this.rendering;
    if (rendering === undefined) {
      // The tail of a dropped unbidden turn. Nothing was playing, so there is
      // nothing to end.
      return;
    }
    if (reason === 'interrupted') {
      this.cancelSpeech('interrupted');
      return;
    }
    if (coverageShort(rendering)) {
      this.cutForDrift(rendering);
      return;
    }
    this.rendering = undefined;
    this.deps.client.send({ t: 'turn_end' });
    if (this.fsm.state === 'speaking') this.fsm.onTtsEnd();
  }

  private cutForDrift(rendering: Rendering): void {
    this.stats.drifts += 1;
    this.rendering = undefined;
    this.deps.report(
      'voice drift',
      new Error(
        `the mouth drifted from the authorized line (cycle ${rendering.cycleId}, ` +
          `${rendering.extra} unauthorized words, ${rendering.matched}/${rendering.total} covered)`,
      ),
    );
    this.deps.client.send({ t: 'flush', reason: 'drifted' });
    this.deps.client.send({ t: 'turn_end' });
    if (this.fsm.state === 'speaking') this.fsm.onTtsEnd();
  }

  /**
   * Stop speaking now.
   *
   * Clearing `rendering` is what makes this work: every chunk still in flight
   * from the provider now fails the drop rule and never reaches the speaker, so
   * there is no race between the flush and the audio it was flushing.
   */
  private cancelSpeech(reason: 'cancelled' | 'interrupted'): void {
    if (this.rendering === undefined) return;
    this.rendering = undefined;
    this.deps.client.send({ t: 'flush', reason });
    this.deps.client.send({ t: 'turn_end' });
    if (this.fsm.state === 'speaking') this.fsm.onTtsEnd();
  }

  // ── Provider callbacks ─────────────────────────────────────────────────────

  private callbacks(): LiveTransportCallbacks {
    return {
      onOpen: () => {},
      onHeard: (text, final) => {
        if (this.closed) return;
        if (text !== '') {
          this.heard = joinHeard(this.heard, text);
          this.deps.client.send({ t: 'heard', text: this.transcript, final: false });
        }
        if (!final) return;
        // The turn the provider committed closed the transcript. Whatever the
        // grace timer was waiting for has arrived.
        if (this.earOpen) return;
        this.clearGrace();
        void this.thinkAboutWhatWasHeard();
      },
      onVoiced: (text) => this.handleVoiced(text),
      onAudio: (base64) => this.handleAudioFromModel(base64),
      onTurnEnd: (reason) => this.handleModelTurnEnd(reason),
      onError: (error) => {
        this.deps.report('voice live transport', error);
        if (this.closed) return;
        this.deps.client.send({
          t: 'error',
          code: 'live_transport',
          message: 'The voice connection had a problem.',
          fatal: false,
        });
      },
      onClose: (code, reason) => {
        if (this.closed) return;
        // The provider hung up. The ear and the mouth are gone; the socket is
        // not, and `say` still runs the twelve stages.
        this.transport = undefined;
        this.earOpen = false;
        this.rendering = undefined;
        this.deps.client.send({
          t: 'error',
          code: 'ear_closed',
          message: `Her ear closed (${code}${reason === '' ? '' : `: ${reason}`}). Typed turns still work.`,
          fatal: false,
        });
      },
    };
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * Publish without making the caller wait.
   *
   * A state transition happens inside a synchronous FSM listener, and a durable
   * write must not be able to delay the sentence she is about to speak. Failures
   * are reported rather than swallowed.
   */
  private publish(type: 'voice.state' | 'voice.transcript', payload: object, cycleId?: string): void {
    void this.publishAndWait(type, payload, cycleId).catch(() => {});
  }

  private async publishAndWait(
    type: 'voice.state' | 'voice.transcript' | 'session.connected' | 'session.disconnected',
    payload: object,
    cycleId?: string,
  ): Promise<void> {
    try {
      await this.deps.eventBus.publish({
        type,
        payload,
        identityId: this.deps.identity.id,
        ...(cycleId === undefined ? {} : { cycleId }),
      });
    } catch (error) {
      this.deps.report(`voice publish ${type}`, error);
    }
  }
}

// ── What was heard ───────────────────────────────────────────────────────────

/**
 * Append one streamed transcription chunk to the utterance so far.
 *
 * The provider streams the transcript in pieces and does not promise that a piece
 * begins at a word boundary, so the separator has to be decided rather than assumed.
 * A space goes in between two chunks — otherwise "kal" and "subah" arrive as
 * "kalsubah" — except in the two cases where a space is definitely wrong:
 *
 *  - Either side already has whitespace there.
 *  - The new chunk begins with a combining mark. A matra, the anusvara, the nukta and
 *    the virama are all `\p{M}` — not letters, but modifiers of the letter to their
 *    left — so a chunk starting with one is the middle of a syllable by definition.
 *    "ठ" then "ीक" must become "ठीक" and not "ठ ीक", which `toRomanHinglish` would
 *    read as two words and render "tha ik".
 *
 * This is the invariant `transcript` depends on: whatever is accumulated here is a
 * whole prefix of the utterance, so transliterating it is the same operation whether
 * it happens once at the end or on every partial along the way.
 */
function joinHeard(sofar: string, chunk: string): string {
  if (sofar === '') return chunk;
  if (/\s$/u.test(sofar) || /^\s/u.test(chunk)) return sofar + chunk;
  if (/^\p{M}/u.test(chunk)) return sofar + chunk;
  return `${sofar} ${chunk}`;
}

// ── The drift check ──────────────────────────────────────────────────────────
/** The authorized line, and how much of it has been voiced so far. */
interface Rendering {
  readonly cycleId: string;
  /** Remaining unmatched tokens of the authorized line, by count. */
  readonly remaining: Map<string, number>;
  readonly total: number;
  matched: number;
  extra: number;
}

function newRendering(line: string, cycleId: string): Rendering {
  const tokens = comparable(line);
  const remaining = new Map<string, number>();
  for (const token of tokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  return { cycleId, remaining, total: tokens.length, matched: 0, extra: 0 };
}

/**
 * Both sides of the drift comparison, in one script.
 *
 * The authorized line is Roman — stage 9 wrote it. The voiced text is the provider's
 * transcription of its own speech, and the provider's *other* transcription field,
 * `inputAudioTranscription`, demonstrably returns Devanagari for the same language in
 * the same session (see `server/lang/script.ts`). If the output field ever does the
 * same, a Roman `remaining` meets Devanagari tokens, nothing matches, `extra` climbs to
 * the full length of the line, and `driftsNow` cuts her off mid-sentence — on every
 * spoken turn, reported as drift. She would be effectively mute and the log would blame
 * her mouth.
 *
 * `toRomanHinglish` returns Roman input byte-identical, so this costs a regex test per
 * chunk today and removes that failure mode entirely. `tokenize` stays script-agnostic
 * on purpose: it is exported, and its combining-mark handling is what makes it correct
 * for any script, not just the one this fold happens to produce.
 */
function comparable(text: string): string[] {
  return tokenize(toRomanHinglish(text));
}

/**
 * Words, with everything that is not a word removed.
 *
 * `\p{L}\p{N}\p{M}` under `/u` rather than `\w`, and the third class is the one that
 * was missing. `\w` is ASCII: under it a Devanagari line tokenizes to nothing, `total`
 * is zero, and `coverageShort` returns early — so the drift gate does not flush a
 * correct rendering, it silently stops existing for every Hindi sentence she says.
 *
 * Adding only letters and numbers fixes less than it looks. Devanagari vowel signs and
 * the halant are combining *marks*, not letters, so `[^\p{L}\p{N}]` deleted them and
 * split at each one: `मौसम` became `म` + `सम`, `कैसा` became `क` + `स`. Both sides of
 * the comparison were shredded the same way, so a correct rendering still mostly
 * matched — which is why this was invisible — but the fragments are single consonants
 * that recur in unrelated words, so a mouth answering in different Hindi matched them
 * too. `total` inflated as well, moving the ratio threshold. The gate was not off; it
 * was blunt in exactly the language she mostly speaks, and
 * `tests/voice/live-session.test.ts` is where that is now asserted.
 *
 * Punctuation and case are still dropped, because a transcription of speech has neither
 * reliably.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((token) => token !== '');
}

/** Fold one streamed chunk of voiced text into the running comparison. */
function absorb(rendering: Rendering, text: string): void {
  for (const token of comparable(text)) {
    const left = rendering.remaining.get(token);
    if (left !== undefined && left > 0) {
      rendering.remaining.set(token, left - 1);
      rendering.matched += 1;
    } else {
      rendering.extra += 1;
    }
  }
}

/**
 * Whether the mouth has said enough unauthorized words to cut it off mid-sentence.
 *
 * A multiset comparison rather than a sequence one: the provider's transcription
 * of its own speech re-orders and re-punctuates, and a strict prefix check would
 * flag a perfectly good rendering. What it cannot forgive is *volume* of words
 * that were never in the line, which is exactly what a model answering rather
 * than reading produces.
 */
function driftsNow(rendering: Rendering): boolean {
  if (rendering.total === 0) return false;
  return rendering.extra > Math.max(DRIFT_EXTRA_FLOOR, rendering.total * DRIFT_EXTRA_RATIO);
}

/** Whether the finished rendering left too much of the line unsaid. */
function coverageShort(rendering: Rendering): boolean {
  if (rendering.total === 0) return false;
  return rendering.matched / rendering.total < DRIFT_MIN_COVERAGE;
}
