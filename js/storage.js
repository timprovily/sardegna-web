// Thin wrapper around localStorage. Everything here survives a phone
// restart but never leaves the device — there is no server.

const SETTINGS_KEY = 'sardegna.settings.v1';

const DEFAULT_SETTINGS = {
  language: (navigator.language || 'nl').toLowerCase().startsWith('en') ? 'en' : 'nl',
  theme: 'auto',          // 'auto' | 'light' | 'dark'
  speechRate: 0.95,       // multiplier on the browser's default rate
  factInterval: 7,        // minutes of silence before a fact
  factsEnabled: true,
  onlineExtras: true,     // Wikipedia summaries
  turnByTurnEnabled: true,
  chimeBeforeSpeech: true,
  // Music
  spotifyClientId: '',
  duckEnabled: true,
  duckLevel: 20,          // percent of normal volume during a story
  radioVolume: 0.55,
  lastStationId: null,
  lastStationName: null,
  lastStationUrl: null,
  locationGranted: false,
  aiModel: 'claude-sonnet-5',
  importMode: 'car',
  // Name of the chosen speech voice; null means pick the best available.
  voiceName: null,
  voiceURI: null,
  powerSaving: true,
  dimLevel: 45
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked (private browsing). Not fatal — settings
    // just won't persist across sessions.
  }
}

// Route geometry cache: the road-snapped line + turn-by-turn steps, keyed
// per route, so the second time you drive a route it works without a
// connection.
function geometryKey(routeId) {
  return `sardegna.geometry.${routeId}`;
}

export function loadCachedGeometry(routeId) {
  try {
    const raw = localStorage.getItem(geometryKey(routeId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveCachedGeometry(routeId, data) {
  try {
    localStorage.setItem(geometryKey(routeId), JSON.stringify(data));
  } catch {
    // Quota exceeded on very old devices — routing just falls back to
    // fetching fresh next time instead of caching.
  }
}

// Custom routes imported from GPX. Kept separate from the bundled routes
// so an app update never overwrites something you added yourself.

const CUSTOM_ROUTES_KEY = 'sardegna.customRoutes.v1';

export function loadCustomRoutes() {
  try {
    const raw = localStorage.getItem(CUSTOM_ROUTES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveCustomRoute(route) {
  const routes = loadCustomRoutes();
  routes.push(route);
  try {
    localStorage.setItem(CUSTOM_ROUTES_KEY, JSON.stringify(routes));
    return { ok: true };
  } catch (err) {
    // localStorage is typically capped around 5 MB. A very dense track
    // can get close, so say so plainly rather than failing silently.
    return {
      ok: false,
      error: 'De opslag van je browser zit vol. Verwijder een eerder geïmporteerde route en probeer het opnieuw.'
    };
  }
}

export function deleteCustomRoute(routeId) {
  const routes = loadCustomRoutes().filter((r) => r.id !== routeId);
  try {
    localStorage.setItem(CUSTOM_ROUTES_KEY, JSON.stringify(routes));
  } catch { /* nothing sensible to do here */ }
}
