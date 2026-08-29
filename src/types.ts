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

export interface PersonaAndVoiceConfig {
  speakingStyle: 'warm_conversational' | 'expressive_witty' | 'calm_thoughtful' | 'concise_direct';
  tone: 'friendly_warm' | 'energetic_witty' | 'poised_professional' | 'playful_charming';
  formality: 'casual' | 'balanced' | 'formal';
  preferredLanguage: 'Hinglish' | 'English' | 'Hindi';
  hinglishBehavior: 'natural_mix' | 'light_conversational' | 'strict_english';
  voiceName: 'Aoede' | 'Kore' | 'Puck' | 'Charon' | 'Fenrir';
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
  precipitation?: number;
  condition?: string;
  time?: string;
  timezone?: string;
  error?: string;
}

export interface SystemStatus {
  status: string;
  hasOwner: boolean;
  ownerName: string | null;
  registeredUserCount: number;
  users: Array<{ id: string; name: string; createdAt: string }>;
  systemTime?: string;
}
