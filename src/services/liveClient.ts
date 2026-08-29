import { AudioStreamer } from './audioStreamer.js';
import { AudioPlayer } from './audioPlayer.js';
import { Identity, LiveState, ToolActionItem } from '../types.js';

export interface LiveClientCallbacks {
  onStateChange: (state: LiveState) => void;
  onIdentityChange: (identity: Identity, token?: string) => void;
  onToolAction: (action: ToolActionItem) => void;
  onUserTranscript?: (transcript: string, isFinal: boolean) => void;
  onAssistantTranscript?: (transcript: string) => void;
  onError: (errorMsg: string) => void;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private streamer: AudioStreamer;
  private player: AudioPlayer;
  private callbacks: LiveClientCallbacks;
  private currentState: LiveState = 'disconnected';
  private currentIdentity: Identity = { id: 'UNKNOWN', name: 'Guest', role: 'unknown' };
  private authToken?: string;

  constructor(callbacks: LiveClientCallbacks) {
    this.callbacks = callbacks;
    this.streamer = new AudioStreamer();
    this.player = new AudioPlayer((isSpeaking) => {
      if (this.currentState === 'listening' && isSpeaking) {
        this.setState('speaking');
      } else if (this.currentState === 'speaking' && !isSpeaking) {
        this.setState('listening');
      }
    });
  }

  public getState(): LiveState {
    return this.currentState;
  }

  public getStreamer(): AudioStreamer {
    return this.streamer;
  }

  public getPlayer(): AudioPlayer {
    return this.player;
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.callbacks.onStateChange(state);
  }

  public async connect(identity: Identity, token?: string) {
    if (this.currentState === 'connecting' || this.currentState === 'listening' || this.currentState === 'speaking') {
      return;
    }

    this.currentIdentity = identity;
    this.authToken = token;
    this.setState('connecting');

    try {
      // 1. Initialize microphone streaming
      await this.streamer.start((base64Audio) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'audio', audio: base64Audio }));
        }
      });

      // 2. Open WebSocket to backend
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host || 'localhost:3000';
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (identity.id) params.set('userId', identity.id);

      const wsUrl = `${protocol}//${host}/live?${params.toString()}`;
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.setState('listening');
      };

      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'audio' && msg.audio) {
            await this.player.playChunk(msg.audio);
          } else if (msg.type === 'user_transcript_final') {
            if (msg.text && this.callbacks.onUserTranscript) {
              this.callbacks.onUserTranscript(msg.text, true);
            }
          } else if (msg.type === 'user_transcript_interim') {
            if (msg.text && this.callbacks.onUserTranscript) {
              this.callbacks.onUserTranscript(msg.text, false);
            }
          } else if (msg.type === 'assistant_transcript_final') {
            if (msg.text && this.callbacks.onAssistantTranscript) {
              this.callbacks.onAssistantTranscript(msg.text);
            }
          } else if (msg.type === 'interrupted') {
            this.player.interrupt();
            if (this.currentState === 'speaking') {
              this.setState('listening');
            }
          } else if (msg.type === 'tool_action') {
            const actionItem: ToolActionItem = {
              id: `tool_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
              tool: msg.tool,
              data: msg.data,
              timestamp: Date.now(),
            };

            // Execute browser side action
            if (msg.tool === 'openWebsite' && msg.data?.url) {
              try {
                window.open(msg.data.url, '_blank', 'noopener,noreferrer');
              } catch (e) {
                console.warn('Could not auto-open popup:', e);
              }
            }

            this.callbacks.onToolAction(actionItem);
          } else if (msg.type === 'identity_changed') {
            if (msg.identity) {
              this.currentIdentity = msg.identity;
              this.callbacks.onIdentityChange(msg.identity, msg.token);
            }
          } else if (msg.type === 'error') {
            this.callbacks.onError(msg.error || 'Live session error');
          }
        } catch (err) {
          console.error('Error processing live websocket message:', err);
        }
      };

      this.ws.onclose = () => {
        this.disconnect();
      };

      this.ws.onerror = (err) => {
        console.error('Live WebSocket error:', err);
        this.callbacks.onError('Connection error to Madhurita voice server');
        this.disconnect();
      };
    } catch (err: any) {
      const isPermissionDenied =
        err?.name === 'NotAllowedError' ||
        err?.name === 'PermissionDeniedError' ||
        err?.message?.toLowerCase().includes('not allowed') ||
        err?.message?.toLowerCase().includes('denied') ||
        err?.message?.toLowerCase().includes('microphone');

      const userMessage = isPermissionDenied
        ? 'Microphone permission is required for voice conversation. Please allow microphone access in your browser, then tap the orb to connect.'
        : (err?.message || 'Connection error to Madhurita voice server');

      console.warn('Live session connection status:', userMessage);
      this.disconnect();
      this.callbacks.onError(userMessage);
    }
  }

  public sendTextMessage(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'text_message',
        text,
      }));
    }
  }

  public updateAuth(token?: string, userId?: string) {
    this.authToken = token;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'update_auth',
        token,
        userId,
      }));
    }
  }

  public disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.streamer.stop();
    this.player.stop();
    this.setState('disconnected');
  }
}
