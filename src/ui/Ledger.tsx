/**
 * How she is built, for when you want to know.
 *
 * This is the surface behind the 6 px dot in the bar. It is closed by default and
 * slides over rather than pushing the room aside, because none of it is needed to
 * talk to her — it is here so that the thing you are talking to is not a black box.
 *
 * ## One count is reported as an absence rather than as a zero
 *
 * `version` is the sequence number of the newest event folded into the state, so it
 * stays at zero whenever there is no `RealtimeFlow` behind it — realtime off, or a
 * direct read of her tables. Drawing "0" would be a number that looks measured and is
 * not, so the note under Stream says which of the two you are looking at instead.
 *
 * There was a second one. A list of in-flight tool calls hung under Work, with a note
 * explaining that nothing ever put anything in it. Both the field and the branch are
 * gone — see `PendingAction`'s epitaph in `server/realtime/types.ts` — and what the
 * branch was reaching for is now read where it actually lives: "Doing now" below is
 * `cognitive.currentStage`, which reads `ACT` for exactly as long as an action is in
 * flight, folded from the event log like every other number here.
 */

import { useEffect, type ReactElement } from 'react';

import type { RuntimeState } from '@server/realtime/types.js';

import type { StreamStatus } from '../lib/stream.js';
import type { SignatureState } from '../state/useSignature.js';
import { clock, doingWords } from './format.js';

export interface LedgerProps {
  open: boolean;
  onClose: () => void;
  state: RuntimeState | undefined;
  status: StreamStatus;
  absentAtBoot: readonly string[];
  /**
   * The signature sound, because this is the one surface that is about the interface
   * rather than about her.
   *
   * The room holds no settings at all — it is the conversation and nothing else — and
   * a mute control in the bar would be a permanent icon for a decision made once.
   * Behind the dot is where someone already comes to ask what this thing is doing.
   */
  sound: SignatureState;
}

/** A count and its name. `<b>` because the number is the thing being looked up. */
function Row({ name, value }: { name: string; value: string | number }): ReactElement {
  return (
    <div className="ledger-row">
      <span>{name}</span>
      <b>{value}</b>
    </div>
  );
}

/** Epoch 0 is "it has not happened", which is not a time and must not be drawn as one. */
function when(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'never';
  return clock(timestamp);
}

export function Ledger({
  open,
  onClose,
  state,
  status,
  absentAtBoot,
  sound,
}: LedgerProps): ReactElement {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      <div
        className="ledger-scrim"
        data-open={open ? 'true' : 'false'}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="ledger"
        data-open={open ? 'true' : 'false'}
        aria-label="How she is built"
        aria-hidden={open ? undefined : true}
      >
        <div className="ledger-head">
          <span className="label">How she is built</span>
          <button className="plain bar-quiet" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {state === undefined ? (
          <p className="ledger-note">
            Nothing has been read from her yet. This fills in as soon as
            <code> GET /api/state </code> answers.
          </p>
        ) : (
          <>
            <div className="ledger-group">
              <span className="label">Memory</span>
              <div className="ledger-rows">
                <Row name="Episodes" value={state.memory.episodicCount} />
                <Row name="Facts" value={state.memory.semanticCount} />
                <Row name="Preferences" value={state.memory.preferenceCount} />
                <Row name="Habits" value={state.memory.habitCount} />
                <Row name="People" value={state.memory.relationshipCount} />
                <Row name="Patterns" value={state.memory.learnedPatternCount} />
                <Row name="Last consolidation" value={when(state.memory.lastConsolidationAt)} />
              </div>
            </div>

            <div className="ledger-group">
              <span className="label">Work</span>
              <div className="ledger-rows">
                <Row name="Loops running" value={state.loops.activeCount} />
                <Row name="Loops paused" value={state.loops.pausedCount} />
                <Row name="Tasks waiting" value={state.tasks.pendingCount} />
                <Row name="Tasks running" value={state.tasks.runningCount} />
                <Row name="Tasks failed" value={state.tasks.failedCount} />
              </div>
            </div>

            <div className="ledger-group">
              <span className="label">This cycle</span>
              <div className="ledger-rows">
                {/*
                  `currentStage` is `PERCEIVE` before the first cycle as much as during
                  one, and only `cycleId` tells the two apart — so the guard is what
                  keeps this row from reporting that she is taking something in when
                  nothing has ever been said to her.
                */}
                <Row
                  name="Doing now"
                  value={
                    state.cognitive.cycleId === ''
                      ? '—'
                      : doingWords(state.cognitive.currentStage)
                  }
                />
                <Row name="Stage reached" value={state.cognitive.lastCompletedStage ?? '—'} />
                <Row name="Cycle" value={state.cognitive.cycleId || '—'} />
                <Row name="Started" value={when(state.cognitive.cycleStartedAt)} />
              </div>
            </div>

            <div className="ledger-group">
              <span className="label">Stream</span>
              <div className="ledger-rows">
                <Row name="Last change" value={state.lastMutation.type || '—'} />
                <Row name="At" value={when(state.lastMutation.timestamp)} />
              </div>
              <p className="ledger-note">
                {status === 'live'
                  ? `Event ${state.version} of her log is the newest one folded into the numbers above.`
                  : 'Nothing is streaming, so no event is being folded in: the numbers above are a direct read of her tables, correct when they were read and not kept fresh.'}
              </p>
            </div>
          </>
        )}

        {absentAtBoot.length > 0 ? (
          <div className="ledger-group">
            <span className="label">Starting without</span>
            <ul className="absent-list">
              {absentAtBoot.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="ledger-group">
          <span className="label">This interface</span>
          <div className="ledger-rows">
            <div className="ledger-row">
              <span>Signature sound</span>
              <button
                className="plain bar-quiet"
                type="button"
                onClick={() => sound.setEnabled(!sound.enabled)}
                aria-label="Signature sound"
                aria-pressed={sound.enabled}
              >
                {sound.enabled ? 'On' : 'Off'}
              </button>
            </div>
          </div>
          <p className="ledger-note">
            Eight short cues, all from one scale: arriving, a turn sent, an answer, a
            turn she ended without words, a stage that fell back, a refusal, and the
            microphone opening and closing. Nothing plays while the microphone is open —
            it would be heard by the ear it just opened.
          </p>
        </div>
      </aside>
    </>
  );
}
