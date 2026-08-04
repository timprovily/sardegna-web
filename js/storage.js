// Thin wrapper around localStorage. Everything here survives a phone
// restart but never leaves the device — there is no server.

const SETTINGS_KEY = 'sardegna.settings.v1';

const DEFAULT_SETTINGS = {
  language: (navigator.language || 'nl').toLowerCase().startsWith('en') ? 'en' : 'nl',
  speechRate: 0.95,       // multiplier on the browser's default rate
  factInterval: 7,        // minutes of silence before a fact
  factsEnabled: true,
  onlineExtras: true,     // Wikipedia summaries
  turnByTurnEnabled: true,
  chimeBeforeSpeech: true
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
