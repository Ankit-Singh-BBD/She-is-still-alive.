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

/**
 * Where she is in a cycle, and which cycle.
 *
 * There was an `attention: Record<string, number>` here, commented "AttentionVector
 * stub". It was written as `{}` by both of the projector's writers and read by
 * nothing — the fifth field of the same family as `VoiceState`'s `energy`,
 * `ttsEnergy`, `frequencyBands` and `voiceId`, and removed for the same reason. All
 * five were declared for the orb renderer, whose direction is dropped; the book names
 * `CognitiveState.attention` in exactly two places, the state contract and the orb's
 * list of visual inputs.
 *
 * Nothing in the cognition layer computes attention, so the field could not have been
 * filled without inventing a subsystem, and an empty `Record<string, number>` is a
 * shape no consumer can rely on anyway. If an attention model is built later it will
 * declare the type it actually produces.
 */
export interface CognitiveState {
  currentStage: CognitiveStageName;
  cycleId: string;
  cycleStartedAt: number;
  /**
   * The last stage that finished, or `undefined` when none has in this process.
   *
   * Optional because the alternative was a lie with nowhere to hide: any concrete
   * default is the name of a stage, and naming one before a cycle has run — or after
   * a `cycle.stage.completed` whose payload could not be read — reports work that did
   * not happen. `PERSIST` was the old default, which is the *most* successful answer
   * of the twelve.
   */
  lastCompletedStage: CognitiveStageName | undefined;
}

/**
 * What the server knows about a live voice session — and only that.
 *
 * It used to carry `energy`, `ttsEnergy`, `frequencyBands` and `voiceId`. All
 * four were written as `0`, `[]` and `''` by the only projector that builds this
 * type, and read by nothing: waveform data exists in the browser, which holds the
 * microphone and the speaker and can run an `AnalyserNode` at frame rate with no
 * network hop. Streaming it out through coalesced SSE would have been a slower
 * copy of something the client already has.
 *
 * What is left is what only the server can answer: which state her session is in,
 * why, and whether there is a live model behind the socket at all.
 */
export interface VoiceState {
  live: VoiceLiveState;
  /** The reason the last transition carried, or `''` when it carried none. */
  reason: string;
  /**
   * Whether a live model is attached to the socket that is open.
   *
   * `false` while `live` is past `disconnected` is the text-only configuration —
   * no `GOOGLE_API_KEY` or `FLAG_VOICE` off. She still runs all twelve stages per
   * turn; she just cannot be heard or heard back.
   */
  canHear: boolean;
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

/**
 * There was a `PendingAction` and a `RuntimeState.pendingActions` here.
 *
 * They are gone rather than filled in, and the reason is worth the paragraph because
 * the field read as an obvious omission: a queue of in-flight tool calls is a thing a
 * state projection plainly ought to carry.
 *
 * It ought to, if actions queued. They do not. `ActionPipeline.execute` awaits seven
 * stages in sequence and the cycle that called it awaits *that*, so at any instant a
 * caller could read this field there is either exactly one action running — inside the
 * same stack frame that would have to publish it — or none. And the one running action
 * is already reported: `cognitive.currentStage` is `'ACT'`, folded from
 * `cycle.stage.completed` like every other field here, with no new machinery.
 * `TaskSummary.runningCount` above covers the other half, the work the scheduler owns.
 *
 * Making it live would also have to fight the projection. `getSnapshot()` is folded at
 * the last event applied, and the last event before an action is stage 6's completion —
 * so a snapshot-derived list is empty at precisely the moment it means something, and an
 * in-flight registry would need overlaying at all three read sites in
 * `server/http/routes/presence.ts`. For a window of a few hundred milliseconds, to
 * print a `toolId` — the inside of the machine — on a screen that shows her.
 *
 * So: a shape that promised a queue the architecture does not have, and a UI branch in
 * `src/ui/Ledger.tsx` that could not render once in the life of the process.
 */
export interface MutationRecord {
  eventId: string;
  type: string;
  timestamp: number;
}

export interface RuntimeState {
  /**
   * The `domain_event.seq` of the newest event folded into this state.
   *
   * Non-decreasing, and that is a guarantee rather than an observation: delivery
   * order is not seq order (stage 12 awaits between the events of one cycle, so an
   * independent publisher can land a later one first), so `RealtimeFlow` raises this
   * to the high-water mark instead of assigning it. `0` means nothing has been
   * applied — either a fresh flow, or `GET /api/state` answering with no flow behind
   * it at all.
   */
  version: number;
  identity: Identity;
  presence: PresenceState;
  environment: EnvironmentState;
  cognitive: CognitiveState;
  voice: VoiceState;
  memory: MemorySummary;
  loops: LoopSummary;
  tasks: TaskSummary;
  lastMutation: MutationRecord;
}

/**
 * One frame on the realtime channel.
 *
 * `coalesceKey` is a routing hint for `RealtimeFlow`'s queues and never reaches the
 * wire — `server/http/sse.ts` serialises the other four fields. There was a `field?:
 * string` beside it, a second way to derive that key, written by nothing in the
 * server, the frontend or the tests and read only by the derivation itself. The book
 * describes coalescing per *field*, and the code does it per event type, which is the
 * same thing one level up: events of a type touch the same part of `RuntimeState`.
 */
export interface BroadcastMessage<T = unknown> {
  seq: number;
  type: string;
  payload: T;
  timestamp: number;
  coalesceKey?: string;
}

export interface Subscriber {
  id: string;
  send(message: BroadcastMessage): void | Promise<void>;
}
