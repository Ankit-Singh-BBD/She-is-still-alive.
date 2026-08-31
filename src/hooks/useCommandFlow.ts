// ===================================================================
// useCommandFlow - Tracks voice/manual command lifecycle
// (UNDERSTAND → ACT → SHOW PROGRESS → RESULT → ACKNOWLEDGE → RETURN)
//
// Lifecycle is driven ONLY by the actual operation state — no
// artificial timers:
//   - submit()    starts UNDERSTAND → ACT in a single render
//   - progress()  caller invokes when the real backend call fires,
//                 moves ACT → SHOW PROGRESS
//   - complete()  caller invokes when the real operation is finished
//                 (assistant transcript, tool action, panel mount).
//                 Advances SHOW PROGRESS → RESULT. Caller can opt
//                 into acknowledge + return-to-origin transitions
//                 via { acknowledge, returnToOrigin }.
//   - fail()      caller invokes on real failure
//   - reset()     caller invokes when the user manually cancels or
//                 navigates elsewhere (e.g. "stop")
// ===================================================================

import { useCallback, useState } from 'react';
import { StageKey } from './useStage.js';
import {
  routeVoiceCommand,
  acknowledgeCommand,
  stageForCommand,
  VoiceCommand,
} from '../utils/voiceCommandRouter.js';

export type CommandPhase =
  | 'idle'
  | 'understand'
  | 'act'
  | 'show-progress'
  | 'result'
  | 'acknowledge'
  | 'returning';

export interface CommandFlowState {
  phase: CommandPhase;
  command: VoiceCommand | null;
  /** Monotonic id so stale callbacks can be ignored */
  flowId: number;
  /** The stage the user was on when the command started */
  originStage: StageKey | null;
  /** The stage currently active (may differ from origin during execution) */
  workingStage: StageKey | null;
  /**
   * Whether the command should auto-return to origin on completion.
   * True only for transient data commands (search, recall, add-task…).
   * False for explicit panel-open commands and lifecycle controls
   * (stop / continue / repeat / help / open-*).
   */
  shouldReturn: boolean;
  /** Time the command was issued (for timing animations) */
  startedAt: number | null;
}

const INITIAL: CommandFlowState = {
  phase: 'idle',
  command: null,
  flowId: 0,
  originStage: null,
  workingStage: null,
  shouldReturn: false,
  startedAt: null,
};

export interface UseCommandFlowResult {
  state: CommandFlowState;
  /** True when no flow is currently active */
  isIdle: boolean;
  /** Currently active flow id (or 0 if idle) */
  flowId: number;
  /**
   * Submit a user input. Returns the classified command so the caller
   * can decide whether to short-circuit (navigate/search) or fall through
   * to backend chat.
   */
  submit: (raw: string, currentStage: StageKey) => VoiceCommand;
  /**
   * Mark the operation as actively in progress (caller has just
   * issued the real backend call). Transitions ACT → SHOW PROGRESS.
   * If the operation is synchronous (e.g. a pure nav) the caller
   * should call complete() directly.
   */
  progress: () => void;
  /**
   * Mark the command as completed; transitions SHOW PROGRESS → RESULT.
   * Optionally advances through ACKNOWLEDGE → RETURNING (and back to
   * the origin stage) when the caller passes { acknowledge: true,
   * returnToOrigin: true }. The caller decides — these transitions
   * are never driven by an artificial timer.
   */
  complete: (opts?: { acknowledge?: boolean; returnToOrigin?: boolean }) => void;
  /** Mark the command as failed / interrupted. */
  fail: () => void;
  /** Clear the flow entirely (e.g. user manually navigated or said "stop"). */
  reset: () => void;
  /** Convenience: human acknowledgement string for the current command. */
  acknowledgement: string;
}

/**
 * Commands that are explicit destinations or lifecycle controls —
 * they must NOT auto-return to the previous stage on completion.
 * Only true data commands (search-query, recall, add-task, etc.) get
 * the shouldReturn=true treatment.
 */
const NON_TRANSIENT: ReadonlySet<string> = new Set([
  'go-home',
  'go-back',
  'close-panel',
  'open-memory',
  'open-search',
  'open-tasks',
  'open-calendar',
  'open-devices',
  'open-identity',
  'open-settings',
  'show-tasks',
  'stop',
  'continue',
  'repeat',
  'help',
  // Destructive / sensitive commands also must not auto-return —
  // the user is looking at a confirmation surface, not a panel.
  'delete-memory',
  'delete-conversation',
  'delete-all-memories',
  'delete-all-conversations',
  'show-bin',
  'restore-from-bin',
  'permanently-delete',
  'confirm-destructive',
  'cancel-destructive',
]);

