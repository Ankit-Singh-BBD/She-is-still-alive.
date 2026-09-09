/**
 * One line, the smallest text in the room, and the honest channel.
 *
 * ## Why there is exactly one
 *
 * Everything below competes for the same line, and that is the point. A stack of
 * status lines is a dashboard; one line is something you actually read. So the
 * contents are strictly ordered by how much they change what you would do next, and
 * the loser is simply not shown:
 *
 * 1. **She is working.** Which of the twelve stages, as a gerund. This is the only
 *    thing that is true *right now* rather than a moment ago.
 * 2. **The last cycle was not clean.** `degraded` names the stages that fell back,
 *    `failed` says the cycle did not close, `redacted` says she held something back
 *    and why. This is the whole reason the cycle contract distinguishes them.
 * 3. **Actions happened.** Counted as confirmed, unconfirmed and failed — never
 *    rolled into "done", because `success` is the call returning and `verified` is
 *    the world having changed.
 * 4. **Nothing is keeping this fresh.** The stream is gone; what is on screen is the
 *    last thing she reported. Said plainly rather than left for the reader to notice.
 * 5. **She does not know where she is** — with the offer to tell her, when that has
 *    not been asked yet.
 * 6. **The hour and the sky**, which is the quiet default and means all is well.
 */

import type { ReactElement } from 'react';

import type { CognitiveStageName, EnvironmentState } from '@server/realtime/types.js';

import type { ChatReply } from '../lib/api.js';
import type { StreamStatus } from '../lib/stream.js';
import type { PlaceState } from '../state/usePlace.js';
import { actionWords, cycleWords, doingWords, environmentWords } from './format.js';

export interface WhisperProps {
  environment: EnvironmentState | undefined;
  stage: CognitiveStageName;
  thinking: boolean;
  lastReply: ChatReply | undefined;
  status: StreamStatus;
  place: PlaceState;
}

export function Whisper({
  environment,
  stage,
  thinking,
  lastReply,
  status,
  place,
}: WhisperProps): ReactElement {
  if (thinking) {
    return (
      <div className="whisper" data-kind="doing" aria-live="polite">
        she is {doingWords(stage)}
      </div>
    );
  }

  const cycle = cycleWords(lastReply);
  if (cycle !== undefined) {
    return (
      <div className="whisper" data-kind="degraded" aria-live="polite">
        {cycle}
      </div>
    );
  }

  const actions = actionWords(lastReply);
  if (actions !== undefined) {
    return (
      <div className="whisper" data-kind="actions" aria-live="polite">
        {actions}
      </div>
    );
  }

  if (status === 'unavailable' || status === 'closed') {
    return (
      <div className="whisper" data-kind="stale">
        not streaming — this is the last thing she reported
      </div>
    );
  }

  if (environment === undefined) {
    return (
      <div className="whisper" data-kind="quiet">
        waiting to hear from her
      </div>
    );
  }

  if (environment.location === undefined) {
    if (place.status === 'asking') {
      return (
        <div className="whisper" data-kind="quiet">
          asking your browser where you are
        </div>
      );
    }
    if (place.status === 'unknown') {
      return (
        <div className="whisper" data-kind="quiet">
          she cannot see the sky —{' '}
          <button className="plain whisper-ask" type="button" onClick={place.ask}>
            tell her where you are
          </button>
        </div>
      );
    }
    return (
      <div className="whisper" data-kind="quiet">
        she does not know where she is
      </div>
    );
  }

  return (
    <div className="whisper" data-kind="quiet">
      {environmentWords(environment).join(' · ')}
    </div>
  );
}
