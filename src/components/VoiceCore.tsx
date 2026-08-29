import { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { Mic, MicOff, Volume2, Loader2, Sparkles, PhoneOff, Radio } from 'lucide-react';
import { LiveState } from '../types.js';
import { AudioVisualizer } from './AudioVisualizer.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';

interface VoiceCoreProps {
  state: LiveState;
  onToggle: () => void;
  streamer: AudioStreamer;
  player: AudioPlayer;
  activeIdentityName: string;
  isOwner: boolean;
}

export function VoiceCore({
  state,
  onToggle,
  streamer,
  player,
  activeIdentityName,
  isOwner,
}: VoiceCoreProps) {
  // Label and status text depending on active state
  let stateTitle = `"Tell me something witty..."`;
  let stateSubtitle = 'Tap to connect with me';

  if (state === 'connecting') {
    stateTitle = `"Establishing Neural Link..."`;
    stateSubtitle = 'Initializing 16kHz & 24kHz stream';
  } else if (state === 'listening') {
    stateTitle = `"I'm listening..."`;
    stateSubtitle = 'Madhurita is listening';
  } else if (state === 'speaking') {
    stateTitle = `"Here's what I'm thinking..."`;
    stateSubtitle = 'Madhurita is speaking';
  }

  return (
    <div className="relative flex flex-col items-center justify-center my-auto w-full max-w-lg mx-auto select-none py-6">
      {/* Concentric Layered Orb Architecture - Vibrant Palette */}
      <div className="relative flex items-center justify-center">
        {/* Layer 1: Ambient Outer Pulse Ring */}
        <div className="absolute w-[360px] h-[360px] sm:w-[420px] sm:h-[420px] rounded-full border border-white/5 animate-pulse pointer-events-none" />

        {/* Layer 2: Subtle Border Ring */}
        <div className="absolute w-[300px] h-[300px] sm:w-[360px] sm:h-[360px] rounded-full border border-white/10 pointer-events-none" />

        {/* Layer 3: Ambient Radial Glow Backdrop */}
        <div className={`absolute w-[260px] h-[260px] sm:w-[300px] sm:h-[300px] rounded-full blur-2xl pointer-events-none transition-all duration-700 ${
          state === 'speaking'
            ? 'bg-gradient-to-b from-pink-500/25 via-purple-500/20 to-transparent'
            : state === 'listening'
            ? 'bg-gradient-to-b from-blue-500/25 via-cyan-500/20 to-transparent'
            : 'bg-gradient-to-b from-blue-500/10 to-transparent'
        }`} />

        {/* Interactive Canvas Visualizer for Audio Waveforms */}
        <AudioVisualizer state={state} streamer={streamer} player={player} />

        {/* Main Central Interactive Orb Glass Container */}
        <motion.button
          id="btn-voice-core"
          onClick={onToggle}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.96 }}
          className="w-56 h-56 sm:w-64 sm:h-64 rounded-full bg-white/5 backdrop-blur-2xl border border-white/20 shadow-2xl flex items-center justify-center relative group cursor-pointer transition-all duration-500 z-10"
        >
          {/* Dynamic Gradient Bloom */}
          <div className={`absolute inset-0 rounded-full blur-xl transition-opacity duration-500 ${
            state === 'speaking'
              ? 'bg-gradient-to-tr from-pink-600/30 via-purple-600/30 to-blue-600/30 opacity-100'
              : state === 'listening'
              ? 'bg-gradient-to-tr from-blue-600/30 via-cyan-600/30 to-purple-600/30 opacity-100'
              : 'bg-gradient-to-tr from-blue-600/20 via-purple-600/20 to-pink-600/20 opacity-70 group-hover:opacity-100'
          }`} />

          {/* Inner Glowing Concave Orb */}
          <div className="w-40 h-40 sm:w-48 sm:h-48 rounded-full bg-gradient-to-br from-white/10 to-transparent border border-white/30 flex flex-col items-center justify-center shadow-inner relative z-10">
            {state === 'connecting' ? (
              <Loader2 className="w-10 h-10 text-amber-300 animate-spin" />
            ) : state === 'speaking' ? (
              <div className="flex flex-col items-center gap-1.5">
                <Volume2 className="w-10 h-10 text-pink-300 animate-bounce" />
                <div className="w-12 h-1 bg-gradient-to-r from-pink-400 via-purple-300 to-white rounded-full shadow-[0_0_15px_rgba(244,114,182,0.8)]" />
              </div>
            ) : state === 'listening' ? (
              <div className="flex flex-col items-center gap-1.5">
                <Mic className="w-10 h-10 text-cyan-300 animate-pulse" />
                <div className="w-12 h-1 bg-gradient-to-r from-blue-400 via-cyan-300 to-white rounded-full shadow-[0_0_15px_rgba(56,189,248,0.8)]" />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Sparkles className="w-9 h-9 text-white/80 group-hover:text-pink-300 transition-colors" />
                <div className="w-14 h-1 bg-white/80 rounded-full shadow-[0_0_15px_rgba(255,255,255,0.6)]" />
              </div>
            )}
          </div>
        </motion.button>

        {/* Dynamic Glowing Equalizer Bars - Vibrant Palette */}
        <div className="absolute -bottom-12 flex items-end gap-1.5 h-12 z-20 pointer-events-none">
          <div className={`w-1.5 rounded-full transition-all duration-300 ${
            state === 'listening' || state === 'speaking' ? 'h-6 bg-blue-400 animate-pulse opacity-80' : 'h-3 bg-blue-400/40'
          }`} />
          <div className={`w-1.5 rounded-full transition-all duration-300 ${
            state === 'listening' || state === 'speaking' ? 'h-10 bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.6)]' : 'h-5 bg-blue-400/60'
          }`} />
          <div className={`w-1.5 rounded-full transition-all duration-300 ${
            state === 'listening' || state === 'speaking' ? 'h-14 bg-purple-400 shadow-[0_0_15px_rgba(192,132,252,0.8)] animate-pulse' : 'h-8 bg-purple-400/70'
          }`} />
          <div className={`w-1.5 rounded-full transition-all duration-300 ${
            state === 'listening' || state === 'speaking' ? 'h-7 bg-purple-400' : 'h-4 bg-purple-400/50'
          }`} />
          <div className={`w-1.5 rounded-full transition-all duration-300 ${
            state === 'listening' || state === 'speaking' ? 'h-11 bg-pink-400 shadow-[0_0_15px_rgba(244,114,182,0.8)]' : 'h-6 bg-pink-400/70'
          }`} />
          <div className={`w-1.5 rounded-full transition-all duration-300 ${
            state === 'listening' || state === 'speaking' ? 'h-5 bg-pink-400 animate-pulse opacity-80' : 'h-3 bg-pink-400/40'
          }`} />
        </div>
      </div>

      {/* State Headline & Subtitle */}
      <motion.div
        key={state}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="mt-20 text-center z-10"
      >
        <h2 className="text-3xl sm:text-4xl font-light tracking-wide text-white/90">
          {stateTitle}
        </h2>
        <p className="mt-3 text-xs sm:text-sm font-medium text-blue-300 uppercase tracking-[0.3em]">
          {stateSubtitle}
        </p>
      </motion.div>
    </div>
  );
}
