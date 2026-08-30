import { Type, FunctionDeclaration } from '@google/genai';
import { db, PersonaAndVoiceConfig, VALID_FEMALE_VOICES } from './db.js';
import { auth, AuthContext } from './auth.js';
import { buildRuntimeContext } from './runtime-state.js';
import { broadcastRuntimeStateToAllSessions } from './live-session.js';

// --- Shared Function Declarations for Gemini ---

export const openWebsiteTool: FunctionDeclaration = {
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

export const rememberFactTool: FunctionDeclaration = {
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

export const getStoredMemoriesTool: FunctionDeclaration = {
  name: 'getStoredMemories',
  description: 'Retrieves memories from persistent database. Normal users can ONLY retrieve their own memories. Authenticated Owner can retrieve their own memories or specify targetUserName to inspect another user memory.',
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

export const recallConversationContextTool: FunctionDeclaration = {
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

export const identifyUserTool: FunctionDeclaration = {
  name: 'identifyUser',
  description: 'Identifies the conversational speaker name when someone says who they are (e.g. "I am Rahul", "Give me owner access"). If already authenticated as Owner, confirms current Owner access without asking for passcode. If not authenticated as Owner and states Owner name, prompts for passcode. For other names, recognizes speaker in conversation without creating a persistent profile automatically.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: {
        type: Type.STRING,
        description: 'The user declared name or role request.',
      },
    },
    required: ['name'],
  },
};

export const registerUserTool: FunctionDeclaration = {
  name: 'registerUser',
  description: 'Creates a persistent registered user profile in the database ONLY when the person explicitly agrees or requests registration/profile creation. Cannot be used to register Owner (Owner uses passcode authentication).',
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

export const ownerAuthenticateTool: FunctionDeclaration = {
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

export const switchContextTool: FunctionDeclaration = {
  name: 'switchContext',
  description: 'Switches active conversation identity and context between Owner, Guest, or a specified registered user. Permitted ONLY for the authenticated Owner. Switching INTO Owner context strictly requires valid Owner passcode if not already authenticated.',
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
        description: 'Required if targetRole is "owner" and not already authenticated.',
      },
    },
    required: ['targetRole'],
  },
};

export const deleteUserProfileTool: FunctionDeclaration = {
  name: 'deleteUserProfile',
  description: 'Permanently deletes a registered user profile along with all associated memories and conversation context from database. Permitted ONLY for the authenticated Owner.',
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

export const deleteMemoryTool: FunctionDeclaration = {
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

export const getTimeAndStatusTool: FunctionDeclaration = {
  name: 'getTimeAndStatus',
  description: 'Gets current real-time clock in Indian Standard Time (IST / Asia/Kolkata), date, configured home location (Orai, Uttar Pradesh, India), active user identity, and Madhurita system status.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const getWeatherTool: FunctionDeclaration = {
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

export const getInteractionTimelineTool: FunctionDeclaration = {
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

export const manageCrossUserNoteTool: FunctionDeclaration = {
  name: 'manageCrossUserNote',
  description: 'Creates, updates, or deletes a cross-user note (message). Use this to send messages or update existing ones in database.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        description: 'The action to perform: "create", "update", "delete", "mark_delivered".',
      },
      noteId: {
        type: Type.STRING,
        description: 'The ID of the note (required for update/delete/mark_delivered).',
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

export const manageTaskTool: FunctionDeclaration = {
  name: 'manageTask',
  description: 'Creates, updates, or deletes a task or open loop for a user in the persistent database.',
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
        description: 'The name of the user to assign the task to (if not the current user, permitted for Owner).',
      },
    },
    required: ['action'],
  },
};

export const getRegisteredUsersInfoTool: FunctionDeclaration = {
  name: 'getRegisteredUsersInfo',
  description: 'Queries the authoritative database to retrieve registered user counts and list. Always call this when user asks about how many users exist or who is registered.',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const updateVoiceConfigurationTool: FunctionDeclaration = {
  name: 'updateVoiceConfiguration',
  description: 'Updates Madhurita voice profile, speaking style, or voice parameters (e.g. "Callirrhoe use karo", "voice change karo", "Aoede voice lagao", "speaking style warm karo"). ONLY female voices are permitted: Callirrhoe, Aoede, Kore, Leda, Despina. Male voices are strictly prohibited and rejected. Updates backend, runtime speech, persists configuration, and confirms.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      voiceName: {
        type: Type.STRING,
        description: 'Female voice name: "Callirrhoe", "Aoede", "Kore", "Leda", or "Despina".',
      },
      speakingStyle: {
        type: Type.STRING,
        description: 'Speaking style: "warm_conversational", "expressive_witty", "calm_thoughtful", or "concise_direct".',
      },
      preferredLanguage: {
        type: Type.STRING,
        description: 'Language preference: "Hinglish", "English", or "Hindi".',
      },
      responseLength: {
        type: Type.STRING,
        description: 'Response length: "concise", "balanced", or "detailed".',
      },
    },
  },
};

