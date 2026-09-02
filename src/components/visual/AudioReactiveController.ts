/**
 * AudioReactiveController
 *
 * Implements Part XVIII.6, XVIII.18, and XVIII.27:
 * Direct bridge from Web Audio API analysers to GPU uniforms without React re-renders.
 * Handles normalization, exponential moving average (EMA) smoothing,
 * band decomposition (low/mid/high), and transient envelope following.
 */

export interface AudioVisuals {
  energy: number;
  low: number;
  mid: number;
  high: number;
  voiceIntensity: number;
  transient: number;
}

export class AudioReactiveController {
  private micAnalyser: AnalyserNode | null = null;
  private ttsAnalyser: AnalyserNode | null = null;

  // Smoothing buffers
  private smoothedEnergy = 0;
  private smoothedLow = 0;
  private smoothedMid = 0;
  private smoothedHigh = 0;
  private smoothedIntensity = 0;

  // Reusable byte arrays to avoid per-frame allocations (XVIII.16)
  private freqData: Uint8Array = new Uint8Array(128);
  private timeData: Uint8Array = new Uint8Array(128);

  constructor(micAnalyser: AnalyserNode | null = null, ttsAnalyser: AnalyserNode | null = null) {
    this.micAnalyser = micAnalyser;
    this.ttsAnalyser = ttsAnalyser;
  }

  public setMicAnalyser(analyser: AnalyserNode | null) {
    this.micAnalyser = analyser;
    this.ensureBufferSize(analyser);
  }

  public setTtsAnalyser(analyser: AnalyserNode | null) {
    this.ttsAnalyser = analyser;
    this.ensureBufferSize(analyser);
  }

  private ensureBufferSize(analyser: AnalyserNode | null) {
    if (analyser && analyser.frequencyBinCount > this.freqData.length) {
      this.freqData = new Uint8Array(analyser.frequencyBinCount);
      this.timeData = new Uint8Array(analyser.fftSize);
    }
  }

  /**
   * Sample current frame audio metrics and update smoothed states.
   * Pure computational step intended to be called inside useFrame / requestAnimationFrame.
   */
  public update(_delta: number): AudioVisuals {
    const activeAnalyser = this.ttsAnalyser || this.micAnalyser;

    if (!activeAnalyser) {
      // Natural decay to baseline (XVIII.7)
      this.smoothedEnergy *= 0.92;
      this.smoothedLow *= 0.92;
      this.smoothedMid *= 0.92;
      this.smoothedHigh *= 0.92;
      this.smoothedIntensity *= 0.92;

      return {
        energy: this.smoothedEnergy,
        low: this.smoothedLow,
        mid: this.smoothedMid,
        high: this.smoothedHigh,
        voiceIntensity: this.smoothedIntensity,
        transient: 0,
      };
    }

    // Read frequency domain data
    const freqData = this.freqData;
    activeAnalyser.getByteFrequencyData(freqData as unknown as Uint8Array<ArrayBuffer>);
    const binCount = activeAnalyser.frequencyBinCount;

    // Calculate energy bands
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;

    const lowEnd = Math.max(1, Math.floor(binCount * 0.1));
    const midEnd = Math.max(lowEnd + 1, Math.floor(binCount * 0.4));
    const highEnd = binCount;

    for (let i = 0; i < lowEnd; i++) lowSum += (this.freqData[i] || 0);
    for (let i = lowEnd; i < midEnd; i++) midSum += (this.freqData[i] || 0);
    for (let i = midEnd; i < highEnd; i++) highSum += (this.freqData[i] || 0);

    const lowRaw = lowSum / lowEnd / 255;
    const midRaw = midSum / (midEnd - lowEnd) / 255;
    const highRaw = highSum / (highEnd - midEnd) / 255;
    const energyRaw = (lowRaw * 0.5 + midRaw * 0.35 + highRaw * 0.15);

    // Exponential Moving Average Smoothing
    const alpha = 0.18;
    this.smoothedEnergy += (energyRaw - this.smoothedEnergy) * alpha;
    this.smoothedLow += (lowRaw - this.smoothedLow) * alpha;
    this.smoothedMid += (midRaw - this.smoothedMid) * alpha;
    this.smoothedHigh += (highRaw - this.smoothedHigh) * alpha;

    // Intensity envelope
    this.smoothedIntensity += (energyRaw * 1.5 - this.smoothedIntensity) * 0.25;

    // Transient detection
    const transient = Math.max(0, energyRaw - this.smoothedEnergy);

    return {
      energy: this.smoothedEnergy,
      low: this.smoothedLow,
      mid: this.smoothedMid,
      high: this.smoothedHigh,
      voiceIntensity: Math.min(1.0, this.smoothedIntensity),
      transient,
    };
  }

  /**
   * Sample time-domain waveform data for the equator line geometry.
   */
  public sampleTimeDomain(target: Float32Array): void {
    const activeAnalyser = this.ttsAnalyser || this.micAnalyser;
    if (!activeAnalyser) {
      target.fill(0);
      return;
    }

    const timeData = this.timeData;
    activeAnalyser.getByteTimeDomainData(timeData as unknown as Uint8Array<ArrayBuffer>);
    const step = timeData.length / target.length;
    for (let i = 0; i < target.length; i++) {
      const idx = Math.floor(i * step);
      // Convert 0..255 to -1.0..1.0
      target[i] = ((timeData[idx] || 0) - 128) / 128;
    }
  }
}
