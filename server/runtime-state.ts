import { db, TaskItem, OpenLoopItem, CrossUserNote, MemoryRecord, ConversationTurn, getISTDateTime, PersonaAndVoiceConfig } from './db.js';
import { AuthContext } from './auth.js';

export interface RuntimeContext {
  activeIdentity: {
    id: string;
    name: string;
    role: 'owner' | 'user' | 'unknown';
  };
  role: 'owner' | 'user' | 'unknown';
  authenticationState: {
    isAuthenticated: boolean;
    isOwner: boolean;
  };
  sessionId: string;
  hasOwner: boolean;
  ownerName: string | null;
  registeredUserCount?: number;
  registeredUsers?: Array<{ id: string; name: string }>;
  currentTasks: TaskItem[];
  currentLoops: OpenLoopItem[];
  currentNotes: CrossUserNote[];
  relevantMemory: MemoryRecord[];
  recentConversation: ConversationTurn[];
  lastInteraction: string | null;
  currentTime: {
    iso: string;
    istDate: string;
    istTime: string;
    istFull: string;
  };
  voiceConfig: PersonaAndVoiceConfig;
}

/**
 * Builds the authoritative runtime context for a given authenticated/identity context.
 * Enforces strict role-based data isolation:
 * - Owner: complete system operational visibility and all registered profiles.
 * - User: strictly their own tasks, loops, notes, memories, and turns.
 * - Guest/Unknown: empty private state, strictly restricted.
 */
export function buildRuntimeContext(context: AuthContext, sessionId?: string): RuntimeContext {
  const isOwner = context.role === 'owner';
  const isUser = context.role === 'user';
  const owner = db.getOwner();
  const hasOwner = db.hasOwner();
  const effectiveSessionId = sessionId || `SESSION_${new Date().toISOString().slice(0, 10)}`;
  const nowIst = getISTDateTime();

  let registeredUserCount: number | undefined;
  let registeredUsers: Array<{ id: string; name: string }> | undefined;
  let currentTasks: TaskItem[] = [];
  let currentLoops: OpenLoopItem[] = [];
  let currentNotes: CrossUserNote[] = [];
  let relevantMemory: MemoryRecord[] = [];
  let recentConversation: ConversationTurn[] = [];
  let lastInteraction: string | null = null;

  if (isOwner) {
    const rawUsers = db.getUsers();
    const allUsersList: Array<{ id: string; name: string }> = [];
    if (owner) allUsersList.push({ id: owner.id, name: owner.name });
    rawUsers.forEach((u) => allUsersList.push({ id: u.id, name: u.name }));

    registeredUserCount = allUsersList.length;
    registeredUsers = allUsersList;
    
    currentTasks = db.getTasksForIdentity(context.id);
    const wa = db.getWorldAwareness();
    currentLoops = wa?.openLoops || [];
    currentNotes = db.getPendingNotesForTarget(context.id, context.name);
    relevantMemory = db.getMemoriesForIdentity(context.id);
    recentConversation = db.getRecentTurns(context.id, 50, effectiveSessionId);

    const turns = db.getRecentTurns(context.id, 2);
    if (turns.length > 0) {
      lastInteraction = turns[turns.length - 1].timestamp;
    }
  } else if (isUser) {
    // Normal registered user: strictly isolated to their own records
    currentTasks = db.getTasksForIdentity(context.id);
    const wa = db.getWorldAwareness();
    currentLoops = (wa?.openLoops || []).filter((l) => l.identityId === context.id);
    currentNotes = db.getPendingNotesForTarget(context.id, context.name);
    relevantMemory = db.getMemoriesForIdentity(context.id);
    recentConversation = db.getRecentTurns(context.id, 50, effectiveSessionId);

    const turns = db.getRecentTurns(context.id, 2);
    if (turns.length > 0) {
      lastInteraction = turns[turns.length - 1].timestamp;
    }
  } else {
    // Unknown / Guest: zero private data access
    currentTasks = [];
    currentLoops = [];
    currentNotes = [];
    relevantMemory = [];
    recentConversation = effectiveSessionId ? db.getRecentTurns('UNKNOWN', 20, effectiveSessionId) : [];
    lastInteraction = null;
  }

  return {
    activeIdentity: {
      id: context.id,
      name: context.name,
      role: context.role,
    },
    role: context.role,
    authenticationState: {
      isAuthenticated: Boolean(context.isOwnerAuthenticated),
      isOwner,
    },
    sessionId: effectiveSessionId,
    hasOwner,
    ownerName: isOwner ? (owner ? owner.name : null) : null,
    registeredUserCount,
    registeredUsers,
    currentTasks,
    currentLoops,
    currentNotes,
    relevantMemory,
    recentConversation,
    lastInteraction,
    currentTime: {
      iso: nowIst.iso,
      istDate: nowIst.istDate,
      istTime: nowIst.istTime,
      istFull: nowIst.istFull,
    },
    voiceConfig: db.getPersonaVoiceConfig(context.id),
  };
}
