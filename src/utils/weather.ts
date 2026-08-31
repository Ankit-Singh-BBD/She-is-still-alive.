// ===================================================================
// WEATHER UTILITIES - Condition → icon, label, color
// ===================================================================

export type WeatherCondition =
  | 'clear' | 'clouds' | 'rain' | 'drizzle' | 'thunderstorm'
  | 'snow' | 'mist' | 'fog' | 'haze' | 'smoke' | 'dust' | 'sand'
  | 'tornado' | 'squall' | 'ash' | 'unknown';

export interface WeatherVisual {
  icon: string;
  label: string;
  /** Tailwind gradient (atmospheric) */
  gradient: string;
  /** Tailwind gradient (UI accent) */
  accent: string;
  /** Text color for headings */
  textAccent: string;
}

const VISUALS: Record<WeatherCondition, WeatherVisual> = {
  clear: {
    icon: '☀️',
    label: 'Clear Sky',
    gradient: 'from-amber-400/30 via-orange-400/20 to-rose-400/20',
    accent: 'from-amber-300 to-orange-400',
    textAccent: 'text-amber-200',
  },
  clouds: {
    icon: '☁️',
    label: 'Cloudy',
    gradient: 'from-slate-400/25 via-gray-400/15 to-zinc-400/20',
    accent: 'from-slate-300 to-gray-400',
    textAccent: 'text-slate-200',
  },
  rain: {
    icon: '🌧️',
    label: 'Rainy',
    gradient: 'from-slate-500/35 via-blue-500/20 to-indigo-500/25',
    accent: 'from-sky-400 to-blue-500',
    textAccent: 'text-sky-200',
  },
  drizzle: {
    icon: '🌦️',
    label: 'Drizzle',
    gradient: 'from-slate-400/30 via-blue-400/20 to-indigo-500/20',
    accent: 'from-sky-300 to-blue-400',
    textAccent: 'text-sky-200',
  },
  thunderstorm: {
    icon: '⛈️',
    label: 'Thunderstorm',
    gradient: 'from-slate-700/45 via-purple-600/25 to-indigo-700/30',
    accent: 'from-violet-400 to-purple-500',
    textAccent: 'text-violet-200',
  },
  snow: {
    icon: '❄️',
    label: 'Snowy',
    gradient: 'from-blue-200/30 via-indigo-200/20 to-violet-200/25',
    accent: 'from-blue-200 to-indigo-300',
    textAccent: 'text-blue-100',
  },
  mist: {
    icon: '🌫️',
    label: 'Misty',
    gradient: 'from-slate-300/25 via-gray-300/15 to-zinc-300/20',
    accent: 'from-slate-200 to-gray-300',
    textAccent: 'text-slate-100',
  },
  fog: {
    icon: '🌫️',
    label: 'Foggy',
    gradient: 'from-slate-400/30 via-gray-400/20 to-zinc-400/20',
    accent: 'from-slate-300 to-gray-400',
    textAccent: 'text-slate-200',
  },
  haze: {
    icon: '🌫️',
    label: 'Hazy',
    gradient: 'from-amber-300/20 via-orange-300/15 to-yellow-300/15',
    accent: 'from-amber-200 to-orange-300',
    textAccent: 'text-amber-100',
  },
  smoke: {
    icon: '💨',
    label: 'Smoky',
    gradient: 'from-slate-500/30 via-gray-500/20 to-zinc-500/20',
    accent: 'from-slate-400 to-gray-500',
    textAccent: 'text-slate-200',
  },
  dust: {
    icon: '🏜️',
    label: 'Dusty',
    gradient: 'from-amber-500/30 via-yellow-500/20 to-orange-500/25',
    accent: 'from-amber-400 to-yellow-500',
    textAccent: 'text-amber-200',
  },
  sand: {
    icon: '🏜️',
    label: 'Sandy',
    gradient: 'from-amber-600/30 via-yellow-600/20 to-orange-600/25',
    accent: 'from-amber-500 to-yellow-600',
    textAccent: 'text-amber-200',
  },
  tornado: {
    icon: '🌪️',
    label: 'Tornado',
    gradient: 'from-slate-700/45 via-zinc-700/30 to-gray-700/30',
    accent: 'from-slate-500 to-zinc-600',
    textAccent: 'text-slate-200',
  },
  squall: {
    icon: '💨',
    label: 'Squally',
    gradient: 'from-slate-500/30 via-blue-500/20 to-indigo-500/25',
    accent: 'from-slate-400 to-indigo-500',
    textAccent: 'text-slate-200',
  },
  ash: {
    icon: '🌋',
    label: 'Ashy',
    gradient: 'from-stone-500/30 via-zinc-500/20 to-gray-500/25',
    accent: 'from-stone-400 to-zinc-500',
    textAccent: 'text-stone-200',
  },
  unknown: {
    icon: '🌤️',
    label: 'Pleasant',
    gradient: 'from-blue-400/20 via-cyan-400/15 to-sky-400/20',
    accent: 'from-blue-300 to-cyan-400',
    textAccent: 'text-blue-200',
  },
};

/**
 * Map an OpenWeatherMap condition string to a normalized key
 */
export function normalizeCondition(raw: string | undefined | null): WeatherCondition {
  if (!raw) return 'unknown';
  const s = raw.toLowerCase().trim();
  if (s.includes('thunder') || s.includes('storm')) return 'thunderstorm';
  if (s.includes('drizzle')) return 'drizzle';
  if (s.includes('rain') || s.includes('shower')) return 'rain';
  if (s.includes('snow')) return 'snow';
  if (s.includes('tornado')) return 'tornado';
  if (s.includes('squall')) return 'squall';
  if (s.includes('ash')) return 'ash';
  if (s.includes('dust')) return 'dust';
  if (s.includes('sand')) return 'sand';
  if (s.includes('smoke')) return 'smoke';
  if (s.includes('haze')) return 'haze';
  if (s.includes('fog')) return 'fog';
  if (s.includes('mist')) return 'mist';
  if (s.includes('cloud')) return 'clouds';
  if (s.includes('clear')) return 'clear';
  return 'unknown';
}

/**
 * Get visual representation for a weather condition
 */
export function getWeatherVisual(raw: string | undefined | null): WeatherVisual {
  return VISUALS[normalizeCondition(raw)];
}

/**
 * Map temperature to a "feeling" descriptor
 */
export function temperatureFeels(celsius: number | undefined): {
  label: string;
  mood: 'cold' | 'cool' | 'pleasant' | 'warm' | 'hot' | 'scorching';
  accent: string;
} {
  if (celsius === undefined || celsius === null) {
    return { label: 'Unknown', mood: 'pleasant', accent: 'text-white/70' };
  }
  if (celsius < 5) return { label: 'Freezing', mood: 'cold', accent: 'text-blue-200' };
  if (celsius < 15) return { label: 'Chilly', mood: 'cold', accent: 'text-sky-200' };
  if (celsius < 22) return { label: 'Cool', mood: 'cool', accent: 'text-cyan-200' };
  if (celsius < 28) return { label: 'Pleasant', mood: 'pleasant', accent: 'text-emerald-200' };
  if (celsius < 33) return { label: 'Warm', mood: 'warm', accent: 'text-amber-200' };
  if (celsius < 38) return { label: 'Hot', mood: 'hot', accent: 'text-orange-300' };
  return { label: 'Scorching', mood: 'scorching', accent: 'text-rose-300' };
}
