import { motion } from 'motion/react';
import { Mic, Volume2, Loader2, Sparkles } from 'lucide-react';
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

export function VoiceCore({ state, onToggle, streamer, player }: VoiceCoreProps) {
  let title = 'Tap to talk';
  let subtitle = 'Start a conversation';

  if (state === 'connecting') {
    title = 'Connecting…';
    subtitle = 'Establishing link';
  } else if (state === 'listening') {
    title = "I'm listening…";
    subtitle = 'Speak now';
  } else if (state === 'speaking') {
    title = 'Speaking…';
    subtitle = 'Madhurita is replying';
  }

  const active = state === 'listening' || state === 'speaking';

  return (
    <div className="glass-panel rounded-[1.75rem] p-5 w-[220px] flex flex-col items-center gap-1 shadow-2xl shadow-black/30 animate-glass-float">
      {/* Orb */}
      <div className="relative flex items-center justify-center w-[150px] h-[150px] my-2">
        {/* Ambient glow rings */}
        <div
          className={`absolute w-[150px] h-[150px] rounded-full blur-xl transition-all duration-700 ${
            state === 'speaking'
              ? 'bg-gradient-to-tr from-fuchsia-500/40 via-violet-500/40 to-indigo-500/40'
              : state === 'listening'
              ? 'bg-gradient-to-tr from-sky-500/40 via-indigo-500/40 to-violet-500/40'
              : 'bg-gradient-to-tr from-indigo-500/25 to-violet-500/25'
          }`}
        />

        {/* Canvas waveform */}
        <AudioVisualizer state={state} streamer={streamer} player={player} />

        {/* Interactive orb */}
        <motion.button
          id="btn-voice-core"
          onClick={onToggle}
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          className="relative z-10 w-[104px] h-[104px] rounded-full flex items-center justify-center cursor-pointer group"
        >
          {/* Glass shell */}
          <div className="absolute inset-0 rounded-full bg-white/10 backdrop-blur-2xl border border-white/25 glass-inset" />
          {/* Inner gradient core */}
          <div
            className={`absolute inset-[10px] rounded-full transition-all duration-500 ${
              state === 'speaking'
                ? 'bg-gradient-to-br from-fuchsia-400/80 via-violet-500/80 to-indigo-500/80'
                : state === 'listening'
                ? 'bg-gradient-to-br from-sky-400/80 via-indigo-500/80 to-violet-500/80'
                : 'bg-gradient-to-br from-indigo-400/60 via-violet-500/60 to-fuchsia-500/60 group-hover:from-indigo-400/80'
            }`}
          />
          <div className="relative z-10 text-white">
            {state === 'connecting' ? (
              <Loader2 className="w-7 h-7 animate-spin" />
            ) : state === 'speaking' ? (
              <Volume2 className="w-7 h-7" />
            ) : state === 'listening' ? (
              <Mic className="w-7 h-7" />
            ) : (
              <Sparkles className="w-7 h-7 opacity-90" />
            )}
          </div>
        </motion.button>
      </div>

      <motion.div key={state} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="text-center">
        <p className="text-[15px] font-semibold text-white">{title}</p>
        <p className={`mt-0.5 text-[12px] ${active ? 'text-indigo-200' : 'text-white/50'}`}>{subtitle}</p>
      </motion.div>
    </div>
  );
}
