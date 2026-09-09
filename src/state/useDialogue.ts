/**
 * The exchange: what has been said, and how to say the next thing.
 *
 * ## The transcript is re-read from the server after every turn
 *
 * A turn is appended locally the moment it is typed, because an interface that
 * waits for a twelve-stage cycle before showing your own words feels broken. But
 * the optimistic copy is *replaced* by `GET /api/conversations/:id/messages` as
 * soon as the cycle returns, rather than being kept and added to.
 *
 * That is deliberate. Stage 12 writes both turns inside the cycle's transaction,
 * so the server's copy is what she will remember; a locally-maintained list would
 * be a second, slightly different history that only diverges — wrong order after a
 * fast double-send, a turn that a rolled-back transaction never actually stored,
 * text that redaction changed on the way out. Re-reading costs one small request
 * per turn and makes the screen and her memory the same thing by construction.
 *
 * ## A failed turn leaves no trace, on purpose
 *
 * If `POST /api/chat` refuses — rate limited, cognition switched off, session
 * expired — the cycle did not run and nothing was persisted. The optimistic turn is
 * therefore removed rather than left greyed out, because a line in the transcript
 * that she has no record of is the interface inventing a memory. The words go back
 * into the composer instead, which is where they can still be sent.
 *
 * ## Turns this client never asked for
 *
 * Re-reading after `say()` is only half of it, and until the autonomic loop existed
 * it was the only half that could matter: every turn in the database got there
 * because this client posted one. That is no longer true. `AutonomicLoop` runs a
 * cycle off its own sensors, and `TaskExecutor` speaks a reminder when it comes
 * due — both commit an assistant turn with no request from here at all. A client
 * that only re-read after its own `POST` would hold a transcript that was missing
 * her, and would keep holding it until the next thing he happened to type.
 *
 * So the stream is watched, through `usePresence`'s `cycleCommits` counter: the
 * number of terminal cycle events that have arrived as their own SSE frames. Stage
 * 12 delivers those after its transaction commits, so a bump is a promise that
 * whatever turns the cycle produced are already readable.
 *
 * Watching cycles rather than `proactive.delivered` is deliberate on two counts. A
 * reminder never touches `proactive_decision`, so `proactive.delivered` would miss
 * the utterances he most expects to hear; and a second open tab is a client with
 * turns it never asked for too, so it should see the exchange the first tab is
 * having. The cost is one small read per cycle this client did not run, and the
 * alternative is a screen that quietly disagrees with her memory.
 *
 * The counter comes from the event frames rather than from `state.lastMutation`,
 * which is the obvious-looking source and is the wrong one: the state frame is
 * built from a snapshot read at send time, so during a burst every trailing frame
 * names the newest event and the cycle's own terminal event never appears in one.
 * That was measured, not reasoned about — the header of `src/lib/stream.ts` has the
 * frame-by-frame trace.
 *
 * ## Two ways to send the same sentence
 *
 * `POST /api/chat` answers in text. The voice socket's `say` runs the identical
 * twelve stages — `LiveSession.think` passes `source: 'text'`, so a typed turn stays
 * a typed turn in the `message` row and the audit trail — and then *speaks* the
 * answer. That is the whole reason `say` exists on the socket, and it means the
 * channel a typed sentence should take depends on whether she currently has a mouth.
 *
 * So the transport is injected. When `speak` is present the words go on the socket;
 * otherwise they go over HTTP. Everything else about a turn — the optimistic append,
 * the authoritative re-read, the removal of a turn that was never persisted — is
 * written once and shared, because two copies of "how a turn appears on screen"
 * would be two subtly different answers to the same question.
 *
 * The two channels differ in exactly one way, and it is not hidden: HTTP resolves a
 * promise, so a refusal is caught and the words stay in the composer where they can
 * still be sent. The socket has no promise — the outcome arrives as one of four
 * later frames — so `voiceTurns` is the resolution, and on the one outcome that
 * persisted nothing (her think-rate limit) the words are lost. That limit is
 * per-identity and one person typing cannot reach it, which is the only reason this
 * is a trade worth making rather than a bug.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiFailure, api, type ChatReply, type ConversationTurn } from '../lib/api.js';
import { noticeFrom, type Notice } from './notice.js';

export interface DialogueState {
  turns: readonly ConversationTurn[];
  /** True from the moment a turn is sent until its cycle answers. */
  thinking: boolean;
  /** The last cycle's own report of itself, including how it degraded. */
  lastReply: ChatReply | undefined;
  notice: Notice | undefined;
  clearNotice: () => void;
  /** `false` means nothing was sent and the text should stay in the composer. */
  say: (text: string) => Promise<boolean>;
}

