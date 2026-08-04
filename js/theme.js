// Light and dark mode.
//
// Three settings: 'auto', 'light', 'dark'. On auto the theme follows the
// actual sun at your location — dark between sunset and sunrise — which is
// what you want in a car: a bright screen at dusk is genuinely unpleasant
// to drive with.
//
// If we have no location yet (permission not granted, or you're just
// browsing at home), auto falls back to the phone's own appearance
// setting via prefers-color-scheme, and switches the moment iOS does.

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export class ThemeManager extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.coords = null;
    this.timer = null;

    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaQuery.addEventListener('change', () => {
      if (this.settings.theme === 'auto') this.apply();
    });
  }

  start() {
    this.apply();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.settings.theme === 'auto') this.apply();
    }, CHECK_INTERVAL_MS);
  }

  /** Called whenever a GPS fix arrives, so auto mode uses real sun times. */
  setCoords(lat, lon) {
    const changed = !this.coords || Math.abs(this.coords.lat - lat) > 0.5;
    this.coords = { lat, lon };
    if (changed && this.settings.theme === 'auto') this.apply();
  }

  /** Resolves the setting to an actual theme and writes it to the document. */
  apply() {
    const resolved = this.resolve();
    document.documentElement.setAttribute('data-theme', resolved);

    // Keep the iOS status bar and browser chrome in step with the theme.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#101418' : '#F7F5F1');

    this.dispatchEvent(new CustomEvent('change', { detail: { theme: resolved } }));
    return resolved;
  }

  resolve() {
    const mode = this.settings.theme || 'auto';
    if (mode === 'light' || mode === 'dark') return mode;

    if (this.coords) {
      const now = new Date();
      const times = sunTimes(now, this.coords.lat, this.coords.lon);
      if (times === 'always-up') return 'light';
      if (times === 'always-down') return 'dark';
      return now >= times.sunrise && now < times.sunset ? 'light' : 'dark';
    }

    return this.mediaQuery.matches ? 'dark' : 'light';
  }

  /** Human-readable explanation for the settings screen. */
  describe(lang) {
    const mode = this.settings.theme || 'auto';
    if (mode !== 'auto') {
      return lang === 'nl'
        ? 'Vast ingesteld, verandert niet mee.'
        : 'Fixed, does not change on its own.';
    }
    if (!this.coords) {
      return lang === 'nl'
        ? 'Volgt nu de instelling van je telefoon. Zodra de app je locatie heeft, schakelt hij op de echte zonsondergang.'
        : "Currently following your phone's appearance setting. Once the app has your location, it switches on actual sunset."
    }
    const times = sunTimes(new Date(), this.coords.lat, this.coords.lon);
    if (typeof times === 'string') {
      return lang === 'nl' ? 'Poolnacht of middernachtzon op deze breedtegraad.' : 'Polar night or midnight sun at this latitude.';
    }
    const fmt = (d) => d.toLocaleTimeString(lang === 'nl' ? 'nl-NL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    return lang === 'nl'
      ? `Licht vanaf ${fmt(times.sunrise)}, donker vanaf ${fmt(times.sunset)}.`
      : `Light from ${fmt(times.sunrise)}, dark from ${fmt(times.sunset)}.`;
  }
}

/**
 * Sunrise and sunset for a date and place.
 *
 * This uses the standard sunrise equation with a cosine approximation for
 * solar declination and ignores the equation of time, so it can be off by
 * up to about a quarter of an hour across the year. For deciding when to
 * dim a screen that's completely fine — it would matter for astronomy,
 * not for this.
 *
 * Returns {sunrise, sunset} as Date objects, or the string 'always-up' /
 * 'always-down' inside the polar circles.
 */
export function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;

  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - start) / 86400000);

  // Solar declination, degrees.
  const decl = -23.44 * Math.cos(rad * (360 / 365) * (dayOfYear + 10));

  // -0.833° accounts for atmospheric refraction and the sun's disc.
  const cosH =
    (Math.sin(rad * -0.833) - Math.sin(rad * lat) * Math.sin(rad * decl)) /
    (Math.cos(rad * lat) * Math.cos(rad * decl));

  if (cosH > 1) return 'always-down';
  if (cosH < -1) return 'always-up';

  const H = Math.acos(cosH) / rad / 15; // half-day length in hours
  const solarNoonUTC = 12 - lon / 15;

  const toDate = (hoursUTC) => {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    d.setUTCMinutes(d.getUTCMinutes() + hoursUTC * 60);
    return d;
  };

  return {
    sunrise: toDate(solarNoonUTC - H),
    sunset: toDate(solarNoonUTC + H)
  };
}
