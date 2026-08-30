import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { WebSocket } from 'ws';
import { db, PersonaAndVoiceConfig, FemaleVoiceName } from './db.js';
import { auth, AuthContext } from './auth.js';
import { cognition } from './cognition.js';
import { buildRuntimeContext } from './runtime-state.js';
import { allMadhuritaTools, executeBackendTool } from './tools.js';

const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is missing.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

export const activeLiveSessions = new Set<LiveSessionManager>();

export function broadcastVoiceConfigUpdate(updated: PersonaAndVoiceConfig, identityId?: string) {
  for (const session of activeLiveSessions) {
    if (!identityId || session.getCurrentContext().id === identityId) {
      session.applyVoiceConfig(updated).catch(() => {});
    }
  }
}

export function broadcastRuntimeStateToAllSessions() {
  for (const session of activeLiveSessions) {
    try {
      session.broadcastRuntimeState();
    } catch (e) {
      // ignore
    }
  }
}

export class LiveSessionManager {
  private clientWs: WebSocket;
  private session: any = null;
  private currentContext: AuthContext;
  private isAlive = true;
  private modelTurnBuffer = '';
  private userInputTranscriptBuffer = '';
  private lastProcessedUserTranscript = '';
  private lastUserTurnContent = '';
  private hasRunStartupCognition = false;
  private sessionId: string;
  private activeSessionToken: object = {};
  private activeVoiceName: FemaleVoiceName = 'Callirrhoe';

  constructor(clientWs: WebSocket, initialContext: AuthContext) {
    this.clientWs = clientWs;
    this.currentContext = initialContext;
    this.sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    activeLiveSessions.add(this);
  }

  public getCurrentContext(): AuthContext {
    return this.currentContext;
  }

  public broadcastRuntimeState() {
    try {
      const runtimeState = buildRuntimeContext(this.currentContext, this.sessionId);
      this.sendToClient({
        type: 'runtime_state',
        state: runtimeState,
      });
    } catch (err) {
      console.error('Failed to broadcast runtime state:', err);
    }
  }

  public async applyVoiceConfig(newVoiceConfig: PersonaAndVoiceConfig) {
    this.sendToClient({
      type: 'voice_config_changed',
      config: newVoiceConfig,
    });
    this.broadcastRuntimeState();

    // Reconnect session cleanly so updated voice/language/style/length system instructions take effect
    if (this.session && this.isAlive) {
      this.activeVoiceName = newVoiceConfig.voiceName;
      try {
        const oldSession = this.session;
        this.session = null;
        try {
          oldSession.close();
        } catch (e) {
          // ignore
        }
        await this.start();
      } catch (err) {
        console.warn('Could not cleanly reinitialize live session with new voice/style config:', err);
      }
    }
  }

  public async updateContext(newContext: AuthContext) {
    this.activeSessionToken = {}; // Immediately invalidate callbacks from previous session
    this.currentContext = newContext;
    this.hasRunStartupCognition = false;
    this.modelTurnBuffer = '';
    this.userInputTranscriptBuffer = '';
    this.lastProcessedUserTranscript = '';
    this.lastUserTurnContent = '';
    this.sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    this.broadcastRuntimeState();

    if (this.session && this.isAlive) {
      try {
        const oldSession = this.session;
        this.session = null;
        try {
          oldSession.close();
        } catch (e) {
          // ignore
        }
        await this.start();
      } catch (err) {
        console.warn('Could not cleanly reinitialize live session with updated context:', err);
      }
    }
  }

