import { GoogleGenAI, LiveServerMessage, Modality, Type, FunctionDeclaration } from '@google/genai';
import { WebSocket } from 'ws';
import { db } from './db.js';
import { auth, AuthContext } from './auth.js';
import { cognition } from './cognition.js';

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

// Available tools for Madhurita
const openWebsiteTool: FunctionDeclaration = {
  name: 'openWebsite',
  description: 'Opens a website or web search URL in the user browser when they request to visit a site or search the web.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: {
        type: Type.STRING,
        description: 'The complete HTTP or HTTPS URL to open (e.g. https://www.google.com, https://en.wikipedia.org).',
      },
      title: {
        type: Type.STRING,
        description: 'Short title or description of the website.',
      },
    },
    required: ['url'],
  },
};

const rememberFactTool: FunctionDeclaration = {
  name: 'rememberFact',
  description: 'Stores an important fact, personal preference, goal, or project detail into the CURRENT verified user private memory store. Fails if user identity is unknown.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      fact: {
        type: Type.STRING,
        description: 'The precise fact or preference to remember for this specific user.',
      },
      category: {
        type: Type.STRING,
        description: 'Category: "preference", "fact", "project", "goal", or "personal".',
      },
    },
    required: ['fact'],
  },
};

const getStoredMemoriesTool: FunctionDeclaration = {
  name: 'getStoredMemories',
  description: 'Retrieves memories. Normal users can ONLY retrieve their own memories. Authenticated Owner can retrieve their own memories or specify targetUserName to inspect another user memory.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUserName: {
        type: Type.STRING,
        description: 'Optional name of a user whose memory to retrieve. ONLY permitted if current role is OWNER.',
      },
      query: {
        type: Type.STRING,
        description: 'Optional keyword to filter within memories.',
      },
    },
  },
};

const recallConversationContextTool: FunctionDeclaration = {
  name: 'recallConversationContext',
  description: 'Recalls recent conversation topics and interaction context. Normal users can only recall their own previous discussion. Authenticated Owner can view context for any user.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUserName: {
        type: Type.STRING,
        description: 'Optional name of user to recall conversation context for (Owner-only).',
      },
    },
  },
};

const identifyUserTool: FunctionDeclaration = {
  name: 'identifyUser',
  description: 'Identifies the conversational speaker name when someone says who they are (e.g. "I am Rahul"). If anyone says "I am Ankit" or requests Owner access, immediately requires the Owner Passcode. For other names, recognizes the speaker in conversation without creating a persistent profile automatically.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'The user declared name.',
      },
    },
    required: ['name'],
  },
};

const registerUserTool: FunctionDeclaration = {
  name: 'registerUser',
  description: 'Creates a persistent registered user profile in the database ONLY when the person explicitly agrees or requests registration/profile creation. NEVER call this when someone merely states a name in passing. Cannot be used to register Ankit (Owner uses passcode authentication).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'The name of the user to officially register.',
      },
    },
    required: ['name'],
  },
};

const ownerAuthenticateTool: FunctionDeclaration = {
  name: 'ownerAuthenticate',
  description: 'Authenticates as the Owner using their secret passcode. NEVER expose the passcode or hash in speech.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      passcode: {
        type: Type.STRING,
        description: 'The secret owner passcode provided by the user.',
      },
    },
    required: ['passcode'],
  },
};

const switchContextTool: FunctionDeclaration = {
  name: 'switchContext',
  description: 'Switches active conversation identity and context between Owner, Guest, or a specified registered user. Permitted ONLY for the authenticated Owner. Switching INTO Owner context strictly requires valid Owner passcode.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetRole: {
        type: Type.STRING,
        description: 'Target role: "owner", "user", or "guest".',
      },
      targetUserName: {
        type: Type.STRING,
        description: 'If switching to a specific registered user, their name.',
      },
      passcode: {
        type: Type.STRING,
        description: 'Required if targetRole is "owner".',
      },
    },
    required: ['targetRole'],
  },
};

const deleteUserProfileTool: FunctionDeclaration = {
  name: 'deleteUserProfile',
  description: 'Permanently deletes a registered user profile along with all associated memories and conversation context. Permitted ONLY for the authenticated Owner.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      userId: {
        type: Type.STRING,
        description: 'The unique user ID to delete (e.g. USER_001).',
      },
    },
    required: ['userId'],
  },
};

