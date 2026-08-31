// ===================================================================
// GREETING BLOCK - "Good Evening, Ankit ✨" + time + weather line
// ===================================================================

import { motion } from 'motion/react';
import { useTimeOfDay, useWeather } from '../../hooks/useUIState.js';
import { getGreeting, formatTemp } from '../../utils/format.js';
import { getWeatherVisual, temperatureFeels } from '../../utils/weather.js';
import { Cloud, Droplets, Wind, Sun } from 'lucide-react';

interface GreetingBlockProps {
  identityName: string;
  role?: 'owner' | 'user' | 'unknown';
}

export function GreetingBlock({ identityName, role = 'unknown' }: GreetingBlockProps) {
  const { timeOfDay, istHour } = useTimeOfDay();
  const weather = useWeather();

  const greeting = getGreeting(istHour);
  const weatherVisual = getWeatherVisual(weather?.condition);
  const tempFeels = temperatureFeels(weather?.temperature);

  const firstName = identityName?.split(' ')[0] || 'there';
  const isOwner = role === 'owner';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col items-center text-center"
    >
      {/* Greeting line */}
      <h1 className="text-[32px] sm:text-[40px] lg:text-[44px] font-semibold tracking-tight leading-[1.1] text-white">
        {greeting.label},{' '}
        <span className="text-gradient-sunset">{firstName}</span>{' '}
        <span className="inline-block">{greeting.emoji}</span>
      </h1>

      {/* Time + weather subline */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.6 }}
        className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px] sm:text-sm text-white/70"
      >
        {/* Location + weather */}
        {weather && (
          <span className="flex items-center gap-1.5">
            <span className="text-base leading-none">{weatherVisual.icon}</span>
            <span className="text-white/85 font-medium">{formatTemp(weather.temperature)}</span>
            <span className="text-white/55">·</span>
            <span className={tempFeels.accent}>{tempFeels.label}</span>
            <span className="text-white/40">·</span>
            <span className="text-white/55">{weatherVisual.label}</span>
          </span>
        )}

        {/* Humidity + wind (only if available) */}
        {weather?.humidity !== undefined && (
          <span className="flex items-center gap-1.5 text-white/55">
            <Droplets className="w-3.5 h-3.5" />
            {weather.humidity}%
          </span>
        )}
      </motion.div>

      {/* Owner / personal / guest micro-tag */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3, duration: 0.6 }}
        className="mt-3 flex items-center gap-2"
      >
        {isOwner ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.12em] bg-amber-400/10 border border-amber-300/25 text-amber-200">
            <span className="w-1 h-1 rounded-full bg-amber-300" />
            Owner Mode
          </span>
        ) : role === 'user' ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.12em] bg-indigo-400/10 border border-indigo-300/25 text-indigo-200">
            <span className="w-1 h-1 rounded-full bg-indigo-300" />
            Personal Mode
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-[0.12em] bg-white/[0.06] border border-white/15 text-white/60">
            <span className="w-1 h-1 rounded-full bg-white/40" />
            Guest Mode
          </span>
        )}
      </motion.div>
    </motion.div>
  );
}
