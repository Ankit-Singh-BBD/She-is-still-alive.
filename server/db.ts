import fs from 'fs';
import path from 'path';

export type FemaleVoiceName = 'Callirrhoe' | 'Aoede' | 'Kore' | 'Leda' | 'Despina';
export const VALID_FEMALE_VOICES: readonly FemaleVoiceName[] = ['Callirrhoe', 'Aoede', 'Kore', 'Leda', 'Despina'] as const;

export interface PersonaAndVoiceConfig {
  speakingStyle: 'warm_conversational' | 'expressive_witty' | 'calm_thoughtful' | 'concise_direct';
  tone: 'friendly_warm' | 'energetic_witty' | 'poised_professional' | 'playful_charming';
  formality: 'casual' | 'balanced' | 'formal';
  preferredLanguage: 'Hinglish' | 'English' | 'Hindi';
  hinglishBehavior: 'natural_mix' | 'light_conversational' | 'strict_english';
  voiceName: FemaleVoiceName;
  responseLength: 'concise' | 'balanced' | 'detailed';
  conversationalStyle: 'interactive_engaging' | 'direct_snappy' | 'deep_analytical';
}

export interface SystemLocationConfig {
  city: string;
  state: string;
  country: string;
  formattedLocation: string;
  timezone: string;
  latitude: number;
  longitude: number;
}

export const HOME_LOCATION_CONFIG: SystemLocationConfig = {
  city: 'Orai',
  state: 'Uttar Pradesh',
  country: 'India',
  formattedLocation: 'Orai, Uttar Pradesh, India',
  timezone: 'Asia/Kolkata',
  latitude: 25.9898,
  longitude: 79.4500,
};

export const DEFAULT_PERSONA_VOICE_CONFIG: PersonaAndVoiceConfig = {
  speakingStyle: 'warm_conversational',
  tone: 'friendly_warm',
  formality: 'balanced',
  preferredLanguage: 'Hinglish',
  hinglishBehavior: 'natural_mix',
  voiceName: 'Callirrhoe',
  responseLength: 'balanced',
  conversationalStyle: 'interactive_engaging',
};

export interface OwnerProfile {
  id: string;
  name: string;
  role: 'owner';
  relationship: string; // System-level Creator & Master Identity fact
  passcodeHash: string;
  passcodeSalt: string;
  preferences?: {
    personaAndVoice?: PersonaAndVoiceConfig;
    [key: string]: any;
  };
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  name: string;
  role: 'user';
  preferences?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  memoryId: string;
  ownerId: string; // The identity ID this memory belongs to (OWNER_001, USER_001, etc.)
  content: string;
  category: 'preference' | 'fact' | 'project' | 'goal' | 'personal' | 'habit' | 'relationship' | 'event' | 'commitment' | 'temporary_context' | 'unresolved_topic' | 'education';
  confidence: number;
  importance?: number;
  evidenceCount?: number;
  novelty?: number;
  futureUsefulness?: number;
  supersededBy?: string;
  expiresAt?: string;
  createdAt: string;
  createdAtIST?: string;
  updatedAt: string;
  updatedAtIST?: string;
}

export interface LearnedPattern {
  id: string;
  identityId: string;
  category: 'habit' | 'routine' | 'preference' | 'plan' | 'relationship' | 'recurring_behavior' | 'preferred_time' | 'communication_style';
  description: string;
  confidence: number;
  evidenceCount: number;
  firstObservedAt?: string;
  firstObservedAtIST?: string;
  lastObservedAt: string;
  lastObservedAtIST?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationTurn {
  turnId: string;
  speaker?: string;
  identityId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  istDate?: string;
  istTime?: string;
  timestampIST?: string;
  sessionId?: string;
  turnOrder?: number;
  sessionDuration?: string | number;
  topic?: string;
  referencedPeople?: string[];
  importantEvents?: string[];
  isResolved?: boolean;
}

export interface CrossUserNote {
  noteId: string;
  senderId: string;
  senderName: string;
  targetId?: string; // 'OWNER_001', 'USER_001', or undefined if general
  targetName?: string;
  content: string;
  createdAt: string;
  createdAtIST: string;
  sourceSession?: string;
  delivered: boolean;
  deliveredAt?: string;
  deliveredAtIST?: string;
}

export interface SessionMetadata {
  sessionId: string;
  identityId: string;
  userName?: string;
  startedAt: string;
  startedAtIST: string;
  lastActiveAt: string;
  lastActiveAtIST: string;
  durationMs: number;
  durationHuman?: string;
  topicsDiscussed: string[];
  turnCount: number;
  summary?: string;
  referencedEntities?: string[];
  unresolvedTopics?: string[];
}

export interface TaskItem {
  id: string;
  identityId: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'paused';
  createdAt: string;
  updatedAt: string;
}

export interface EntityRelationship {
  id: string;
  sourceEntity: string;
  targetEntity: string;
  relationshipType: string;
  description: string;
  confidence: number;
  createdAt: string;
  createdAtIST: string;
  updatedAt: string;
}

export interface OpenLoopItem {
  id: string;
  identityId: string;
  name: string;
  description: string;
  createdAtIST: string;
  createdAtISO?: string;
  status: 'open' | 'resolved';
  resolvedAtISO?: string;
  resolvedAtIST?: string;
}

export interface MadhuritaWorldAwareness {
  lastSystemStartup: string;
  lastSystemStartupIST: string;
  recentVisitors: Array<{
    identityId: string;
    name: string;
    lastSeenISO: string;
    lastSeenIST: string;
    sessionCount: number;
  }>;
  recentInteractions: Array<{
    identityId: string;
    name: string;
    summary: string;
    timestampISO: string;
    timestampIST: string;
    sessionId: string;
  }>;
  openLoops: OpenLoopItem[];
  milestones?: Array<{
    id: string;
    description: string;
    timestampIST: string;
    identityId?: string;
  }>;
}

export interface ProactiveEventRecord {
  eventId: string;
  createdAt: string;
  createdAtIST: string;
  category: 'pending_message' | 'unfinished_task' | 'world_change' | 'open_loop' | 'system_event' | 'important_change';
  relevanceTarget: string; // 'OWNER_001', 'USER_001', or 'ALL'
  summary: string;
  payload?: any;
  deliveredTo?: string[]; // array of identityIds who have received this event
  deliveredAt?: string;
  deliveredAtIST?: string;
  status: 'NEW' | 'SEEN' | 'DELIVERED' | 'ACKNOWLEDGED' | 'EXPIRED' | 'SUPERSEDED';
}

export interface RequestLifecycleItem {
  requestId: string;
  identityId: string;
  sessionId: string;
  query: string;
  status: 'REQUESTED' | 'ANSWERED' | 'PARTIALLY_ANSWERED' | 'DEFERRED' | 'CANCELLED' | 'UNRESOLVED';
  createdAtIST: string;
  updatedAtIST: string;
  resolutionNotes?: string;
}

export interface ExplicitCommitment {
  commitmentId: string;
  identityId: string;
  who: string; // 'user' | 'madhurita' | other name
  what: string;
  when?: string;
  status: 'active' | 'fulfilled' | 'broken' | 'cancelled';
  createdAtIST: string;
  dueAtIST?: string;
  evidenceTurnId?: string;
}

export interface DatabaseSchema {
  owner: OwnerProfile | null;
  users: UserProfile[];
  memories: MemoryRecord[];
  patterns?: LearnedPattern[];
  conversations: ConversationTurn[];
  crossUserNotes?: CrossUserNote[];
  sessions?: SessionMetadata[];
  tasks?: TaskItem[];
  relationships?: EntityRelationship[];
  worldAwareness?: MadhuritaWorldAwareness;
  proactiveEvents?: ProactiveEventRecord[];
  requests?: RequestLifecycleItem[];
  commitments?: ExplicitCommitment[];
  systemVoiceConfig?: PersonaAndVoiceConfig;
}

export function getISTDateTime(date: Date = new Date()): {
  iso: string;
  istDate: string;
  istTime: string;
  istFull: string;
} {
  const iso = date.toISOString();
  const istDate = date.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const istTime = date.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: true,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const istFull = `${istDate}, ${istTime}`;
  return { iso, istDate, istTime, istFull };
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

export type StateChangeListener = (operation: string, details?: string) => void;
const stateChangeListeners: StateChangeListener[] = [];

export function onDatabaseStateChange(listener: StateChangeListener) {
  stateChangeListeners.push(listener);
}

export function emitDatabaseStateChange(operation: string, details?: string) {
  for (const listener of stateChangeListeners) {
    try {
      listener(operation, details);
    } catch (e) {
      console.error('Error in state change listener:', e);
    }
  }
}

class DatabaseEngine {
  private data: DatabaseSchema = {
    owner: null,
    users: [],
    memories: [],
    patterns: [],
    conversations: [],
    tasks: [],
    crossUserNotes: [],
    sessions: [],
    relationships: [],
    worldAwareness: {
      lastSystemStartup: new Date().toISOString(),
      lastSystemStartupIST: getISTDateTime().istFull,
      recentVisitors: [],
      recentInteractions: [],
      openLoops: [],
      milestones: [],
    },
  };
  private isLoaded = false;

  constructor() {
    this.init();
  }

  private init() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(DB_FILE)) {
      try {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.patterns) this.data.patterns = [];
        if (!this.data.crossUserNotes) this.data.crossUserNotes = [];
        if (!this.data.sessions) this.data.sessions = [];
        if (!this.data.tasks) this.data.tasks = [];
        if (!this.data.relationships) this.data.relationships = [];
        if (!this.data.proactiveEvents) this.data.proactiveEvents = [];
        if (!this.data.requests) this.data.requests = [];
        if (!this.data.commitments) this.data.commitments = [];
        if (!this.data.worldAwareness) {
          this.data.worldAwareness = {
            lastSystemStartup: new Date().toISOString(),
            lastSystemStartupIST: getISTDateTime().istFull,
            recentVisitors: [],
            recentInteractions: [],
            openLoops: [],
            milestones: [],
          };
        }
      } catch (err) {
        console.error('Failed to parse db.json, initializing fresh data', err);
      }
    }

