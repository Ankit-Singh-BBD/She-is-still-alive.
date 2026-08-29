// Robust downsampler from any source sample rate to 16kHz PCM16 Base64
function resampleAndConvertToPCM16Base64(
  inputBuffer: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16000
): string {
  if (inputBuffer.length === 0) return '';

  let samples: Float32Array;

  if (inputSampleRate === outputSampleRate) {
    samples = inputBuffer;
  } else {
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.round(inputBuffer.length / ratio);
    samples = new Float32Array(outputLength);
    let offsetResult = 0;
    let offsetBuffer = 0;

    while (offsetResult < samples.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < inputBuffer.length; i++) {
        accum += inputBuffer[i];
        count++;
      }
      samples[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
  }

  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Clamp sample between -1.0 and 1.0
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const uint8 = new Uint8Array(pcm16.buffer);
  let binary = '';
  const CHUNK_SIZE = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
    const chunk = uint8.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export class AudioStreamer {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private isStreaming = false;
  private onAudioChunkCallback: ((base64Audio: string) => void) | null = null;
  private dataArray: Uint8Array | null = null;

  public async start(onAudioChunk: (base64Audio: string) => void): Promise<void> {
    if (this.isStreaming) return;
    this.onAudioChunkCallback = onAudioChunk;

    try {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not supported in this browser environment.');
      }

      // 1. Acquire media stream with progressive fallback
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (firstErr: any) {
        const isPermissionDenied =
          firstErr?.name === 'NotAllowedError' ||
          firstErr?.name === 'PermissionDeniedError' ||
          firstErr?.name === 'SecurityError' ||
          firstErr?.message?.toLowerCase().includes('not allowed') ||
          firstErr?.message?.toLowerCase().includes('denied') ||
          firstErr?.message?.toLowerCase().includes('permission');

        if (isPermissionDenied) {
          const permErr = new Error('Microphone permission is not allowed. Please allow microphone access in your browser to speak with Madhurita.');
          permErr.name = 'NotAllowedError';
          throw permErr;
        }

        console.warn('Advanced audio constraints not accepted, falling back to basic audio:', firstErr);
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
        } catch (secondErr: any) {
          if (
            secondErr?.name === 'NotAllowedError' ||
            secondErr?.name === 'PermissionDeniedError' ||
            secondErr?.message?.toLowerCase().includes('not allowed') ||
            secondErr?.message?.toLowerCase().includes('denied')
          ) {
            const permErr = new Error('Microphone permission is not allowed. Please allow microphone access in your browser to speak with Madhurita.');
            permErr.name = 'NotAllowedError';
            throw permErr;
          }
          throw secondErr;
        }
      }

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) {
        throw new Error('Web Audio API is not supported in this browser.');
      }

      // 2. Initialize AudioContext with fallback
      try {
        this.audioContext = new AudioCtx({ sampleRate: 16000 });
      } catch (e) {
        this.audioContext = new AudioCtx();
      }

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      const sampleRate = this.audioContext.sampleRate || 16000;

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.8;
      this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

      // Buffer size 2048 (~128ms latency per chunk at 16kHz)
      this.processor = this.audioContext.createScriptProcessor(2048, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.isStreaming) return;
        const inputData = e.inputBuffer.getChannelData(0);

        // Resample and convert to 16kHz PCM16 Base64
        const base64Chunk = resampleAndConvertToPCM16Base64(inputData, sampleRate, 16000);
        if (this.onAudioChunkCallback && base64Chunk.length > 0) {
          this.onAudioChunkCallback(base64Chunk);
        }
      };

      this.source.connect(this.analyser);
      this.analyser.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.isStreaming = true;
    } catch (err) {
      console.error('Failed to start AudioStreamer:', err);
      this.stop();
      throw err;
    }
  }

  public getVolumeLevel(): number {
    if (!this.analyser || !this.dataArray) return 0;
    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      sum += this.dataArray[i];
    }
    const avg = sum / this.dataArray.length;
    return Math.min(100, Math.round((avg / 255) * 100));
  }

  public getWaveformData(targetArray: Uint8Array): void {
    if (!this.analyser) {
      targetArray.fill(128);
      return;
    }
    this.analyser.getByteTimeDomainData(targetArray);
  }

  public stop(): void {
    this.isStreaming = false;
    if (this.processor) {
      try {
        this.processor.disconnect();
      } catch (e) {}
      this.processor = null;
    }
    if (this.analyser) {
      try {
        this.analyser.disconnect();
      } catch (e) {}
      this.analyser = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch (e) {}
      this.source = null;
    }
    if (this.mediaStream) {
      try {
        this.mediaStream.getTracks().forEach((track) => track.stop());
      } catch (e) {}
      this.mediaStream = null;
    }
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    this.onAudioChunkCallback = null;
  }
}
