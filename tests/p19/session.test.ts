import { describe, it, expect, vi } from 'vitest';
import { LiveSessionStateMachine } from '@server/voice/session.js';
import type { SessionStateChangeEvent } from '@server/voice/session.js';

describe('P19 Live Session State Machine', () => {
  it('starts in disconnected state', () => {
    const sm = new LiveSessionStateMachine();
    expect(sm.state).toBe('disconnected');
    expect(sm.error).toBeUndefined();
  });

  it('allows valid happy path transitions', () => {
    const sm = new LiveSessionStateMachine();
    const states: string[] = [];
    sm.on('state', (e: SessionStateChangeEvent) => states.push(e.current));

    sm.start();
    expect(sm.state).toBe('connecting');

    sm.onConnected();
    expect(sm.state).toBe('listening');

    sm.onSpeechEnd();
    expect(sm.state).toBe('thinking');

    sm.onTtsStart();
    expect(sm.state).toBe('speaking');

    sm.onTtsEnd();
    expect(sm.state).toBe('listening');

    sm.stop();
    expect(sm.state).toBe('disconnected');

    expect(states).toEqual(['connecting', 'listening', 'thinking', 'speaking', 'listening', 'disconnected']);
  });

  it('rejects illegal transitions', () => {
    const sm = new LiveSessionStateMachine();

    // disconnected -> speaking is illegal
    expect(() => sm.onTtsStart()).toThrowError(/Illegal state transition/);

    // Start transitions to connecting
    sm.start();

    // connecting -> thinking is illegal
    expect(() => sm.onSpeechEnd()).toThrowError(/Illegal state transition/);

    sm.onConnected(); // listening

    // listening -> connecting is illegal
    expect(() => sm.retry()).toThrowError(/Can only retry from error state/);
  });

  it('recovers from error to connecting via retry', () => {
    const sm = new LiveSessionStateMachine();
    sm.start();

    const err = new Error('Network timeout');
    sm.onError(err);

    expect(sm.state).toBe('error');
    expect(sm.error).toBe(err);

    sm.retry();
    expect(sm.state).toBe('connecting');
    expect(sm.error).toBeUndefined();
  });

  it('recovers from error to disconnected via reset', () => {
    const sm = new LiveSessionStateMachine();
    sm.start();
    sm.onError(new Error('Fatal'));
    expect(sm.state).toBe('error');

    sm.reset();
    expect(sm.state).toBe('disconnected');
    expect(sm.error).toBeUndefined();
  });

  it('emits state change events with reason and error', () => {
    const sm = new LiveSessionStateMachine();
    const listener = vi.fn();
    sm.on('state', listener);

    sm.start(); // disconnected -> connecting
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      previous: 'disconnected',
      current: 'connecting',
      reason: 'start'
    }));

    const err = new Error('boom');
    sm.onError(err);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      previous: 'connecting',
      current: 'error',
      reason: 'error',
      error: err
    }));
  });

  it('handles Thinking -> Listening (e.g. no speech generated)', () => {
    const sm = new LiveSessionStateMachine();
    sm.start();
    sm.onConnected(); // listening
    sm.onSpeechEnd(); // thinking

    sm.onThinkingFinished(); // listening
    expect(sm.state).toBe('listening');
  });

  it('handles Speaking -> Thinking (e.g. interruption generating new thought)', () => {
    const sm = new LiveSessionStateMachine();
    sm.start();
    sm.onConnected();
    sm.onTtsStart(); // speaking directly from listening
    expect(sm.state).toBe('speaking');

    // User interrupts, starts new thought immediately
    sm.onSpeechEnd();
    expect(sm.state).toBe('thinking');
  });

  it('allows stopping from any active state', () => {
    let sm = new LiveSessionStateMachine();
    sm.start();
    sm.stop();
    expect(sm.state).toBe('disconnected');

    sm = new LiveSessionStateMachine();
    sm.start();
    sm.onConnected();
    sm.stop();
    expect(sm.state).toBe('disconnected');

    sm = new LiveSessionStateMachine();
    sm.start();
    sm.onConnected();
    sm.onSpeechEnd();
    sm.stop();
    expect(sm.state).toBe('disconnected');

    sm = new LiveSessionStateMachine();
    sm.start();
    sm.onConnected();
    sm.onTtsStart();
    sm.stop();
    expect(sm.state).toBe('disconnected');
  });
});
