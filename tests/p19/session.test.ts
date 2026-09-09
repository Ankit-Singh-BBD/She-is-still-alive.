/**
 * The voice session's transition table, and the two things it must never do.
 *
 * `SessionState` reaches the browser (`{t:'state'}`), `RuntimeState.voice.live` and
 * React state, so this machine decides what the interface can be asked to show. The
 * tests that matter are therefore not "does `start` work" but:
 *
 *   1. an illegal transition **throws** rather than silently keeping the old state,
 *      because a session reporting `listening` when it is not is the honesty defect
 *      this whole codebase is shaped against; and
 *   2. the edges that look surprising are the ones that are load-bearing —
 *      `listening → speaking` is her speaking first, `speaking → thinking` is
 *      barge-in, `thinking → listening` is a cycle that chose to stay quiet. All
 *      three are things she really does, so a table that rejected them would break
 *      her rather than protect her.
 *
 * There is no `'error'` state to test. `server/voice/session.ts` explains why at
 * length: every voice failure in `server/voice/live/session.ts` is deliberately
 * non-fatal and is reported as an `{t:'error', fatal:false}` frame while the session
 * stays `listening`, because typed turns still work.
 */

import { describe, it, expect, vi } from 'vitest';

import { LiveSessionStateMachine } from '@server/voice/session.js';
import type { SessionState, SessionStateChangeEvent } from '@server/voice/session.js';

/** The machine plus the transitions it announced, which is what the socket sees. */
function machine(): { sm: LiveSessionStateMachine; seen: SessionStateChangeEvent[] } {
  const seen: SessionStateChangeEvent[] = [];
  return { sm: new LiveSessionStateMachine((change) => seen.push(change)), seen };
}

/** Dial, answer: the two steps every path below starts with. */
function connected(): { sm: LiveSessionStateMachine; seen: SessionStateChangeEvent[] } {
  const made = machine();
  made.sm.start();
  made.sm.onConnected();
  return made;
}

describe('live voice session state', () => {
  it('starts closed, and says so before anything is asked of it', () => {
    expect(new LiveSessionStateMachine().state).toBe('disconnected');
  });

  it('announces every transition once, in order, with the reason that caused it', () => {
    const { sm, seen } = machine();

    sm.start();
    sm.onConnected();
    sm.onSpeechEnd();
    sm.onTtsStart();
    sm.onTtsEnd();
    sm.stop();

    expect(seen.map((change) => change.current)).toEqual([
      'connecting',
      'listening',
      'thinking',
      'speaking',
      'listening',
      'disconnected',
    ]);
    // `previous` is what the socket needs to render a transition rather than a
    // state, so each one must name the state actually left behind.
    expect(seen.map((change) => change.previous)).toEqual([
      'disconnected',
      'connecting',
      'listening',
      'thinking',
      'speaking',
      'listening',
    ]);
    expect(seen.map((change) => change.reason)).toEqual([
      'start',
      'connected',
      'speech_end',
      'tts_start',
      'tts_end',
      'stop',
    ]);
    expect(sm.state).toBe('disconnected');
  });

  describe('the edges that carry her behaviour', () => {
    it('lets her speak first, without a question to answer', () => {
      // The autonomic loop can start a cycle nobody asked for. If this edge were
      // missing she could only ever reply.
      const { sm } = connected();

      sm.onTtsStart();

      expect(sm.state).toBe('speaking');
    });

    it('lets her think and then stay quiet', () => {
      const { sm } = connected();
      sm.onSpeechEnd();

      sm.onThinkingFinished();

      expect(sm.state).toBe('listening');
    });

    it('accepts barge-in: a new thought while she is still talking', () => {
      const { sm } = connected();
      sm.onTtsStart();

      sm.onSpeechEnd();

      expect(sm.state).toBe('thinking');
    });

    it('closes from any state she can be in', () => {
      const paths: readonly ((sm: LiveSessionStateMachine) => void)[] = [
        (sm) => sm.start(),
        (sm) => {
          sm.start();
          sm.onConnected();
        },
        (sm) => {
          sm.start();
          sm.onConnected();
          sm.onSpeechEnd();
        },
        (sm) => {
          sm.start();
          sm.onConnected();
          sm.onTtsStart();
        },
      ];

      for (const walk of paths) {
        const sm = new LiveSessionStateMachine();
        walk(sm);
        sm.stop();
        expect(sm.state).toBe('disconnected');
      }
    });
  });

  describe('an illegal transition is a failure, not a silent no-op', () => {
    it('refuses to speak from a session that was never opened', () => {
      const { sm, seen } = machine();

      expect(() => sm.onTtsStart()).toThrowError(
        /Illegal state transition from 'disconnected' to 'speaking'/,
      );
      // The point of throwing: nothing moved and nothing was announced, so no
      // listener was told she was speaking.
      expect(sm.state).toBe('disconnected');
      expect(seen).toEqual([]);
    });

    it('refuses to think while the provider is still being dialled', () => {
      const { sm } = machine();
      sm.start();

      expect(() => sm.onSpeechEnd()).toThrowError(/from 'connecting' to 'thinking'/);
    });

    it('refuses to reopen a session that is already open', () => {
      const { sm } = connected();

      expect(() => sm.start()).toThrowError(/from 'listening' to 'connecting'/);
    });
  });

  describe('asking for the state it is already in', () => {
    it('is not an error, and is not announced', () => {
      // The orchestrator guards several calls on state it read a moment earlier;
      // `stop` on a closed session is the ordinary case. A no-op event would still
      // have gone out over the socket, so the machine swallows it here instead.
      const listener = vi.fn();
      const sm = new LiveSessionStateMachine(listener);

      expect(() => sm.stop()).not.toThrow();

      expect(sm.state).toBe('disconnected');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  it('runs with no listener at all', () => {
    // `VoiceSession` always passes one, but the machine's correctness does not
    // depend on anyone watching — and a throw from an absent callback would be a
    // failure caused purely by not caring about the answer.
    const sm = new LiveSessionStateMachine();

    sm.start();
    sm.onConnected();

    expect(sm.state satisfies SessionState).toBe('listening');
  });
});
