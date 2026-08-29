// Converts Base64 PCM16 into Float32Array with minimal allocation overhead
function base64ToFloat32(base64: string): Float32Array {
  if (!base64 || typeof base64 !== 'string') return new Float32Array(0);
  try {
    const cleanBase64 = base64.replace(/\s+/g, '');
    const binary = atob(cleanBase64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const numSamples = int16Array.length;
    const float32Array = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const s = int16Array[i];
      float32Array[i] = s < 0 ? s / 32768 : s / 32767;
    }
    return float32Array;
  } catch (err) {
    console.warn('Failed to parse base64 audio PCM16 chunk:', err);
    return new Float32Array(0);
  }
}

export class AudioPlayer {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  private onSpeakingChange: ((isSpeaking: boolean) => void) | null = null;
  private isSpeaking = false;
  private checkSpeakingTimer: number | null = null;
  private dataArray: Uint8Array | null = null;

  constructor(onSpeakingChange?: (isSpeaking: boolean) => void) {
    this.onSpeakingChange = onSpeakingChange || null;
  }

  private initContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      try {
        this.audioContext = new AudioCtx({ sampleRate: 24000 });
      } catch (e) {
        this.audioContext = new AudioCtx();
      }
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.connect(this.audioContext.destination);
      this.nextStartTime = this.audioContext.currentTime;
    }
  }

  public async playChunk(base64Pcm16: string): Promise<void> {
    this.initContext();
    if (!this.audioContext || !this.analyser) return;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    const float32Data = base64ToFloat32(base64Pcm16);
    if (float32Data.length === 0) return;

    const audioBuffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);

    const currentTime = this.audioContext.currentTime;
    // Jitter buffer gap protection
    if (this.nextStartTime < currentTime) {
      this.nextStartTime = currentTime;
    }

    source.start(this.nextStartTime);
    this.nextStartTime += audioBuffer.duration;
    this.activeSources.push(source);

    this.updateSpeakingState(true);

    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) {
        this.activeSources.splice(idx, 1);
      }
      if (this.activeSources.length === 0 && this.audioContext && this.audioContext.currentTime >= this.nextStartTime - 0.05) {
        this.updateSpeakingState(false);
      }
    };
  }

  private updateSpeakingState(speaking: boolean) {
    if (this.isSpeaking !== speaking) {
      this.isSpeaking = speaking;
      if (this.onSpeakingChange) {
        this.onSpeakingChange(speaking);
      }
    }

    if (speaking) {
      if (this.checkSpeakingTimer) window.clearTimeout(this.checkSpeakingTimer);
      this.checkSpeakingTimer = window.setTimeout(() => {
        if (this.audioContext && this.audioContext.currentTime >= this.nextStartTime - 0.05) {
          this.updateSpeakingState(false);
        }
      }, (this.nextStartTime - (this.audioContext?.currentTime || 0)) * 1000 + 100);
    }
  }

  public interrupt(): void {
    // Immediately stop all currently scheduled/playing buffers
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // ignore already stopped
      }
    }
    this.activeSources = [];
    if (this.audioContext) {
      this.nextStartTime = this.audioContext.currentTime;
    }
    this.updateSpeakingState(false);
  }

  public getVolumeLevel(): number {
    if (!this.analyser || !this.dataArray || !this.isSpeaking) return 0;
    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i];
    }
    const avg = sum / this.dataArray.length;
    return Math.min(100, Math.round((avg / 255) * 100));
  }

  public getWaveformData(targetArray: Uint8Array): void {
    if (!this.analyser || !this.isSpeaking) {
      targetArray.fill(128);
      return;
    }
    this.analyser.getByteTimeDomainData(targetArray);
  }

  public stop(): void {
    this.interrupt();
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
