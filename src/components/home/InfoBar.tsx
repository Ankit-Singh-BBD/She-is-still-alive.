// ===================================================================
// INFO BAR - 3-Column Glass Info Bar (Location & Weather | Digital Clock | Astronomy)
// ===================================================================

import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useTimeOfDay, useWeather } from '../../hooks/useUIState.js';
import { formatTemp } from '../../utils/format.js';
import { getWeatherVisual } from '../../utils/weather.js';
import { MapPin, Sunrise, Sunset, Clock, Sparkles } from 'lucide-react';

interface InfoBarProps {
  location?: string;
  className?: string;
}

export function InfoBar({ location, className = '' }: InfoBarProps) {
  const { istHour, timeOfDay } = useTimeOfDay();
  const weather = useWeather();
  const [now, setNow] = useState(new Date());

  // Tick clock every second for smooth digital display
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Formatted IST time (12-hour with AM/PM)
  const istTimeFormatted = now.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const displayLocation = location || weather?.locationName || 'Orai, UP';
  const weatherVisual = getWeatherVisual(weather?.condition);
  const sunriseTime = weather?.sunrise || '05:48 AM';
  const sunsetTime = weather?.sunset || '07:01 PM';

  // Determine whether to highlight sunrise or sunset depending on hour
  const isAfterSunset = istHour >= 19 || istHour < 5;
  const isDaytime = istHour >= 5 && istHour < 19;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.4, duration: 0.5 }}
      className={`w-full max-w-2xl mx-auto grid grid-cols-3 items-center gap-2 px-4 py-2 rounded-2xl glass-panel text-xs text-white/70 shadow-lg border border-white/10 ${className}`}
    >
      {/* Column 1: Location & Live Weather */}
      <div className="flex items-center gap-2 min-w-0">
        <div className="w-7 h-7 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center text-sm shrink-0">
          {weatherVisual.icon || <MapPin className="w-3.5 h-3.5 text-white/70" />}
        </div>
        <div className="min-w-0 truncate">
          <p className="text-[11px] font-semibold text-white/90 truncate leading-tight">
            {displayLocation}
          </p>
          <p className="text-[10px] text-white/50 truncate leading-tight mt-0.5">
            {weather?.temperature !== undefined ? `${formatTemp(weather.temperature)} · ${weatherVisual.label}` : 'Live Weather'}
          </p>
        </div>
      </div>

      {/* Column 2: Digital Clock */}
      <div className="flex flex-col items-center justify-center text-center">
        <div className="flex items-center gap-1 text-[12px] font-semibold tracking-wider text-white tabular-nums">
          <Clock className="w-3 h-3 text-indigo-300/80" />
          <span>{istTimeFormatted}</span>
        </div>
        <span className="text-[9.5px] uppercase tracking-[0.14em] text-white/40 leading-tight mt-0.5">
          IST · {timeOfDay}
        </span>
      </div>

      {/* Column 3: Astronomical Sunrise/Sunset */}
      <div className="flex items-center justify-end gap-2 text-right min-w-0">
        <div className="min-w-0 truncate">
          <p className="text-[11px] font-semibold text-white/90 truncate leading-tight">
            {isDaytime ? `Sunset ${sunsetTime}` : `Sunrise ${sunriseTime}`}
          </p>
          <p className="text-[10px] text-white/50 truncate leading-tight mt-0.5">
            {isDaytime ? `Dawn: ${sunriseTime}` : `Dusk: ${sunsetTime}`}
          </p>
        </div>
        <div className="w-7 h-7 rounded-xl bg-white/[0.06] border border-white/10 flex items-center justify-center text-sm shrink-0">
          {isDaytime ? (
            <Sunset className="w-3.5 h-3.5 text-orange-300" />
          ) : (
            <Sunrise className="w-3.5 h-3.5 text-amber-300" />
          )}
        </div>
      </div>
    </motion.div>
  );
}
