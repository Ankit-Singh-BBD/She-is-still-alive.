import { useEffect, useRef } from 'react';
import { LiveState } from '../types.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

interface HeaderIconProps {
  state: LiveState;
  streamer?: AudioStreamer | null;
  player?: AudioPlayer | null;
}

export function HeaderIcon({ state, streamer, player }: HeaderIconProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let smoothedVolume = 0;
    const bufferLength = 32;
    const waveData = new Uint8Array(bufferLength);

    const render = () => {
      // 1. Measure real audio input / output level
      let rawVolume = 0;
      if (state === 'speaking' && player) {
        rawVolume = player.getVolumeLevel();
        player.getWaveformData(waveData);
      } else if (state === 'listening' && streamer) {
        rawVolume = streamer.getVolumeLevel();
        streamer.getWaveformData(waveData);
      } else {
        waveData.fill(128);
      }

      // Smooth decay / lerp
      const targetVol = Math.min(100, Math.max(0, rawVolume));
      smoothedVolume += (targetVol - smoothedVolume) * 0.25;
      const normVol = smoothedVolume / 100; // 0.0 to 1.0

      // 2. Clear canvas
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;

      ctx.save();

      // Background Squircle Badge
      const size = 68;
      const x = cx - size / 2;
      const y = cy - size / 2;
      const radius = 18;

      ctx.beginPath();
      ctx.roundRect(x, y, size, size, radius);
      
      // Dynamic Glass gradient
      const bgGrad = ctx.createLinearGradient(x, y, x + size, y + size);
      if (state === 'speaking') {
        bgGrad.addColorStop(0, `rgba(236, 72, 153, ${0.18 + normVol * 0.25})`);
        bgGrad.addColorStop(1, `rgba(168, 85, 247, ${0.25 + normVol * 0.25})`);
      } else if (state === 'listening') {
        bgGrad.addColorStop(0, `rgba(59, 130, 246, ${0.18 + normVol * 0.25})`);
        bgGrad.addColorStop(1, `rgba(6, 182, 212, ${0.25 + normVol * 0.25})`);
      } else if (state === 'connecting') {
        bgGrad.addColorStop(0, 'rgba(245, 158, 11, 0.2)');
        bgGrad.addColorStop(1, 'rgba(217, 119, 6, 0.2)');
      } else {
        bgGrad.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
        bgGrad.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
      }

      ctx.fillStyle = bgGrad;
      ctx.fill();

      // Border outline
      ctx.strokeStyle = state === 'speaking'
        ? `rgba(244, 114, 182, ${0.4 + normVol * 0.5})`
        : state === 'listening'
        ? `rgba(147, 197, 253, ${0.4 + normVol * 0.5})`
        : 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Outer Audio Glow Halo (when voice active)
      if (normVol > 0.02) {
        ctx.beginPath();
        ctx.arc(cx, cy, 24 + normVol * 10, 0, Math.PI * 2);
        const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 24 + normVol * 10);
        const glowColor = state === 'speaking' ? '236, 72, 153' : '59, 130, 246';
        glow.addColorStop(0, `rgba(${glowColor}, ${0.35 + normVol * 0.4})`);
        glow.addColorStop(1, `rgba(${glowColor}, 0)`);
        ctx.fillStyle = glow;
        ctx.fill();
      }

      // Minimalist Madhurita Voice Crest: Symmetrical 5-Bar Harmonic Spectrum
      const barCount = 5;
      const barWidth = 3;
      const barSpacing = 4.5;
      const totalWidth = barCount * barWidth + (barCount - 1) * barSpacing;
      const startX = cx - totalWidth / 2 + barWidth / 2;

      // Base heights (forming an elegant arch/wave)
      const baseHeights = [9, 16, 22, 16, 9];

      for (let i = 0; i < barCount; i++) {
        const bx = startX + i * (barWidth + barSpacing);
        const baseH = baseHeights[i];
        
        // Voice-responsive height modulation from real waveform / volume
        let waveFactor = 0;
        if (state === 'speaking' || state === 'listening') {
          const sampleIndex = Math.min(bufferLength - 1, i * 4);
          const sampleVal = (waveData[sampleIndex] - 128) / 128; // -1 to 1
          waveFactor = Math.abs(sampleVal) * (10 + normVol * 14);
        }

        const dynamicH = Math.max(4, baseH * (0.6 + normVol * 0.9) + waveFactor);

        // Bar gradient
        const barGrad = ctx.createLinearGradient(bx, cy - dynamicH / 2, bx, cy + dynamicH / 2);
        if (state === 'speaking') {
          barGrad.addColorStop(0, '#f472b6'); // Pink-400
          barGrad.addColorStop(1, '#a855f7'); // Purple-500
        } else if (state === 'listening') {
          barGrad.addColorStop(0, '#93c5fd'); // Blue-300
          barGrad.addColorStop(1, '#3b82f6'); // Blue-500
        } else {
          barGrad.addColorStop(0, '#ffffff');
          barGrad.addColorStop(1, 'rgba(255, 255, 255, 0.45)');
        }

        ctx.beginPath();
        ctx.roundRect(bx - barWidth / 2, cy - dynamicH / 2, barWidth, dynamicH, barWidth / 2);
        ctx.fillStyle = barGrad;
        ctx.fill();
      }

      // Minimalist Center Sparkle Node
      const nodeRadius = 1.5 + normVol * 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy - 18, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = state === 'speaking' ? '#f472b6' : state === 'listening' ? '#93c5fd' : 'rgba(255, 255, 255, 0.7)';
      ctx.fill();

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [state, streamer, player]);

  return (
    <div
      id="header-madhurita-icon"
      className="relative w-10 h-10 flex items-center justify-center shrink-0 rounded-2xl select-none"
    >
      <canvas
        ref={canvasRef}
        width={80}
        height={80}
        className="w-10 h-10 block pointer-events-none"
      />
    </div>
  );
}
