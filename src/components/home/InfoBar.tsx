// ===================================================================
// INFO BAR - Bottom info strip (time, sunrise, sunset, AQI)
// ===================================================================

import { motion } from 'motion/react';
import { useTimeOfDay, useWeather } from '../../hooks/useUIState.js';
import { formatTime, getGreeting } from '../../utils/format.js';
import { MapPin, Sunrise, Sunset, Clock, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

interface InfoBarProps {
  location?: string;
  className?: string;
}

export function InfoBar({ location = 'Orai, UP', className = '' }: InfoBarProps) {
  const { istHour, timeOfDay } = useTimeOfDay();
  const weather = useWeather();
  const [now, setNow] = useState(new Date());

  // Tick clock every 30s
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  // Compute sunrise / sunset (approximate, based on IST hour for the date)
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000,
  );
  // Orai, UP — approximate sunrise 5:30-6:15 IST, sunset 18:30-19:00 IST
  const sunriseMin = 330 + Math.round(20 * Math.sin(((dayOfYear - 80) / 365) * 2 * Math.PI)); // 5:30 + drift
  const sunsetMin = 1110 + Math.round(20 * Math.sin(((dayOfYear - 80) / 365) * 2 * Math.PI)); // 18:30 + drift
  const sunrise = `${String(Math.floor(sunriseMin / 60)).padStart(2, '0')}:${String(sunriseMin % 60).padStart(2, '0')}`;
  const sunset = `${String(Math.floor(sunsetMin / 60)).padStart(2, '0')}:${String(sunsetMin % 60).padStart(2, '0')}`;

  // Current IST time
  const istNow = now.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6, duration: 0.5 }}
      className={`flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[11.5px] text-white/50 ${className}`}
    >
      <span className="flex items-center gap-1.5">
        <MapPin className="w-3 h-3" />
        <span className="text-white/70 font-medium">{location}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Clock className="w-3 h-3" />
        <span className="tabular-nums text-white/65 font-medium">{istNow} IST</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Sunrise className="w-3 h-3 text-amber-300/80" />
        <span className="tabular-nums text-white/55">{sunrise}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Sunset className="w-3 h-3 text-orange-300/80" />
        <span className="tabular-nums text-white/55">{sunset}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <Sparkles className="w-3 h-3 text-indigo-300/80" />
        <span className="text-white/55 capitalize">{timeOfDay}</span>
      </span>
    </motion.div>
  );
}
