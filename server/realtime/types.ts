import type { Identity } from '../identity/types.js';
import type { SessionState as VoiceLiveState } from '../voice/session.js';

export interface PresenceState {
  activeActor: string | null; // IdentityId
  recentActors: string[]; // Bounded LRU
  sessionStartedAt: number;
}

export type TimeOfDay = 'night' | 'sunrise' | 'day' | 'sunset';

export interface WeatherSnapshot {
  /**
   * Six renderable conditions, plus `'unknown'`.
   *
   * The book lists the six the visual layer knows how to draw. `'unknown'` is
   * the seventh state the *code* needs, because weather arrives over a network
   * that fails: without it the only way to represent "nobody could see the sky"
   * is to pick one of the six, and the orb would then render rain she never
   * observed. The palette still has to choose something for `'unknown'` — that
   * is a rendering decision, and it is made in the palette derivation where it
   * is visible, not smuggled in here as a claim about the weather.
   */
  condition: 'clear' | 'cloudy' | 'rainy' | 'stormy' | 'snow' | 'fog' | 'unknown';
  temperature?: number; // degrees Celsius
  observedAt?: number; // epoch ms of the reading
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
  /**
   * Absent when nobody has told her where she is.
   *
   * The book types this as required, which forces a value into it even when
   * there is none, and the only available value is `{ lat: 0, lng: 0 }` — a
   * point in the Gulf of Guinea. That is not a missing location, it is a wrong
   * one, and every consumer downstream would treat it as a real reading.
   * Optional is the honest shape.
   */
  location?: GeoSnapshot | undefined;
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
