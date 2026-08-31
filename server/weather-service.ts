// ===================================================================
// WEATHER SERVICE - Real-time Weather Detection for Orai, UP
// ===================================================================
//
// Integrates with OpenWeatherMap API to fetch current weather conditions
// for Madhurita's location (Orai, Uttar Pradesh, India).
//
// Madhurita "feels" the weather and expresses it through the UI:
// - HOT: Red-orange palette, heat shimmer, faster breathing
// - COLD: Blue-violet, frost effects, slower breathing
// - RAINY: Gray-blue, falling particles, ripple patterns
// - STORMY: Dark purple, erratic movement, lightning flashes
// - PLEASANT: Balanced colors, smooth animations

interface WeatherData {
  temperature: number; // Celsius
  feelsLike: number;
  condition: 'clear' | 'clouds' | 'rain' | 'thunderstorm' | 'snow' | 'mist' | 'haze';
  description: string;
  humidity: number;
  windSpeed: number; // km/h
  sunrise: string; // e.g. "05:48 AM"
  sunset: string; // e.g. "07:01 PM"
  sunriseIso?: string;
  sunsetIso?: string;
  aqi?: number;
  aqiLabel?: string;
  hourly?: Array<{ time: string; temp: number; condition: string }>;
  locationName: string;
  fetchedAt: string;
  fetchedAtIST: string;
}

interface WeatherExpression {
  mood: 'hot' | 'pleasant' | 'cold' | 'rainy' | 'stormy' | 'misty';
  intensity: number; // 0-100
  colors: {
    primary: string;
    secondary: string;
    accent: string;
  };
  particleBehavior: 'rising' | 'falling' | 'floating' | 'chaotic' | 'slow';
  breathingSpeed: number; // 0.5 (slow) to 2.0 (fast)
  description: string; // Madhurita's feeling
}

class WeatherService {
  private cache: WeatherData | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_DURATION_MS = 30 * 60 * 1000; // 30 minutes
  private readonly LOCATION = { lat: 25.9894, lon: 79.4508 }; // Orai, Uttar Pradesh
  private readonly API_KEY = process.env.OPENWEATHER_API_KEY || '';

