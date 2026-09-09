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
}

/** Local ids are prefixed so a turn that never reached the server is recognisable. */
const LOCAL_PREFIX = 'local:';

export function useDialogue({ active, onExpire }: DialogueOptions): DialogueState {
  const [turns, setTurns] = useState<readonly ConversationTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [thinking, setThinking] = useState(false);
  const [lastReply, setLastReply] = useState<ChatReply | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);

  const expireRef = useRef(onExpire);
  expireRef.current = onExpire;
  const localCount = useRef(0);

  // Pick up whatever was in the middle of being said. `listForIdentity` filters by
  // identity in SQL and excludes ended conversations, so the first row is the one.
  useEffect(() => {
    if (!active) {
      setTurns([]);
      setConversationId(undefined);
      setLastReply(undefined);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const { conversations } = await api.conversations();
        const open = conversations[0];
        if (!live || open === undefined) return;
        setConversationId(open.id);
        const transcript = await api.transcript(open.id);
        if (!live) return;
        setTurns(transcript.turns);
      } catch (error) {
        if (!live) return;
        if (error instanceof ApiFailure && error.isAuth) expireRef.current();
        // Otherwise: an empty room is a fine place to start talking from.
      }
    })();
    return () => {
      live = false;
    };
  }, [active]);

  const say = useCallback<DialogueState['say']>(
    async (raw) => {
      const text = raw.trim();
      // The server refuses whitespace with a 400 and, importantly, writes no
      // `cycle_record` for it. Catching it here spends no request to learn that.
      if (text.length === 0) return false;

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
      setThinking(true);
      setNotice(undefined);

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
