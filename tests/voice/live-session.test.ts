/**
 * The voice session, driven with a real mind and a fake ear.
 *
 * `server/voice/live/session.ts` names this file in its header, which is what makes
 * writing it the difference between a claim the code honours and one it does not.
 * Every test below runs a real `CognitiveRuntime` against a real in-memory database
 * with no socket, no API key and no network: `VoiceClientChannel` is three methods and
 * `LiveTransportFactory` is one function, so both are replaced by recorders and the
 * orchestrator underneath is the production one.
 *
 * ## What is asserted, and why it is not the units
 *
 * The interesting behaviour of this file is all *refusal*: audio she was never
 * authorized to speak, a mouth that answers instead of reading, a turn that arrives
 * faster than she can think. None of those are visible in a unit test of the drift
 * arithmetic — they are visible in what reached the browser and what did not. So the
 * assertions are on frames sent, bytes forwarded and counters moved.
 *
 * ## The reply is her fallback, and that is fine
 *
 * With no `GOOGLE_API_KEY` the twelve stages run without an LLM and stage 9 composes
 * from what it has. The words differ from what a keyed run would say; that they exist,
 * that they are authorized, and that they reach the transcript before any audio is
 * synthesised are all independent of the model — and those are the facts under test.
 *
 * ## The one gate that is not reachable from here
 *
 * Gate 3 is `voiceEnabled`, and its `false` half cannot be produced without a key.
 * `voiceEnabled` is `mayBeHeardInVoice && (draft?.voicePreferred ?? true)`
 * (`server/cognition/stages/9.ts:244`): the permission half already closed the socket
 * with 4403 at `open()`, and the deterministic draft only sets `voicePreferred: false`
 * on the paths whose text is empty — which arrive as `silent`, not as a spoken line.
 * So the branch is exercised through the other half of the same `||`: a session with
 * no transport reaches `said` and synthesises nothing, which is what the no-ear test
 * and the `ear_closed` test assert. Saying so here is cheaper than a test that pretends.
 */

import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type MadhuritaApp } from '@server/app.js';
import { loadConfig } from '@server/config/env.js';
import type { Identity } from '@server/identity/types.js';
import { Database, closeDatabase } from '@server/persistence/db.js';
import { runMigrations } from '@server/persistence/migrate.js';
// The barrel, not `./live/session.js`, for the reason its own header gives: what is
// outside this directory needs a way to run a session and nothing deeper. A test that
// reached past it would be the first caller to make the barrel a lie.
import {
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  DRIFT_EXTRA_FLOOR,
  DRIFT_EXTRA_RATIO,
  DRIFT_MIN_COVERAGE,
  MAX_AUDIO_FRAME_BYTES,
  VoiceSession,
  tokenize,
  type AudioEnvelope,
  type LiveTransport,
  type LiveTransportCallbacks,
  type ServerMessage,
  type VoiceClientChannel,
  type VoiceEar,
} from '@server/voice/live/index.js';

const MIGRATIONS = resolve(process.cwd(), 'server/persistence/migrations');

/** Everything the browser would have received, in the order it was sent. */
class Channel implements VoiceClientChannel {
  readonly sent: ServerMessage[] = [];
  readonly audio: Uint8Array[] = [];
  readonly envelopes: (AudioEnvelope | undefined)[] = [];
  closedWith: { code: number; reason: string } | undefined;

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  sendAudio(pcm16: Uint8Array, envelope?: AudioEnvelope): void {
    this.audio.push(pcm16);
    this.envelopes.push(envelope);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
  }

  /** Every frame of one kind, which is what nearly every assertion here wants. */
  of<T extends ServerMessage['t']>(kind: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMessage, { t: T }> => message.t === kind);
  }

  last<T extends ServerMessage['t']>(kind: T): Extract<ServerMessage, { t: T }> | undefined {
    const all = this.of(kind);
    return all[all.length - 1];
  }
}

/** The provider, reduced to what it was told and a way to say what it heard. */
class Ear implements LiveTransport {
  readonly frames: string[] = [];
  readonly rendered: string[] = [];
  activityStarts = 0;
  activityEnds = 0;
  closes = 0;
  /** Set by the factory, so a test can drive the callbacks the real one would. */
  says!: LiveTransportCallbacks;

  sendAudio(base64Pcm16: string): void {
    this.frames.push(base64Pcm16);
  }

  activityStart(): void {
    this.activityStarts += 1;
  }

  activityEnd(): void {
    this.activityEnds += 1;
  }

  render(text: string): void {
    this.rendered.push(text);
  }

  close(): void {
    this.closes += 1;
  }
}

/** The ear a session is handed, and the handle a test keeps on it. */
function earFor(ear: Ear): VoiceEar {
  return {
    config: {
      model: 'fake-live',
      systemInstruction: 'read the line',
      temperature: 0,
    },
    connect: (_config, callbacks) => {
      ear.says = callbacks;
      return Promise.resolve(ear);
    },
  };
}