    // Record system startup in world awareness
    const nowIst = getISTDateTime();
    if (!this.data.worldAwareness) {
      this.data.worldAwareness = {
        lastSystemStartup: nowIst.iso,
        lastSystemStartupIST: nowIst.istFull,
        recentVisitors: [],
        recentInteractions: [],
        openLoops: [],
        milestones: [],
      };
    } else {
      this.data.worldAwareness.lastSystemStartup = nowIst.iso;
      this.data.worldAwareness.lastSystemStartupIST = nowIst.istFull;
    }

    // Authoritative system configuration: Ankit is the Creator and Owner of Madhurita
    if (!this.data.owner) {
      this.data.owner = {
        id: 'OWNER_001',
        name: 'Ankit',
        role: 'owner',
        relationship: 'Creator and Master Identity of Madhurita',
        passcodeHash: '',
        passcodeSalt: '',
        preferences: {
          personaAndVoice: { ...DEFAULT_PERSONA_VOICE_CONFIG },
        },
        createdAt: nowIst.iso,
        updatedAt: nowIst.iso,
      };
      this.save();
    } else {
      let updated = false;
      if (!this.data.owner.relationship) {
        this.data.owner.relationship = 'Creator and Master Identity of Madhurita';
        this.data.owner.name = this.data.owner.name || 'Ankit';
        updated = true;
      }
      if (!this.data.owner.preferences) {
        this.data.owner.preferences = { personaAndVoice: { ...DEFAULT_PERSONA_VOICE_CONFIG } };
        updated = true;
      } else if (!this.data.owner.preferences.personaAndVoice) {
        this.data.owner.preferences.personaAndVoice = { ...DEFAULT_PERSONA_VOICE_CONFIG };
        updated = true;
      }
      if (updated) {
        this.save();
      }
    }

