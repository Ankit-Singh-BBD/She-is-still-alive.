/**
 * What has been said. No bubbles, no avatars, no rails.
 *
 * ## Why her lines are the largest text in the room
 *
 * Because they are the only thing here anyone reads at length. Everything else — the
 * bar, the whisper, the ledger — is status, and status should be small. Her lines are
 * 1.0625 rem at weight 300 and a 1.65 line height, which is prose settings, not chat
 * settings. Your own lines are dimmer with a single hairline to their left: enough to
 * tell the two apart while scanning, and no more.
 *
 * ## The autoscroll rule
 *
 * It follows the newest turn *only if you were already at the bottom*. Scrolling up
 * to reread something and being yanked back down by an arriving line is the single
 * most common way a transcript betrays the person reading it, so the pinned flag is
 * recomputed on every scroll event and the effect obeys it.
 *
 * The jump is instant rather than smooth. A smooth scroll on the first paint would
 * animate through the entire history, and a smooth scroll mid-conversation competes
 * with the arriving line's own entrance.
 *
 * ## Times are shown sparingly
 *
 * A clock on every line is noise: in a fast exchange they are all the same minute.
 * One appears on the first turn and after any gap longer than five minutes, which is
 * exactly where it carries information — "this was a while later".
 */

import { useEffect, useRef, type ReactElement } from 'react';

import type { ConversationTurn } from '../lib/api.js';
import { LOCAL_PREFIX } from '../state/useDialogue.js';
import { clock } from './format.js';

/** How close to the bottom still counts as "at the bottom", in CSS pixels. */
const PINNED_SLACK = 96;

/** A gap this long earns a clock on the turn that follows it. */
const GAP_MS = 300_000;

export interface TranscriptProps {
  turns: readonly ConversationTurn[];
  /** Scrolls again when a cycle starts, so the ring is not left off-screen. */
  thinking: boolean;
}

export function Transcript({ turns, thinking }: TranscriptProps): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [turns, thinking]);

  return (
    <div
      className="scroll"
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinnedRef.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < PINNED_SLACK;
      }}
    >
      <div className="turns">
        {turns.length === 0 ? (
          <p className="transcript-empty">
            Nothing has been said in this room yet. Whatever you say here, she writes down and
            keeps.
          </p>
        ) : (
          turns.map((turn, index) => {
            const previous = index > 0 ? turns[index - 1] : undefined;
            const stamped =
              previous === undefined || turn.timestamp - previous.timestamp > GAP_MS
                ? clock(turn.timestamp)
                : '';
            return (
              <div
                className="turn"
                key={turn.id}
                data-role={turn.role}
                data-pending={turn.id.startsWith(LOCAL_PREFIX) ? 'true' : undefined}
              >
                {turn.text}
                {stamped.length > 0 ? <span className="turn-time">{stamped}</span> : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