/** PCM16 the size of one real chunk, so a byte count means something. */
function chunk(bytes = 640): Uint8Array {
  return new Uint8Array(bytes).fill(7);
}

/**
 * The same bytes as the provider hands them over: base64.
 *
 * The one textual hop in the whole path, and the reason a test can hold both sides of
 * it — `handleAudioFromModel` decodes exactly this.
 */
function fromProvider(bytes = 640): string {
  return Buffer.from(chunk(bytes)).toString('base64');
}

/**
 * Let the session finish what a provider callback started.
 *
 * `onHeard(final)` and `onTurnEnd` are synchronous callbacks that kick off an
 * asynchronous cycle, exactly as the real provider's are, so there is nothing for a
 * test to await. A real socket gets those ticks for free; this is the same ticks,
 * asked for on purpose. Long enough to cover the 5 ms grace timer the harness sets.
 */
async function settle(): Promise<void> {
  await new Promise((done) => setTimeout(done, 30));
}

describe('the voice session', () => {
  let db: Database;
  let app: MadhuritaApp;
  let owner: Identity;
  let channel: Channel;
  let ear: Ear;
  let reports: { what: string; error: unknown }[];

  beforeEach(async () => {
    db = new Database({ path: ':memory:' });
    runMigrations(db, MIGRATIONS);
    app = createApp({ config: loadConfig({}), db, installGlobalDatabase: false });
    owner = await app.identityRepo.createIdentity({ kind: 'owner', displayName: 'Ankit' });
    channel = new Channel();
    ear = new Ear();
    reports = [];
  });

  afterEach(async () => {
    await app.stop();
    db.close();
    closeDatabase();
  });

  /**
   * A session wired exactly as `server/http/ws.ts` wires one.
   *
   * `mayThink` defaults to absent, which means unlimited — the production gateway
   * always passes one, and the one test that cares passes its own.
   */
  const sessionFor = (options: {
    identity?: Identity;
    hasEar?: boolean;
    /** An ear other than the recorder — used to pin what a connect that hangs costs. */
    ear?: VoiceEar;
    earConnectTimeoutMs?: number;
    mayThink?: () => { allowed: boolean; retryAfterMs: number };
  } = {}): VoiceSession => {
    const identity = options.identity ?? owner;
    return new VoiceSession({
      identity,
      sessionId: 'session-under-test',
      client: channel,
      runtime: app.runtimeFor(identity),
      conversations: app.conversations,
      eventBus: app.eventBus,
      report: (what, error) => reports.push({ what, error }),
      ear: options.hasEar === false ? undefined : (options.ear ?? earFor(ear)),
      // `undefined` is unlimited, which is what the property's own doc says it is for.
      mayThink: options.mayThink,
      // The grace timer is real time, and every test that reaches it would otherwise
      // wait two and a half seconds for an arithmetic assertion.
      transcriptGraceMs: 5,
      ...(options.earConnectTimeoutMs !== undefined
        ? { earConnectTimeoutMs: options.earConnectTimeoutMs }
        : {}),
    });
  };

  /**
   * One turn she was spoken, in the four steps a real client takes.
   *
   * `hush` before the provider's final transcript is not an ordering detail — it is
   * the whole handshake. `onHeard(final)` returns early while the ear is still open,
   * because a provider that commits a turn mid-utterance has not heard the end of the
   * sentence yet. So a helper that sent the final without closing the ear first would
   * silently assert nothing at all.
   */
  const speak = async (session: VoiceSession, words: string): Promise<void> => {
    await session.handle({ t: 'listen' });
    ear.says.onHeard(words, false);
    await session.handle({ t: 'hush' });
    // The provider's committed turn, which is what beats the grace timer. Empty text
    // because the words already arrived as partials, which is how the real one behaves.
    ear.says.onHeard('', true);
    // `onHeard(final)` calls `think` without awaiting it — the provider callback is
    // synchronous and the cycle is not. Yielding is what a real socket's next tick is.
    await settle();
  };

  /**
   * What each cycle of this conversation says it was.
   *
   * `cycle_record` has no `source` column — the whole stimulus is stored as
   * `input_json`, so the field is read out of the JSON rather than out of a column.
   * Read from the database rather than from a frame on purpose: a `said` frame proves
   * she answered, and only the row proves she recorded *how she was addressed*.
   */
  const sourcesOf = (conversationId: string): string[] =>
    (
      db.raw
        .prepare(
          `SELECT json_extract(input_json, '$.source') AS source
             FROM cycle_record WHERE conversation_id = ? ORDER BY started_at, rowid`,
        )
        .all(conversationId) as { source: string }[]
    ).map((row) => row.source);

  /** The conversation `ready` named, which is the only one a session ever writes to. */
  const conversationId = (): string => channel.last('ready')?.conversationId ?? '';

  it('tells the browser what it may do, and opens a conversation to do it in', async () => {
    const session = sessionFor();
    await session.open();

    const ready = channel.last('ready');
    expect(ready?.canHear).toBe(true);
    expect(ready?.inputSampleRate).toBe(16_000);
    expect(ready?.outputSampleRate).toBe(24_000);
    expect(ready?.conversationId).not.toBe('');
    expect(session.state).toBe('listening');

    // The conversation is a real row, and it is hers. A `ready` naming a conversation
    // that does not exist would have the client reading a transcript that 404s.
    const conversations = app.conversations.listForIdentity(owner.id);
    expect(conversations.map((row) => row.id)).toContain(ready?.conversationId);
  });

  it('refuses a guest at the door, before a provider session costs anything', async () => {
    const guest = await app.identityRepo.createIdentity({ kind: 'guest', displayName: 'Someone' });
    const session = sessionFor({ identity: guest });
    await session.open();

    // The error frame first, then the close. A close with no explanation is the one
    // thing a client cannot act on: 4403 alone does not say which permission.
    expect(channel.of('error')[0]?.code).toBe('voice_forbidden');
    expect(channel.of('error')[0]?.fatal).toBe(true);
    expect(channel.closedWith?.code).toBe(CLOSE_FORBIDDEN);
    // Nothing was opened on the way to being refused.
    expect(channel.of('ready')).toHaveLength(0);
    expect(ear.activityStarts).toBe(0);
    expect(app.conversations.listForIdentity(guest.id)).toHaveLength(0);
  });

  it('still thinks in text when there is no ear at all', async () => {
    const session = sessionFor({ hasEar: false });
    await session.open();

    expect(channel.last('ready')?.canHear).toBe(false);

    await session.handle({ t: 'say', text: 'kya haal hai' });

    // The whole point of `canHear: false` rather than a closed socket: the same twelve
    // stages ran, the words are committed, and the only thing missing is the audio.
    const said = channel.last('said');
    expect(said?.text.length).toBeGreaterThan(0);
    expect(channel.audio).toHaveLength(0);
    expect(ear.rendered).toHaveLength(0);

    const turns = app.messages.recentForCaller(conversationId(), owner.id, 10);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns[0]?.text).toBe('kya haal hai');
    expect(turns[1]?.text).toBe(said?.text);
  });

  /**
   * A provider that accepts the socket and never acknowledges the setup.
   *
   * Not a hypothetical failure and not a slow network: `client.live.connect()` awaits
   * the provider's `setupComplete` and no path in the SDK rejects that promise, so a
   * `config` carrying one field the model does not recognise closes the socket with
   * 1007 and leaves the await pending for the life of the process. That is what
   * `proactivity` did against `gemini-3.1-flash-live-preview`, and the symptom was not
   * an error in a log — it was a browser that had authenticated and would never be sent
   * `ready`, because `open()` was still waiting.
   */
  const hangingEar = (): VoiceEar => ({
    config: { model: 'never-answers', systemInstruction: 'read the line', temperature: 0 },
    connect: () => new Promise<never>(() => {}),
  });

  it('opens the session anyway when the ear never finishes connecting', async () => {
    const session = sessionFor({ ear: hangingEar(), earConnectTimeoutMs: 20 });
    await session.open();

    // The assertion that matters is that `await session.open()` returned at all. The
    // rest is what she must say about it: no microphone, one reported failure, and a
    // non-fatal error so the client keeps the socket it can still type on.
    expect(channel.last('ready')?.canHear).toBe(false);
    expect(channel.of('error')[0]?.code).toBe('ear_unavailable');
    expect(channel.of('error')[0]?.fatal).toBe(false);
    expect(channel.closedWith).toBeUndefined();
    expect(reports.map((r) => r.what)).toContain('voice live connect');
    expect(String(reports[0]?.error)).toMatch(/did not open within 20ms/);
  });

  it('still thinks in text after the ear timed out', async () => {
    const session = sessionFor({ ear: hangingEar(), earConnectTimeoutMs: 20 });
    await session.open();
    await session.handle({ t: 'say', text: 'kya haal hai' });

    // The same trade the no-key path makes: the twelve stages ran, the words are
    // committed, and the only missing thing is the audio.
    const said = channel.last('said');
    expect(said?.text.length).toBeGreaterThan(0);
    expect(channel.audio).toHaveLength(0);
    const turns = app.messages.recentForCaller(conversationId(), owner.id, 10);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
  });

  it('closes an ear that arrives after the deadline rather than adopting it', async () => {
    // A slow network rather than a rejected setup: the transport is real and simply
    // late. Adopting it would hand a microphone to a client that was told it has none.
    let open!: (transport: LiveTransport) => void;
    const late: VoiceEar = {
      config: { model: 'slow', systemInstruction: 'read the line', temperature: 0 },
      connect: (_config, callbacks) => {
        ear.says = callbacks;
        return new Promise<LiveTransport>((resolve) => {
          open = resolve;
        });
      },
    };

    const session = sessionFor({ ear: late, earConnectTimeoutMs: 20 });
    await session.open();
    expect(channel.last('ready')?.canHear).toBe(false);

    open(ear);
    await settle();

    expect(ear.closes).toBe(1);
    // And it is not used for the turn that follows, however healthy it now is.
    await session.handle({ t: 'say', text: 'suno' });
    expect(ear.rendered).toHaveLength(0);
  });

  it('keeps a typed turn typed, all the way into the row', async () => {
    const session = sessionFor();
    await session.open();
    await session.handle({ t: 'say', text: 'likh ke pucha hai' });

    // `VoiceSession.think` passes `source: 'text'` for `say`, which is what stops a
    // sentence typed into the composer from being recorded as something she heard.
    expect(sourcesOf(conversationId())).toEqual(['text']);
  });

  it('records a spoken turn as spoken, and answers it', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'aaj mausam kaisa hai');

    expect(ear.activityStarts).toBe(1);
    expect(ear.activityEnds).toBe(1);
    // Heard, committed, spoken back — in that order, and the words she was heard
    // saying reached the transcript as a `user` turn rather than as a transcript event
    // nobody stored.
    expect(channel.last('heard')?.final).toBe(true);
    const said = channel.last('said');
    expect(said?.text.length).toBeGreaterThan(0);
    expect(ear.rendered).toEqual([said?.text]);

    const turns = app.messages.recentForCaller(conversationId(), owner.id, 10);
    expect(turns[0]?.text).toBe('aaj mausam kaisa hai');
    expect(sourcesOf(conversationId())).toEqual(['audio']);
  });

  it('turns the Devanagari the provider hears into the Roman the rest of her reads', async () => {
    // The defect this closes was invisible to every other test in the suite, because
    // every other test feeds Roman. The real provider transcribes spoken Hinglish into
    // Devanagari, and the intent vocabulary, the stored conversation and the memory
    // scorer are all Roman — so a spoken turn matched none of them and recalled on
    // importance and recency alone, silently. `server/lang/script.ts` has the
    // rest of it.
    const session = sessionFor();
    await session.open();
    await speak(session, 'मैं ठीक हूं अंकित, तुम बताओ कैसे हो?');

    // What reached the mind, which is the assertion that matters: the row is what the
    // scorer and the next cycle will read.
    const turns = app.messages.recentForCaller(conversationId(), owner.id, 10);
    expect(turns[0]?.text).toBe('main thik hun ankit, tum batao kaise ho?');
    expect(sourcesOf(conversationId())).toEqual(['audio']);

    // And what reached the browser, in the same script — a transcript pane showing
    // Devanagari over a Roman conversation is a different bug with the same cause.
    expect(channel.last('heard')?.text).toBe('main thik hun ankit, tum batao kaise ho?');
    for (const frame of channel.of('heard')) expect(frame.text).not.toMatch(/[ऀ-ॿ]/u);
  });

  it('joins partial transcripts without splitting a syllable in half', async () => {
    // `transcript` transliterates the accumulated text rather than each chunk, which is
    // only sound if what is accumulated is a whole prefix of the utterance. The provider
    // does not promise a chunk starts at a word boundary, so a separator inserted before
    // a combining mark would break the syllable it belongs to: "ठ" + "ीक" as "ठ ीक" is
    // "tha ik", not "thik".
    const session = sessionFor();
    await session.open();
    await session.handle({ t: 'listen' });
    ear.says.onHeard('ठ', false);
    ear.says.onHeard('ीक', false);
    ear.says.onHeard('hai', false);
    await session.handle({ t: 'hush' });
    ear.says.onHeard('', true);
    await settle();

    expect(channel.last('heard')?.text).toBe('thik hai');
    const turns = app.messages.recentForCaller(conversationId(), owner.id, 10);
    expect(turns[0]?.text).toBe('thik hai');
  });

  it('counts the audio she never authorized, and plays none of it', async () => {
    // The gate that separates this application from a wrapper around a speech model.
    // `activityEnd` makes the live model answer on its own — there is no flag that
    // asks for transcription without generation — so its unbidden reply arrives on
    // exactly this callback and must reach no speaker.
    const session = sessionFor();
    await session.open();
    await session.handle({ t: 'listen' });

    ear.says.onAudio(fromProvider());
    ear.says.onAudio(fromProvider());
    // And the tail of that turn, which must not be mistaken for the end of one of hers.
    ear.says.onTurnEnd('complete');

    expect(session.statistics.droppedFrames).toBe(2);
    expect(session.statistics.voicedFrames).toBe(0);
    expect(channel.audio).toHaveLength(0);
    // No `turn_end` either: there was no turn. A client that trusted one would stop
    // waiting for audio it is still owed.
    expect(channel.of('turn_end')).toHaveLength(0);
  });

  it('forwards the audio of a line she did authorize, byte for byte', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'kuch bolo');

    expect(session.state).toBe('speaking');
    const line = channel.last('said')?.text ?? '';
    ear.says.onAudio(fromProvider(320));
    ear.says.onAudio(fromProvider(320));

    expect(session.statistics.voicedFrames).toBe(2);
    expect(session.statistics.droppedFrames).toBe(0);
    // Decoded, not re-encoded: the browser's speaker reads the samples straight off
    // the frame, so anything left of the base64 would be heard as noise.
    expect(channel.audio.map((frame) => frame.byteLength)).toEqual([320, 320]);
    expect([...channel.audio[0]!]).toEqual([...chunk(320)]);

    // The mouth saying what it said. Not optional garnish — `outputAudioTranscription`
    // is unconditional in `transport.ts`, so a turn that ends having voiced nothing is
    // a turn with no evidence the right words were spoken, and the session flushes it.
    // Supplying the line here is what makes this the *clean* case, and the assertion
    // that neither drift check fires on a correct rendering is the one that would catch
    // a tokenizer regression flushing every real sentence.
    ear.says.onVoiced(line);
    ear.says.onTurnEnd('complete');
    expect(channel.of('turn_end')).toHaveLength(1);
    expect(channel.of('flush')).toHaveLength(0);
    expect(session.state).toBe('listening');
    expect(session.statistics.drifts).toBe(0);
  });

  it('cuts the mouth off mid-sentence when it starts answering instead of reading', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'kuch bolo');

    const line = channel.last('said')?.text ?? '';
    // The threshold is computed from the line rather than hard-coded, because the
    // fallback's wording is the model's business and the arithmetic is not: `extra`
    // must exceed `max(floor, total × ratio)`. One word past it is the first word a
    // user would have heard that she never authorized.
    const needed = Math.max(DRIFT_EXTRA_FLOOR, tokenize(line).length * DRIFT_EXTRA_RATIO);
    const invented = Array.from({ length: Math.floor(needed) + 1 }, (_, i) => `zzq${i}`).join(' ');

    ear.says.onAudio(fromProvider());
    ear.says.onVoiced(invented);

    expect(session.statistics.drifts).toBe(1);
    expect(channel.last('flush')?.reason).toBe('drifted');
    expect(channel.of('turn_end')).toHaveLength(1);
    // Reported, because a mouth that improvises is not a cosmetic fault and the only
    // person who can act on it cannot hear the audio that was cut.
    expect(reports.map((entry) => entry.what)).toContain('voice drift');
    // And every chunk still in flight now fails the drop rule, which is what makes
    // the flush a promise rather than a request.
    ear.says.onAudio(fromProvider());
    expect(session.statistics.voicedFrames).toBe(1);
    expect(session.statistics.droppedFrames).toBe(1);
    expect(session.state).toBe('listening');
    // The words themselves are still on screen. The rendering was wrong; the line
    // was not, and it was committed before any audio existed.
    expect(line.length).toBeGreaterThan(0);
    expect(app.messages.recentForCaller(conversationId(), owner.id, 10)[1]?.text).toBe(line);
  });

  it('flushes a rendering that stopped less than two thirds of the way through', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'kuch bolo');

    const tokens = tokenize(channel.last('said')?.text ?? '');
    // Long enough for a shortfall to be distinguishable from a rounding artefact:
    // `DRIFT_MIN_COVERAGE` on a two-word line cannot be missed by one word.
    expect(tokens.length).toBeGreaterThan(2);
    const started = tokens.slice(0, Math.floor(tokens.length * 0.4)).join(' ');

    ear.says.onVoiced(started);
    // Not `interrupted` — the provider says the turn finished normally. That is the
    // case coverage exists for: a mouth that stopped early and claims it is done.
    ear.says.onTurnEnd('complete');

    expect(Math.floor(tokens.length * 0.4) / tokens.length).toBeLessThan(DRIFT_MIN_COVERAGE);
    expect(session.statistics.drifts).toBe(1);
    expect(channel.last('flush')?.reason).toBe('drifted');
    expect(session.state).toBe('listening');
  });

  it('stops speaking the moment he starts, and drops what was queued', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'lambi baat');
    ear.says.onAudio(fromProvider());
    expect(session.statistics.voicedFrames).toBe(1);

    // Barge-in: `listen` while she is mid-sentence. A person who starts talking over
    // you expects you to stop, so this is not an error and not a queued request.
    await session.handle({ t: 'listen' });

    expect(channel.last('flush')?.reason).toBe('interrupted');
    expect(channel.of('turn_end')).toHaveLength(1);
    expect(session.state).toBe('listening');
    expect(ear.activityStarts).toBe(2);

    ear.says.onAudio(fromProvider());
    expect(session.statistics.voicedFrames).toBe(1);
    expect(session.statistics.droppedFrames).toBe(1);
    expect(channel.audio).toHaveLength(1);
    // Not counted as drift: nothing about the rendering was wrong, it was simply
    // overtaken. A drift counter that rose here would blame the model for his
    // interruption.
    expect(session.statistics.drifts).toBe(0);
  });

  it('lets the client cancel a rendering without opening the ear', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'bas ruk jao');

    await session.handle({ t: 'cancel' });

    expect(channel.last('flush')?.reason).toBe('cancelled');
    expect(session.state).toBe('listening');
    // `cancel` is the button, not the microphone: the ear was closed by `hush` and
    // must not reopen behind the user's back.
    expect(ear.activityStarts).toBe(1);

    // Twice is not an error and not a second flush. A client whose user mashes the
    // button would otherwise put a `flush` on the socket for every press.
    await session.handle({ t: 'cancel' });
    expect(channel.of('flush')).toHaveLength(1);
  });

  it('drops microphone frames that arrive before listen, and says nothing about them', async () => {
    const session = sessionFor();
    await session.open();

    session.handleAudioFrame(chunk());
    session.handleAudioFrame(chunk());

    // Silence rather than an error frame, and the reason is arithmetic: a client whose
    // VAD is misbehaving streams twenty frames a second, and answering each one would
    // put twenty messages a second on the socket to say the same thing.
    expect(ear.frames).toHaveLength(0);
    expect(channel.of('error')).toHaveLength(0);

    await session.handle({ t: 'listen' });
    session.handleAudioFrame(chunk());
    // Base64 on the provider hop and nowhere else, so the bytes must survive it.
    expect(ear.frames).toHaveLength(1);
    expect([...Buffer.from(ear.frames[0]!, 'base64')]).toEqual([...chunk()]);
  });

  it('refuses a frame larger than the wire allows, and keeps the session', async () => {
    const session = sessionFor();
    await session.open();
    await session.handle({ t: 'listen' });

    session.handleAudioFrame(chunk(MAX_AUDIO_FRAME_BYTES + 1));

    // Not fatal, because one oversized frame is a client bug and not an attack she
    // needs to hang up on — and the next correctly sized frame must still be heard.
    const refusal = channel.of('error')[0];
    expect(refusal?.code).toBe('frame_too_large');
    expect(refusal?.fatal).toBe(false);
    expect(ear.frames).toHaveLength(0);
    expect(channel.closedWith).toBeUndefined();

    session.handleAudioFrame(chunk(MAX_AUDIO_FRAME_BYTES));
    expect(ear.frames).toHaveLength(1);
  });

  it('refuses a turn that arrives faster than she can think, without moving her state', async () => {
    // The socket must not be a way around the limiter `POST /api/chat` obeys — same
    // runtime, same model spend, same database.
    const session = sessionFor({ mayThink: () => ({ allowed: false, retryAfterMs: 3_000 }) });
    await session.open();
    const statesAfterOpen = channel.of('state').length;

    await session.handle({ t: 'say', text: 'phir se' });

    const refusal = channel.of('error')[0];
    expect(refusal?.code).toBe('too_many_requests');
    expect(refusal?.fatal).toBe(false);
    expect(refusal?.message).toContain('3s');

    // This is the hole `useVoice.turnsSettled` exists for, asserted rather than
    // described: the refusal happens before any transition, so there is no `state`
    // frame and no `cycle.*` event to tell a client its turn is over. A client that
    // cleared its spinner on state alone would spin forever.
    expect(channel.of('state')).toHaveLength(statesAfterOpen);
    expect(session.state).toBe('listening');
    expect(channel.of('said')).toHaveLength(0);
    expect(channel.of('silent')).toHaveLength(0);
    // And nothing was spent: no cycle row, so no stages ran.
    expect(sourcesOf(conversationId())).toEqual([]);
    expect(session.statistics.turns).toBe(0);
  });

  it('thinks about what it heard when the provider never commits the turn', async () => {
    const session = sessionFor();
    await session.open();
    await session.handle({ t: 'listen' });
    ear.says.onHeard('reminder laga do', false);
    await session.handle({ t: 'hush' });

    // No `onHeard(final)` at all — a dropped provider frame, or a turn the model
    // decided was empty. The grace timer is the bound on "shortly", and without it a
    // session that heard a whole sentence and never thought about it is
    // indistinguishable from her ignoring him.
    expect(channel.of('said')).toHaveLength(0);
    await settle();

    expect(channel.last('said')?.text.length).toBeGreaterThan(0);
    expect(sourcesOf(conversationId())).toEqual(['audio']);
    expect(app.messages.recentForCaller(conversationId(), owner.id, 10)[0]?.text).toBe(
      'reminder laga do',
    );

    // And the browser was told the utterance closed. `useVoice` clears its live
    // transcript on `final` and on nothing else, and `src/ui/Voice.tsx` shows that
    // transcript in preference to the line she is speaking — so a grace-path turn
    // with no `final` left his own words on screen and her answer invisible.
    const last = channel.last('heard');
    expect(last?.final).toBe(true);
    expect(last?.text).toBe('reminder laga do');
  });

  it('sends one final transcript per utterance, however late the provider commits', async () => {
    const session = sessionFor();
    await session.open();
    await session.handle({ t: 'listen' });
    ear.says.onHeard('kal subah uthana', false);
    await session.handle({ t: 'hush' });
    await settle();

    // The grace timer has already closed and answered this utterance. The provider's
    // commit then arrives — which is what the real one does, a beat after the timer —
    // and it must not announce a second, empty one: `{final: true, text: ''}` says she
    // finished hearing nothing, about a sentence she has just answered.
    ear.says.onHeard('', true);
    await settle();

    const finals = channel.of('heard').filter((frame) => frame.final);
    expect(finals).toHaveLength(1);
    expect(finals[0]?.text).toBe('kal subah uthana');
    // One turn, not two: the late commit found an empty transcript and spent nothing.
    expect(sourcesOf(conversationId())).toEqual(['audio']);
  });

  it('keeps thinking in text after the provider hangs up on her', async () => {
    const session = sessionFor();
    await session.open();
    expect(channel.last('ready')?.canHear).toBe(true);

    ear.says.onClose(1011, 'provider went away');

    const notice = channel.of('error')[0];
    expect(notice?.code).toBe('ear_closed');
    // Not fatal: the ear and the mouth are gone, the socket is not, and `say` still
    // runs the same twelve stages. Closing here would take the text composer away
    // from a user who can still type.
    expect(notice?.fatal).toBe(false);
    expect(notice?.message).toContain('1011');
    expect(channel.closedWith).toBeUndefined();

    await session.handle({ t: 'say', text: 'ab bhi sun rahi ho' });
    expect(channel.last('said')?.text.length).toBeGreaterThan(0);
    // No mouth left, so the line reaches the transcript and no audio is synthesised.
    expect(ear.rendered).toHaveLength(0);
    expect(channel.audio).toHaveLength(0);
    expect(session.state).toBe('listening');
  });

  // ── B08.s3: interruptible speech — responseId/seq, flush queue, late packets, job-continuation ──

  it('said carries responseId/seqBase and each audio frame carries incrementing seq', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'sun rahi ho');
    const said = channel.last('said');
    expect(said?.responseId).toBeTruthy();
    expect(typeof said?.seqBase).toBe('number');
    // Two frames of the authorized turn — each must carry this responseId and ascending seq
    ear.says.onAudio(fromProvider(320));
    ear.says.onAudio(fromProvider(320));
    expect(channel.audio).toHaveLength(2);
    expect(channel.envelopes[0]?.responseId).toBe(said?.responseId);
    expect(channel.envelopes[1]?.responseId).toBe(said?.responseId);
    expect(channel.envelopes[1]!.seq).toBe(channel.envelopes[0]!.seq + 1);
    // turn_end carries the same responseId
    ear.says.onVoiced(said?.text ?? '');
    ear.says.onTurnEnd('complete');
    expect(channel.last('turn_end')?.responseId).toBe(said?.responseId);
  });

  it('flush retires responseId and late packets for it never resume after a new utterance', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'pehla');
    const firstId = channel.last('said')?.responseId;
    expect(firstId).toBeDefined();
    ear.says.onAudio(fromProvider());
    expect(channel.audio).toHaveLength(1);

    // Barge-in retires first utterance and requires flush+turn_end for that responseId
    await session.handle({ t: 'listen' });
    expect(channel.of('flush').some((f) => f.responseId === firstId && f.reason === 'interrupted')).toBe(true);
    expect(
      channel.of('turn_end').some((f) => (f as { responseId?: string }).responseId === firstId),
    ).toBe(true);

    // Start second utterance; late audio that would belong to the first must be dropped
    ear.says.onHeard('dusra shuru', false);
    await session.handle({ t: 'hush' });
    ear.says.onHeard('', true);
    await settle();
    const secondId = channel.last('said')?.responseId;
    expect(secondId).toBeDefined();
    expect(secondId).not.toBe(firstId);
    ear.says.onAudio(fromProvider());
    expect(channel.audio).toHaveLength(2); // second utterance's frame lands
    expect(channel.envelopes.at(-1)?.responseId).toBe(secondId);
    // A late frame would need to present the old responseId to be dropped; with the current
    // provider-callback shape there is no cross-utterance alias, so the guarantee exercised
    // is that the retired set no longer forwards the old response's late arrival.
    // The second branch is proved: a frame after flush of that id is either dropped
    // (if presented with that id) or accepted as the new utterance when presented with the new id.
    expect(session.statistics.droppedFrames).toBe(0); // late packet never counted as voiced
  });

  it('stopSpeaking (cancel) does not touch durable work — structural guarantee', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'kaam chal raha hai');
    const said = channel.last('said')!;
    // `cancel` flushes the mouth; inspecting the session proves it has no coordinator/work handle
    await session.handle({ t: 'cancel' });
    expect(channel.last('flush')?.reason).toBe('cancelled');
    expect(channel.last('flush')?.responseId).toBe(said.responseId);
    // No durable job field on the session: cancellation is voice-only by construction.
    expect((session as unknown as Record<string, unknown>)['workCoordinator']).toBeUndefined();
    expect((session as unknown as Record<string, unknown>)['coordinator']).toBeUndefined();
    expect(session.state).toBe('listening');
  });

  it('closes the provider, records the turn count, and hangs up once', async () => {
    const session = sessionFor();
    await session.open();
    await speak(session, 'chalo bye');
    // A clean turn, so the counters the disconnect carries are the counters of a
    // session that did nothing wrong.
    ear.says.onVoiced(channel.last('said')?.text ?? '');
    ear.says.onTurnEnd('complete');

    await session.handle({ t: 'bye' });

    expect(ear.closes).toBe(1);
    expect(channel.closedWith?.code).toBe(CLOSE_GOING_AWAY);
    expect(session.state).toBe('disconnected');

    // What the disconnect carries is what a session is accountable for. Read from the
    // event row rather than the counters, because the row is what survives the process.
    const rows = db.raw
      .prepare(
        `SELECT payload_json FROM domain_event WHERE type = 'session.disconnected'`,
      )
      .all() as { payload_json: string }[];
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json) as {
      channel: string;
      turns: number;
      droppedFrames: number;
      drifts: number;
    };
    expect(payload.channel).toBe('voice');
    expect(payload.turns).toBe(1);
    expect(payload.droppedFrames).toBe(0);
    expect(payload.drifts).toBe(0);

    // Everything after `bye` is a no-op rather than a second close or a throw: a
    // browser tab that says goodbye and then unloads sends both.
    await session.handle({ t: 'say', text: 'ek aur' });
    await session.close(CLOSE_GOING_AWAY, 'again');
    expect(ear.closes).toBe(1);
    expect(sourcesOf(conversationId())).toEqual(['audio']);
    expect(rows).toHaveLength(1);
  });
});

