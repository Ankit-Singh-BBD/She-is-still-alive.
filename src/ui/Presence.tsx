/**
 * The room: a thin bar, the transcript, the composer, one whisper.
 *
 * ## What is not here
 *
 * No sidebar, no tabs, no toolbar, no icons. Everything that is not the conversation
 * is either in the bar (her name, the hour, the sky, the stream) or behind the dot
 * that opens the ledger. The field is not rendered here at all — it lives in `App`,
 * one layer down, so that walking from the door into the room does not tear down and
 * rebuild a GL context.
 *
 * ## The dot has two jobs
 *
 * It reports the stream and it opens the ledger. That is deliberate rather than
 * thrifty: the ledger is where you go when the dot has told you something is wrong,
 * so the dot is the right thing to press. It also means the bar has three elements
 * on its right instead of four.
 *
 * ## Grid rows, not scroll positions
 *
 * The room is `auto / 1fr / auto`, and only the middle row scrolls. A single page
 * scroll would drag the fixed field's edges against the viewport, and a
 * `position: sticky` composer would slide under the mobile keyboard rather than above
 * it. The keyboard shrinks the visual viewport, the grid re-lays out, and the
 * composer stays where it belongs.
 *
 * ## Voice is part of the composer row, not a mode
 *
 * There is no "voice mode" to enter and leave. The microphone is one dot at the head
 * of the same row the words are typed into, and the live caption is one dim line
 * above it — so speaking to her and typing to her are the same act performed two
 * ways, and either can interrupt the other mid-sentence. When the server has no ear
 * the dot is simply not there and the row is what it always was.
 */

import type { ReactElement } from 'react';

import type { RuntimeState } from '@server/realtime/types.js';

import type { Hello } from '../lib/api.js';
import type { StreamStatus } from '../lib/stream.js';
import type { DialogueState } from '../state/useDialogue.js';
import type { PlaceState } from '../state/usePlace.js';
import type { VoiceReading } from '../state/useVoice.js';
import { Composer } from './Composer.js';
import { Notice } from './Notice.js';
import { Transcript } from './Transcript.js';
import { Mic, VoiceLine } from './Voice.js';
import { Whisper } from './Whisper.js';
import { environmentWords } from './format.js';

export interface PresenceProps {
  hello: Hello | undefined;
  state: RuntimeState | undefined;
  status: StreamStatus;
  dialogue: DialogueState;
  voice: VoiceReading;
  /**
   * She is thinking, on either channel.
   *
   * Not `dialogue.thinking`, which is narrower on purpose: that one means "a turn
   * this client sent is outstanding", which is what the optimistic transcript
   * bookkeeping needs. A turn she was *spoken* has nothing of his on screen at all
   * while she thinks about it, so the room would look idle through the one gap where
   * an indicator matters most. Computed in `App`, which holds both hooks, so there is
   * one definition of it rather than one per reader.
   */
  thinking: boolean;
  place: PlaceState;
  busy: boolean;
  onLeave: () => void;
  onOpenLedger: () => void;
}

/** What the dot says out loud, since a colour is not readable. */
const STREAM_WORDS: Record<StreamStatus, string> = {
  live: 'She is streaming.',
  connecting: 'Reconnecting to her.',
  unavailable: 'Not streaming — showing the last thing she reported.',
  closed: 'The stream has closed.',
};

export function Presence({
  hello,
  state,
  status,
  dialogue,
  voice,
  thinking,
  place,
  busy,
  onLeave,
  onOpenLedger,
}: PresenceProps): ReactElement {
  const environment = state?.environment;

  return (
    <div className="room">
      <header className="bar">
        <div className="bar-left">
          <span className="bar-name">{hello?.name ?? 'Madhurita'}</span>
          {environment !== undefined ? (
            <div className="bar-env">
              {environmentWords(environment).map((word) => (
                <span key={word}>{word}</span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="bar-right">
          <button
            className="plain"
            type="button"
            onClick={onOpenLedger}
            title={`${STREAM_WORDS[status]} Open how she is built.`}
            aria-label={`${STREAM_WORDS[status]} Open how she is built.`}
          >
            <span className="dot" data-status={status} />
          </button>
          <button className="plain bar-quiet" type="button" onClick={onLeave} disabled={busy}>
            Leave
          </button>
        </div>
      </header>

      <Transcript turns={dialogue.turns} thinking={thinking} />

      <div className="foot">
        <div className="foot-inner">
          {/* Two channels, two notices, and no arbitration between them. `Notice`
              draws nothing for `undefined`, so in the ordinary case this is one line
              or none — and when both have something to say, both said it. */}
          <Notice notice={dialogue.notice} />
          <Notice notice={voice.notice} />
          <VoiceLine voice={voice} />
          <Composer
            say={dialogue.say}
            thinking={dialogue.thinking}
            lead={<Mic voice={voice} />}
          />
          <Whisper
            environment={environment}
            stage={state?.cognitive.currentStage ?? 'PERCEIVE'}
            thinking={thinking}
            lastReply={dialogue.lastReply}
            status={status}
            place={place}
          />
        </div>
      </div>
    </div>
  );
}