export interface DialogueOptions {
  active: boolean;
  onExpire: () => void;
  /**
   * `usePresence.cycleCommits` — how many cycles have committed on this stream.
   *
   * Passed in rather than subscribed to here so there is one `EventSource` for the
   * page: `usePresence` owns the connection, and this hook only needs to know that
   * the number went up.
   */
  cycleCommits: number;
  /**
   * `useVoice.sayAloud` — the socket's `say`, or `undefined` when she has no mouth.
   *
   * `undefined` is the ordinary configuration, not a failure: no key, or `FLAG_VOICE`
   * off. Injected for the same reason `cycleCommits` is: `useVoice` owns the socket,
   * and this hook only needs a function that either exists or does not.
   */
  speak: ((text: string) => boolean) | undefined;
  /**
   * `useVoice.turnsSettled` — how many turns the socket has finished with.
   *
   * The socket's answer to a resolved promise. It rises on every outcome including
   * the ones that persisted nothing, which is what keeps a turn from waiting forever
   * on a reply that is not coming.
   */
  voiceTurns: number;
}

/**
 * Local ids are prefixed so a turn that never reached the server is recognisable.
 *
 * Exported because the transcript draws those turns differently — a line that is
 * still in the air is dimmed — and a second copy of the string in the component
 * would be a convention that can silently drift apart.
 */
export const LOCAL_PREFIX = 'local:';

