export type LiveState = 'disconnected' | 'connecting' | 'listening' | 'speaking';

export interface Identity {
  id: string;
  name: string;
  role: 'owner' | 'user' | 'unknown';
}

export interface MemoryItem {
  memoryId: string;
  ownerId: string;
  content: string;
  category: 'preference' | 'fact' | 'project' | 'goal' | 'personal';
  confidence?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface ToolActionItem {
  id: string;
  tool: string;
  data: any;
  timestamp: number;
}

export type FemaleVoiceName = 'Callirrhoe' | 'Aoede' | 'Kore' | 'Leda' | 'Despina';

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

export interface GroupedMemory {
  user: { id: string; name: string; role: 'owner' | 'user' };
  memories: MemoryItem[];
  count: number;
}

export interface ConversationTurnItem {
  turnId: string;
  identityId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface GroupedConversation {
  user: { id: string; name: string; role: 'owner' | 'user' };
  turns: ConversationTurnItem[];
  count: number;
}

export interface LearnedPatternItem {
  id: string;
  identityId: string;
  category: 'habit' | 'routine' | 'preference' | 'plan' | 'pattern';
  description: string;
  confidence?: number;
  evidenceCount?: number;
  lastObservedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface GroupedPattern {
  user: { id: string; name: string; role: 'owner' | 'user' };
  patterns: LearnedPatternItem[];
  count: number;
}

export interface WeatherData {
  available: boolean;
  location: string;
  temperature?: number;
  feelsLike?: number;
  humidity?: number;
  windSpeed?: number;
  sunrise?: string;
  sunset?: string;
  sunriseIso?: string;
  sunsetIso?: string;
  aqi?: number;
  aqiLabel?: string;
  hourly?: Array<{ time: string; temp: number; condition: string }>;
  precipitation?: number;
  condition?: string;
  description?: string;
  time?: string;
  timezone?: string;
  error?: string;
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

export interface OpenLoopItem {
  id: string;
  identityId: string;
  name: string;
  description: string;
  createdAtIST: string;
  status: 'open' | 'resolved';
}

export interface CrossUserNote {
  noteId: string;
  senderId: string;
  senderName: string;
  targetId?: string;
  targetName?: string;
  content: string;
  createdAt: string;
  createdAtIST: string;
  delivered: boolean;
  deliveredAt?: string;
  deliveredAtIST?: string;
}

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
  relevantMemory: MemoryItem[];
  recentConversation: ConversationTurnItem[];
  lastInteraction: string | null;
  currentTime: {
    iso: string;
    istDate: string;
    istTime: string;
    istFull: string;
  };
  voiceConfig?: PersonaAndVoiceConfig;
}

export interface SystemStatus {
  status: string;
  hasOwner: boolean;
  ownerName: string | null;
  registeredUserCount: number;
  users: Array<{ id: string; name: string; createdAt: string }>;
  systemTime?: string;
}