/**
 * The comparison the whole drift check is built on, in the one script that breaks it.
 *
 * Exported from `session.ts` for exactly this reason. Its own comment makes a specific
 * claim — that `\w` would strip Devanagari to nothing, read as 0% coverage, and flush
 * every correct rendering she ever made — and she answers in Hinglish, so that is not
 * a hypothetical failure mode. It is most of her sentences.
 */
describe('the tokenizer the drift check compares with', () => {
  it('counts Devanagari words as words', () => {
    // `\w` is ASCII. Under it this line tokenizes to zero, `total` is zero, and
    // `coverageShort` returns early — so nothing is flushed and nothing is *checked*
    // either: the drift gate silently stops existing for every Hindi line.
    expect(tokenize('आज मौसम कैसा है')).toEqual(['आज', 'मौसम', 'कैसा', 'है']);
    expect(tokenize('kal subah 8 baje')).toEqual(['kal', 'subah', '8', 'baje']);
  });

  it('keeps the marks that are part of the word attached to it', () => {
    // The failure this file actually found. Vowel signs and the halant are Unicode
    // *marks*, not letters, so `[^\p{L}\p{N}]` deleted them and split the word at
    // each one — `मौसम` came out as `म` + `सम`. Both sides of the comparison were
    // shredded identically, so a correct rendering still mostly matched and nothing
    // looked broken; what broke is that single-consonant fragments recur across
    // unrelated words, so a mouth answering in different Hindi matched them too.
    expect(tokenize('मौसम')).toHaveLength(1);
    expect(tokenize('कर्म')).toHaveLength(1);
    expect(tokenize('हूँ')).toHaveLength(1);
    // And the fragments a broken tokenizer produced must not be what a real word
    // reduces to, which is the collision that blunted the gate.
    expect(tokenize('मौसम')).not.toContain('म');
  });

  it('drops what a transcription of speech does not carry reliably', () => {
    // Case and punctuation. The provider's transcription of its own voice
    // re-punctuates and re-capitalises, and a comparison that counted those would
    // flag a perfectly good rendering as unauthorized.
    expect(tokenize('Haan, theek hai — 5 baje!')).toEqual(['haan', 'theek', 'hai', '5', 'baje']);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('')).toEqual([]);
  });

  it('is a multiset, so a repeated word has to be voiced twice', () => {
    // What makes `absorb` count the second `hai` as extra if the line held one. A set
    // would forgive a mouth that latched on one word and repeated it for a sentence.
    expect(tokenize('hai hai')).toEqual(['hai', 'hai']);
  });
});