    this.isLoaded = true;
    console.log(`[DB AUTHORITATIVE INSTANCE] Initialized Database at absolute path: ${path.resolve(DB_FILE)}`);
  }

  public getDatabaseFilePath(): string {
    return path.resolve(DB_FILE);
  }

  public logMutation(identityId: string, operation: string, success: boolean, details?: string): void {
    const now = getISTDateTime().iso;
    const dbPath = path.resolve(DB_FILE);
    console.log(`[STATE MUTATION LOG] timestamp: ${now} | identityId: ${identityId || 'UNKNOWN'} | operation: ${operation} | success: ${success} | path: ${dbPath}${details ? ` | details: ${details}` : ''}`);
    if (success) {
      emitDatabaseStateChange(operation, details);
    }
  }

  private save(): boolean {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tmpFile = path.join(DATA_DIR, `.db.json.${Date.now()}.${Math.random().toString(36).substring(2, 6)}.tmp`);
      const content = JSON.stringify(this.data, null, 2);
      fs.writeFileSync(tmpFile, content, 'utf-8');
      fs.renameSync(tmpFile, DB_FILE);
      emitDatabaseStateChange('db_saved');
      return true;
    } catch (err) {
      console.error('DATABASE_WRITE_FAILED', err);
      return false;
    }
  }

  // --- Owner Operations ---
  public getOwner(): OwnerProfile | null {
    return this.data.owner;
  }

  public setOwner(owner: OwnerProfile): boolean {
    this.data.owner = owner;
    const ok = this.save();
    this.logMutation(owner.id, 'setOwner', ok);
    return ok;
  }

  public hasOwner(): boolean {
    return this.data.owner !== null && Boolean(this.data.owner.passcodeHash);
  }

  // --- User Operations ---
  public getUsers(): UserProfile[] {
    return this.data.users;
  }

  public getUserById(id: string): UserProfile | null {
    return this.data.users.find((u) => u.id === id) || null;
  }

  public getUserByName(name: string): UserProfile | null {
    const clean = name.trim().toLowerCase();
    const exactMatch = this.data.users.find((u) => u.name.trim().toLowerCase() === clean);
    if (exactMatch) return exactMatch;
    
    // Partial unambiguous match
    const partialMatches = this.data.users.filter((u) => u.name.trim().toLowerCase().includes(clean));
    if (partialMatches.length === 1) {
      return partialMatches[0];
    }
    
    return null;
  }

  public createOrGetUser(name: string): UserProfile {
    const cleanName = name.trim();
    const existing = this.getUserByName(cleanName);
    if (existing) return existing;

    const nextIndex = this.data.users.length + 1;
    const id = `USER_${String(nextIndex).padStart(3, '0')}`;
    const now = new Date().toISOString();
    const newUser: UserProfile = {
      id,
      name: cleanName,
      role: 'user',
      preferences: {
        personaAndVoice: { ...DEFAULT_PERSONA_VOICE_CONFIG },
      },
      createdAt: now,
      updatedAt: now,
    };
    this.data.users.push(newUser);
    this.save();
    this.logMutation(newUser.id, 'createOrGetUser', true);
    return newUser;
  }

  public deleteUser(userId: string): boolean {
    if (!userId) return false;
    const userIndex = this.data.users.findIndex((u) => u.id === userId);
    if (userIndex === -1) return false;

    // 1. Remove user profile
    this.data.users.splice(userIndex, 1);

    // 2. Cascade delete all user-scoped memories
    this.data.memories = this.data.memories.filter((m) => m.ownerId !== userId);

    // 3. Cascade delete all user-scoped learned patterns
    if (this.data.patterns) {
      this.data.patterns = this.data.patterns.filter((p) => p.identityId !== userId);
    }

    // 4. Cascade delete all conversation context turns
    if (this.data.conversations) {
      this.data.conversations = this.data.conversations.filter((c) => c.identityId !== userId);
    }

    // 5. Cascade delete tasks
    if (this.data.tasks) {
      this.data.tasks = this.data.tasks.filter((t) => t.identityId !== userId);
    }

    // 6. Cascade delete sessions
    if (this.data.sessions) {
      this.data.sessions = this.data.sessions.filter((s) => s.identityId !== userId);
    }

    // 7. Cascade delete open loops
    if (this.data.worldAwareness && this.data.worldAwareness.openLoops) {
      this.data.worldAwareness.openLoops = this.data.worldAwareness.openLoops.filter((ol) => ol.identityId !== userId);
    }

    // 8. Cascade delete requests
    if (this.data.requests) {
      this.data.requests = this.data.requests.filter((r) => r.identityId !== userId);
    }

    // 9. Cascade delete commitments
    if (this.data.commitments) {
      this.data.commitments = this.data.commitments.filter((cm) => cm.identityId !== userId);
    }

    // 10. Cascade delete cross-user notes
    if (this.data.crossUserNotes) {
      this.data.crossUserNotes = this.data.crossUserNotes.filter((n) => n.senderId !== userId && n.targetId !== userId);
    }

    // 11. Cascade delete world awareness visitors & interactions
    if (this.data.worldAwareness) {
      if (this.data.worldAwareness.recentVisitors) {
        this.data.worldAwareness.recentVisitors = this.data.worldAwareness.recentVisitors.filter((v) => v.identityId !== userId);
      }
      if (this.data.worldAwareness.recentInteractions) {
        this.data.worldAwareness.recentInteractions = this.data.worldAwareness.recentInteractions.filter((i) => i.identityId !== userId);
      }
    }

    // 12. Cascade delete proactive events targeting user
    if (this.data.proactiveEvents) {
      this.data.proactiveEvents = this.data.proactiveEvents.filter((pe) => pe.relevanceTarget !== userId);
    }

    const ok = this.save();
    this.logMutation(userId, 'deleteUser', ok);
    return ok;
  }

  // --- Identity-Scoped Memory Operations ---
  public getMemoriesForIdentity(identityId: string, includeCandidates: boolean = false): MemoryRecord[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    return this.data.memories
      .filter((m) => {
        if (m.ownerId !== identityId || m.supersededBy) return false;
        if (includeCandidates) return true;
        // Strict threshold for permanent memory
        return (m.evidenceCount && m.evidenceCount > 1) || (m.confidence >= 0.95);
      })
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  }

  public getAllMemoriesIncludingSuperseded(identityId: string): MemoryRecord[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    return this.data.memories
      .filter((m) => m.ownerId === identityId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  }

  public getLatestMemoryForIdentity(identityId: string): MemoryRecord | null {
    const list = this.getMemoriesForIdentity(identityId);
    return list.length > 0 ? list[0] : null;
  }

  // Tokenize string for semantic similarity comparisons
  private tokenizeText(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'to', 'for', 'of', 'with',
      'you', 'i', 'me', 'my', 'we', 'our', 'what', 'did', 'about', 'how', 'when', 'where', 'why',
      'can', 'will', 'do', 'does', 'user', 'prefers', 'likes', 'fav', 'favourite', 'favorite',
      'tha', 'thi', 'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'se', 'me', 'mein', 'ne', 'aur'
    ]);
    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
    return new Set(words);
  }

  // Calculate word overlap Jaccard similarity
  private calculateSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Consolidate or add a memory:
   * - Searches existing memories for the identity.
   * - If an existing memory expresses the same core fact or preference:
   *   strengthens evidence count, updates confidence, updates IST timestamp.
   * - If an existing memory contradicts the new info (or is an update of previous state):
   *   updates the record or marks superseded.
   * - Otherwise, creates a new persistent record with IST timestamps.
   */
  public addMemory(
    identityId: string,
    content: string,
    category: MemoryRecord['category'] = 'fact',
    confidence = 1.0,
    importance = 0.8
  ): MemoryRecord | null {
    if (!identityId || !content.trim()) return null;
    const cleanContent = content.trim();
    const nowIst = getISTDateTime();
    const newTokens = this.tokenizeText(cleanContent);

    // 1. Exact match check
    const exactMatch = this.data.memories.find(
      (m) => m.ownerId === identityId && m.content.toLowerCase() === cleanContent.toLowerCase()
    );
    if (exactMatch) {
      exactMatch.evidenceCount = (exactMatch.evidenceCount || 1) + 1;
      exactMatch.confidence = Math.min(1.0, (exactMatch.confidence || 0.8) + 0.05);
      exactMatch.importance = Math.max(exactMatch.importance || 0.7, importance);
      exactMatch.updatedAt = nowIst.iso;
      exactMatch.updatedAtIST = nowIst.istFull;
      this.save();
      return exactMatch;
    }

    // 2. High semantic / keyword similarity check (Consolidation)
    const userMemories = this.data.memories.filter((m) => m.ownerId === identityId && !m.supersededBy);
    let bestMatch: MemoryRecord | null = null;
    let highestSim = 0;

    for (const mem of userMemories) {
      const existingTokens = this.tokenizeText(mem.content);
      const sim = this.calculateSimilarity(newTokens, existingTokens);
      if (sim > highestSim) {
        highestSim = sim;
        bestMatch = mem;
      }
    }

    // If similarity >= 0.60 or one is a clear refinement of the other
    if (bestMatch && highestSim >= 0.60) {
      bestMatch.evidenceCount = (bestMatch.evidenceCount || 1) + 1;
      bestMatch.confidence = Math.min(1.0, Math.max(bestMatch.confidence, confidence) + 0.05);
      bestMatch.importance = Math.max(bestMatch.importance || 0.7, importance);
      // If new text is richer or more detailed, update content while keeping record identity
      if (cleanContent.length > bestMatch.content.length) {
        bestMatch.content = cleanContent;
      }
      bestMatch.category = category || bestMatch.category;
      bestMatch.updatedAt = nowIst.iso;
      bestMatch.updatedAtIST = nowIst.istFull;
      this.save();
      return bestMatch;
    }

    // 3. New memory creation
    const memoryId = `MEM_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const record: MemoryRecord = {
      memoryId,
      ownerId: identityId,
      content: cleanContent,
      category,
      confidence,
      importance,
      evidenceCount: 1,
      novelty: 1.0,
      createdAt: nowIst.iso,
      createdAtIST: nowIst.istFull,
      updatedAt: nowIst.iso,
      updatedAtIST: nowIst.istFull,
    };

    this.data.memories.push(record);
    const ok = this.save();
    return ok ? record : null;
  }

  /**
   * Authoritative candidate knowledge validation:
   * Decides IGNORE, TEMPORARY, STORE, UPDATE, STRENGTHEN, SUPERSEDE, or CONFLICT.
   * Ensures guest users do NOT receive permanent personal memory records.
   */
  public validateAndApplyMemoryCandidate(
    identityId: string,
    content: string,
    category: MemoryRecord['category'] = 'fact',
    confidence = 0.85,
    importance = 0.75,
    isTemporary = false
  ): { decision: 'IGNORE' | 'TEMPORARY' | 'STORE' | 'UPDATE' | 'STRENGTHEN' | 'SUPERSEDE' | 'CONFLICT'; memory: MemoryRecord | null } {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'GUEST' || !content.trim()) {
      return { decision: 'IGNORE', memory: null };
    }

    const cleanContent = content.trim();
    const lower = cleanContent.toLowerCase();

    // Check for temporary statements (e.g. today's mood, one-off feeling)
    if (isTemporary || lower.includes(' today') || lower.includes(' right now') || lower.includes(' aaj ') || lower.includes(' abhi ') || lower.includes('feel like')) {
      return { decision: 'TEMPORARY', memory: null };
    }

    const userMemories = this.data.memories.filter((m) => m.ownerId === identityId && !m.supersededBy);
    const newTokens = this.tokenizeText(cleanContent);

    // 1. Contradiction / Conflict check
    for (const mem of userMemories) {
      const memTokens = this.tokenizeText(mem.content);
      const overlap = this.calculateSimilarity(newTokens, memTokens);
      const isOpposite = (lower.includes('dislike') || lower.includes('hate') || lower.includes('not ') || lower.includes('na pasand') || lower.includes('nahi') || lower.includes('stopped')) &&
                         (mem.content.toLowerCase().includes('like') || mem.content.toLowerCase().includes('love') || mem.content.toLowerCase().includes('prefer') || mem.content.toLowerCase().includes('pasand') || mem.content.toLowerCase().includes('uses'));
      if (overlap >= 0.30 && isOpposite) {
        const nowIst = getISTDateTime();
        const newMemoryId = `MEM_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        mem.supersededBy = newMemoryId;
        mem.updatedAt = nowIst.iso;
        mem.updatedAtIST = nowIst.istFull;

        const newRec: MemoryRecord = {
          memoryId: newMemoryId,
          ownerId: identityId,
          content: cleanContent,
          category,
          confidence,
          importance,
          evidenceCount: 1,
          novelty: 1.0,
          createdAt: nowIst.iso,
          createdAtIST: nowIst.istFull,
          updatedAt: nowIst.iso,
          updatedAtIST: nowIst.istFull,
        };
        this.data.memories.push(newRec);
        this.save();
        return { decision: 'SUPERSEDE', memory: newRec };
      }
    }

    // 2. Similarity & Consolidation check
    let bestMatch: MemoryRecord | null = null;
    let highestSim = 0;
    for (const mem of userMemories) {
      const memTokens = this.tokenizeText(mem.content);
      const sim = this.calculateSimilarity(newTokens, memTokens);
      if (sim > highestSim) {
        highestSim = sim;
        bestMatch = mem;
      }
    }

    if (bestMatch && highestSim >= 0.50) {
      const nowIst = getISTDateTime();
      bestMatch.evidenceCount = (bestMatch.evidenceCount || 1) + 1;
      bestMatch.confidence = Math.min(1.0, (bestMatch.confidence || 0.8) + 0.05);
      bestMatch.importance = Math.max(bestMatch.importance || 0.7, importance);
      let decision: 'STRENGTHEN' | 'UPDATE' = 'STRENGTHEN';
      if (cleanContent.length > bestMatch.content.length) {
        bestMatch.content = cleanContent;
        decision = 'UPDATE';
      }
      bestMatch.updatedAt = nowIst.iso;
      bestMatch.updatedAtIST = nowIst.istFull;
      this.save();
      return { decision, memory: bestMatch };
    }

    // 3. New memory creation
    const stored = this.addMemory(identityId, cleanContent, category, confidence, importance);
    return { decision: stored ? 'STORE' : 'IGNORE', memory: stored };
  }

  public deleteMemory(identityId: string, memoryId: string): boolean {
    const index = this.data.memories.findIndex(
      (m) => m.memoryId === memoryId && (m.ownerId === identityId || identityId === 'OWNER_001')
    );
    if (index !== -1) {
      this.data.memories.splice(index, 1);
      return this.save();
    }
    return false;
  }

  public deleteMemoryByQuery(
    identityId: string,
    queryOrId: string
  ): { success: boolean; deletedCount: number; deleted: MemoryRecord[] } {
    if (!identityId || !queryOrId.trim()) {
      return { success: false, deletedCount: 0, deleted: [] };
    }

    const cleanQuery = queryOrId.trim().toLowerCase();
    const userMemories = this.data.memories.filter((m) => m.ownerId === identityId);
    
    // 1. Direct ID match
    const byId = userMemories.find((m) => m.memoryId.toLowerCase() === cleanQuery);
    if (byId) {
      this.data.memories = this.data.memories.filter((m) => m.memoryId !== byId.memoryId);
      this.save();
      return { success: true, deletedCount: 1, deleted: [byId] };
    }

    // 2. Exact or substring match in content
    const matching = userMemories.filter((m) => m.content.toLowerCase().includes(cleanQuery));
    if (matching.length > 0) {
      const matchIds = new Set(matching.map((m) => m.memoryId));
      this.data.memories = this.data.memories.filter((m) => !matchIds.has(m.memoryId));
      this.save();
      return { success: true, deletedCount: matching.length, deleted: matching };
    }

    return { success: false, deletedCount: 0, deleted: [] };
  }

  public deleteMemoryAsOwner(
    queryOrId: string,
    targetUserId?: string
  ): { success: boolean; deletedCount: number; deleted: MemoryRecord[] } {
    if (!queryOrId.trim()) {
      return { success: false, deletedCount: 0, deleted: [] };
    }

    const cleanQuery = queryOrId.trim().toLowerCase();
    let candidates = this.data.memories;
    if (targetUserId) {
      candidates = candidates.filter((m) => m.ownerId === targetUserId);
    }

    // 1. Direct ID match
    const byId = candidates.find((m) => m.memoryId.toLowerCase() === cleanQuery);
    if (byId) {
      this.data.memories = this.data.memories.filter((m) => m.memoryId !== byId.memoryId);
      this.save();
      return { success: true, deletedCount: 1, deleted: [byId] };
    }

    // 2. Substring match
    const matching = candidates.filter((m) => m.content.toLowerCase().includes(cleanQuery));
    if (matching.length > 0) {
      const matchIds = new Set(matching.map((m) => m.memoryId));
      this.data.memories = this.data.memories.filter((m) => !matchIds.has(m.memoryId));
      this.save();
      return { success: true, deletedCount: matching.length, deleted: matching };
    }

    return { success: false, deletedCount: 0, deleted: [] };
  }

  // --- Identity-Scoped Learned Patterns (Habits, Routines, Preferences, Plans, Recurring Behaviors) ---
  public getPatternsForIdentity(identityId: string): LearnedPattern[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    if (!this.data.patterns) this.data.patterns = [];
    return this.data.patterns
      .filter((p) => p.identityId === identityId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  }

  public addOrUpdatePattern(
    identityId: string,
    description: string,
    category: LearnedPattern['category'] = 'preference',
    confidence = 0.85
  ): LearnedPattern | null {
    if (!identityId || !description.trim()) return null;
    if (!this.data.patterns) this.data.patterns = [];

    const cleanDesc = description.trim();
    const nowIst = getISTDateTime();
    const newTokens = this.tokenizeText(cleanDesc);

    const existing = this.data.patterns.find((p) => {
      if (p.identityId !== identityId) return false;
      if (p.description.toLowerCase() === cleanDesc.toLowerCase()) return true;
      const sim = this.calculateSimilarity(newTokens, this.tokenizeText(p.description));
      return sim > 0.6;
    });

    if (existing) {
      existing.evidenceCount = (existing.evidenceCount || 1) + 1;
      existing.confidence = Math.min(1.0, (existing.confidence || 0.8) + 0.05);
      if (cleanDesc.length > existing.description.length) {
        existing.description = cleanDesc;
      }
      existing.category = category || existing.category;
      existing.lastObservedAt = nowIst.iso;
      existing.lastObservedAtIST = nowIst.istFull;
      existing.updatedAt = nowIst.iso;
      this.save();
      return existing;
    }

    const patternId = `PAT_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newPattern: LearnedPattern = {
      id: patternId,
      identityId,
      category,
      description: cleanDesc,
      confidence,
      evidenceCount: 1,
      firstObservedAt: nowIst.iso,
      firstObservedAtIST: nowIst.istFull,
      lastObservedAt: nowIst.iso,
      lastObservedAtIST: nowIst.istFull,
      createdAt: nowIst.iso,
      updatedAt: nowIst.iso,
    };

    this.data.patterns.push(newPattern);
    this.save();
    return newPattern;
  }

  public deletePattern(identityId: string, patternId: string): boolean {
    if (!this.data.patterns) return false;
    const index = this.data.patterns.findIndex(
      (p) => p.id === patternId && (p.identityId === identityId || identityId === 'OWNER_001')
    );
    if (index !== -1) {
      this.data.patterns.splice(index, 1);
      return this.save();
    }
    return false;
  }

  /**
   * Updates the description or category of an existing pattern (correction/evolution).
   */
  public updatePatternDescription(
    identityId: string,
    patternId: string,
    newDescription: string,
    newCategory?: LearnedPattern['category']
  ): boolean {
    if (!this.data.patterns) return false;
    const pattern = this.data.patterns.find(
      (p) => p.id === patternId && (p.identityId === identityId || identityId === 'OWNER_001')
    );
    if (!pattern) return false;
    const nowIst = getISTDateTime();
    pattern.description = newDescription.trim();
    if (newCategory) pattern.category = newCategory;
    pattern.lastObservedAt = nowIst.iso;
    pattern.lastObservedAtIST = nowIst.istFull;
    pattern.updatedAt = nowIst.iso;
    return this.save();
  }

  /**
   * Weakens a pattern's confidence. If confidence drops below threshold, removes it.
   */
  public weakenPattern(identityId: string, patternId: string, amount = 0.2): boolean {
    if (!this.data.patterns) return false;
    const pattern = this.data.patterns.find(
      (p) => p.id === patternId && (p.identityId === identityId || identityId === 'OWNER_001')
    );
    if (!pattern) return false;
    pattern.confidence = Math.max(0, (pattern.confidence || 0.8) - amount);
    pattern.updatedAt = getISTDateTime().iso;
    if (pattern.confidence < 0.15) {
      return this.deletePattern(identityId, patternId);
    }
    return this.save();
  }

  /**
   * Updates the content of an existing memory record (for cognitive correction/evolution).
   */
  public updateMemoryContent(
    identityId: string,
    memoryId: string,
    newContent: string,
    newCategory?: MemoryRecord['category']
  ): boolean {
    if (!this.data.memories) return false;
    const memory = this.data.memories.find(
      (m) => m.memoryId === memoryId && (m.ownerId === identityId || identityId === 'OWNER_001')
    );
    if (!memory) return false;
    const nowIst = getISTDateTime();
    memory.content = newContent.trim();
    if (newCategory) memory.category = newCategory;
    memory.updatedAt = nowIst.iso;
    memory.updatedAtIST = nowIst.istFull;
    return this.save();
  }

  // --- Interaction / Session Metadata & World Awareness ---
  public touchSession(identityId: string, sessionId?: string, userName?: string): SessionMetadata {
    if (!this.data.sessions) this.data.sessions = [];
    const nowIst = getISTDateTime();
    const id = sessionId || `SESSION_${nowIst.iso.slice(0, 10)}`;

    let sess = this.data.sessions.find((s) => s.sessionId === id && s.identityId === identityId);
    if (!sess) {
      sess = {
        sessionId: id,
        identityId,
        userName: userName || (identityId === 'OWNER_001' ? this.data.owner?.name : this.getUserById(identityId)?.name) || 'Guest',
        startedAt: nowIst.iso,
        startedAtIST: nowIst.istFull,
        lastActiveAt: nowIst.iso,
        lastActiveAtIST: nowIst.istFull,
        durationMs: 0,
        durationHuman: '0 min',
        topicsDiscussed: [],
        turnCount: 0,
        referencedEntities: [],
        unresolvedTopics: [],
      };
      this.data.sessions.push(sess);
    }

    sess.lastActiveAt = nowIst.iso;
    sess.lastActiveAtIST = nowIst.istFull;
    sess.durationMs = Math.max(0, new Date(sess.lastActiveAt).getTime() - new Date(sess.startedAt).getTime());
    const durationMin = Math.round(sess.durationMs / 60000);
    sess.durationHuman = durationMin < 1 ? '< 1 min' : `${durationMin} min`;
    sess.turnCount += 1;
    if (userName && !sess.userName) sess.userName = userName;

    // Update Madhurita World Awareness: Recent Visitors
    this.recordVisitor(identityId, sess.userName || 'Guest', nowIst.iso, nowIst.istFull);

    const ok = this.save();
    this.logMutation(identityId, 'touchSession', ok, `sessionId: ${sess.sessionId}`);

    return sess;
  }

  private recordVisitor(identityId: string, name: string, iso: string, istFull: string) {
    if (!this.data.worldAwareness) {
      this.data.worldAwareness = {
        lastSystemStartup: iso,
        lastSystemStartupIST: istFull,
        recentVisitors: [],
        recentInteractions: [],
        openLoops: [],
        milestones: [],
      };
    }
    const visitors = this.data.worldAwareness.recentVisitors || [];
    const existing = visitors.find((v) => v.identityId === identityId);
    if (existing) {
      existing.lastSeenISO = iso;
      existing.lastSeenIST = istFull;
      existing.sessionCount = (existing.sessionCount || 1) + 1;
      existing.name = name;
    } else {
      visitors.unshift({
        identityId,
        name,
        lastSeenISO: iso,
        lastSeenIST: istFull,
        sessionCount: 1,
      });
      if (visitors.length > 20) visitors.pop();
    }
    this.data.worldAwareness.recentVisitors = visitors;
  }

  public recordInteractionSummary(
    identityId: string,
    name: string,
    summary: string,
    sessionId: string
  ): void {
    if (!summary || !summary.trim()) return;
    const nowIst = getISTDateTime();
    if (!this.data.worldAwareness) {
      this.data.worldAwareness = {
        lastSystemStartup: nowIst.iso,
        lastSystemStartupIST: nowIst.istFull,
        recentVisitors: [],
        recentInteractions: [],
        openLoops: [],
        milestones: [],
      };
    }
    const interactions = this.data.worldAwareness.recentInteractions || [];
    interactions.unshift({
      identityId,
      name,
      summary: summary.trim(),
      timestampISO: nowIst.iso,
      timestampIST: nowIst.istFull,
      sessionId,
    });
    if (interactions.length > 30) interactions.pop();
    this.data.worldAwareness.recentInteractions = interactions;
    this.save();
  }

  public addSessionTopic(sessionId: string, topic: string): void {
    if (!topic || !this.data.sessions) return;
    const sess = this.data.sessions.find((s) => s.sessionId === sessionId);
    if (sess) {
      const cleanTopic = topic.trim();
      if (cleanTopic && !sess.topicsDiscussed.includes(cleanTopic)) {
        sess.topicsDiscussed.push(cleanTopic);
        this.save();
      }
    }
  }

  public getSessionsForIdentity(identityId: string): SessionMetadata[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    if (!this.data.sessions) return [];
    return this.data.sessions
      .filter((s) => s.identityId === identityId)
      .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
  }

  // --- Identity-Scoped Conversation Context with Rich Temporal Fields ---
  public getRecentTurns(identityId: string, limit = 10, sessionId?: string): ConversationTurn[] {
    if (!identityId) return [];
    let userTurns = this.data.conversations.filter((c) => c.identityId === identityId);
    
    // STRICT ISOLATION: Prevent cross-guest conversation leakage.
    // If the identity is UNKNOWN/Guest, ONLY return turns matching the CURRENT sessionId.
    if (identityId === 'UNKNOWN' || identityId === 'UNREGISTERED') {
      if (sessionId) {
        userTurns = userTurns.filter((c) => c.sessionId === sessionId);
      } else {
        return []; // Do not return other guests' turns if no session is provided
      }
    }
    
    return userTurns.slice(-limit);
  }

  public logTurn(
    identityId: string,
    role: ConversationTurn['role'],
    content: string,
    sessionId?: string,
    options?: {
      speaker?: string;
      topic?: string;
      referencedPeople?: string[];
      importantEvents?: string[];
      isResolved?: boolean;
    }
  ): ConversationTurn {
    const cleanContent = (content || '').trim();
    const nowIst = getISTDateTime();
    const turnId = `TURN_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const finalSessionId = sessionId || `SESSION_${nowIst.iso.slice(0, 10)}`;

    const identityTurns = this.data.conversations.filter((c) => c.identityId === identityId && c.sessionId === finalSessionId);
    const turnOrder = identityTurns.length + 1;

    let speakerName = options?.speaker;
    if (!speakerName) {
      if (role === 'assistant') {
        speakerName = 'Madhurita';
      } else if (identityId === 'OWNER_001') {
        speakerName = this.data.owner?.name || 'Ankit';
      } else {
        const user = this.getUserById(identityId);
        speakerName = user?.name || 'User';
      }
    }

    const sess = this.touchSession(identityId, finalSessionId, speakerName);

    const turn: ConversationTurn = {
      turnId,
      speaker: speakerName,
      identityId,
      role,
      content: cleanContent,
      timestamp: nowIst.iso,
      istDate: nowIst.istDate,
      istTime: nowIst.istTime,
      timestampIST: nowIst.istFull,
      sessionId: finalSessionId,
      turnOrder,
      sessionDuration: sess.durationHuman,
      topic: options?.topic,
      referencedPeople: options?.referencedPeople || [],
      importantEvents: options?.importantEvents || [],
      isResolved: options?.isResolved ?? true,
    };

    this.data.conversations.push(turn);

    // Keep history manageable (up to 1000 turns per identity for rich persistent continuity)
    const userTurns = this.data.conversations.filter((c) => c.identityId === identityId);
    if (userTurns.length > 1000) {
      const turnsToRemove = userTurns.slice(0, userTurns.length - 1000);
      const removeIds = new Set(turnsToRemove.map((t) => t.turnId));
      this.data.conversations = this.data.conversations.filter((c) => !removeIds.has(c.turnId));
    }
    const ok = this.save();
    if (!ok) {
      this.data.conversations = this.data.conversations.filter((c) => c.turnId !== turnId);
      console.error(`[DB ERROR] Failed to save conversation turn for identity ${identityId}`);
      throw new Error(`DATABASE_SAVE_FAILED: Failed to save conversation turn for identity ${identityId}`);
    }
    this.logMutation(identityId, 'logTurn', true, `${role}: ${cleanContent.slice(0, 40)}`);
    return turn;
  }

  public deleteSession(identityId: string, sessionId: string): boolean {
    if (!this.data.conversations && !this.data.sessions) return false;

    let convRemoved = false;
    if (this.data.conversations) {
      const initialConvLen = this.data.conversations.length;
      this.data.conversations = this.data.conversations.filter(
        (c) => !(c.identityId === identityId && (c.sessionId === sessionId || (!c.sessionId && sessionId === 'unknown')))
      );
      if (this.data.conversations.length !== initialConvLen) {
        convRemoved = true;
      }
    }

    let sessionRemoved = false;
    if (this.data.sessions) {
      const initialSessLen = this.data.sessions.length;
      this.data.sessions = this.data.sessions.filter(
        (s) => !(s.identityId === identityId && (s.sessionId === sessionId || (!s.sessionId && sessionId === 'unknown')))
      );
      if (this.data.sessions.length !== initialSessLen) {
        sessionRemoved = true;
      }
    }

    if (convRemoved || sessionRemoved) {
      this.logMutation(identityId, 'deleteSession', true, `sessionId: ${sessionId}`);
      const ok = this.save();
      if (!ok) {
        console.error(`[DB ERROR] Failed to save database after deleting session ${sessionId} for identity ${identityId}`);
        throw new Error(`DATABASE_SAVE_FAILED: Could not persist session deletion for ${sessionId}`);
      }
      return true;
    }
    return false;
  }

  public getRelevantTurns(
    identityId: string,
    currentQuery: string,
    excludeTurnIds: Set<string> = new Set(),
    limit = 8
  ): ConversationTurn[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    const userTurns = this.data.conversations.filter(
      (c) => c.identityId === identityId && !excludeTurnIds.has(c.turnId)
    );

    if (!currentQuery || !currentQuery.trim()) {
      return userTurns.slice(-limit);
    }

    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'in', 'to', 'for', 'of', 'with',
      'you', 'i', 'me', 'my', 'we', 'our', 'what', 'did', 'about', 'how', 'when', 'where', 'why',
      'can', 'will', 'do', 'does', 'tha', 'thi', 'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'se', 'me'
    ]);
    const keywords = currentQuery
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    if (keywords.length === 0) {
      return userTurns.slice(-limit);
    }

    const userSessions = this.getSessionsForIdentity(identityId);

    const scored = userTurns
      .map((turn) => {
        const textLower = turn.content.toLowerCase();
        let matchCount = 0;
        for (const kw of keywords) {
          if (textLower.includes(kw)) {
            matchCount += 2;
          }
        }

        // Topic matching boost
        if (turn.topic) {
          const topicLower = turn.topic.toLowerCase();
          for (const kw of keywords) {
            if (topicLower.includes(kw)) matchCount += 3;
          }
        }

        // Referenced people boost
        if (turn.referencedPeople && turn.referencedPeople.length > 0) {
          for (const p of turn.referencedPeople) {
            const pLower = p.toLowerCase();
            for (const kw of keywords) {
              if (pLower.includes(kw)) matchCount += 4;
            }
          }
        }

        // Session topic boost
        if (turn.sessionId) {
          const sess = userSessions.find((s) => s.sessionId === turn.sessionId);
          if (sess && sess.topicsDiscussed) {
            for (const topic of sess.topicsDiscussed) {
              const topicLower = topic.toLowerCase();
              for (const kw of keywords) {
                if (topicLower.includes(kw)) {
                  matchCount += 2;
                }
              }
            }
          }
        }

        return { turn, matchCount };
      })
      .filter((item) => item.matchCount > 0);

    if (scored.length === 0) {
      return userTurns.slice(-limit);
    }

    scored.sort(
      (a, b) =>
        b.matchCount - a.matchCount ||
        new Date(b.turn.timestamp).getTime() - new Date(a.turn.timestamp).getTime()
    );
    return scored.slice(0, limit).map((s) => s.turn);
  }

  public clearHistory(identityId: string): boolean {
    if (!identityId) return false;
    this.data.conversations = (this.data.conversations || []).filter((c) => c.identityId !== identityId);
    if (this.data.sessions) {
      this.data.sessions = this.data.sessions.filter((s) => s.identityId !== identityId);
    }
    if (this.data.requests) {
      this.data.requests = this.data.requests.filter((r) => r.identityId !== identityId);
    }
    if (this.data.worldAwareness && this.data.worldAwareness.recentInteractions) {
      this.data.worldAwareness.recentInteractions = this.data.worldAwareness.recentInteractions.filter((i) => i.identityId !== identityId);
    }
    this.logMutation(identityId, 'clearHistory', true);
    const ok = this.save();
    if (!ok) {
      console.error(`[DB ERROR] Failed to save database after clearing history for identity ${identityId}`);
      throw new Error(`DATABASE_SAVE_FAILED: Failed to save database after clearing history for ${identityId}`);
    }
    return true;
  }

  public getUserPreferences(identityId: string): Record<string, any> {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return {};
    if (identityId === 'OWNER_001' || (this.data.owner && identityId === this.data.owner.id)) {
      return this.data.owner?.preferences || {};
    }
    const user = this.data.users.find((u) => u.id === identityId);
    return user?.preferences || {};
  }

  public updateUserPreference(identityId: string, key: string, value: any): Record<string, any> {
    let result: Record<string, any> = {};
    if (identityId === 'OWNER_001' || (this.data.owner && identityId === this.data.owner.id)) {
      if (this.data.owner) {
        if (!this.data.owner.preferences) this.data.owner.preferences = {};
        this.data.owner.preferences[key] = value;
        this.data.owner.updatedAt = new Date().toISOString();
        this.save();
        result = this.data.owner.preferences;
      }
    } else {
      const user = this.data.users.find((u) => u.id === identityId);
      if (user) {
        if (!user.preferences) user.preferences = {};
        user.preferences[key] = value;
        user.updatedAt = new Date().toISOString();
        this.save();
        result = user.preferences;
      }
    }
    this.logMutation(identityId, `updateUserPreference:${key}`, true);
    return result;
  }

  public setAddressingPreference(identityId: string, title: string): boolean {
    if (!identityId || identityId === 'UNKNOWN' || !title) return false;
    const cleanTitle = title.trim();
    const prefs = this.getUserPreferences(identityId);
    const addressing = prefs.addressing || {};
    addressing.preferredTitle = cleanTitle;
    this.updateUserPreference(identityId, 'addressing', addressing);
    this.updateUserPreference(identityId, 'preferredTitle', cleanTitle);

    this.logMutation(identityId, 'setAddressingPreference', true);
    return true;
  }

  /**
   * Authoritative Identity Resolution Engine:
   * 1. Exact match for Owner ('ankit', 'owner', or Owner's name)
   * 2. Exact match for registered user names
   * 3. First-name resolution with Ambiguity Detection:
   *    - If exactly one user has first name 'Govind' -> resolves to 'Govind Singh'.
   *    - If multiple users match -> returns ambiguous result with candidates list.
   *    - If no users match -> returns null (remains UNKNOWN / UNREGISTERED).
   * 4. NEVER creates a user profile automatically!
   */
  public resolveIdentityByName(
    nameOrPronoun: string
  ): { id: string; name: string; role: 'owner' | 'user'; ambiguous?: boolean; candidates?: string[] } | null {
    if (!nameOrPronoun || !nameOrPronoun.trim()) return null;
    const clean = nameOrPronoun.trim().toLowerCase();

    // 1. Owner check
    if (this.data.owner) {
      const ownerNameLower = this.data.owner.name.trim().toLowerCase();
      if (clean === 'ankit' || clean === 'owner' || clean === ownerNameLower || clean.startsWith('ankit ')) {
        return { id: this.data.owner.id, name: this.data.owner.name, role: 'owner' };
      }
    }

    // 2. Exact full-name match in registered users
    for (const u of this.data.users) {
      if (u.name.trim().toLowerCase() === clean) {
        return { id: u.id, name: u.name, role: 'user' };
      }
    }

    // 3. First name / single token search
    const matchingUsers = this.data.users.filter((u) => {
      const nameParts = u.name.trim().toLowerCase().split(/\s+/);
      return nameParts[0] === clean || u.name.trim().toLowerCase().startsWith(clean + ' ');
    });

    if (matchingUsers.length === 1) {
      return { id: matchingUsers[0].id, name: matchingUsers[0].name, role: 'user' };
    } else if (matchingUsers.length > 1) {
      // Ambiguous: multiple people share the same first name
      return {
        id: '',
        name: nameOrPronoun.trim(),
        role: 'user',
        ambiguous: true,
        candidates: matchingUsers.map((u) => u.name),
      };
    }

    return null;
  }

  // --- Entity Relationships ---
  public getRelationshipsForEntity(entityIdOrName: string): EntityRelationship[] {
    if (!this.data.relationships) return [];
    const clean = entityIdOrName.trim().toLowerCase();
    return this.data.relationships.filter(
      (r) =>
        r.sourceEntity.toLowerCase() === clean ||
        r.targetEntity.toLowerCase() === clean
    );
  }

  public addRelationship(
    sourceEntity: string,
    targetEntity: string,
    relationshipType: string,
    description: string,
    confidence = 0.9
  ): EntityRelationship | null {
    if (!sourceEntity || !targetEntity || !relationshipType) return null;
    if (!this.data.relationships) this.data.relationships = [];
    const nowIst = getISTDateTime();

    const existing = this.data.relationships.find(
      (r) =>
        r.sourceEntity.toLowerCase() === sourceEntity.toLowerCase() &&
        r.targetEntity.toLowerCase() === targetEntity.toLowerCase() &&
        r.relationshipType.toLowerCase() === relationshipType.toLowerCase()
    );

    if (existing) {
      existing.description = description;
      existing.confidence = confidence;
      existing.updatedAt = nowIst.iso;
      this.save();
      return existing;
    }

    const rel: EntityRelationship = {
      id: `REL_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      sourceEntity,
      targetEntity,
      relationshipType,
      description,
      confidence,
      createdAt: nowIst.iso,
      createdAtIST: nowIst.istFull,
      updatedAt: nowIst.iso,
    };
    this.data.relationships.push(rel);
    this.save();
    return rel;
  }

  // --- Task & Unfinished Work Tracking ---
  public getTasksForIdentity(identityId: string): TaskItem[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    if (!this.data.tasks) return [];
    return this.data.tasks
      .filter((t) => t.identityId === identityId)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
  }

  public getActiveUnfinishedTaskForIdentity(identityId: string): TaskItem | null {
    const tasks = this.getTasksForIdentity(identityId);
    return tasks.find((t) => t.status === 'in_progress' || t.status === 'paused') || null;
  }

  public addOrUpdateTask(
    identityId: string,
    title: string,
    description?: string,
    status: TaskItem['status'] = 'in_progress'
  ): TaskItem | null {
    if (!identityId || !title.trim()) return null;
    if (!this.data.tasks) this.data.tasks = [];

    const cleanTitle = title.trim();
    const existing = this.data.tasks.find(
      (t) => t.identityId === identityId && t.title.toLowerCase() === cleanTitle.toLowerCase()
    );

    const now = new Date().toISOString();
    if (existing) {
      existing.status = status;
      if (description !== undefined) existing.description = description;
      existing.updatedAt = now;
      this.save();
      return existing;
    }

    const newTask: TaskItem = {
      id: `TASK_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      identityId,
      title: cleanTitle,
      description,
      status,
      createdAt: now,
      updatedAt: now,
    };

    this.data.tasks.push(newTask);
    this.save();
    return newTask;
  }

  public updateTaskStatus(identityId: string, taskId: string, status: TaskItem['status']): boolean {
    if (!this.data.tasks) return false;
    const task = this.data.tasks.find((t) => t.id === taskId && (t.identityId === identityId || identityId === 'OWNER_001'));
    if (task) {
      task.status = status;
      task.updatedAt = new Date().toISOString();
      return this.save();
    }
    return false;
  }

  public deleteTask(identityId: string, taskId: string): boolean {
    if (!this.data.tasks) return false;
    const idx = this.data.tasks.findIndex((t) => t.id === taskId && (t.identityId === identityId || identityId === 'OWNER_001'));
    if (idx !== -1) {
      this.data.tasks.splice(idx, 1);
      return this.save();
    }
    return false;
  }

  // --- Cross-User Communication & Information Storage ---
  public addCrossUserNote(
    senderId: string,
    senderName: string,
    content: string,
    targetName?: string,
    targetId?: string,
    sourceSession?: string
  ): CrossUserNote | null {
    if (!content.trim()) return null;
    if (!this.data.crossUserNotes) this.data.crossUserNotes = [];

    // Attempt to resolve targetId if not passed
    let resolvedTargetId = targetId;
    if (!resolvedTargetId && targetName) {
      const resolved = this.resolveIdentityByName(targetName);
      if (resolved && !resolved.ambiguous) resolvedTargetId = resolved.id;
    }

    const nowIst = getISTDateTime();
    const noteId = `NOTE_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const note: CrossUserNote = {
      noteId,
      senderId,
      senderName,
      targetId: resolvedTargetId,
      targetName,
      content: content.trim(),
      createdAt: nowIst.iso,
      createdAtIST: nowIst.istFull,
      sourceSession,
      delivered: false,
    };

    this.data.crossUserNotes.push(note);
    this.save();
    return note;
  }

  public editCrossUserNote(identityId: string, noteId: string, newContent: string): boolean {
    if (!this.data.crossUserNotes) return false;
    const note = this.data.crossUserNotes.find((n) => n.noteId === noteId);
    if (!note) return false;
    if (note.senderId !== identityId && identityId !== 'OWNER_001') return false;
    note.content = newContent;
    this.save();
    return true;
  }

  public deleteCrossUserNote(identityId: string, noteId: string): boolean {
    if (!this.data.crossUserNotes) return false;
    const idx = this.data.crossUserNotes.findIndex((n) => n.noteId === noteId);
    if (idx === -1) return false;
    const note = this.data.crossUserNotes[idx];
    if (note.senderId !== identityId && identityId !== 'OWNER_001') return false;
    this.data.crossUserNotes.splice(idx, 1);
    this.save();
    return true;
  }

  public getNotesForTarget(targetId: string, targetName?: string): CrossUserNote[] {
    if (!targetId || targetId === 'UNKNOWN' || targetId === 'UNREGISTERED' || targetId === 'GUEST') return [];
    if (!this.data.crossUserNotes) return [];
    const cleanTargetName = targetName?.trim().toLowerCase();

    return this.data.crossUserNotes.filter((n) => {
      if (n.targetId && n.targetId === targetId) return true;
      if (cleanTargetName && n.targetName && n.targetName.trim().toLowerCase() === cleanTargetName) return true;
      if (targetId === 'OWNER_001' && (n.targetName?.toLowerCase() === 'ankit' || n.targetName?.toLowerCase() === 'owner')) return true;
      return false;
    });
  }

  public getPendingNotesForTarget(targetId: string, targetName?: string): CrossUserNote[] {
    if (!targetId || targetId === 'UNKNOWN' || targetId === 'UNREGISTERED' || targetId === 'GUEST') return [];
    if (!this.data.crossUserNotes) return [];
    const cleanTargetName = targetName?.trim().toLowerCase();

    return this.data.crossUserNotes.filter((n) => {
      if (n.delivered) return false;
      if (n.targetId && n.targetId === targetId) return true;
      if (cleanTargetName && n.targetName && n.targetName.trim().toLowerCase() === cleanTargetName) return true;
      if (targetId === 'OWNER_001' && (n.targetName?.toLowerCase() === 'ankit' || n.targetName?.toLowerCase() === 'owner')) return true;
      return false;
    });
  }

  public markNotesDelivered(noteIds: string[]): boolean {
    if (!this.data.crossUserNotes || noteIds.length === 0) return false;
    const idSet = new Set(noteIds);
    let updated = false;
    const nowIst = getISTDateTime();

    for (const note of this.data.crossUserNotes) {
      if (idSet.has(note.noteId) && !note.delivered) {
        note.delivered = true;
        note.deliveredAt = nowIst.iso;
        note.deliveredAtIST = nowIst.istFull;
        updated = true;
      }
    }

    if (updated) {
      this.save();
    }
    return updated;
  }

  // --- Proactive Events & Anti-Spam Tracking ---
  public recordProactiveEvent(
    category: ProactiveEventRecord['category'],
    relevanceTarget: string,
    summary: string,
    payload?: any
  ): ProactiveEventRecord {
    if (!this.data.proactiveEvents) this.data.proactiveEvents = [];
    const nowIst = getISTDateTime();
    const eventId = `EVT_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const record: ProactiveEventRecord = {
      eventId,
      createdAt: nowIst.iso,
      createdAtIST: nowIst.istFull,
      category,
      relevanceTarget,
      summary: summary.trim(),
      payload,
      deliveredTo: [],
      status: 'NEW',
    };
    this.data.proactiveEvents.unshift(record);
    if (this.data.proactiveEvents.length > 100) this.data.proactiveEvents.pop();
    this.save();
    return record;
  }

  public getUndeliveredProactiveEvents(identityId: string): ProactiveEventRecord[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    if (!this.data.proactiveEvents) return [];
    return this.data.proactiveEvents.filter((e) => {
      if (e.status === 'EXPIRED' || e.status === 'SUPERSEDED') return false;
      const isTarget = e.relevanceTarget === 'ALL' || e.relevanceTarget === identityId || (identityId === 'OWNER_001' && e.relevanceTarget.startsWith('OWNER'));
      if (!isTarget) return false;
      const alreadyDelivered = (e.deliveredTo || []).includes(identityId);
      return !alreadyDelivered;
    });
  }

  public markProactiveEventDelivered(eventId: string, identityId: string): boolean {
    if (!this.data.proactiveEvents) return false;
    const evt = this.data.proactiveEvents.find((e) => e.eventId === eventId);
    if (evt) {
      if (!evt.deliveredTo) evt.deliveredTo = [];
      if (!evt.deliveredTo.includes(identityId)) {
        evt.deliveredTo.push(identityId);
        const nowIst = getISTDateTime();
        evt.deliveredAt = nowIst.iso;
        evt.deliveredAtIST = nowIst.istFull;
        evt.status = 'DELIVERED';
        this.save();
        return true;
      }
    }
    return false;
  }

  public markProactiveEventsDelivered(eventIds: string[], identityId: string): boolean {
    if (!this.data.proactiveEvents || eventIds.length === 0) return false;
    let anyUpdated = false;
    const nowIst = getISTDateTime();
    for (const eid of eventIds) {
      const evt = this.data.proactiveEvents.find((e) => e.eventId === eid);
      if (evt) {
        if (!evt.deliveredTo) evt.deliveredTo = [];
        if (!evt.deliveredTo.includes(identityId)) {
          evt.deliveredTo.push(identityId);
          evt.deliveredAt = nowIst.iso;
          evt.deliveredAtIST = nowIst.istFull;
          evt.status = 'DELIVERED';
          anyUpdated = true;
        }
      }
    }
    if (anyUpdated) this.save();
    return anyUpdated;
  }

  // --- Request Lifecycle Management ---
  public addRequest(
    identityId: string,
    sessionId: string,
    query: string,
    status: RequestLifecycleItem['status'] = 'REQUESTED'
  ): RequestLifecycleItem {
    if (!this.data.requests) this.data.requests = [];
    const nowIst = getISTDateTime();
    const requestId = `REQ_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const req: RequestLifecycleItem = {
      requestId,
      identityId,
      sessionId,
      query: query.trim(),
      status,
      createdAtIST: nowIst.istFull,
      updatedAtIST: nowIst.istFull,
    };
    this.data.requests.unshift(req);
    if (this.data.requests.length > 200) this.data.requests.pop();
    this.save();
    return req;
  }

  public updateRequestStatus(
    requestId: string,
    status: RequestLifecycleItem['status'],
    resolutionNotes?: string
  ): boolean {
    if (!this.data.requests) return false;
    const req = this.data.requests.find((r) => r.requestId === requestId);
    if (req) {
      req.status = status;
      req.updatedAtIST = getISTDateTime().istFull;
      if (resolutionNotes) req.resolutionNotes = resolutionNotes;
      this.save();
      return true;
    }
    return false;
  }

  public getUnresolvedRequests(identityId: string): RequestLifecycleItem[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    if (!this.data.requests) return [];
    return this.data.requests.filter(
      (r) => r.identityId === identityId && (r.status === 'REQUESTED' || r.status === 'PARTIALLY_ANSWERED' || r.status === 'UNRESOLVED')
    );
  }

  // --- Explicit Commitments Management ---
  public addCommitment(
    identityId: string,
    who: string,
    what: string,
    when?: string,
    dueAtIST?: string,
    evidenceTurnId?: string
  ): ExplicitCommitment {
    if (!this.data.commitments) this.data.commitments = [];
    const nowIst = getISTDateTime();
    const commitmentId = `COM_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const com: ExplicitCommitment = {
      commitmentId,
      identityId,
      who: who.trim(),
      what: what.trim(),
      when: when?.trim(),
      status: 'active',
      createdAtIST: nowIst.istFull,
      dueAtIST,
      evidenceTurnId,
    };
    this.data.commitments.unshift(com);
    if (this.data.commitments.length > 100) this.data.commitments.pop();
    this.save();
    return com;
  }

  public updateCommitmentStatus(
    commitmentId: string,
    status: ExplicitCommitment['status']
  ): boolean {
    if (!this.data.commitments) return false;
    const com = this.data.commitments.find((c) => c.commitmentId === commitmentId);
    if (com) {
      com.status = status;
      this.save();
      return true;
    }
    return false;
  }

  public getActiveCommitments(identityId: string): ExplicitCommitment[] {
    if (!identityId || identityId === 'UNKNOWN' || identityId === 'UNREGISTERED' || identityId === 'GUEST') return [];
    if (!this.data.commitments) return [];
    return this.data.commitments.filter((c) => c.identityId === identityId && c.status === 'active');
  }

  public getAllCrossUserNotesForOwner(): CrossUserNote[] {
    if (!this.data.crossUserNotes) return [];
    return [...this.data.crossUserNotes].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  public getInteractionTimeline(
    targetNameOrId: string,
    callerRole: 'owner' | 'user' | 'unknown',
    callerId: string
  ): {
    success: boolean;
    targetIdentity?: { id: string; name: string; role: string };
    lastActiveISO?: string;
    lastActiveIST?: string;
    elapsedHuman?: string;
    totalSessions?: number;
    totalTurns?: number;
    topicsDiscussed?: string[];
    recentTurns?: Array<{ role: string; content: string; timestampIST: string }>;
    error?: string;
  } {
    let target = this.resolveIdentityByName(targetNameOrId);
    if (!target && (targetNameOrId === 'OWNER_001' || targetNameOrId.startsWith('USER_'))) {
      if (targetNameOrId === 'OWNER_001' && this.data.owner) {
        target = { id: this.data.owner.id, name: this.data.owner.name, role: 'owner' };
      } else {
        const u = this.getUserById(targetNameOrId);
        if (u) target = { id: u.id, name: u.name, role: 'user' };
      }
    }

    if (!target) {
      return { success: false, error: `No registered profile or record found matching "${targetNameOrId}".` };
    }

    // Authorization check: Normal users can only query their own interaction history
    if (callerRole !== 'owner' && target.id !== callerId) {
      return { success: false, error: `Access denied. Normal users can only view their own interaction history.` };
    }

    const sessions = this.getSessionsForIdentity(target.id);
    const turns = this.getRecentTurns(target.id, 15);

    let elapsedHuman = 'No recorded interactions';
    let lastActiveISO = undefined;
    let lastActiveIST = undefined;

    if (turns.length > 0) {
      const lastTurn = turns[turns.length - 1];
      lastActiveISO = lastTurn.timestamp;
      lastActiveIST = lastTurn.timestampIST || new Date(lastTurn.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const now = new Date();
      const diffMs = Math.max(0, now.getTime() - new Date(lastTurn.timestamp).getTime());
      const diffMin = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMin / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffMin < 1) elapsedHuman = 'just now';
      else if (diffMin < 60) elapsedHuman = `${diffMin} minute(s) ago`;
      else if (diffHours < 24) elapsedHuman = `${diffHours} hour(s) ago`;
      else elapsedHuman = `${diffDays} day(s) ago (${lastActiveIST})`;
    }

    const topics = Array.from(new Set(sessions.flatMap((s) => s.topicsDiscussed || [])));

    return {
      success: true,
      targetIdentity: target,
      lastActiveISO,
      lastActiveIST,
      elapsedHuman,
      totalSessions: sessions.length,
      totalTurns: turns.length,
      topicsDiscussed: topics,
      recentTurns: turns.map((t) => ({ role: t.role, content: t.content, timestampIST: t.timestampIST || t.timestamp })),
    };
  }

  // --- Persona & Voice Configuration (Authoritative System & Per-Identity) ---
  public getPersonaVoiceConfig(identityId?: string): PersonaAndVoiceConfig {
    let prefs: Partial<PersonaAndVoiceConfig> | undefined;
    const ownerId = this.data.owner?.id || 'OWNER_001';
    if (identityId === 'OWNER_001' || identityId === ownerId) {
      prefs = this.data.owner?.preferences?.personaAndVoice;
    } else if (identityId && identityId !== 'UNKNOWN' && identityId !== 'UNREGISTERED') {
      const user = this.getUserById(identityId);
      prefs = user?.preferences?.personaAndVoice;
    }

    const baseConfig = this.data.systemVoiceConfig || DEFAULT_PERSONA_VOICE_CONFIG;
    const merged: PersonaAndVoiceConfig = {
      ...DEFAULT_PERSONA_VOICE_CONFIG,
      ...baseConfig,
      ...(prefs || {}),
    };

    // STRICT FEMALE VOICE SANITIZATION: Never fall back to or allow a male voice
    if (!VALID_FEMALE_VOICES.includes(merged.voiceName)) {
      merged.voiceName = 'Callirrhoe';
    }

    return merged;
  }

  public updatePersonaVoiceConfig(identityId: string, config: Partial<PersonaAndVoiceConfig>): PersonaAndVoiceConfig {
    // Validate voiceName if provided: Must be a supported female voice
    if (config.voiceName) {
      const rawName = String(config.voiceName).trim();
      const normalizedMatch = VALID_FEMALE_VOICES.find(
        (v) => v.toLowerCase() === rawName.toLowerCase()
      );

      if (!normalizedMatch) {
        throw new Error(
          `MALE_VOICE_PROHIBITED: All Madhurita voice profiles must use female voices (${VALID_FEMALE_VOICES.join(', ')}). '${config.voiceName}' is not a permitted voice.`
        );
      }
      config.voiceName = normalizedMatch;
    }

    let target: OwnerProfile | UserProfile | null = null;
    const ownerId = this.data.owner?.id || 'OWNER_001';
    if (identityId === 'OWNER_001' || identityId === ownerId) {
      target = this.data.owner;
    } else if (identityId && identityId !== 'UNKNOWN' && identityId !== 'UNREGISTERED') {
      target = this.getUserById(identityId);
    }

    const current = this.getPersonaVoiceConfig(identityId);
    const updated: PersonaAndVoiceConfig = { ...current, ...config };

    // Ensure persistent system-wide voice configuration
    this.data.systemVoiceConfig = updated;

    if (target) {
      if (!target.preferences) target.preferences = {};
      target.preferences.personaAndVoice = updated;
      target.updatedAt = new Date().toISOString();
    }

    this.save();
    return updated;
  }

  // --- Location / Home Context ---
  public getLocationConfig(): SystemLocationConfig {
    return { ...HOME_LOCATION_CONFIG };
  }

  // --- Grouped Memory Overview (Owner-Exclusive) ---
  public getAllMemoriesGrouped(): Array<{
    user: { id: string; name: string; role: 'owner' | 'user' };
    memories: MemoryRecord[];
    count: number;
  }> {
    const groups: Array<{
      user: { id: string; name: string; role: 'owner' | 'user' };
      memories: MemoryRecord[];
      count: number;
    }> = [];

    // 1. Owner memories
    if (this.data.owner) {
      const ownerMemories = this.getMemoriesForIdentity(this.data.owner.id);
      groups.push({
        user: { id: this.data.owner.id, name: this.data.owner.name, role: 'owner' },
        memories: ownerMemories,
        count: ownerMemories.length,
      });
    }

    // 2. All Registered User memories
    for (const user of this.data.users) {
      const userMemories = this.getMemoriesForIdentity(user.id);
      groups.push({
        user: { id: user.id, name: user.name, role: 'user' },
        memories: userMemories,
        count: userMemories.length,
      });
    }

    return groups;
  }

  // --- Grouped Conversation Overview (Owner-Exclusive) ---
  public getAllConversationsGrouped(): Array<{
    user: { id: string; name: string; role: 'owner' | 'user' };
    turns: ConversationTurn[];
    count: number;
  }> {
    const groups: Array<{
      user: { id: string; name: string; role: 'owner' | 'user' };
      turns: ConversationTurn[];
      count: number;
    }> = [];

    if (this.data.owner) {
      const ownerTurns = this.getRecentTurns(this.data.owner.id, 50);
      groups.push({
        user: { id: this.data.owner.id, name: this.data.owner.name, role: 'owner' },
        turns: ownerTurns,
        count: ownerTurns.length,
      });
    }

    for (const user of this.data.users) {
      const userTurns = this.getRecentTurns(user.id, 50);
      groups.push({
        user: { id: user.id, name: user.name, role: 'user' },
        turns: userTurns,
        count: userTurns.length,
      });
    }

    return groups;
  }

  // --- Grouped Patterns Overview (Owner-Exclusive) ---
  public getAllPatternsGrouped(): Array<{
    user: { id: string; name: string; role: 'owner' | 'user' };
    patterns: LearnedPattern[];
    count: number;
  }> {
    const groups: Array<{
      user: { id: string; name: string; role: 'owner' | 'user' };
      patterns: LearnedPattern[];
      count: number;
    }> = [];

    if (this.data.owner) {
      const ownerPatterns = this.getPatternsForIdentity(this.data.owner.id);
      groups.push({
        user: { id: this.data.owner.id, name: this.data.owner.name, role: 'owner' },
        patterns: ownerPatterns,
        count: ownerPatterns.length,
      });
    }

    for (const user of this.data.users) {
      const userPatterns = this.getPatternsForIdentity(user.id);
      groups.push({
        user: { id: user.id, name: user.name, role: 'user' },
        patterns: userPatterns,
        count: userPatterns.length,
      });
    }

    return groups;
  }

  // --- Madhurita World Awareness & System State ---
  public getWorldAwareness(): MadhuritaWorldAwareness {
    if (!this.data.worldAwareness) {
      const nowIst = getISTDateTime();
      this.data.worldAwareness = {
        lastSystemStartup: nowIst.iso,
        lastSystemStartupIST: nowIst.istFull,
        recentVisitors: [],
        recentInteractions: [],
        openLoops: [],
        milestones: [],
      };
    }
    return this.data.worldAwareness;
  }

  public getRecentVisitors(limit = 10) {
    const wa = this.getWorldAwareness();
    return (wa.recentVisitors || []).slice(0, limit);
  }

  public getRecentInteractions(limit = 15) {
    const wa = this.getWorldAwareness();
    return (wa.recentInteractions || []).slice(0, limit);
  }

  public getOpenLoops(identityId?: string, includeResolved = true): OpenLoopItem[] {
    const wa = this.getWorldAwareness();
    let loops = wa.openLoops || [];
    if (identityId && identityId !== 'ALL' && identityId !== 'UNKNOWN') {
      loops = loops.filter((l) => l.identityId === identityId);
    }
    if (!includeResolved) {
      loops = loops.filter((l) => l.status === 'open');
    }
    return [...loops].sort((a, b) => {
      const timeA = new Date(a.createdAtISO || 0).getTime();
      const timeB = new Date(b.createdAtISO || 0).getTime();
      return timeB - timeA;
    });
  }

  public addOpenLoop(name: string, description: string, identityId: string = 'UNKNOWN'): OpenLoopItem {
    const wa = this.getWorldAwareness();
    if (!wa.openLoops) wa.openLoops = [];
    const nowIst = getISTDateTime();
    const id = `LOOP_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const loop: OpenLoopItem = {
      id,
      identityId,
      name: name.trim(),
      description: description.trim(),
      createdAtIST: nowIst.istFull,
      createdAtISO: nowIst.iso,
      status: 'open',
    };
    wa.openLoops.unshift(loop);
    this.save();
    return loop;
  }

  public resolveOpenLoop(loopId: string): boolean {
    const wa = this.getWorldAwareness();
    if (!wa.openLoops) return false;
    const loop = wa.openLoops.find((l) => l.id === loopId);
    if (loop && loop.status === 'open') {
      const nowIst = getISTDateTime();
      loop.status = 'resolved';
      loop.resolvedAtISO = nowIst.iso;
      loop.resolvedAtIST = nowIst.istFull;
      this.save();
      return true;
    }
    return false;
  }

  public reopenOpenLoop(loopId: string): boolean {
    const wa = this.getWorldAwareness();
    if (!wa.openLoops) return false;
    const loop = wa.openLoops.find((l) => l.id === loopId);
    if (loop && loop.status === 'resolved') {
      loop.status = 'open';
      loop.resolvedAtISO = undefined;
      loop.resolvedAtIST = undefined;
      this.save();
      return true;
    }
    return false;
  }

  public deleteOpenLoop(loopId: string): boolean {
    const wa = this.getWorldAwareness();
    if (!wa.openLoops) return false;
    const initialLen = wa.openLoops.length;
    wa.openLoops = wa.openLoops.filter((l) => l.id !== loopId);
    if (wa.openLoops.length !== initialLen) {
      this.save();
      return true;
    }
    return false;
  }

  public updateOpenLoop(loopId: string, updates: { name?: string; description?: string; status?: 'open' | 'resolved' }): boolean {
    const wa = this.getWorldAwareness();
    if (!wa.openLoops) return false;
    const loop = wa.openLoops.find((l) => l.id === loopId);
    if (!loop) return false;
    if (updates.name !== undefined) loop.name = updates.name.trim();
    if (updates.description !== undefined) loop.description = updates.description.trim();
    if (updates.status !== undefined && updates.status !== loop.status) {
      if (updates.status === 'resolved') {
        const nowIst = getISTDateTime();
        loop.status = 'resolved';
        loop.resolvedAtISO = nowIst.iso;
        loop.resolvedAtIST = nowIst.istFull;
      } else {
        loop.status = 'open';
        loop.resolvedAtISO = undefined;
        loop.resolvedAtIST = undefined;
      }
    }
    this.save();
    return true;
  }

  public recordMilestone(description: string, identityId?: string) {
    const wa = this.getWorldAwareness();
    if (!wa.milestones) wa.milestones = [];
    const nowIst = getISTDateTime();
    const milestone = {
      id: `MILE_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      description: description.trim(),
      timestampIST: nowIst.istFull,
      identityId,
    };
    wa.milestones.unshift(milestone);
    if (wa.milestones.length > 50) wa.milestones.pop();
    this.save();
    return milestone;
  }

  /**
   * Generates a structured operational summary for the Owner:
   * 1. Recent visitors & when they interacted
   * 2. Pending cross-user notes
   * 3. Open loops & tasks
   * 4. System uptime & recent interactions
   */
  public getSystemAwarenessBriefingForOwner(): {
    summary: string;
    totalRegisteredUsers: number;
    recentVisitors: Array<{ name: string; lastSeenIST: string; sessionCount: number; topicsDiscussed?: string[] }>;
    pendingNotesCount: number;
    pendingNotes: CrossUserNote[];
    openLoopsCount: number;
    openLoops: OpenLoopItem[];
    activeTasks: TaskItem[];
    lastInteractions: Array<{ name: string; summary: string; timestampIST: string }>;
  } {
    const wa = this.getWorldAwareness();
    const pendingNotes = this.getPendingNotesForTarget('OWNER_001');
    const openLoops = (wa.openLoops || []).filter((l) => l.status === 'open');
    const activeTasks = (this.data.tasks || []).filter((t) => t.status === 'in_progress' || t.status === 'paused');
    const lastInteractions = (wa.recentInteractions || []).slice(0, 5);
    
    const users = this.getUsers();
    const recentVisitors = [];
    for (const u of users) {
      const timeline = this.getInteractionTimeline(u.id, 'owner', 'OWNER_001');
      if (timeline && timeline.success && timeline.totalSessions && timeline.totalSessions > 0) {
        recentVisitors.push({
          name: u.name,
          lastSeenIST: timeline.lastActiveIST || 'Unknown',
          sessionCount: timeline.totalSessions,
          topicsDiscussed: timeline.topicsDiscussed,
        });
      }
    }
    
    recentVisitors.sort((a, b) => new Date(b.lastSeenIST).getTime() - new Date(a.lastSeenIST).getTime());

    return {
      summary: "System Operational Briefing",
      totalRegisteredUsers: users.length,
      recentVisitors: recentVisitors.slice(0, 10),
      pendingNotesCount: pendingNotes.length,
      pendingNotes,
      openLoopsCount: openLoops.length,
      openLoops,
      activeTasks,
      lastInteractions,
    };
  }

  // --- Persistence & Backup Operations ---
  public getRawData(): DatabaseSchema {
    if (!fs.existsSync(DB_FILE)) {
      this.save();
    }
    return JSON.parse(JSON.stringify(this.data));
  }

  public backupSnapshot(): DatabaseSchema {
    return JSON.parse(JSON.stringify(this.data));
  }

  public restoreRawData(newData: DatabaseSchema): boolean {
    if (!newData) return false;
    this.data = JSON.parse(JSON.stringify(newData));
    return this.save();
  }

  public reloadFromDisk(): boolean {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf-8');
        this.data = JSON.parse(raw);
        this.isLoaded = true;
        return true;
      } else {
        this.save();
        this.isLoaded = true;
        return true;
      }
    } catch (err) {
      console.error('DATABASE_RELOAD_FAILED', err);
      return false;
    }
  }
}

export const db = new DatabaseEngine();
