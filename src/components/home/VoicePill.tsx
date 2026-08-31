// ===================================================================
// VOICE PILL - Compact voice control shown on home near the orb
// ===================================================================

import { motion, AnimatePresence } from 'motion/react';
import { Mic, Volume2, Loader2, Sparkles, AudioLines } from 'lucide-react';
import { LiveState } from '../../types.js';
import { useWeatherExpression } from '../../hooks/useUIState.js';

interface VoicePillProps {
  state: LiveState;
  onToggle: () => void;
  disabled?: boolean;
}

const STATE_LABEL: Record<LiveState, { title: string; subtitle: string }> = {
  disconnected: { title: 'Tap to talk', subtitle: 'Start a conversation' },
  connecting: { title: 'Connecting…', subtitle: 'Establishing link' },
  listening: { title: "I'm listening…", subtitle: 'Speak now' },
  speaking: { title: 'Speaking…', subtitle: 'Madhurita is replying' },
};

const STATE_GLOW: Record<LiveState, string> = {
  disconnected: '',
  connecting: 'glow-thinking',
  listening: 'glow-listening',
  speaking: 'glow-speaking',
};

const STATE_BORDER: Record<LiveState, string> = {
  disconnected: 'border-white/15',
  connecting: 'border-violet-300/40',
  listening: 'border-sky-300/50',
  speaking: 'border-orange-300/50',
};

const STATE_BG: Record<LiveState, string> = {
  disconnected: 'from-white/[0.08] to-white/[0.02]',
  connecting: 'from-violet-500/15 to-violet-500/5',
  listening: 'from-sky-500/18 to-sky-500/5',
  speaking: 'from-orange-500/18 to-orange-500/5',
};

export function VoicePill({ state, onToggle, disabled }: VoicePillProps) {
  const weather = useWeatherExpression();
  const meta = STATE_LABEL[state];
  const active = state === 'listening' || state === 'speaking';

  const StateIcon =
    state === 'connecting'
      ? Loader2
      : state === 'speaking'
      ? Volume2
      : state === 'listening'
      ? AudioLines
      : Mic;

  return (
    <motion.button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      whileHover={{ scale: 1.02, y: -1 }}
      whileTap={{ scale: 0.97 }}
      className={`relative flex items-center gap-3 px-4 py-2.5 rounded-2xl border bg-gradient-to-br ${STATE_BG[state]} ${STATE_BORDER[state]} backdrop-blur-2xl cursor-pointer press-scale transition-all ${STATE_GLOW[state]} ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      }`}
    >
      {/* Animated state indicator dot */}
      <span className="relative flex items-center justify-center">
        <AnimatePresence mode="wait">
          {active && (
            <motion.span
              key="ring"
              className="absolute inset-0 m-auto w-7 h-7 rounded-full"
              style={{
                border: `1.5px solid ${state === 'listening' ? '#60A5FA' : '#FB923C'}`,
              }}
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: [0.8, 1.4, 0.8], opacity: [0.6, 0, 0.6] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
            />
          )}
        </AnimatePresence>
        <span
          className={`w-7 h-7 rounded-full flex items-center justify-center ${
            state === 'listening'
              ? 'bg-sky-400/25 text-sky-100'
              : state === 'speaking'
              ? 'bg-orange-400/25 text-orange-100'
              : state === 'connecting'
              ? 'bg-violet-400/25 text-violet-100'
              : 'bg-white/10 text-white/80'
          }`}
        >
          <StateIcon
            className={`w-3.5 h-3.5 ${state === 'connecting' ? 'animate-spin' : ''}`}
          />
        </span>
      </span>

      <div className="text-left min-w-0">
        <AnimatePresence mode="wait">
          <motion.p
            key={meta.title}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className="text-[13px] font-semibold text-white leading-tight whitespace-nowrap"
          >
            {meta.title}
          </motion.p>
        </AnimatePresence>
        <AnimatePresence mode="wait">
          <motion.p
            key={meta.subtitle + weather.description}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
            className={`text-[10.5px] leading-tight mt-0.5 whitespace-nowrap ${
              active ? 'text-indigo-200/80' : 'text-white/50'
            }`}
          >
            {state === 'disconnected' ? weather.description : meta.subtitle}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.button>
  );
}
