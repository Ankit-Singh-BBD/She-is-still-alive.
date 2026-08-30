// ===================================================================
// VOICE CORE - Interactive voice control with emotion-driven orb
// ===================================================================

import { motion } from 'motion/react';
import { Mic, Volume2, Loader2, Sparkles } from 'lucide-react';
import { LiveState } from '../types.js';
import { MadhuritaOrb } from './MadhuritaOrb.js';
import { AudioStreamer } from '../services/audioStreamer.js';
import { AudioPlayer } from '../services/audioPlayer.js';
import { useEmotions, useWeatherExpression } from '../hooks/useUIState.js';

interface VoiceCoreProps {
  state: LiveState;
  onToggle: () => void;
  streamer: AudioStreamer;
  player: AudioPlayer;
  activeIdentityName: string;
  isOwner: boolean;
}

export function VoiceCore({ state, onToggle, streamer, player, activeIdentityName, isOwner }: VoiceCoreProps) {
  const emotions = useEmotions();
  const weatherExpression = useWeatherExpression();

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

  // Get state icon
  const StateIcon = state === 'connecting' ? Loader2 :
                    state === 'speaking' ? Volume2 :
                    state === 'listening' ? Mic :
                    Sparkles;

  return (
    <motion.div
      className="glass-panel rounded-[1.75rem] p-5 w-[260px] sm:w-[280px] flex flex-col items-center gap-2 shadow-2xl shadow-black/30"
      initial={{ opacity: 0, scale: 0.9, filter: 'blur(20px)' }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
    >
      {/* Emotion-driven orb */}
      <MadhuritaOrb
        state={state}
        size={180}
        onClick={onToggle}
        streamer={streamer}
        player={player}
      />

      {/* State icon overlay (subtle) */}
      <div className="relative -mt-32 mb-16 pointer-events-none z-20">
        <motion.div
          className="w-9 h-9 rounded-full glass flex items-center justify-center"
          animate={state === 'connecting' ? { rotate: 360 } : {}}
          transition={state === 'connecting' ? { duration: 1.5, repeat: Infinity, ease: 'linear' } : {}}
        >
          <StateIcon className="w-4 h-4 text-white" />
        </motion.div>
      </div>

      <motion.div
        key={state}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center"
      >
        <p className="text-[15px] font-semibold text-white">{title}</p>
        <p className={`mt-0.5 text-[12px] ${active ? 'text-indigo-200' : 'text-white/50'}`}>
          {subtitle}
        </p>
      </motion.div>

      {/* Madhurita's feeling/expression */}
      <motion.div
        className="w-full mt-2 px-3 py-2 rounded-xl bg-white/[0.05] border border-white/10 backdrop-blur-xl"
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        key={weatherExpression.description}
      >
        <p className="text-[10px] uppercase tracking-wider text-white/50 mb-0.5">Madhurita feels</p>
        <p className="text-[11px] text-white/80 italic leading-relaxed">"{weatherExpression.description}"</p>
      </motion.div>

      {/* Emotion metrics (subtle) */}
      <div className="w-full grid grid-cols-3 gap-1.5 text-center text-[9px] text-white/50">
        <div>
          <div className="text-white/80 font-medium">{Math.round(emotions.engagement)}%</div>
          <div>engaged</div>
        </div>
        <div>
          <div className="text-white/80 font-medium">{Math.round(emotions.focus)}%</div>
          <div>focused</div>
        </div>
        <div>
          <div className="text-white/80 font-medium">{Math.round(emotions.confidence)}%</div>
          <div>confident</div>
        </div>
      </div>
    </motion.div>
  );
}
