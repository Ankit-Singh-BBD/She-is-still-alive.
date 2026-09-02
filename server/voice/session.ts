import { EventEmitter } from 'events';

export type SessionState =
  | 'disconnected'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface SessionStateChangeEvent {
  previous: SessionState;
  current: SessionState;
  reason?: string;
  error?: Error | undefined;
}

export class LiveSessionStateMachine extends EventEmitter {
  private _state: SessionState = 'disconnected';
  private _lastError?: Error;

  constructor() {
    super();
  }

  get state(): SessionState {
    return this._state;
  }

  get error(): Error | undefined {
    return this._lastError;
  }

  private transitionTo(newState: SessionState, reason?: string, error?: Error): void {
    if (this._state === newState) return; // Idempotent or ignored

    const previous = this._state;

    // Validate transitions
    const valid = this.isValidTransition(previous, newState);
    if (!valid) {
      throw new Error(`Illegal state transition from '${previous}' to '${newState}'`);
    }

    this._state = newState;
    if (error) {
      this._lastError = error;
    } else if (newState === 'disconnected' || newState === 'connecting') {
      this._lastError = undefined as any; // Clear error on reset or retry
    }

    this.emit('state', {
      previous,
      current: newState,
      reason,
      error
    } as SessionStateChangeEvent);
  }

  private isValidTransition(from: SessionState, to: SessionState): boolean {
    switch (from) {
      case 'disconnected':
        return to === 'connecting';
      case 'connecting':
        return to === 'listening' || to === 'error' || to === 'disconnected';
      case 'listening':
        return to === 'thinking' || to === 'speaking' || to === 'disconnected' || to === 'error';
      case 'thinking':
        return to === 'listening' || to === 'speaking' || to === 'disconnected' || to === 'error';
      case 'speaking':
        return to === 'listening' || to === 'thinking' || to === 'disconnected' || to === 'error';
      case 'error':
        return to === 'disconnected' || to === 'connecting';
      default:
        return false;
    }
  }

  // --- Actions ---

  public start(): void {
    this.transitionTo('connecting', 'start');
  }

  public onConnected(): void {
    this.transitionTo('listening', 'connected');
  }

  public onSpeechEnd(): void {
    // LLM query starts
    this.transitionTo('thinking', 'speech_end');
  }
  
  public onThinkingFinished(): void {
    this.transitionTo('listening', 'thinking_finished_no_speech');
  }

  public onTtsStart(): void {
    // Could happen directly from listening (interjection) or thinking
    this.transitionTo('speaking', 'tts_start');
  }

  public onTtsEnd(): void {
    this.transitionTo('listening', 'tts_end');
  }

  public stop(): void {
    // Can stop from anywhere except already disconnected (which is a no-op internally, but let's allow it to be safely called)
    if (this._state === 'disconnected') return;
    this.transitionTo('disconnected', 'stop');
  }

  public onError(err: Error): void {
    if (this._state === 'error' || this._state === 'disconnected') return;
    this.transitionTo('error', 'error', err);
  }

  public retry(): void {
    if (this._state !== 'error') {
      throw new Error('Can only retry from error state');
    }
    this.transitionTo('connecting', 'retry');
  }
  
  public reset(): void {
    if (this._state === 'disconnected') return;
    this.transitionTo('disconnected', 'reset');
  }
}