  public async start() {
    try {
      const sessionToken = {};
      this.activeSessionToken = sessionToken;

      const ai = getGeminiClient();

      // Read persistent user-configured Persona & Voice parameters (strict female voice)
      const personaConfig = db.getPersonaVoiceConfig(this.currentContext.id);
      this.activeVoiceName = personaConfig.voiceName;

      // Formulate identity and context-aware system instruction via full cognition retrieval pipeline
      const cognitiveContext = cognition.assembleCognitiveContext(
        this.currentContext.id,
        this.currentContext.role,
        this.currentContext.name,
        undefined,
        this.sessionId
      );
      const systemInstruction = cognition.buildReasoningPromptFromContext(cognitiveContext);

      this.session = await ai.live.connect({
        model: 'gemini-3.1-flash-live-preview',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: personaConfig.voiceName },
            },
          },
          systemInstruction,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [
            {
              functionDeclarations: allMadhuritaTools,
            },
          ],
        },
        callbacks: {
          onmessage: async (message: LiveServerMessage) => {
            if (!this.isAlive || this.activeSessionToken !== sessionToken) return;

            // Handle Gemini Live input audio transcription (interim)
            if (message.serverContent?.interimInputTranscription?.text) {
              const interimText = message.serverContent.interimInputTranscription.text.trim();
              if (interimText) {
                this.sendToClient({
                  type: 'user_transcript_interim',
                  text: interimText,
                });
              }
            }

            // Handle Gemini Live input audio transcription (final text chunk)
            if (message.serverContent?.inputTranscription?.text) {
              this.userInputTranscriptBuffer += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.inputTranscription?.finished) {
              this.finalizeUserTranscript();
            }

            // Handle Gemini Live output audio transcription (model speech transcript)
            if (message.serverContent?.outputTranscription?.text) {
              this.modelTurnBuffer += message.serverContent.outputTranscription.text;
            }

            // 1. Audio and text parts from Gemini (24kHz PCM)
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts && parts.length > 0) {
              if (this.userInputTranscriptBuffer.trim()) {
                this.finalizeUserTranscript();
              }
              for (const part of parts) {
                if (part.inlineData?.data) {
                  this.sendToClient({
                    type: 'audio',
                    audio: part.inlineData.data,
                  });
                }
                if (part.text && !message.serverContent?.outputTranscription?.text) {
                  this.modelTurnBuffer += part.text;
                }
              }
            }

            // 2. Turn Complete - log assistant response & trigger background continuous cognitive learning
            if (message.serverContent?.turnComplete) {
              if (this.userInputTranscriptBuffer.trim()) {
                this.finalizeUserTranscript();
              }
              if (this.modelTurnBuffer.trim()) {
                const assistantText = this.modelTurnBuffer.trim();
                this.modelTurnBuffer = '';
                db.logTurn(this.currentContext.id, 'assistant', assistantText, this.sessionId);

                this.sendToClient({
                  type: 'assistant_transcript_final',
                  text: assistantText,
                  timestamp: new Date().toISOString(),
                });

                const userText = this.lastUserTurnContent;
                this.lastUserTurnContent = '';

                // Continuous, non-blocking cognitive learning for full user+assistant exchange
                cognition.analyzeAndLearn(this.currentContext.id, this.currentContext.role, {
                  userText,
                  assistantText,
                }, this.sessionId).catch(() => {});
              }
            }

            // 3. Interruption signal
            if (message.serverContent?.interrupted) {
              if (this.userInputTranscriptBuffer.trim()) {
                this.finalizeUserTranscript();
              }
              if (this.modelTurnBuffer.trim()) {
                const assistantText = this.modelTurnBuffer.trim();
                this.modelTurnBuffer = '';
                db.logTurn(this.currentContext.id, 'assistant', assistantText, this.sessionId);

                this.sendToClient({
                  type: 'assistant_transcript_final',
                  text: assistantText,
                  timestamp: new Date().toISOString(),
                });

                const userText = this.lastUserTurnContent;
                this.lastUserTurnContent = '';

                cognition.analyzeAndLearn(this.currentContext.id, this.currentContext.role, {
                  userText,
                  assistantText,
                }, this.sessionId).catch(() => {});
              }
              this.sendToClient({
                type: 'interrupted',
              });
            }

            // 4. Tool Calls from model
            if (message.toolCall) {
              if (this.userInputTranscriptBuffer.trim()) {
                this.finalizeUserTranscript();
              }
              await this.handleToolCalls(message.toolCall);
            }
          },
          onclose: () => {
            if (this.activeSessionToken === sessionToken) {
              this.sendToClient({ type: 'status', status: 'session_closed' });
            }
          },
          onerror: (err: any) => {
            if (this.activeSessionToken !== sessionToken) return;
            console.error('Gemini Live session error:', err);
            this.sendToClient({
              type: 'error',
              error: err?.message || 'Live session encountered an error',
            });
          },
        },
      });

      this.sendToClient({
        type: 'status',
        status: 'connected',
        identity: {
          id: this.currentContext.id,
          name: this.currentContext.name,
          role: this.currentContext.role,
        },
      });

      this.broadcastRuntimeState();

      // Cognitive startup: assemble factual context for the LLM to reason over.
      // The LLM decides whether to speak and what to say based on facts.
      // NO [SYSTEM TRIGGER] injection, NO forced behavioral commands.
      if (!this.hasRunStartupCognition) {
        this.hasRunStartupCognition = true;
        const cognitiveContext = cognition.assembleCognitiveContext(
          this.currentContext.id,
          this.currentContext.role,
          this.currentContext.name
        );
        const startupFacts = cognition.buildStartupFacts(cognitiveContext);
        if (startupFacts) {
          try {
            await this.session.sendRealtimeInput({
              text: startupFacts,
            });
          } catch (err) {
            console.error('Failed to send startup context to Gemini Live:', err);
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to initialize Gemini Live session:', err);
      this.sendToClient({
        type: 'error',
        error: `Could not connect to Gemini Live: ${err.message}`,
      });
    }
  }

  private buildSystemPrompt(): string {
    return cognition.buildReasoningPrompt(this.currentContext.id, this.currentContext.role, this.currentContext.name);
  }

  private async handleToolCalls(toolCall: any) {
    if (!this.session || !toolCall.functionCalls) return;

    const functionResponses: any[] = [];
    let pendingContextUpdate: AuthContext | null = null;
    let pendingVoiceUpdate: PersonaAndVoiceConfig | null = null;

    // 1. EXECUTE REQUIRED TOOL/ACTION & UPDATE DATABASE FIRST
    for (const call of toolCall.functionCalls) {
      const { name, args, id } = call;
      const toolExec = await executeBackendTool(name, args, this.currentContext);

      if (toolExec.clientEvent) {
        this.sendToClient(toolExec.clientEvent);
      }
      if (toolExec.pendingContextUpdate) {
        pendingContextUpdate = toolExec.pendingContextUpdate;
      }
      if (toolExec.pendingVoiceUpdate) {
        pendingVoiceUpdate = toolExec.pendingVoiceUpdate;
      }

      functionResponses.push({
        id,
        name,
        response: toolExec.result,
      });
    }

    // 2. UPDATE AUTHORITATIVE RUNTIME STATE & SYNC STATE TO UI BEFORE LLM RESPONDS
    if (pendingContextUpdate) {
      await this.updateContext(pendingContextUpdate);
    } else if (pendingVoiceUpdate) {
      await this.applyVoiceConfig(pendingVoiceUpdate);
    } else {
      this.broadcastRuntimeState();
    }

    // 3. ONLY THEN GIVE THE FINAL REAL STATE TO LLM TO REASON OVER
    if (this.session && this.isAlive && typeof this.session.sendToolResponse === 'function') {
      try {
        await this.session.sendToolResponse({ functionResponses });
      } catch (err) {
        console.error('Failed to send tool response to Live session:', err);
      }
    } else {
      console.warn('Live session is inactive or closed; skipped sending tool response.');
    }
  }

  public sendRealtimeAudio(base64Pcm16Audio: string) {
    if (!this.session || !this.isAlive) return;
    try {
      this.session.sendRealtimeInput({
        audio: {
          data: base64Pcm16Audio,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    } catch (err) {
      console.error('Error sending audio to Gemini Live:', err);
    }
  }

  private detectAndApplyAddressingDirective(cleanText: string) {
    if (!cleanText) return;

    // Detect addressing title directives: "ab se mujhe Sir keh kar bulana", "call me Boss from now on"
    // This is kept as a deterministic fast-path for addressing preferences only.
    const addressingMatch = cleanText.match(/(?:ab\s+se\s+)?mujhe\s+(.+?)\s+(?:keh\s*ke|keh\s*kar|bolo|bulana)/i) ||
                            cleanText.match(/call\s+me\s+(.+?)(?:\s+from\s+now\s+on)?$/i);
    if (addressingMatch && addressingMatch[1]) {
      const preferredTitle = addressingMatch[1].trim();
      db.setAddressingPreference(this.currentContext.id, preferredTitle);
    }
  }

  private finalizeUserTranscript() {
    const finalCleanText = this.userInputTranscriptBuffer.trim();
    this.userInputTranscriptBuffer = '';
    if (!finalCleanText) return;

    if (finalCleanText === this.lastProcessedUserTranscript) {
      return;
    }
    this.lastProcessedUserTranscript = finalCleanText;
    this.lastUserTurnContent = finalCleanText;

    // Only addressing preference detection is kept as a deterministic fast-path.
    // Voice, language, style directives are handled by the LLM through tool calls.
    this.detectAndApplyAddressingDirective(finalCleanText);

    const canonicalUserMessage = {
      identityId: this.currentContext.id,
      role: 'user' as const,
      content: finalCleanText,
      timestamp: new Date().toISOString(),
    };

    db.logTurn(canonicalUserMessage.identityId, canonicalUserMessage.role, canonicalUserMessage.content, this.sessionId);

    this.sendToClient({
      type: 'user_transcript_final',
      text: canonicalUserMessage.content,
      timestamp: canonicalUserMessage.timestamp,
    });
  }

  public handleUserTranscript(transcript: string) {
    if (!transcript || !transcript.trim()) return;
    const clean = transcript.trim();

    if (clean === this.lastProcessedUserTranscript) return;
    this.lastProcessedUserTranscript = clean;
    this.lastUserTurnContent = clean;

    // Only addressing preference detection is kept as a deterministic fast-path.
    this.detectAndApplyAddressingDirective(clean);

    const canonicalUserMessage = {
      identityId: this.currentContext.id,
      role: 'user' as const,
      content: clean,
      timestamp: new Date().toISOString(),
    };

    db.logTurn(canonicalUserMessage.identityId, canonicalUserMessage.role, canonicalUserMessage.content, this.sessionId);

    this.sendToClient({
      type: 'user_transcript_final',
      text: canonicalUserMessage.content,
      timestamp: canonicalUserMessage.timestamp,
    });
  }

  public async sendTextMessage(text: string) {
    if (!text || !text.trim()) return;
    const clean = text.trim();
    this.handleUserTranscript(clean);

    if (this.session && this.isAlive) {
      try {
        await this.session.sendRealtimeInput({
          text: clean,
        });
      } catch (err) {
        console.error('Error sending text to Gemini Live:', err);
      }
    }
  }

  private sendToClient(data: any) {
    if (this.clientWs.readyState === WebSocket.OPEN) {
      this.clientWs.send(JSON.stringify(data));
    }
  }

  public close() {
    this.isAlive = false;
    activeLiveSessions.delete(this);
    if (this.session) {
      try {
        this.session.close();
      } catch (e) {
        // ignore
      }
      this.session = null;
    }
  }
}
