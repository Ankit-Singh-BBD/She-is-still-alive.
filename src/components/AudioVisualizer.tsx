import { useEffect, useRef } from 'react';
import { LiveState } from '../types.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

interface AudioVisualizerProps {
  state: LiveState;
  streamer: AudioStreamer;
  player: AudioPlayer;
}

export function AudioVisualizer({ state, streamer, player }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const bufferLength = 128;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      if (state === 'listening') {
        streamer.getWaveformData(dataArray);
      } else if (state === 'speaking') {
        player.getWaveformData(dataArray);
      } else {
        dataArray.fill(128);
      }

      const centerX = width / 2;
      const centerY = height / 2;
      const radius = Math.min(width, height) * 0.38;

      // Draw dynamic glowing circular wave
      ctx.save();
      ctx.translate(centerX, centerY);

      // Color scheme based on state - Vibrant Palette
      let strokeColor = 'rgba(147, 197, 253, 0.4)';
      let glowColor = 'rgba(168, 85, 247, 0.4)';

      if (state === 'listening') {
        strokeColor = 'rgba(96, 165, 250, 0.9)';
        glowColor = 'rgba(59, 130, 246, 0.8)';
      } else if (state === 'speaking') {
        strokeColor = 'rgba(244, 114, 182, 0.95)';
        glowColor = 'rgba(192, 132, 252, 0.85)';
      } else if (state === 'connecting') {
        strokeColor = 'rgba(251, 191, 36, 0.9)';
        glowColor = 'rgba(245, 158, 11, 0.7)';
      }

      ctx.shadowBlur = state === 'disconnected' ? 4 : 16;
      ctx.shadowColor = glowColor;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = strokeColor;

      ctx.beginPath();
      const points = 64;
      for (let i = 0; i <= points; i++) {
        const index = Math.floor((i / points) * (bufferLength / 2));
        const v = dataArray[index] / 128.0; // 0 to 2, 1 is center
        const angle = (i / points) * Math.PI * 2;

        let dynamicOffset = 0;
        if (state === 'listening' || state === 'speaking') {
          dynamicOffset = (v - 1.0) * 35;
        } else if (state === 'connecting') {
          dynamicOffset = Math.sin(Date.now() * 0.005 + angle * 4) * 4;
        }

        const r = radius + dynamicOffset;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.closePath();
      ctx.stroke();

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [state, streamer, player]);

  return (
    <canvas
      ref={canvasRef}
      width={300}
      height={300}
      className="absolute inset-0 m-auto pointer-events-none w-[150px] h-[150px]"
    />
  );
}