export const updateUserPreferenceTool: FunctionDeclaration = {
  name: 'updateUserPreference',
  description: 'Updates a user preference key-value pair in the persistent database for the active user identity (or target user if Owner).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      preferenceKey: {
        type: Type.STRING,
        description: 'The preference key name (e.g. "addressingTitle", "theme", "language", "notificationPreference").',
      },
      preferenceValue: {
        type: Type.STRING,
        description: 'The preference value to store.',
      },
      targetUserName: {
        type: Type.STRING,
        description: 'Optional target user name (Owner only).',
      },
    },
    required: ['preferenceKey', 'preferenceValue'],
  },
};

export const clearConversationHistoryTool: FunctionDeclaration = {
  name: 'clearConversationHistory',
  description: 'Deletes conversation history and session metadata from the persistent database. Normal registered users can ONLY clear their own conversation history. Authenticated Owner can clear their own history or clear conversation history for a target user by specifying targetUserName. If targetSessionId is provided, deletes only that specific session.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetUserName: {
        type: Type.STRING,
        description: 'Optional name of the registered user whose history to clear (Permitted ONLY for the authenticated Owner).',
      },
      targetSessionId: {
        type: Type.STRING,
        description: 'Optional specific session ID to delete (e.g. SESS_123). If omitted, clears all history for the user.',
      },
    },
  },
};

export const allMadhuritaTools = [
  openWebsiteTool,
  rememberFactTool,
  getStoredMemoriesTool,
  deleteMemoryTool,
  clearConversationHistoryTool,
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
  updateVoiceConfigurationTool,
  updateUserPreferenceTool,
];

export interface ToolExecutionResult {
  result: any;
  pendingContextUpdate?: AuthContext;
  pendingVoiceUpdate?: PersonaAndVoiceConfig;
  clientEvent?: {
    type: string;
    [key: string]: any;
  };
}

/**
 * Authoritative Backend Tool Execution Engine.
 * MUST be executed before LLM generates responses regarding application state or executing actions.
 */