export function useDialogue({
  active,
  onExpire,
  cycleCommits,
  speak,
  voiceTurns,
}: DialogueOptions): DialogueState {
  const [turns, setTurns] = useState<readonly ConversationTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [thinking, setThinking] = useState(false);
  const [lastReply, setLastReply] = useState<ChatReply | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const localCount = useRef(0);

  /**
   * True from the moment a turn goes out on the socket until `voiceTurns` moves.
   *
   * A ref rather than state because nothing renders differently for it — `thinking`
   * already does that — and because the settle effect must not re-run when it
   * changes. It is what tells that effect the bump belongs to a turn this client
   * sent, rather than to something she said on her own.
   */
  const awaitingVoice = useRef(false);

  /**
   * The transport a typed turn actually took, and its live availability.
   *
   * `speak` is read through a ref inside `say` so that `say`'s identity does not
   * change every time the socket reconnects — the composer would re-render on each
   * one for a function whose behaviour is unchanged.
   */
  const speakRef = useRef(speak);
  speakRef.current = speak;

  /**
   * True while `say` is in flight, in a ref rather than in the effect's deps.
   *
   * A stream frame that lands mid-turn must be ignored: the transcript holds an
   * optimistic turn the server has not got yet, and replacing it with the server's
   * copy would delete his words from under him. `say` re-reads when its cycle
   * returns, so nothing is lost by skipping — and reading `thinking` through a ref
   * keeps that decision from re-running this effect twice per turn.
   */
  const thinkingRef = useRef(false);
  thinkingRef.current = thinking;

  /**
   * Replace the transcript with the server's, finding the open conversation when
   * this client has not seen one yet.
   *
   * The discovery step is not redundant. She can speak first — a reminder due at
   * boot, a sensor that fired before he said anything — and then the conversation
   * stage 12 opened for her is one this client has never been told about.
   */
  const readTranscript = useCallback(
    async (alive: () => boolean): Promise<void> => {
      let id = conversationId;
      if (id === undefined) {
        const { conversations } = await api.conversations();
        if (!alive()) return;
        id = conversations[0]?.id;
        if (id === undefined) return;
        setConversationId(id);
      }
      const transcript = await api.transcript(id);
      if (!alive()) return;
      setTurns(transcript.turns);
    },
    [conversationId],
  );

  // Pick up whatever was in the middle of being said. `listForIdentity` filters by
  // identity in SQL and excludes ended conversations, so the first row is the one.
  useEffect(() => {
    if (!active) {
      setTurns([]);
      setConversationId(undefined);
      setLastReply(undefined);
      // A turn on the socket has no promise to unwind, so leaving the room while one
      // is outstanding would otherwise leave `thinking` true for the next visit.
      awaitingVoice.current = false;
      setThinking(false);
      return;
    }
    let live = true;
    void (async () => {
      try {
        await readTranscript(() => live);
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiFailure && error.isAuth) expireRef.current();
        // Otherwise: an empty room is a fine place to start talking from.
      }
    })();
    return () => {
      live = false;
    };
    // `readTranscript` is deliberately not a dependency: it changes identity when
    // the conversation id lands, and re-running the opening read then would be a
    // second request for what the first one just fetched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // A cycle committed somewhere. See the header: it may not have been ours.
  //
  // `cycleCommits` starts at 0 and only ever rises, so the guard below is the whole
  // of the bookkeeping — a counter cannot be read twice, and an effect that runs on
  // a re-render with the same count does nothing.
  useEffect(() => {
    if (!active || cycleCommits === 0) return;
    // While `say` is in flight the only cycle that can be committing is its own —
    // the per-identity gate holds, so `runIfIdle` declines every proactive attempt
    // for the duration — and `say` re-reads authoritatively when its reply lands.
    // Reading here as well would fetch the same rows twice, and reading them
    // *early* would replace his optimistic turn with a transcript that does not
    // have it yet, deleting his words from under him.
    if (thinkingRef.current) return;

    let live = true;
    void (async () => {
      try {
        await readTranscript(() => live);
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiFailure && error.isAuth) expireRef.current();
        // A failed read is not worth a notice. Nothing was asked for, so nothing
        // is owed an answer, and the next cycle will bring another chance.
      }
    })();
    return () => {
      live = false;
    };
  }, [active, cycleCommits, readTranscript]);

  // A turn this client put on the socket has finished. See the header: `said`,
  // `silent`, a refusal and a socket that went away all move `voiceTurns`, so this
  // runs on every outcome rather than only on the ones that produced words.
  //
  // That is what lets the four outcomes share one branch. The re-read is
  // authoritative, and stage 12 commits inside `runCycle` — before `said` or `silent`
  // is sent — so a turn that got that far is already readable, and a turn that did
  // not is absent. Absent is the honest thing to show for words she has no record of.
  useEffect(() => {
    if (!active || !awaitingVoice.current) return;
    awaitingVoice.current = false;
    setThinking(false);

    let live = true;
    void (async () => {
      try {
        await readTranscript(() => live);
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiFailure && error.isAuth) expireRef.current();
        // No notice: whatever the outcome was, `useVoice` has already said so on the
        // socket's own channel. A second sentence about one turn is noise.
      }
    })();
    return () => {
      live = false;
    };
  }, [active, voiceTurns, readTranscript]);

  const say = useCallback<DialogueState['say']>(
    async (raw) => {
      const text = raw.trim();
      // The server refuses whitespace with a 400 and, importantly, writes no
      // `cycle_record` for it. Catching it here spends no request to learn that.
      if (text.length === 0) return false;

      // Read at the keystroke rather than closed over, so a socket that opened or
      // dropped since the last render is accounted for.
      const onSocket = speakRef.current;

      localCount.current += 1;
      const localId = `${LOCAL_PREFIX}${localCount.current}`;
      const optimistic: ConversationTurn = {
        id: localId,
        conversationId: conversationId ?? '',
        role: 'user',
        text,
        timestamp: Date.now(),
      };
      setTurns((current) => [...current, optimistic]);
      setNotice(undefined);

      if (onSocket !== undefined) {
        // `false` means it never left the browser: past `MAX_SAY_LENGTH`, or the
        // socket closed between the render that offered this transport and the
        // keystroke that took it. Either way nothing is in flight, so the optimistic
        // turn comes straight back off and the words stay in the composer.
        if (!onSocket(text)) {
          setTurns((current) => current.filter((turn) => turn.id !== localId));
          return false;
        }
        awaitingVoice.current = true;
        setThinking(true);
        return true;
      }

      setThinking(true);
      try {
        const reply = await api.chat({
          text,
          ...(conversationId !== undefined ? { conversationId } : {}),
        });
        setLastReply(reply);
        setConversationId(reply.conversationId);
        // The authoritative history, including the turn stage 12 just committed.
        const transcript = await api.transcript(reply.conversationId);
        setTurns(transcript.turns);
        return true;
      } catch (error) {
        setTurns((current) => current.filter((turn) => turn.id !== localId));
        if (error instanceof ApiFailure && error.isAuth) {
          expireRef.current();
        } else {
          setNotice(noticeFrom(error));
        }
        return false;
      } finally {
        setThinking(false);
      }
    },
    [conversationId],
  );

  const clearNotice = useCallback(() => setNotice(undefined), []);

  return { turns, thinking, lastReply, notice, clearNotice, say };
}
