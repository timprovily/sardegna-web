// Weather for a route, plus a suggested departure time.
//
// Open-Meteo is free for non-commercial use, needs no API key and no
// account, and sends permissive CORS headers — so it can be called
// straight from the browser, same as Wikipedia. It also returns sunrise
// and sunset for the exact spot, which is more accurate than the
// approximation theme.js uses for dimming the screen, so where we have a
// connection we prefer these numbers.

const BASE = 'https://api.open-meteo.com/v1/forecast';

// WMO weather codes, condensed to what a driver actually cares about.
const CODES = {
  0:  { icon: '☀️', nl: 'Onbewolkt',            en: 'Clear' },
  1:  { icon: '🌤️', nl: 'Overwegend zonnig',    en: 'Mainly clear' },
  2:  { icon: '⛅', nl: 'Half bewolkt',          en: 'Partly cloudy' },
  3:  { icon: '☁️', nl: 'Bewolkt',               en: 'Overcast' },
  45: { icon: '🌫️', nl: 'Mist',                  en: 'Fog' },
  48: { icon: '🌫️', nl: 'Aanvriezende mist',     en: 'Rime fog' },
  51: { icon: '🌦️', nl: 'Lichte motregen',       en: 'Light drizzle' },
  53: { icon: '🌦️', nl: 'Motregen',              en: 'Drizzle' },
  55: { icon: '🌦️', nl: 'Dichte motregen',       en: 'Dense drizzle' },
  61: { icon: '🌧️', nl: 'Lichte regen',          en: 'Light rain' },
  63: { icon: '🌧️', nl: 'Regen',                 en: 'Rain' },
  65: { icon: '🌧️', nl: 'Zware regen',           en: 'Heavy rain' },
  71: { icon: '🌨️', nl: 'Lichte sneeuw',         en: 'Light snow' },
  73: { icon: '🌨️', nl: 'Sneeuw',                en: 'Snow' },
  75: { icon: '🌨️', nl: 'Zware sneeuw',          en: 'Heavy snow' },
  80: { icon: '🌦️', nl: 'Buien',                 en: 'Showers' },
  81: { icon: '🌦️', nl: 'Stevige buien',         en: 'Heavy showers' },
  82: { icon: '⛈️', nl: 'Zware buien',           en: 'Violent showers' },
  95: { icon: '⛈️', nl: 'Onweer',                en: 'Thunderstorm' },
  96: { icon: '⛈️', nl: 'Onweer met hagel',      en: 'Thunderstorm with hail' },
  99: { icon: '⛈️', nl: 'Zwaar onweer met hagel', en: 'Severe thunderstorm with hail' }
};

export function describeCode(code, lang) {
  const entry = CODES[code] || { icon: '🌡️', nl: 'Onbekend', en: 'Unknown' };
  return { icon: entry.icon, text: entry[lang] || entry.en };
}

const cache = new Map();

/** Today and tomorrow at a coordinate, plus sunrise/sunset and wind. */
export async function fetchWeather(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = cache.get(key);
  // Weather goes stale; half an hour is plenty fresh for trip planning.
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.data;

  const url =
    `${BASE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    `&current=temperature_2m,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&forecast_days=2&timezone=auto&wind_speed_unit=kmh`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    // Offline, or the service is having a moment. The route screen simply
    // leaves the weather panel out rather than showing an error.
    return null;
  }
}

/**
 * When to set off so the last stretch falls in the golden hour.
 *
 * The best light on a coast road is the hour before sunset, and every one
 * of these routes ends somewhere worth seeing in that light. So: work
 * backwards from sunset, land you at the end about twenty minutes before
 * it, and allow a generous margin for the stops you'll actually make.
 */
export function goldenHourDeparture(sunsetISO, durationMinutes) {
  if (!sunsetISO) return null;
  const sunset = new Date(sunsetISO);
  const arrive = new Date(sunset.getTime() - 20 * 60 * 1000);
  // Real driving always takes longer than the raw estimate: photos,
  // coffee, a herd of goats. Half again is about right on these roads.
  const travelMs = durationMinutes * 1.5 * 60 * 1000;
  return {
    depart: new Date(arrive.getTime() - travelMs),
    arrive,
    sunset
  };
}

export function formatTime(date, lang) {
  if (!date) return '—';
  return date.toLocaleTimeString(lang === 'nl' ? 'nl-NL' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit'
  });
}
