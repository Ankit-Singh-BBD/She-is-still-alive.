/**
 * P18 — Voice Plumbing Refactor
 *
 * AudioCapture interface — server-side abstraction for capturing audio.
 * This is implemented by platform-specific adapters (Web, Node, React Native, etc.).
 * The legacy `AudioStreamer` class from `src/services/audioStreamer.ts` is wrapped
 * by an adapter implementing this interface.
 */

export type AudioFormat = 'pcm16' | 'pcm16_base64' | 'float32' | 'opus' | 'mp3';

export interface AudioCaptureConfig {
  /** Target sample rate in Hz (default: 16000) */
  sampleRate?: number;
  /** Number of audio channels (default: 1) */
  channelCount?: number;
  /** Echo cancellation (default: true) */
  echoCancellation?: boolean;
  /** Noise suppression (default: true) */
  noiseSuppression?: boolean;
  /** Auto gain control (default: true) */
  autoGainControl?: boolean;
  /** Output format (default: 'pcm16_base64') */
  format?: AudioFormat;
  /** Chunk duration in ms (default: 100) */
  chunkMs?: number;
}

export interface AudioCaptureCallbacks {
  /** Called when a new audio chunk is available */
  onChunk: (chunk: AudioChunk) => void;
  /** Called when capture starts successfully */
  onStart?: () => void;
  /** Called when capture stops (graceful or error) */
  onStop?: (error?: Error) => void;
  /** Called when a permission error occurs */
  onPermissionDenied?: () => void;
  /** Called when audio device is not found */
  onDeviceNotFound?: () => void;
}

export interface AudioChunk {
  /** Raw audio data */
  data: ArrayBuffer | string; // ArrayBuffer for binary, string for base64
  /** Format of the data */
  format: AudioFormat;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels */
  channelCount: number;
  /** Timestamp when this chunk was captured (epoch ms) */
  timestamp: number;
  /** Duration of this chunk in ms */
  durationMs: number;
  /** Sequence number for ordering */
  sequence: number;
}

export interface AudioCaptureState {
  /** Current capture state */
  state: 'idle' | 'starting' | 'capturing' | 'stopping' | 'stopped' | 'error';
  /** Error if state is 'error' */
  error?: Error | undefined;
  /** Current audio level (0-100) for UI visualization */
  level?: number;
  /** Current sample rate */
  sampleRate: number;
  /** Number of chunks captured since start */
  chunksCaptured: number;
}

/**
 * AudioCapture interface — platform-agnostic audio input.
 *
 * Implementations:
 * - WebAudioCapture: wraps legacy AudioStreamer (getUserMedia + ScriptProcessorNode)
 * - NodeAudioCapture: uses @xenova/transformers or native node-audio
 * - ReactNativeAudioCapture: uses expo-audio or react-native-audio
 */
export interface AudioCapture {
  /** Get current state */
  getState(): AudioCaptureState;

  /** Start capturing audio */
  start(callbacks: AudioCaptureCallbacks): Promise<void>;

  /** Stop capturing audio */
  stop(): Promise<void>;

  /** Pause capturing (keeps stream open but stops emitting chunks) */
  pause(): Promise<void>;

  /** Resume capturing after pause */
  resume(): Promise<void>;

  /** Update configuration (e.g., change sample rate) */
  configure(config: Partial<AudioCaptureConfig>): Promise<void>;

  /** Get available audio input devices */
  getDevices(): Promise<MediaDeviceInfo[]>;

  /** Set specific input device */
  setDevice(deviceId: string): Promise<void>;

  /** Cleanup resources */
  dispose(): Promise<void>;
}

/**
 * Factory type for creating AudioCapture instances.
 * Allows platform-specific implementations to be registered.
 */
export type AudioCaptureFactory = (config: AudioCaptureConfig) => AudioCapture;