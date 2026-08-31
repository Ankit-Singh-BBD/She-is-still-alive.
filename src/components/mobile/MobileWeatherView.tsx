// ===================================================================
// MOBILE WEATHER VIEW - Real Meteorological & Astronomical Insights
// ===================================================================

import React from 'react';
import { motion } from 'motion/react';
import { useWeather, useTimeOfDay } from '../../hooks/useUIState.js';
import { formatTemp } from '../../utils/format.js';
import { getWeatherVisual, temperatureFeels } from '../../utils/weather.js';
import { MapPin, Wind, Droplets, Sunrise, Sunset, Cloud, ArrowLeft } from 'lucide-react';

interface MobileWeatherViewProps {
  onClose?: () => void;
}

export function MobileWeatherView({ onClose }: MobileWeatherViewProps) {
  const weather = useWeather();
  const { istHour } = useTimeOfDay();

  const visual = getWeatherVisual(weather?.condition);
  const feels = temperatureFeels(weather?.temperature);
  const location = weather?.locationName || 'Orai, UP';

  return (
    <div className="w-full h-full flex flex-col p-4 overflow-y-auto custom-scrollbar">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full glass flex items-center justify-center text-white/80 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        )}
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white/90">
          <MapPin className="w-3.5 h-3.5 text-indigo-300" />
          <span>{location}</span>
        </div>
        <div className="w-8" />
      </div>

      {/* Hero Weather Card */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full glass-panel rounded-3xl p-6 flex flex-col items-center text-center shadow-xl border border-white/15 mb-4"
      >
        <span className="text-5xl mb-2">{visual.icon}</span>
        <h2 className="text-4xl font-bold tracking-tight text-white mb-1">
          {weather?.temperature !== undefined ? formatTemp(weather.temperature) : '--°C'}
        </h2>
        <p className="text-sm font-medium text-white/80 capitalize mb-1">{visual.label}</p>
        <p className="text-xs text-white/50">{feels.label} · Feels like {weather?.feelsLike !== undefined ? `${Math.round(weather.feelsLike)}°C` : '--'}</p>

        {/* Environmental Metrics Grid */}
        <div className="grid grid-cols-2 gap-3 w-full mt-6 pt-4 border-t border-white/10 text-xs">
          <div className="glass rounded-2xl p-3 flex items-center gap-2.5">
            <Droplets className="w-4 h-4 text-sky-300" />
            <div className="text-left">
              <p className="text-[10px] text-white/45">Humidity</p>
              <p className="font-semibold text-white/90">{weather?.humidity ?? 60}%</p>
            </div>
          </div>
          <div className="glass rounded-2xl p-3 flex items-center gap-2.5">
            <Wind className="w-4 h-4 text-teal-300" />
            <div className="text-left">
              <p className="text-[10px] text-white/45">Wind</p>
              <p className="font-semibold text-white/90">{weather?.windSpeed ?? 12} km/h</p>
            </div>
          </div>
          <div className="glass rounded-2xl p-3 flex items-center gap-2.5">
            <Sunrise className="w-4 h-4 text-amber-300" />
            <div className="text-left">
              <p className="text-[10px] text-white/45">Sunrise</p>
              <p className="font-semibold text-white/90">{weather?.sunrise || '05:48 AM'}</p>
            </div>
          </div>
          <div className="glass rounded-2xl p-3 flex items-center gap-2.5">
            <Sunset className="w-4 h-4 text-orange-300" />
            <div className="text-left">
              <p className="text-[10px] text-white/45">Sunset</p>
              <p className="font-semibold text-white/90">{weather?.sunset || '07:01 PM'}</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* Hourly Forecast */}
      {weather?.hourly && weather.hourly.length > 0 && (
        <div className="w-full glass-panel rounded-3xl p-4">
          <p className="text-xs font-semibold text-white/70 uppercase tracking-wider mb-3 px-1">
            24-Hour Forecast
          </p>
          <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
            {weather.hourly.map((h, i) => {
              const hVisual = getWeatherVisual(h.condition);
              return (
                <div
                  key={i}
                  className="flex flex-col items-center justify-between p-2.5 min-w-[64px] rounded-2xl glass shrink-0"
                >
                  <span className="text-[10px] text-white/60">{h.time}</span>
                  <span className="text-lg my-1.5">{hVisual.icon}</span>
                  <span className="text-xs font-semibold text-white/90">{Math.round(h.temp)}°</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