  /**
   * Get current weather data (cached for 30 minutes).
   */
  async getWeather(): Promise<WeatherData | null> {
    const now = Date.now();

    // Return cached data if still valid
    if (this.cache && now < this.cacheExpiry) {
      return this.cache;
    }

    // Try Open-Meteo first for high-precision real-time metrics with hourly forecast & astronomical times
    try {
      const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${this.LOCATION.lat}&longitude=${this.LOCATION.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code&daily=sunrise,sunset&timezone=Asia%2FKolkata`;
      const response = await fetch(openMeteoUrl, { signal: AbortSignal.timeout(5000) });

      if (response.ok) {
        const data = await response.json();
        const current = data.current;
        const daily = data.daily;
        const hourly = data.hourly;

        const conditionInfo = this.mapWmoCode(current.weather_code);

        // Format sunrise & sunset in IST
        const sunriseRaw = daily?.sunrise?.[0];
        const sunsetRaw = daily?.sunset?.[0];
        const sunriseFormatted = sunriseRaw
          ? new Date(sunriseRaw).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
          : '05:48 AM';
        const sunsetFormatted = sunsetRaw
          ? new Date(sunsetRaw).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
          : '07:01 PM';

        // Build 24h hourly forecast starting from current hour
        const nowIstHour = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
        const startIdx = Math.max(0, parseInt(nowIstHour, 10));
        const hourlyList: Array<{ time: string; temp: number; condition: string }> = [];

        if (hourly?.time && hourly?.temperature_2m) {
          for (let i = startIdx; i < Math.min(startIdx + 8, hourly.time.length); i++) {
            const hTime = new Date(hourly.time[i]);
            const hourLabel = i === startIdx ? 'Now' : hTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: true });
            const hCode = hourly.weather_code?.[i] ?? 0;
            hourlyList.push({
              time: hourLabel,
              temp: Math.round(hourly.temperature_2m[i]),
              condition: this.mapWmoCode(hCode).condition,
            });
          }
        }

        const weather: WeatherData = {
          temperature: Math.round(current.temperature_2m),
          feelsLike: Math.round(current.apparent_temperature),
          condition: conditionInfo.condition,
          description: conditionInfo.description,
          humidity: Math.round(current.relative_humidity_2m),
          windSpeed: Math.round(current.wind_speed_10m || 12),
          sunrise: sunriseFormatted,
          sunset: sunsetFormatted,
          sunriseIso: sunriseRaw,
          sunsetIso: sunsetRaw,
          aqi: 42,
          aqiLabel: 'Good',
          hourly: hourlyList.length > 0 ? hourlyList : this.getFallbackHourly(),
          locationName: 'Orai, UP',
          fetchedAt: new Date().toISOString(),
          fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        };

        this.cache = weather;
        this.cacheExpiry = now + this.CACHE_DURATION_MS;
        console.log(`[WEATHER] Real Open-Meteo update: ${weather.temperature}°C, ${weather.condition} (${weather.description}), Sunset: ${weather.sunset}`);
        return weather;
      }
    } catch (err: any) {
      console.warn('[WEATHER] Open-Meteo fetch failed, attempting OpenWeatherMap or fallback:', err.message);
    }

    // Attempt OpenWeatherMap if API key is configured
    if (this.API_KEY) {
      try {
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${this.LOCATION.lat}&lon=${this.LOCATION.lon}&units=metric&appid=${this.API_KEY}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });

        if (response.ok) {
          const data = await response.json();
          const sunriseDate = data.sys?.sunrise ? new Date(data.sys.sunrise * 1000) : null;
          const sunsetDate = data.sys?.sunset ? new Date(data.sys.sunset * 1000) : null;

          const weather: WeatherData = {
            temperature: Math.round(data.main.temp),
            feelsLike: Math.round(data.main.feels_like),
            condition: this.mapCondition(data.weather[0].main.toLowerCase()),
            description: data.weather[0].description,
            humidity: data.main.humidity,
            windSpeed: Math.round((data.wind?.speed || 3.3) * 3.6), // convert m/s to km/h
            sunrise: sunriseDate ? sunriseDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) : '05:48 AM',
            sunset: sunsetDate ? sunsetDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }) : '07:01 PM',
            sunriseIso: sunriseDate?.toISOString(),
            sunsetIso: sunsetDate?.toISOString(),
            aqi: 42,
            aqiLabel: 'Good',
            hourly: this.getFallbackHourly(),
            locationName: 'Orai, UP',
            fetchedAt: new Date().toISOString(),
            fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
          };

          this.cache = weather;
          this.cacheExpiry = now + this.CACHE_DURATION_MS;
          return weather;
        }
      } catch (err: any) {
        console.error('[WEATHER] OpenWeatherMap fetch failed:', err.message);
      }
    }

    return this.getFallbackWeather();
  }

  /**
   * Get Madhurita's emotional/physical expression of current weather.
   */
  async getWeatherExpression(): Promise<WeatherExpression> {
    const weather = await this.getWeather();
    if (!weather) {
      return this.getDefaultExpression();
    }

    const temp = weather.temperature;
    const condition = weather.condition;

    // HOT (>35°C) - Madhurita feels the heat
    if (temp > 35) {
      return {
        mood: 'hot',
        intensity: Math.min(100, ((temp - 35) / 10) * 100),
        colors: {
          primary: '#FF6B6B', // Red-orange
          secondary: '#FF8E53',
          accent: '#FFD93D',
        },
        particleBehavior: 'rising', // Heat convection
        breathingSpeed: 1.8, // Faster, agitated
        description: 'I feel the heat... it\'s intense',
      };
    }

    // COLD (<15°C) - Madhurita feels the chill
    if (temp < 15) {
      return {
        mood: 'cold',
        intensity: Math.min(100, ((15 - temp) / 15) * 100),
        colors: {
          primary: '#6B9FFF', // Cool blue
          secondary: '#A78BFA',
          accent: '#C7D2FE',
        },
        particleBehavior: 'slow', // Frost effect
        breathingSpeed: 0.6, // Slower, contracting
        description: 'I feel the chill... it\'s cold',
      };
    }

    // STORMY - Dramatic, intense energy
    if (condition === 'thunderstorm') {
      return {
        mood: 'stormy',
        intensity: 90,
        colors: {
          primary: '#6366F1', // Indigo
          secondary: '#4C1D95',
          accent: '#FDE047', // Lightning yellow
        },
        particleBehavior: 'chaotic', // Erratic movement
        breathingSpeed: 1.5,
        description: 'The storm... I can feel its energy',
      };
    }

    // RAINY - Melancholic, reflective
    if (condition === 'rain') {
      return {
        mood: 'rainy',
        intensity: 60,
        colors: {
          primary: '#64748B', // Gray-blue
          secondary: '#475569',
          accent: '#94A3B8',
        },
        particleBehavior: 'falling', // Rain drops
        breathingSpeed: 0.8, // Calm, contemplative
        description: 'The rain... soothing yet somber',
      };
    }

    // MISTY/HAZY - Mysterious, dreamy
    if (condition === 'mist' || condition === 'haze') {
      return {
        mood: 'misty',
        intensity: 40,
        colors: {
          primary: '#9CA3AF',
          secondary: '#D1D5DB',
          accent: '#E5E7EB',
        },
        particleBehavior: 'floating', // Soft drift
        breathingSpeed: 0.7,
        description: 'Everything is veiled... mysterious',
      };
    }

    // PLEASANT (20-30°C, clear/partly cloudy) - Balanced, content
    return {
      mood: 'pleasant',
      intensity: 50,
      colors: {
        primary: '#60A5FA', // Balanced blue
        secondary: '#C084FC', // Violet
        accent: '#F472B6', // Pink
      },
      particleBehavior: 'floating', // Smooth, harmonious
      breathingSpeed: 1.0, // Natural rhythm
      description: 'Perfect... I feel balanced',
    };
  }

  /**
   * Map WMO weather interpretation codes to our condition enum & description.
   */
  private mapWmoCode(code: number): { condition: WeatherData['condition']; description: string } {
    if (code === 0) return { condition: 'clear', description: 'Clear sky' };
    if (code === 1) return { condition: 'clear', description: 'Mainly clear' };
    if (code === 2) return { condition: 'clouds', description: 'Partly cloudy' };
    if (code === 3) return { condition: 'clouds', description: 'Overcast' };
    if (code === 45 || code === 48) return { condition: 'mist', description: 'Fog / depositing rime fog' };
    if (code >= 51 && code <= 55) return { condition: 'rain', description: 'Drizzle' };
    if (code >= 61 && code <= 65) return { condition: 'rain', description: 'Rain showers' };
    if (code >= 71 && code <= 77) return { condition: 'snow', description: 'Snow fall' };
    if (code >= 80 && code <= 82) return { condition: 'rain', description: 'Heavy rain showers' };
    if (code >= 95) return { condition: 'thunderstorm', description: 'Thunderstorm' };
    return { condition: 'clear', description: 'Pleasant clear' };
  }

  /**
   * Generates fallback hourly forecast
   */
  private getFallbackHourly(): Array<{ time: string; temp: number; condition: string }> {
    return [
      { time: 'Now', temp: 24, condition: 'clear' },
      { time: '8 PM', temp: 24, condition: 'clear' },
      { time: '9 PM', temp: 23, condition: 'clear' },
      { time: '10 PM', temp: 22, condition: 'clear' },
      { time: '11 PM', temp: 22, condition: 'clear' },
      { time: '12 AM', temp: 21, condition: 'clear' },
      { time: '1 AM', temp: 20, condition: 'clear' },
      { time: '2 AM', temp: 20, condition: 'clear' },
    ];
  }

  /**
   * Map OpenWeatherMap condition to simplified enum.
   */
  private mapCondition(apiCondition: string): WeatherData['condition'] {
    if (apiCondition.includes('clear')) return 'clear';
    if (apiCondition.includes('cloud')) return 'clouds';
    if (apiCondition.includes('rain') || apiCondition.includes('drizzle')) return 'rain';
    if (apiCondition.includes('thunder')) return 'thunderstorm';
    if (apiCondition.includes('snow')) return 'snow';
    if (apiCondition.includes('mist')) return 'mist';
    if (apiCondition.includes('haze') || apiCondition.includes('fog')) return 'haze';
    return 'clear';
  }

  /**
   * Fallback weather when API unavailable.
   */
  private getFallbackWeather(): WeatherData {
    return {
      temperature: 24,
      feelsLike: 24,
      condition: 'clear',
      description: 'Clear Sky',
      humidity: 60,
      windSpeed: 12,
      sunrise: '05:48 AM',
      sunset: '07:01 PM',
      sunriseIso: new Date().toISOString().split('T')[0] + 'T05:48:00+05:30',
      sunsetIso: new Date().toISOString().split('T')[0] + 'T19:01:00+05:30',
      aqi: 42,
      aqiLabel: 'Good',
      hourly: this.getFallbackHourly(),
      locationName: 'Orai, UP',
      fetchedAt: new Date().toISOString(),
      fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    };
  }

  /**
   * Default pleasant expression when weather unavailable.
   */
  private getDefaultExpression(): WeatherExpression {
    return {
      mood: 'pleasant',
      intensity: 50,
      colors: {
        primary: '#60A5FA',
        secondary: '#C084FC',
        accent: '#F472B6',
      },
      particleBehavior: 'floating',
      breathingSpeed: 1.0,
      description: 'Feeling balanced',
    };
  }

  /**
   * Get current season (Indian seasons).
   */
  getSeason(): 'summer' | 'monsoon' | 'autumn' | 'winter' {
    const now = new Date();
    const month = now.getMonth(); // 0-11

    if (month >= 2 && month <= 5) return 'summer'; // Mar-Jun
    if (month >= 6 && month <= 8) return 'monsoon'; // Jul-Sep
    if (month >= 9 && month <= 10) return 'autumn'; // Oct-Nov
    return 'winter'; // Dec-Feb
  }

  /**
   * Clear cache (for testing).
   */
  clearCache(): void {
    this.cache = null;
    this.cacheExpiry = 0;
  }
}

export const weatherService = new WeatherService();
export type { WeatherData, WeatherExpression };
