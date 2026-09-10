/**
 * The voice subsystem's live surface.
 *
 * `server/http/ws.ts` and `server/app.ts` import from here and from nowhere
 * deeper, for the reason `server/llm/index.ts` gives about its own barrel: the
 * only thing outside this directory needs is a way to build the factory and a way
 * to run a session, and everything else — the message splitter, the drift
 * comparison, the `Rendering` bookkeeping — stays where it can be changed without
 * a caller noticing.
 */

export {
  createGeminiLiveTransportFactory,
  INPUT_MIME_TYPE,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  RENDERER_INSTRUCTION,
  type LiveTransport,
  type LiveTransportCallbacks,
  type LiveTransportFactory,
  type LiveVoiceConfig,
} from './transport.js';

export {
  ClientMessageSchema,
  CLOSE_FORBIDDEN,
  CLOSE_GOING_AWAY,
  CLOSE_INTERNAL,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHENTICATED,
  MAX_AUDIO_FRAME_BYTES,
  MAX_SAY_LENGTH,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js';

export {
  DRIFT_EXTRA_FLOOR,
  DRIFT_EXTRA_RATIO,
  DRIFT_MIN_COVERAGE,
  TRANSCRIPT_GRACE_MS,
  tokenize,
  VoiceSession,
  type AudioEnvelope,
  type VoiceClientChannel,
  type VoiceEar,
  type VoiceSessionDeps,
  type VoiceSessionStats,
} from './session.js';