const deleteMemoryTool: FunctionDeclaration = {
  name: 'deleteMemory',
  description: 'Permanently deletes a specific memory from the real persistent database. Authenticated Owner can delete any memory or any user\'s memory. Normal registered users can delete ONLY their own memories. After deletion, the memory is permanently gone and cannot be recalled.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'The memory ID, keyword, or exact phrase/content of the memory to delete.',
      },
      targetUserName: {
        type: Type.STRING,
        description: 'Optional name of the registered user whose memory to delete (Permitted ONLY for the authenticated Owner).',
      },
    },
    required: ['query'],
  },
};

const getTimeAndStatusTool: FunctionDeclaration = {
  name: 'getTimeAndStatus',
  description: 'Gets current real-time clock in Indian Standard Time (IST / Asia/Kolkata), date, configured home location (Orai, Uttar Pradesh, India), active user identity, and Madhurita system status.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

const getWeatherTool: FunctionDeclaration = {
  name: 'getWeather',
  description: 'Fetches real live meteorological weather data for Madhurita\'s home location (Orai, Uttar Pradesh, India) or any specified location. Returns real live temperatures, humidity, wind, and conditions. Never fabricate weather information.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      location: {
        type: Type.STRING,
        description: 'Optional city or location name. Defaults to configured home location (Orai, Uttar Pradesh, India).',
      },
    },
  },
};

const getInteractionTimelineTool: FunctionDeclaration = {
  name: 'getInteractionTimeline',
  description: 'Retrieves authoritative interaction timeline, session metadata, turn count, discussed topics, and exact last active IST timestamp for any user or the Owner.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUserName: {
        type: Type.STRING,
        description: 'The name or ID of the user to query (e.g. "Sapna", "Govind", "Ankit").',
      },
    },
    required: ['targetUserName'],
  },
};

const manageCrossUserNoteTool: FunctionDeclaration = {
  name: 'manageCrossUserNote',
  description: 'Creates, updates, or deletes a cross-user note (message). Use this to send messages or update existing ones.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        description: 'The action to perform: "create", "update", "delete".',
      },
      noteId: {
        type: Type.STRING,
        description: 'The ID of the note (required for update/delete).',
      },
      targetUserName: {
        type: Type.STRING,
        description: 'The recipient user name (required for create).',
      },
      content: {
        type: Type.STRING,
        description: 'The message content (required for create/update).',
      },
    },
    required: ['action'],
  },
};

const manageTaskTool: FunctionDeclaration = {
  name: 'manageTask',
  description: 'Creates, updates, or deletes a task or open loop for a user.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        description: 'The action: "create", "update", "delete".',
      },
      taskId: {
        type: Type.STRING,
        description: 'The ID of the task (required for update/delete).',
      },
      title: {
        type: Type.STRING,
        description: 'The task title (required for create/update).',
      },
      status: {
        type: Type.STRING,
        description: 'The status: "in_progress", "completed", "paused".',
      },
      targetUserName: {
        type: Type.STRING,
        description: 'The name of the user to assign the task to (if not the current user).',
      }
    },
    required: ['action'],
  },
};