export async function executeBackendTool(
  name: string,
  args: any,
  currentContext: AuthContext
): Promise<ToolExecutionResult> {
  let result: any = {};
  let pendingContextUpdate: AuthContext | undefined;
  let pendingVoiceUpdate: PersonaAndVoiceConfig | undefined;
  let clientEvent: any | undefined;

  try {
    if (name === 'openWebsite') {
      let url = args?.url || '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://${url}`;
      }
      const title = args?.title || url;
      result = { success: true, action: 'opened_website', url, title };
      clientEvent = {
        type: 'tool_action',
        tool: 'openWebsite',
        data: { url, title },
      };
    } else if (name === 'rememberFact') {
      if (
        currentContext.role === 'unknown' ||
        currentContext.id === 'UNKNOWN' ||
        currentContext.id === 'UNREGISTERED'
      ) {
        result = {
          success: false,
          error: 'IDENTITY_NOT_REGISTERED',
          message: 'Cannot store persistent memory for an unregistered or guest user. Please register a profile first using registerUser.',
        };
      } else {
        const fact = args?.fact;
        const category = args?.category || 'fact';
        const record = db.addMemory(currentContext.id, fact, category);
        result = {
          success: Boolean(record),
          memoryId: record?.memoryId,
          ownerId: currentContext.id,
          userName: currentContext.name,
          message: `Memory securely stored in database for ${currentContext.name} (${currentContext.id}).`,
        };
        clientEvent = {
          type: 'tool_action',
          tool: 'rememberFact',
          data: { fact, category, ownerId: currentContext.id, userName: currentContext.name },
        };
      }
    } else if (name === 'getStoredMemories') {
      const targetUserName = args?.targetUserName?.trim();
      const isOwner = currentContext.role === 'owner';

      if (targetUserName && !isOwner) {
        if (targetUserName.toLowerCase() !== currentContext.name.toLowerCase()) {
          result = {
            count: 0,
            memories: [],
            error: 'ACCESS_DENIED',
            message: `Access denied. Normal users can only retrieve their own memories. You cannot access ${targetUserName}'s memories.`,
          };
        } else {
          const memories = db.getMemoriesForIdentity(currentContext.id);
          result = {
            count: memories.length,
            identity: currentContext.name,
            memories: memories.map((m) => ({ category: m.category, content: m.content })),
          };
        }
      } else if (targetUserName && isOwner) {
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
            message: `No user found in database with name "${targetUserName}".`,
          };
        }
      } else {
        if (currentContext.role === 'unknown') {
          result = {
            count: 0,
            memories: [],
            message: 'No stored memories available in guest mode.',
          };
        } else {
          const memories = db.getMemoriesForIdentity(currentContext.id);
          result = {
            count: memories.length,
            identity: currentContext.name,
            memories: memories.map((m) => ({ category: m.category, content: m.content })),
          };
        }
      }
    } else if (name === 'deleteMemory') {
      const query = args?.query?.trim();
      const targetUserName = args?.targetUserName?.trim();
      const isOwner = currentContext.role === 'owner';

      if (!query) {
        result = {
          success: false,
          error: 'QUERY_REQUIRED',
          message: 'Please specify the memory ID, keyword, or text content of the memory to delete.',
        };
      } else if (currentContext.role === 'unknown') {
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
            clientEvent = {
              type: 'tool_action',
              tool: 'deleteMemory',
              data: { query, deletedCount: res.deletedCount, deleted: res.deleted },
            };
          } else {
            result = {
              success: false,
              error: 'MEMORY_NOT_FOUND',
              message: `No matching memory found in database for query "${query}".`,
            };
          }
        }
      } else {
        if (targetUserName && targetUserName.toLowerCase() !== currentContext.name.toLowerCase()) {
          result = {
            success: false,
            error: 'PERMISSION_DENIED',
            message: 'Permission denied: Normal users can only delete their own memories.',
          };
        } else {
          const res = db.deleteMemoryByQuery(currentContext.id, query);
          if (res.success) {
            result = {
              success: true,
              deletedCount: res.deletedCount,
              deletedMemories: res.deleted.map((m) => m.content),
              message: `Permanently deleted ${res.deletedCount} memory item(s) from your profile in database.`,
            };
            clientEvent = {
              type: 'tool_action',
              tool: 'deleteMemory',
              data: { query, deletedCount: res.deletedCount, deleted: res.deleted },
            };
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
      const isOwner = currentContext.role === 'owner';

      if (targetUserName && !isOwner) {
        if (targetUserName.toLowerCase() !== currentContext.name.toLowerCase()) {
          result = {
            error: 'ACCESS_DENIED',
            message: 'Access denied. You can only recall your own conversation context.',
          };
        } else {
          const turns = db.getRecentTurns(currentContext.id, 6);
          result = {
            user: currentContext.name,
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
          result = { message: `No conversation context found in database for ${targetUserName}.` };
        }
      } else {
        const turns = db.getRecentTurns(currentContext.id, 6);
        result = {
          user: currentContext.name,
          recentTopics: turns.map((t) => `${t.role}: ${t.content}`),
        };
      }
    } else if (name === 'identifyUser') {
      const userName = (args?.name || '').trim();
      const cleanUser = userName.toLowerCase();
      const owner = db.getOwner();
      const isOwnerNameMatch = Boolean(
        (owner && owner.name.trim().toLowerCase() === cleanUser) ||
        cleanUser === 'ankit' ||
        cleanUser === 'owner' ||
        cleanUser.startsWith('ankit ') ||
        cleanUser.includes('owner access')
      );

      // RULE 1: If current backend state already says role = owner, authenticated = true: DO NOT ask for passcode again!
      if (isOwnerNameMatch || cleanUser.includes('owner')) {
        if (currentContext.role === 'owner' && currentContext.isOwnerAuthenticated) {
          result = {
            isOwnerNameMatch: true,
            alreadyAuthenticated: true,
            name: currentContext.name,
            role: 'owner',
            message: `User is ALREADY verified and authenticated as the System Owner (${currentContext.name}). Full Owner privileges are currently active. Do NOT ask for the passcode again.`,
          };
        } else {
          result = {
            isOwnerNameMatch: true,
            alreadyAuthenticated: false,
            name: userName,
            requiresPasscode: true,
            role: 'unknown',
            message: `The user stated "${userName}" / requested Owner access. Owner authentication is absent. Prompt the user to provide their Owner Passcode, which will be verified authoritatively via ownerAuthenticate.`,
          };
        }
      } else if (userName.length > 0) {
        const resolved = db.resolveIdentityByName(userName);
        if (resolved && !resolved.ambiguous) {
          if (resolved.role === 'owner') {
            if (currentContext.role === 'owner' && currentContext.isOwnerAuthenticated) {
              result = {
                isOwnerNameMatch: true,
                alreadyAuthenticated: true,
                name: currentContext.name,
                role: 'owner',
                message: `User is ALREADY verified and authenticated as the System Owner (${currentContext.name}). Full Owner privileges are currently active. Do NOT ask for the passcode again.`,
              };
            } else {
              result = {
                isOwnerNameMatch: true,
                alreadyAuthenticated: false,
                name: resolved.name,
                requiresPasscode: true,
                role: 'unknown',
                message: `Owner identification requires secret passcode authentication. Prompt for Owner passcode.`,
              };
            }
          } else {
            const newContext = auth.resolveContext(undefined, resolved.id);
            pendingContextUpdate = newContext;

            result = {
              isOwnerNameMatch: false,
              isRegistered: true,
              userId: resolved.id,
              name: resolved.name,
              role: 'user',
              message: `Existing registered profile found in database for ${resolved.name} (${resolved.id}). Active user context loaded.`,
            };

            clientEvent = {
              type: 'identity_changed',
              identity: { id: resolved.id, name: resolved.name, role: 'user' },
            };
          }
        } else if (resolved && resolved.ambiguous) {
          result = {
            isOwnerNameMatch: false,
            isRegistered: true,
            ambiguous: true,
            candidates: resolved.candidates,
            message: `Multiple registered user profiles found matching "${userName}": ${resolved.candidates?.join(', ')}. Please ask the user for clarification on which person they are.`,
          };
        } else {
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
            message: `The user is "${userName}", but is NOT registered in the database. DO NOT automatically create a persistent profile. Treat them as an unregistered guest.`,
          };

          clientEvent = {
            type: 'identity_changed',
            identity: { id: 'UNREGISTERED', name: userName, role: 'unknown' },
          };
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
          message: `Persistent user profile created in database for ${profile.name} (${profile.id}).`,
        };

        clientEvent = {
          type: 'identity_changed',
          identity: { id: profile.id, name: profile.name, role: 'user' },
        };
      } else {
        result = { success: false, error: 'INVALID_NAME', message: 'Please provide a valid name for registration.' };
      }
    } else if (name === 'ownerAuthenticate') {
      if (currentContext.role === 'owner' && currentContext.isOwnerAuthenticated) {
        result = {
          success: true,
          role: 'owner',
          name: currentContext.name,
          message: 'Already authenticated as System Owner. Full Owner privileges are active.',
        };
      } else {
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
          clientEvent = {
            type: 'identity_changed',
            token: authRes.token,
            identity: { id: newContext.id, name: newContext.name, role: 'owner' },
          };
        } else {
          result = {
            success: false,
            error: authRes.error || 'AUTHENTICATION_FAILED',
            message: 'Invalid owner passcode. Access remains at current permission level.',
          };
        }
      }
    } else if (name === 'switchContext') {
      const targetRole = (args?.targetRole || 'guest').toLowerCase();
      const targetUserName = args?.targetUserName?.trim();
      const passcode = args?.passcode;

      if (targetRole === 'owner') {
        if (currentContext.role === 'owner' && currentContext.isOwnerAuthenticated) {
          result = {
            success: true,
            role: 'owner',
            name: currentContext.name,
            message: 'Already in Owner context with active authentication.',
          };
        } else if (!passcode) {
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
            clientEvent = {
              type: 'identity_changed',
              token: authRes.token,
              identity: { id: newContext.id, name: newContext.name, role: 'owner' },
            };
          } else {
            result = {
              success: false,
              error: 'AUTHENTICATION_FAILED',
              message: 'Incorrect Owner passcode. Could not switch to Owner context.',
            };
          }
        }
      } else {
        if (currentContext.role !== 'owner') {
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
            message: 'Switched to Guest context.',
          };
          clientEvent = {
            type: 'identity_changed',
            identity: { id: 'UNKNOWN', name: 'Guest', role: 'unknown' },
          };
        } else if (targetRole === 'user') {
          if (targetUserName) {
            const resolved = db.resolveIdentityByName(targetUserName);
            if (!resolved || resolved.ambiguous || resolved.role !== 'user') {
              result = {
                success: false,
                error: resolved?.ambiguous ? 'AMBIGUOUS_NAME' : 'USER_NOT_FOUND',
                message: resolved?.ambiguous
                  ? `Multiple user profiles match "${targetUserName}": ${resolved.candidates?.join(', ')}. Please specify full name.`
                  : `Registered user profile "${targetUserName}" was not found in the database.`,
              };
            } else {
              const newContext = auth.resolveContext(currentContext.token, resolved.id);
              pendingContextUpdate = newContext;
              result = {
                success: true,
                role: 'user',
                name: resolved.name,
                userId: resolved.id,
                message: `Switched active conversation context to user ${resolved.name} (${resolved.id}).`,
              };
              clientEvent = {
                type: 'identity_changed',
                identity: { id: resolved.id, name: resolved.name, role: 'user' },
                token: currentContext.token,
              };
            }
          } else {
            result = {
              success: false,
              error: 'USER_NAME_REQUIRED',
              message: 'Please specify the name of the user profile to switch to.',
            };
          }
        }
      }
    } else if (name === 'deleteUserProfile') {
      if (currentContext.role !== 'owner') {
        result = {
          success: false,
          error: 'PERMISSION_DENIED',
          message: 'Only the authenticated Owner can delete user profiles.',
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
                message: `User ${targetUser.name} (${targetUser.id}) and all associated memories and conversation context were permanently deleted from database.`,
              };
              clientEvent = {
                type: 'tool_action',
                action: {
                  type: 'user_deleted',
                  userId: targetUser.id,
                  userName: targetUser.name,
                },
              };
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
    } else if (name === 'clearConversationHistory') {
      const targetUserName = args?.targetUserName?.trim();
      const targetSessionId = args?.targetSessionId?.trim();

      let targetId = currentContext.id;
      let targetName = currentContext.name;
      let permDenied = false;

      if (targetUserName) {
        if (currentContext.role !== 'owner') {
          permDenied = true;
          result = {
            success: false,
            error: 'PERMISSION_DENIED',
            message: 'Permission denied: Only the authenticated Owner can clear conversation history for other users.',
          };
        } else {
          const targetUser = db.getUserByName(targetUserName) || db.getUserById(targetUserName);
          if (targetUser) {
            targetId = targetUser.id;
            targetName = targetUser.name;
          } else if (targetUserName.toLowerCase() === 'ankit' || targetUserName.toLowerCase() === 'owner') {
            const owner = db.getOwner();
            targetId = owner?.id || 'OWNER_001';
            targetName = owner?.name || 'Ankit';
          } else {
            result = {
              success: false,
              error: 'USER_NOT_FOUND',
              message: `User "${targetUserName}" was not found in registered profiles.`,
            };
          }
        }
      }

      if (!permDenied && (!result || !result.error)) {
        if (targetSessionId) {
          const ok = db.deleteSession(targetId, targetSessionId);
          if (ok) {
            result = {
              success: true,
              message: `Session "${targetSessionId}" for ${targetName} was permanently deleted from persistent database.`,
            };
            clientEvent = {
              type: 'tool_action',
              tool: 'clearConversationHistory',
              data: { targetId, targetName, sessionId: targetSessionId },
            };
          } else {
            result = {
              success: false,
              error: 'SESSION_NOT_FOUND',
              message: `Session "${targetSessionId}" was not found for user ${targetName}.`,
            };
          }
        } else {
          const ok = db.clearHistory(targetId);
          if (ok) {
            result = {
              success: true,
              message: `All conversation history for ${targetName} (${targetId}) was permanently cleared from persistent database.`,
            };
            clientEvent = {
              type: 'tool_action',
              tool: 'clearConversationHistory',
              data: { targetId, targetName },
            };
          } else {
            result = {
              success: false,
              error: 'CLEAR_FAILED',
              message: `Failed to clear history for ${targetName}.`,
            };
          }
        }
      }
    } else if (name === 'getTimeAndStatus') {
      const now = new Date();
      const locationConfig = db.getLocationConfig();
      const registeredUsers = db.getUsers();
      const owner = db.getOwner();
      const isOwner = currentContext.role === 'owner';
      const timeIST = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
      const dateIST = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const allUsers = [];
      if (owner) allUsers.push({ id: owner.id, name: owner.name });
      registeredUsers.forEach((u) => allUsers.push({ id: u.id, name: u.name }));

      result = {
        currentTimeIST: timeIST,
        currentDateIST: dateIST,
        timezone: 'Asia/Kolkata (IST, UTC+05:30)',
        homeLocation: locationConfig.formattedLocation,
        totalRegisteredUsers: allUsers.length,
        registeredUsers: isOwner ? allUsers : undefined,
        activeIdentity: {
          id: currentContext.id,
          name: currentContext.name,
          role: currentContext.role,
        },
        accessLevel: isOwner ? 'Owner' : currentContext.role === 'user' ? 'Registered User' : 'Unregistered',
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
        result = {
          available: false,
          message: 'Live weather service is currently unreachable.',
          location: targetLocation,
        };
      }
    } else if (name === 'getInteractionTimeline') {
      const targetUserName = args?.targetUserName?.trim();
      result = db.getInteractionTimeline(
        targetUserName || currentContext.name,
        currentContext.role,
        currentContext.id
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
          const note = db.addCrossUserNote(currentContext.id, currentContext.name, content, targetUserName);
          result = { success: Boolean(note), noteId: note?.noteId, targetUserName, message: 'Message securely saved in database.' };
          clientEvent = {
            type: 'tool_action',
            tool: 'manageCrossUserNote',
            data: { action, targetUserName, content, noteId: note?.noteId },
          };
        }
      } else if (action === 'update' || action === 'delete' || action === 'mark_delivered') {
        if (!noteId) {
          result = { success: false, error: 'NOTEID_REQUIRED' };
        } else {
          if (action === 'update') {
            const success = db.editCrossUserNote(currentContext.id, noteId, content);
            result = { success, message: success ? 'Note updated.' : 'Failed to update note.' };
          } else if (action === 'delete') {
            const success = db.deleteCrossUserNote(currentContext.id, noteId);
            result = { success, message: success ? 'Note deleted.' : 'Failed to delete note.' };
          } else if (action === 'mark_delivered') {
            db.markNotesDelivered([noteId]);
            result = { success: true, message: 'Marked note as delivered.' };
          }
        }
      }
    } else if (name === 'manageTask') {
      const action = args?.action;
      const taskId = args?.taskId?.trim();
      const title = args?.title?.trim();
      const status = args?.status?.trim() as any;
      const targetUserName = args?.targetUserName?.trim();

      let targetId = currentContext.id;
      if (targetUserName && currentContext.role === 'owner') {
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
            result = { success: true, taskId: t?.id, title: t?.title, status: t?.status, message: `Task created: "${title}"` };
          } else {
            if (status) db.updateTaskStatus(targetId, taskId, status);
            result = { success: true, taskId, status, message: `Task ${taskId} status updated to ${status}.` };
          }
          clientEvent = {
            type: 'tool_action',
            tool: 'manageTask',
            data: { action, taskId, title, status },
          };
        }
      } else if (action === 'delete') {
        if (!taskId) {
          result = { success: false, error: 'TASKID_REQUIRED' };
        } else {
          const ok = db.deleteTask(targetId, taskId);
          result = { success: ok, taskId, message: ok ? `Task ${taskId} deleted.` : 'Task not found.' };
        }
      }
    } else if (name === 'getRegisteredUsersInfo') {
      // RULE 2: Query authoritative database directly!
      const registeredUsers = db.getUsers();
      const owner = db.getOwner();
      const isOwner = currentContext.role === 'owner';
      const allUsers = [];
      if (owner) allUsers.push({ id: owner.id, name: owner.name, role: 'owner' });
      registeredUsers.forEach((u) => allUsers.push({ id: u.id, name: u.name, role: 'user' }));

      result = {
        totalRegisteredUsers: allUsers.length,
        registeredUsers: isOwner ? allUsers : undefined,
        message: isOwner
          ? `Authoritative database query: There are ${allUsers.length} registered user(s): ${allUsers.map((u) => u.name).join(', ')}.`
          : `Authoritative database query: There are ${allUsers.length} registered user(s) in the database. Individual user names are restricted to the Owner.`,
      };
    } else if (name === 'updateVoiceConfiguration') {
      const requestedVoice = args?.voiceName?.trim();
      const speakingStyle = args?.speakingStyle?.trim();
      const preferredLanguage = args?.preferredLanguage?.trim();
      const responseLength = args?.responseLength?.trim();

      const updatePayload: Partial<PersonaAndVoiceConfig> = {};
      if (requestedVoice) {
        const matchedVoice = VALID_FEMALE_VOICES.find((v) => v.toLowerCase() === requestedVoice.toLowerCase());
        if (!matchedVoice) {
          result = {
            success: false,
            error: `MALE_VOICES_PROHIBITED: All Madhurita voice profiles must use female voices (${VALID_FEMALE_VOICES.join(', ')}). '${requestedVoice}' is not a permitted voice.`,
          };
          return { result };
        }
        updatePayload.voiceName = matchedVoice;
      }
      if (speakingStyle) updatePayload.speakingStyle = speakingStyle as any;
      if (preferredLanguage) updatePayload.preferredLanguage = preferredLanguage as any;
      if (responseLength) updatePayload.responseLength = responseLength as any;

      try {
        const updated = db.updatePersonaVoiceConfig(currentContext.id, updatePayload);
        result = {
          success: true,
          message: `Voice configuration successfully updated. Active voice is now ${updated.voiceName} with ${updated.speakingStyle} style.`,
          voiceConfig: updated,
        };
        pendingVoiceUpdate = updated;
        clientEvent = {
          type: 'voice_config_changed',
          config: updated,
        };
      } catch (err: any) {
        result = { success: false, error: err.message || 'Failed to update voice configuration' };
      }
    } else if (name === 'updateUserPreference') {
      const key = (args?.preferenceKey || '').trim();
      const val = args?.preferenceValue;
      const targetUserName = args?.targetUserName?.trim();
      let targetId = currentContext.id;

      if (currentContext.role === 'owner' && targetUserName) {
        const targetUser = db.getUserByName(targetUserName);
        if (targetUser) targetId = targetUser.id;
      }

      if (currentContext.role === 'unknown' || targetId === 'UNKNOWN' || targetId === 'UNREGISTERED') {
        result = {
          success: false,
          error: 'IDENTITY_NOT_REGISTERED',
          message: 'Cannot save preferences for guest/unregistered identity.',
        };
      } else if (!key) {
        result = {
          success: false,
          error: 'KEY_REQUIRED',
          message: 'preferenceKey is required.',
        };
      } else {
        const updated = db.updateUserPreference(targetId, key, val);
        result = {
          success: true,
          preferenceKey: key,
          preferenceValue: val,
          updatedPreferences: updated,
          message: `Preference "${key}" updated for identity ${targetId}.`,
        };
        clientEvent = {
          type: 'tool_action',
          tool: 'updateUserPreference',
          data: { preferenceKey: key, preferenceValue: val, targetId },
        };
      }
    } else {
      result = { error: `Unknown tool declaration: ${name}` };
    }
  } catch (err: any) {
    result = { error: err.message || 'Tool execution error' };
  }

  // Trigger UI update broadcast across all active WebSocket sessions after state mutations
  if ([
    'rememberFact',
    'deleteMemory',
    'clearConversationHistory',
    'identifyUser',
    'registerUser',
    'ownerAuthenticate',
    'switchContext',
    'deleteUserProfile',
    'manageCrossUserNote',
    'manageTask',
    'updateVoiceConfiguration',
    'updateUserPreference',
  ].includes(name)) {
    try {
      broadcastRuntimeStateToAllSessions();
    } catch (e) {
      // ignore broadcast failure
    }
  }

  return {
    result,
    pendingContextUpdate,
    pendingVoiceUpdate,
    clientEvent,
  };
}
