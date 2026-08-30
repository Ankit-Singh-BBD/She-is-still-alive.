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

    // Fetch fresh weather data
    if (!this.API_KEY) {
      console.warn('[WEATHER] No API key configured, using fallback pleasant weather');
      return this.getFallbackWeather();
    }

    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${this.LOCATION.lat}&lon=${this.LOCATION.lon}&units=metric&appid=${this.API_KEY}`;
      const response = await fetch(url);

      if (!response.ok) {
        console.warn(`[WEATHER] API error: ${response.status}`);
        return this.getFallbackWeather();
      }

      const data = await response.json();

      const weather: WeatherData = {
        temperature: Math.round(data.main.temp),
        feelsLike: Math.round(data.main.feels_like),
        condition: this.mapCondition(data.weather[0].main.toLowerCase()),
        description: data.weather[0].description,
        humidity: data.main.humidity,
        fetchedAt: new Date().toISOString(),
        fetchedAtIST: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      };

      this.cache = weather;
      this.cacheExpiry = now + this.CACHE_DURATION_MS;

      console.log(`[WEATHER] Updated: ${weather.temperature}°C, ${weather.condition} (${weather.description})`);
      return weather;
    } catch (err: any) {
      console.error('[WEATHER] Fetch failed:', err.message);
      return this.getFallbackWeather();
    }
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
      temperature: 28,
      feelsLike: 30,
      condition: 'clear',
      description: 'clear sky',
      humidity: 60,
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