const getRegisteredUsersInfoTool: FunctionDeclaration = {
  name: 'getRegisteredUsersInfo',
  description: 'Retrieves authoritative information about registered users. Owner gets a full list, while normal users just get the count of registered users without private details.',
  parameters: {
    type: Type.OBJECT,
    properties: {}
  },
};

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

  constructor(clientWs: WebSocket, initialContext: AuthContext) {
    this.clientWs = clientWs;
    this.currentContext = initialContext;
    this.sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
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

      // Read persistent user-configured Persona & Voice parameters
      const personaConfig = db.getPersonaVoiceConfig(this.currentContext.id);

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
          tools: [
            {
              functionDeclarations: [
                openWebsiteTool,
                rememberFactTool,
                getStoredMemoriesTool,
                deleteMemoryTool,
                recallConversationContextTool,
                identifyUserTool,
                registerUserTool,
                ownerAuthenticateTool,
                switchContextTool,
                deleteUserProfileTool,
                getTimeAndStatusTool,
                getWeatherTool,
                getInteractionTimelineTool,
                manageCrossUserNoteTool,
                manageTaskTool,
                getRegisteredUsersInfoTool,
              ],
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
                if (part.text) {
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

      // Deterministic startup cognition evaluation:
      // Only speak when authoritative application state contains an explicit reason or meaningful return.
      // If shouldSpeak === false: DO NOT send anything to Gemini Live realtime input.
      if (!this.hasRunStartupCognition) {
        this.hasRunStartupCognition = true;
        try {
          const evalResult = cognition.evaluateStartupState(cognitiveContext);
          const isRegisteredOrOwner = this.currentContext.role !== 'unknown' && this.currentContext.id !== 'UNKNOWN' && this.currentContext.id !== 'UNREGISTERED';
          const isMeaningfulReturn = isRegisteredOrOwner && !cognitiveContext.temporal.isShortAbsence && cognitiveContext.temporal.totalTurnCount > 0;

          if (evalResult.shouldSpeak) {
            if (evalResult.reason === 'pending_message' && evalResult.payload?.notes) {
              const notes = evalResult.payload.notes;
              const messageText = notes.map((n) => `From ${n.senderName}: "${n.content}"`).join('; ');
              await this.session.sendRealtimeInput({
                text: `[SYSTEM_DIRECTIVE: Deliver these pending unread message(s) to ${this.currentContext.name} immediately: ${messageText}]`,
              });
              db.markNotesDelivered(notes.map((n) => n.noteId));
            } else if (evalResult.reason === 'owner_briefing' && evalResult.payload?.briefing) {
              const b = evalResult.payload.briefing;
              const visitors = b.recentVisitors?.map((v: any) => `${v.name} at ${v.lastSeenIST}`).join(', ') || 'None';
              const notesCount = b.pendingNotes?.length || 0;
              const openLoopsCount = b.openLoops?.length || 0;
              await this.session.sendRealtimeInput({
                text: `[SYSTEM_DIRECTIVE: Briefly and concisely provide an operational briefing to the Owner (${this.currentContext.name}). Summary: ${b.summary}. Recent Visitors: ${visitors}. Pending notes across system: ${notesCount}. Active open loops: ${openLoopsCount}. Only highlight what is meaningful. Do not dump raw data.]`,
              });
            } else if (evalResult.reason === 'unfinished_task' && evalResult.payload?.task) {
              const task = evalResult.payload.task;
              await this.session.sendRealtimeInput({
                text: `[SYSTEM_DIRECTIVE: You may briefly check in on the active unfinished task with ${this.currentContext.name}: "${task.title}"]`,
              });
            }
          } else if (isMeaningfulReturn) {
            await this.session.sendRealtimeInput({
              text: `[SYSTEM_DIRECTIVE: ${this.currentContext.name} has re-connected after a meaningful absence (${cognitiveContext.temporal.elapsedHuman}). Address or greet ${this.currentContext.name} naturally and seamlessly continue the conversation or topic from last time. Do not force a generic greeting if unnecessary.]`,
            });
          }
        } catch (e) {
          console.warn('Startup cognition evaluation error:', e);
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

    for (const call of toolCall.functionCalls) {
      const { name, args, id } = call;
      let result: any = {};

      try {
        if (name === 'openWebsite') {
          let url = args?.url || '';
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = `https://${url}`;
          }
          const title = args?.title || url;
          result = { success: true, action: 'opened_website', url, title };
          this.sendToClient({
            type: 'tool_action',
            tool: 'openWebsite',
            data: { url, title },
          });
        } else if (name === 'rememberFact') {
          // Verify identity is registered and established
          if (
            this.currentContext.role === 'unknown' ||
            this.currentContext.id === 'UNKNOWN' ||
            this.currentContext.id === 'UNREGISTERED'
          ) {
            result = {
              success: false,
              error: 'IDENTITY_NOT_REGISTERED',
              message: 'Cannot store persistent memory for an unregistered or guest user. Please ask if they would like to register a profile first using registerUser.',
            };
          } else {
            const fact = args?.fact;
            const category = args?.category || 'fact';
            const record = db.addMemory(this.currentContext.id, fact, category);
            result = {
              success: Boolean(record),
              memoryId: record?.memoryId,
              ownerId: this.currentContext.id,
              userName: this.currentContext.name,
              message: `Memory securely stored for ${this.currentContext.name} (${this.currentContext.id}).`,
            };
            this.sendToClient({
              type: 'tool_action',
              tool: 'rememberFact',
              data: { fact, category, ownerId: this.currentContext.id, userName: this.currentContext.name },
            });
          }
        } else if (name === 'getStoredMemories') {
          const targetUserName = args?.targetUserName?.trim();
          const isOwner = this.currentContext.role === 'owner';

          if (targetUserName && !isOwner) {
            // Normal user trying to access someone else's memory
            if (targetUserName.toLowerCase() !== this.currentContext.name.toLowerCase()) {
              result = {
                count: 0,
                memories: [],
                error: 'ACCESS_DENIED',
                message: `Access denied. Normal users can only retrieve their own memories. You cannot access ${targetUserName}'s memories.`,
              };
            } else {
              const memories = db.getMemoriesForIdentity(this.currentContext.id);
              result = {
                count: memories.length,
                identity: this.currentContext.name,
                memories: memories.map((m) => ({ category: m.category, content: m.content })),
              };
            }
          } else if (targetUserName && isOwner) {
            // Owner accessing specified user's memories
            const targetUser = db.getUserByName(targetUserName);
            if (targetUser) {
              const memories = db.getMemoriesForIdentity(targetUser.id);
              result = {
                count: memories.length,
                targetUser: targetUser.name,
                targetUserId: targetUser.id,
                memories: memories.map((m) => ({ category: m.category, content: m.content })),
                message: `Authorized Owner retrieval for user ${targetUser.name}.`,
              };
            } else {
              result = {
                count: 0,
                memories: [],
                message: `No user found with name "${targetUserName}".`,
              };
            }
          } else {
            // Querying own memories
            if (this.currentContext.role === 'unknown') {
              result = {
                count: 0,
                memories: [],
                message: 'No stored memories available in guest mode.',
              };
            } else {
              const memories = db.getMemoriesForIdentity(this.currentContext.id);
              result = {
                count: memories.length,
                identity: this.currentContext.name,
                memories: memories.map((m) => ({ category: m.category, content: m.content })),
              };
            }
          }
        } else if (name === 'deleteMemory') {
          const query = args?.query?.trim();
          const targetUserName = args?.targetUserName?.trim();
          const isOwner = this.currentContext.role === 'owner';

          if (!query) {
            result = {
              success: false,
              error: 'QUERY_REQUIRED',
              message: 'Please specify the memory ID, keyword, or text content of the memory to delete.',
            };
          } else if (this.currentContext.role === 'unknown') {
            result = {
              success: false,
              error: 'PERMISSION_DENIED',
              message: 'Unregistered guests do not have stored persistent memories.',
            };
          } else if (isOwner) {
            let targetUserId: string | undefined = undefined;
            if (targetUserName) {
              const targetUser = db.getUserByName(targetUserName);
              if (!targetUser) {
                result = {
                  success: false,
                  error: 'USER_NOT_FOUND',
                  message: `User "${targetUserName}" was not found in the database.`,
                };
              } else {
                targetUserId = targetUser.id;
              }
            }

            if (result.success !== false) {
              const res = db.deleteMemoryAsOwner(query, targetUserId);
              if (res.success) {
                result = {
                  success: true,
                  deletedCount: res.deletedCount,
                  deletedMemories: res.deleted.map((m) => m.content),
                  message: `Permanently deleted ${res.deletedCount} memory item(s) from persistent database.`,
                };
                this.sendToClient({
                  type: 'tool_action',
                  tool: 'deleteMemory',
                  data: { query, deletedCount: res.deletedCount, deleted: res.deleted },
                });
              } else {
                result = {
                  success: false,
                  error: 'MEMORY_NOT_FOUND',
                  message: `No matching memory found for query "${query}".`,
                };
              }
            }
          } else {
            // Normal user can ONLY delete their own memories
            if (targetUserName && targetUserName.toLowerCase() !== this.currentContext.name.toLowerCase()) {
              result = {
                success: false,
                error: 'PERMISSION_DENIED',
                message: 'Permission denied: Normal users can only delete their own memories.',
              };
            } else {
              const res = db.deleteMemoryByQuery(this.currentContext.id, query);
              if (res.success) {
                result = {
                  success: true,
                  deletedCount: res.deletedCount,
                  deletedMemories: res.deleted.map((m) => m.content),
                  message: `Permanently deleted ${res.deletedCount} memory item(s) from your profile.`,
                };
                this.sendToClient({
                  type: 'tool_action',
                  tool: 'deleteMemory',
                  data: { query, deletedCount: res.deletedCount, deleted: res.deleted },
                });
              } else {
                result = {
                  success: false,
                  error: 'MEMORY_NOT_FOUND',
                  message: `No matching memory found in your profile for "${query}".`,
                };
              }
            }
          }
        } else if (name === 'recallConversationContext') {
          const targetUserName = args?.targetUserName?.trim();
          const isOwner = this.currentContext.role === 'owner';

          if (targetUserName && !isOwner) {
            if (targetUserName.toLowerCase() !== this.currentContext.name.toLowerCase()) {
              result = {
                error: 'ACCESS_DENIED',
                message: 'Access denied. You can only recall your own conversation context.',
              };
            } else {
              const turns = db.getRecentTurns(this.currentContext.id, 6);
              result = {
                user: this.currentContext.name,
                recentTopics: turns.map((t) => `${t.role}: ${t.content}`),
              };
            }
          } else if (targetUserName && isOwner) {
            const targetUser = db.getUserByName(targetUserName);
            if (targetUser) {
              const turns = db.getRecentTurns(targetUser.id, 6);
              result = {
                targetUser: targetUser.name,
                recentTopics: turns.map((t) => `${t.role}: ${t.content}`),
              };
            } else {
              result = { message: `No conversation context found for ${targetUserName}.` };
            }
          } else {
            const turns = db.getRecentTurns(this.currentContext.id, 6);
            result = {
              user: this.currentContext.name,
              recentTopics: turns.map((t) => `${t.role}: ${t.content}`),
            };
          }
        } else if (name === 'identifyUser') {
          const userName = (args?.name || '').trim();
          const cleanUser = userName.toLowerCase();
          const owner = db.getOwner();
          const isOwnerNameMatch = Boolean(
            (owner && owner.name.trim().toLowerCase() === cleanUser) ||
            cleanUser === 'ankit'
          );

          if (isOwnerNameMatch) {
            // NEVER create or switch to a normal Ankit user profile.
            // Always ask for the existing Owner Passcode. Never grant Owner access from name alone.
            // Never treat previous authentication as permanent authorization for a new Owner-access request.
            result = {
              isOwnerNameMatch: true,
              name: userName,
              requiresPasscode: true,
              role: 'unknown',
              message: `The user stated "${userName}" / requested Owner access. ALWAYS ask for the existing Owner Passcode. Never grant Owner access from the name alone, and never treat previous authentication as permanent authorization for a new Owner-access request. Prompt the user to provide their Owner Passcode, which will be verified authoritatively via ownerAuthenticate.`,
            };
          } else if (userName.length > 0) {
            const existing = db.getUserByName(userName);
            if (existing) {
              // Existing registered user in the database
              const newContext = auth.resolveContext(undefined, existing.id);
              pendingContextUpdate = newContext;

              result = {
                isOwnerNameMatch: false,
                isRegistered: true,
                userId: existing.id,
                name: existing.name,
                role: 'user',
                message: `Existing registered profile found for ${existing.name} (${existing.id}). Active user context and isolated memories loaded.`,
              };

              this.sendToClient({
                type: 'identity_changed',
                identity: { id: existing.id, name: existing.name, role: 'user' },
              });
            } else {
              // Unregistered user: do NOT automatically create a profile in the database!
              const newContext: AuthContext = {
                id: 'UNREGISTERED',
                name: userName,
                role: 'unknown',
                isOwnerAuthenticated: false,
                scopes: ['conversation:general', 'user:register', 'owner:auth', 'tool:info'],
              };
              pendingContextUpdate = newContext;

              result = {
                isOwnerNameMatch: false,
                isRegistered: false,
                name: userName,
                role: 'unknown',
                message: `The user is "${userName}", but is NOT registered in the database. DO NOT automatically create a persistent profile. Treat them as an unregistered user. Continue the conversation normally, and ask if they would like you to create a registered user profile for them. Call registerUser ONLY if they explicitly agree.`,
              };

              this.sendToClient({
                type: 'identity_changed',
                identity: { id: 'UNREGISTERED', name: userName, role: 'unknown' },
              });
            }
          } else {
            result = { error: 'INVALID_NAME', message: 'Please provide a valid name.' };
          }
        } else if (name === 'registerUser') {
          const regName = (args?.name || '').trim();
          const cleanReg = regName.toLowerCase();
          const owner = db.getOwner();
          const isOwnerNameMatch = Boolean(
            (owner && owner.name.trim().toLowerCase() === cleanReg) ||
            cleanReg === 'ankit'
          );

          if (isOwnerNameMatch) {
            result = {
              success: false,
              error: 'OWNER_NAME_RESERVED',
              message: 'Cannot create a normal user profile for Ankit / Owner. Owner access requires Owner Passcode Authentication.',
            };
          } else if (regName.length > 0) {
            const profile = db.createOrGetUser(regName);
            const newContext = auth.resolveContext(undefined, profile.id);
            pendingContextUpdate = newContext;

            result = {
              success: true,
              userId: profile.id,
              name: profile.name,
              role: 'user',
              message: `Persistent user profile created in database for ${profile.name} (${profile.id}). Normal user permissions and memory persistence now active.`,
            };

            this.sendToClient({
              type: 'identity_changed',
              identity: { id: profile.id, name: profile.name, role: 'user' },
            });
          } else {
            result = { success: false, error: 'INVALID_NAME', message: 'Please provide a valid name for registration.' };
          }
        } else if (name === 'ownerAuthenticate') {
          const passcode = args?.passcode || '';
          const authRes = auth.authenticateOwner(passcode);
          if (authRes.success && authRes.token) {
            const newContext = auth.resolveContext(authRes.token);
            pendingContextUpdate = newContext;
            result = {
              success: true,
              role: 'owner',
              name: newContext.name,
              message: 'Owner passcode verified successfully. Full owner privileges granted.',
            };
            this.sendToClient({
              type: 'identity_changed',
              token: authRes.token,
              identity: { id: newContext.id, name: newContext.name, role: 'owner' },
            });
          } else {
            result = {
              success: false,
              error: authRes.error || 'AUTHENTICATION_FAILED',
              message: 'Invalid owner passcode. Access remains at current permission level.',
            };
          }
        } else if (name === 'switchContext') {
          const targetRole = (args?.targetRole || 'guest').toLowerCase();
          const targetUserName = args?.targetUserName?.trim();
          const passcode = args?.passcode;

          if (targetRole === 'owner') {
            // Switching into Owner ALWAYS requires passcode
            if (!passcode) {
              result = {
                success: false,
                requiresPasscode: true,
                error: 'PASSCODE_REQUIRED',
                message: 'Switching into Owner context strictly requires the secret Owner passcode. Prompt the user for the passcode.',
              };
            } else {
              const authRes = auth.authenticateOwner(passcode);
              if (authRes.success && authRes.token) {
                const newContext = auth.resolveContext(authRes.token);
                pendingContextUpdate = newContext;
                result = {
                  success: true,
                  role: 'owner',
                  name: newContext.name,
                  message: 'Owner passcode verified. Switched to Owner context.',
                };
                this.sendToClient({
                  type: 'identity_changed',
                  token: authRes.token,
                  identity: { id: newContext.id, name: newContext.name, role: 'owner' },
                });
              } else {
                result = {
                  success: false,
                  error: 'AUTHENTICATION_FAILED',
                  message: 'Incorrect Owner passcode. Could not switch to Owner context.',
                };
              }
            }
          } else {
            // Only the authenticated Owner is permitted to switch identities to another user or guest
            if (this.currentContext.role !== 'owner') {
              result = {
                success: false,
                error: 'PERMISSION_DENIED',
                message: 'Identity profile switching is restricted exclusively to the authenticated Owner.',
              };
            } else if (targetRole === 'guest' || targetRole === 'unknown') {
              const guestContext = auth.resolveContext(undefined, undefined);
              pendingContextUpdate = guestContext;
              result = {
                success: true,
                role: 'unknown',
                name: 'Guest',
                message: 'Owner requested switch to Guest context.',
              };
              this.sendToClient({
                type: 'identity_changed',
                identity: { id: 'UNKNOWN', name: 'Guest', role: 'unknown' },
              });
            } else if (targetRole === 'user') {
              if (targetUserName) {
                const profile = db.getUserByName(targetUserName);
                if (!profile) {
                  result = {
                    success: false,
                    error: 'USER_NOT_FOUND',
                    message: `Registered user profile "${targetUserName}" was not found in the database. switchContext only resolves existing registered users.`,
                  };
                } else {
                  const newContext = auth.resolveContext(undefined, profile.id);
                  pendingContextUpdate = newContext;
                  result = {
                    success: true,
                    role: 'user',
                    name: profile.name,
                    userId: profile.id,
                    message: `Owner switched active conversation context to user ${profile.name} (${profile.id}).`,
                  };
                  this.sendToClient({
                    type: 'identity_changed',
                    identity: { id: profile.id, name: profile.name, role: 'user' },
                  });
                }
              } else {
                result = {
                  success: false,
                  error: 'USER_NAME_REQUIRED',
                  message: 'Please specify the name of the user profile to switch to.',
                };
              }
            } else {
              result = { error: 'UNKNOWN_ROLE', message: 'Target role must be owner, user, or guest.' };
            }
          }
        } else if (name === 'deleteUserProfile') {
          // Deleting users is an authoritative Owner-only action
          if (this.currentContext.role !== 'owner') {
            result = {
              success: false,
              error: 'PERMISSION_DENIED',
              message: 'Only the authenticated Owner can delete user profiles and associated records.',
            };
          } else {
            const userId = args?.userId?.trim();
            if (!userId) {
              result = { success: false, error: 'MISSING_USER_ID', message: 'You must provide the exact user ID to delete.' };
            } else if (userId === 'OWNER_001') {
              result = { success: false, error: 'CANNOT_DELETE_OWNER', message: 'The Owner profile cannot be deleted.' };
            } else {
              const targetUser = db.getUserById(userId);
              if (!targetUser) {
                result = {
                  success: false,
                  error: 'USER_NOT_FOUND',
                  message: `Could not find a registered user with ID "${userId}".`,
                };
              } else {
                const deleted = db.deleteUser(targetUser.id);
                if (deleted) {
                  result = {
                    success: true,
                    message: `User ${targetUser.name} (${targetUser.id}) and all associated memories and conversation context were permanently deleted.`,
                  };
                  this.sendToClient({
                    type: 'tool_action',
                    action: {
                      type: 'user_deleted',
                      userId: targetUser.id,
                      userName: targetUser.name,
                    },
                  });
                } else {
                  result = {
                    success: false,
                    error: 'DELETE_FAILED',
                    message: `Failed to delete user ${targetUser.name}.`,
                  };
                }
              }
            }
          }
        } else if (name === 'getTimeAndStatus') {
          const now = new Date();
          const locationConfig = db.getLocationConfig();
          const registeredUsers = db.getUsers();
          const owner = db.getOwner();
          const isOwner = this.currentContext.role === 'owner';
          const timeIST = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
          const dateIST = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
          result = {
            currentTimeIST: timeIST,
            currentDateIST: dateIST,
            timezone: 'Asia/Kolkata (IST, UTC+05:30)',
            homeLocation: locationConfig.formattedLocation,
            totalRegisteredUsers: isOwner ? registeredUsers.length : undefined,
            registeredUsers: isOwner ? registeredUsers.map((u) => ({ id: u.id, name: u.name })) : undefined,
            activeIdentity: {
              id: this.currentContext.id,
              name: this.currentContext.name,
              role: this.currentContext.role,
            },
            accessLevel: isOwner ? 'Owner' : this.currentContext.role === 'user' ? 'Registered User' : 'Unregistered',
            ownerName: isOwner ? (owner ? owner.name : null) : undefined,
            systemHealth: 'Optimal',
          };
        } else if (name === 'getWeather') {
          const locationConfig = db.getLocationConfig();
          const targetLocation = args?.location?.trim() || locationConfig.formattedLocation;
          try {
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${locationConfig.latitude}&longitude=${locationConfig.longitude}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=Asia%2FKolkata`;
            const weatherRes = await fetch(weatherUrl);
            if (!weatherRes.ok) {
              result = {
                available: false,
                message: 'Live weather service returned an error. Current meteorological data is unavailable.',
                location: targetLocation,
              };
            } else {
              const weatherData = await weatherRes.json();
              const current = weatherData.current;
              const weatherCodeMap: Record<number, string> = {
                0: 'Clear sky',
                1: 'Mainly clear',
                2: 'Partly cloudy',
                3: 'Overcast',
                45: 'Foggy',
                48: 'Depositing rime fog',
                51: 'Light drizzle',
                53: 'Moderate drizzle',
                55: 'Dense drizzle',
                61: 'Slight rain',
                63: 'Moderate rain',
                65: 'Heavy rain',
                71: 'Slight snow',
                73: 'Moderate snow',
                75: 'Heavy snow',
                80: 'Slight rain showers',
                81: 'Moderate rain showers',
                82: 'Violent rain showers',
                95: 'Thunderstorm',
              };
              const condition = weatherCodeMap[current.weather_code] || 'Clear';
              result = {
                available: true,
                location: targetLocation,
                temperature: `${current.temperature_2m}°C`,
                feelsLike: `${current.apparent_temperature}°C`,
                humidity: `${current.relative_humidity_2m}%`,
                windSpeed: `${current.wind_speed_10m} km/h`,
                precipitation: `${current.precipitation} mm`,
                condition,
                timezone: 'Asia/Kolkata (IST)',
              };
            }
          } catch (err: any) {
            console.warn('Weather fetch error in tool:', err);
            result = {
              available: false,
              message: 'Live weather service is currently unreachable.',
              location: targetLocation,
            };
          }
        } else if (name === 'getInteractionTimeline') {
          const targetUserName = args?.targetUserName?.trim();
          result = db.getInteractionTimeline(
            targetUserName || this.currentContext.name,
            this.currentContext.role,
            this.currentContext.id
          );
        } else if (name === 'manageCrossUserNote') {
          const action = args?.action;
          const targetUserName = args?.targetUserName?.trim();
          const content = args?.content?.trim();
          const noteId = args?.noteId?.trim();

          if (action === 'create') {
            if (!content) {
              result = { success: false, error: 'CONTENT_REQUIRED' };
            } else {
              const note = db.addCrossUserNote(this.currentContext.id, this.currentContext.name, content, targetUserName);
              result = { success: Boolean(note), noteId: note?.noteId, targetUserName, message: 'Message securely saved.' };
              this.sendToClient({ type: 'tool_action', tool: 'manageCrossUserNote', data: { action, targetUserName, content, noteId: note?.noteId } });
            }
          } else if (action === 'update' || action === 'delete' || action === 'mark_delivered') {
            if (!noteId) {
               result = { success: false, error: 'NOTEID_REQUIRED' };
            } else {
               if (action === 'update') {
                  const success = db.editCrossUserNote(this.currentContext.id, noteId, content);
                  result = { success };
               } else if (action === 'delete') {
                  const success = db.deleteCrossUserNote(this.currentContext.id, noteId);
                  result = { success };
               } else if (action === 'mark_delivered') {
                  db.markNotesDelivered([noteId]);
                  result = { success: true };
               }
            }
          }
        } else if (name === 'manageTask') {
          const action = args?.action;
          const taskId = args?.taskId?.trim();
          const title = args?.title?.trim();
          const status = args?.status?.trim() as any;
          const targetUserName = args?.targetUserName?.trim();

          let targetId = this.currentContext.id;
          if (targetUserName && this.currentContext.role === 'owner') {
             const u = db.resolveIdentityByName(targetUserName);
             if (u) targetId = u.id;
          }

          if (action === 'create' || action === 'update') {
            if (action === 'create' && !title) {
               result = { success: false, error: 'TITLE_REQUIRED' };
            } else if (action === 'update' && !taskId) {
               result = { success: false, error: 'TASKID_REQUIRED' };
            } else {
               if (action === 'create') {
                 const t = db.addOrUpdateTask(targetId, title, '', status || 'in_progress');
                 result = { success: true, taskId: t?.id };
               } else {
                 if (status) db.updateTaskStatus(targetId, taskId, status);
                 // We don't have update title yet in db, but we can just update status for now.
                 result = { success: true };
               }
               this.sendToClient({ type: 'tool_action', tool: 'manageTask', data: { action, taskId, title, status } });
            }
          } else if (action === 'delete') {
             if (!taskId) result = { success: false, error: 'TASKID_REQUIRED' };
             else {
               const ok = db.deleteTask(targetId, taskId);
               result = { success: ok };
             }
          }
        } else if (name === 'getRegisteredUsersInfo') {
          const registeredUsers = db.getUsers();
          const isOwner = this.currentContext.role === 'owner';
          result = {
            totalRegisteredUsers: registeredUsers.length,
            registeredUsers: isOwner ? registeredUsers.map((u) => ({ id: u.id, name: u.name })) : undefined,
          };
        } else {
          result = { error: 'Unknown tool declaration' };
        }
      } catch (err: any) {
        result = { error: err.message || 'Tool execution error' };
      }

      functionResponses.push({
        id,
        name,
        response: result,
      });
    }

    if (this.session && this.isAlive && typeof this.session.sendToolResponse === 'function') {
      try {
        await this.session.sendToolResponse({ functionResponses });
      } catch (err) {
        console.error('Failed to send tool response to Live session:', err);
      }
    } else {
      console.warn('Live session is inactive or closed; skipped sending tool response.');
    }

    if (pendingContextUpdate) {
      await this.updateContext(pendingContextUpdate);
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

  private detectAndApplyUserDirectives(cleanText: string) {
    if (!cleanText) return;

    // Detect addressing title directives: "ab se mujhe Sir keh kar bulana", "call me Boss from now on"
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

    this.detectAndApplyUserDirectives(finalCleanText);

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

    this.detectAndApplyUserDirectives(clean);

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
