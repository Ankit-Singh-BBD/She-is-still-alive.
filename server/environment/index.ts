/**
 * Where she is and what the sky is doing.
 *
 * `EnvironmentService` is the only thing outside this directory should need;
 * the pure functions are exported because the tests pin them directly and
 * because `derivePalette` is useful to a renderer on its own.
 */

export {
  conditionForWmoCode,
  parseOpenMeteo,
  unknownWeather,
  OpenMeteoProvider,
  type WeatherCondition,
  type WeatherObservation,
  type WeatherProvider,
  type OpenMeteoOptions,
} from './weather.js';

export {
  resolveTimeOfDay,
  hourInZone,
  TRANSITION_WINDOW_MS,
  type SolarTimes,
  type TimeOfDayBasis,
  type TimeOfDayReading,
} from './time-of-day.js';

export { derivePalette, hslToHex } from './palette.js';

export {
  EnvironmentService,
  WEATHER_TTL_MS,
  type EnvironmentServiceOptions,
  type EnvironmentReport,
} from './service.js';