export function useCommandFlow(
  setStage: (key: StageKey) => void,
): UseCommandFlowResult {
  const [state, setState] = useState<CommandFlowState>(INITIAL);

  const submit = useCallback(
    (raw: string, currentStage: StageKey): VoiceCommand => {
      // Cancel any in-flight flow first — interruption rule.
      const cmd = routeVoiceCommand(raw);

      // Compute the destination stage up-front so we can paint the
      // ACT phase and the stage change in a single render.
      const target = stageForCommand(cmd);
      const workingStage = target ?? currentStage;
      const flowId = state.flowId + 1;

      // For nav commands, the action IS the stage change. For data
      // commands (search-query, recall, add-task, etc.) we still
      // navigate to the relevant panel so the user SEES the work happen.
      const shouldReturn = !NON_TRANSIENT.has(cmd.kind) && workingStage !== currentStage;

      // Single render: UNDERSTAND phase, all state in place, banner
      // paints. Then a microtask later we transition to ACT so React
      // commits the UNDERSTAND frame first.
      setState({
        phase: 'understand',
        command: cmd,
        flowId,
        originStage: currentStage,
        workingStage,
        shouldReturn,
        startedAt: Date.now(),
      });

      // Apply the stage change atomically with the UNDERSTAND phase.
      if (workingStage !== currentStage) {
        setStage(workingStage);
      }

      // Move to ACT in a microtask so React commits the UNDERSTAND
      // frame first. (No rAF batching problem — a microtask runs
      // before the next paint but after the current event handler.)
      queueMicrotask(() => {
        setState((prev) =>
          prev.flowId === flowId && prev.phase === 'understand'
            ? { ...prev, phase: 'act' }
            : prev,
        );
      });

      return cmd;
    },
    [setStage, state.flowId],
  );

  const progress = useCallback(() => {
    setState((prev) => {
      if (prev.phase === 'idle') return prev;
      if (prev.phase === 'act' || prev.phase === 'understand') {
        return { ...prev, phase: 'show-progress' };
      }
      return prev;
    });
  }, []);

  const complete = useCallback(
    (opts?: { acknowledge?: boolean; returnToOrigin?: boolean }) => {
      const wantAcknowledge = opts?.acknowledge === true;
      const wantReturn = opts?.returnToOrigin === true;

      // Snapshot the current state outside of the setter so we can
      // decide whether to call setStage() as a side effect without
      // invoking it during render.
      let originToReturn: StageKey | null = null;
      setState((prev) => {
        if (prev.phase === 'idle') return prev;
        if (wantAcknowledge && wantReturn && prev.shouldReturn && prev.originStage) {
          originToReturn = prev.originStage;
        }
        return { ...prev, phase: 'result' };
      });

      // Caller may also want the acknowledgement text visible, and
      // may want us to return to the origin stage. Both are gated
      // by the caller's flags, not by a timer.
      if (wantAcknowledge) {
        setState((prev) => {
          if (prev.phase === 'idle') return prev;
          return { ...prev, phase: 'acknowledge' };
        });
        if (wantReturn && originToReturn) {
          setStage(originToReturn);
          setState((prev) => {
            if (prev.phase === 'idle') return prev;
            return { ...prev, phase: 'returning' };
          });
        }
      }

      // After RESULT (or the full ACKNOWLEDGE/RETURNING sequence)
      // paints, dismiss the banner on the next microtask. The caller
      // has already declared the operation done; the banner has
      // served its purpose. This is NOT a completion timer — it
      // fires immediately after the synchronous state commits, in
      // the same task, gated only on the next microtask checkpoint.
      queueMicrotask(() => {
        setState((s) => (s.flowId === state.flowId ? INITIAL : s));
      });
    },
    [setStage, state.flowId],
  );

  const fail = useCallback(() => {
    setState(INITIAL);
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL);
  }, []);

  const acknowledgement = state.command
    ? acknowledgeCommand(state.command)
    : '';

  return {
    state,
    isIdle: state.phase === 'idle',
    flowId: state.flowId,
    submit,
    progress,
    complete,
    fail,
    reset,
    acknowledgement,
  };
}
