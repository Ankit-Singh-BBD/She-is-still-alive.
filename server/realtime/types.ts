import type { Identity } from '../identity/types.js';
import type { SessionState as VoiceLiveState } from '../voice/session.js';
import type { DomainEvent } from '../events/types.js';

export interface PresenceState {
  activeActor: string | null; // IdentityId
  recentActors: string[]; // Bounded LRU
  sessionStartedAt: number;
}

export type TimeOfDay = 'night' | 'sunrise' | 'day' | 'sunset';

export interface WeatherSnapshot {
  condition: 'clear' | 'cloudy' | 'rainy' | 'stormy' | 'snow' | 'fog';
  temperature?: number;
}

export interface GeoSnapshot {
  lat: number;
  lng: number;
}

export interface PaletteSpec {
  primary: string;
  secondary: string;
  accent: string;
}

export interface EnvironmentState {
  timeOfDay: TimeOfDay;
  weather: WeatherSnapshot;
  location: GeoSnapshot;
  derivedPalette: PaletteSpec;
}

export type CognitiveStageName =
  | 'PERCEIVE'
  | 'IDENTIFY'
  | 'RECALL'
  | 'UNDERSTAND'
  | 'REASON'
  | 'DECIDE'
  | 'ACT'
  | 'VERIFY'
  | 'RESPOND'
  | 'LEARN'
  | 'UPDATE'
  | 'PERSIST';

export interface CognitiveState {
  currentStage: CognitiveStageName;
  cycleId: string;
  cycleStartedAt: number;
  lastCompletedStage: CognitiveStageName;
  attention: Record<string, number>; // AttentionVector stub
}

export interface VoiceState {
  live: VoiceLiveState;
  energy: number;
  ttsEnergy: number;
  frequencyBands: number[];
  voiceId: string;
}

export interface MemorySummary {
  episodicCount: number;
  semanticCount: number;
  preferenceCount: number;
  habitCount: number;
  relationshipCount: number;
  learnedPatternCount: number;
  lastConsolidationAt: number;
}

export interface LoopSummary {
  activeCount: number;
  pausedCount: number;
}

export interface TaskSummary {
  pendingCount: number;
  runningCount: number;
  failedCount: number;
}

export interface PendingAction {
  id: string;
  toolId: string;
  status: 'pending' | 'running';
}

export interface MutationRecord {
  eventId: string;
  type: string;
  timestamp: number;
}

export interface RuntimeState {
  version: number; // monotonic schema version
  identity: Identity;
  presence: PresenceState;
  environment: EnvironmentState;
  cognitive: CognitiveState;
  voice: VoiceState;
  memory: MemorySummary;
  loops: LoopSummary;
  tasks: TaskSummary;
  pendingActions: PendingAction[];
  lastMutation: MutationRecord;
}

export interface BroadcastMessage<T = unknown> {
  seq: number;
  type: string;
  payload: T;
  timestamp: number;
  coalesceKey?: string;
  field?: string;
}

export interface Subscriber {
  id: string;
  send(message: BroadcastMessage): void | Promise<void>;
}
