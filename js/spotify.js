// Spotify remote control.
//
// Authorisation uses the PKCE flow, which is the one designed for apps
// with no server: there is no client secret anywhere in this code, and
// there couldn't be — everything here is public. You supply your own
// Client ID once, in Settings.
//
// What this can and can't do, plainly:
//  · It controls whatever device Spotify is already playing on, over
//    Spotify's servers. So it needs a connection, and it is not instant —
//    reckon on half a second to two seconds.
//  · Playback control requires Spotify Premium. That's Spotify's rule for
//    the /me/player write endpoints, not ours.
//  · Since February 2026 a development-mode app also needs its *owner* to
//    hold Premium, is capped at five authorised users, and one Client ID
//    per developer. For personal use that's plenty.
//
// The one real prize: because we can set the volume, we can duck your
// music during a story and put it back afterwards, instead of the browser
// bluntly pausing it.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing'
].join(' ');

const TOKEN_KEY = 'sardegna.spotify.tokens';
const VERIFIER_KEY = 'sardegna.spotify.verifier';

export class SpotifyController extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings;
    this.tokens = readTokens();
    this.state = null;          // last known player state
    this.pollTimer = null;
    this.volumeBeforeDuck = null;
    this.ducking = false;
  }

  get clientId() {
    return (this.settings.spotifyClientId || '').trim();
  }

  get isConfigured() {
    return this.clientId.length > 0;
  }

  get isLoggedIn() {
    return !!(this.tokens && this.tokens.refresh_token);
  }

  // ── Auth ────────────────────────────────────────────────────────────

  /** Sends you to Spotify to approve. Returns to this same page after. */
  async login() {
    if (!this.isConfigured) throw new Error('Geen Spotify Client ID ingevuld.');

    const verifier = randomString(64);
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    localStorage.setItem(VERIFIER_KEY, verifier); // survives a full reload on iOS

    const challenge = await pkceChallenge(verifier);
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: redirectURI(),
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES
    });
    window.location.href = `${AUTH_URL}?${params}`;
  }

  /** Call once at startup: swaps ?code=… in the URL for real tokens. */
  async handleRedirect() {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      cleanURL();
      throw new Error(`Spotify weigerde de koppeling: ${error}`);
    }
    if (!code) return false;

    const verifier =
      sessionStorage.getItem(VERIFIER_KEY) || localStorage.getItem(VERIFIER_KEY);
    cleanURL();
    if (!verifier) throw new Error('Koppeling verlopen, probeer opnieuw in te loggen.');

    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectURI(),
      code_verifier: verifier
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) throw new Error(`Spotify-token mislukt (${res.status}).`);

    this.tokens = stampExpiry(await res.json());
    writeTokens(this.tokens);
    localStorage.removeItem(VERIFIER_KEY);
    this.dispatchEvent(new Event('authchange'));
    return true;
  }

  logout() {
    this.tokens = null;
    localStorage.removeItem(TOKEN_KEY);
    this.stopPolling();
    this.state = null;
    this.dispatchEvent(new Event('authchange'));
    this.dispatchEvent(new CustomEvent('state', { detail: null }));
  }

  async accessToken() {
    if (!this.tokens) return null;
    // Refresh a minute early so a call never lands on an expired token.
    if (Date.now() < this.tokens.expires_at - 60000) return this.tokens.access_token;

    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) {
      // Refresh token revoked or expired — make the user log in again
      // rather than failing silently on every subsequent call.
      this.logout();
      return null;
    }
    const fresh = await res.json();
    // Spotify doesn't always return a new refresh token; keep the old one.
    this.tokens = stampExpiry({ ...this.tokens, ...fresh });
    writeTokens(this.tokens);
    return this.tokens.access_token;
  }

  // ── API plumbing ────────────────────────────────────────────────────

  async call(path, { method = 'GET', body = null } = {}) {
    const token = await this.accessToken();
    if (!token) return null;

    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000)
      });

      if (res.status === 204) return {};              // nothing playing
      if (res.status === 401) { this.logout(); return null; }
      if (res.status === 403) {
        this.dispatchEvent(new CustomEvent('problem', {
          detail: 'Spotify weigert dit. Meestal betekent dat: geen Premium, of dit account staat niet in de lijst met toegestane gebruikers van je Spotify-app.'
        }));
        return null;
      }
      if (res.status === 404) {
        this.dispatchEvent(new CustomEvent('problem', {
          detail: 'Geen actief Spotify-apparaat. Start één nummer in de Spotify-app, daarna kun je het hier bedienen.'
        }));
        return null;
      }
      if (res.status === 429) return null;            // rate limited, skip a beat
      if (!res.ok) return null;

      const text = await res.text();
      return text ? JSON.parse(text) : {};
    } catch {
      return null; // offline or timed out — the UI just shows stale state
    }
  }

  // ── Playback ────────────────────────────────────────────────────────

  async refreshState() {
    const data = await this.call('/me/player');
    if (data && data.item) {
      this.state = {
        isPlaying: data.is_playing,
        title: data.item.name,
        artist: (data.item.artists || []).map((a) => a.name).join(', '),
        art: data.item.album?.images?.slice(-1)[0]?.url || null,
        volume: data.device?.volume_percent ?? null,
        device: data.device?.name || null
      };
    } else if (data) {
      this.state = null;
    }
    this.dispatchEvent(new CustomEvent('state', { detail: this.state }));
    return this.state;
  }

  async play()  { await this.call('/me/player/play',  { method: 'PUT' }); this.nudge(); }
  async pause() { await this.call('/me/player/pause', { method: 'PUT' }); this.nudge(); }
  async next()  { await this.call('/me/player/next',  { method: 'POST' }); this.nudge(); }
  async prev()  { await this.call('/me/player/previous', { method: 'POST' }); this.nudge(); }

  async toggle() {
    if (this.state?.isPlaying) await this.pause();
    else await this.play();
  }

  async setVolume(percent) {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    await this.call(`/me/player/volume?volume_percent=${v}`, { method: 'PUT' });
  }

  /** Spotify needs a moment to settle before it reports the new state. */
  nudge() {
    setTimeout(() => this.refreshState(), 700);
  }

  // ── Ducking ─────────────────────────────────────────────────────────

  async duck(level) {
    if (this.ducking || !this.isLoggedIn) return;
    const current = this.state?.volume;
    if (current == null || current === 0) return;
    this.ducking = true;
    this.volumeBeforeDuck = current;
    await this.setVolume(Math.round(current * (level / 100)));
  }

  async unduck() {
    if (!this.ducking) return;
    const restore = this.volumeBeforeDuck;
    this.ducking = false;
    this.volumeBeforeDuck = null;
    if (restore != null) await this.setVolume(restore);
  }

  startPolling(intervalMs = 5000) {
    this.stopPolling();
    if (!this.isLoggedIn) return;
    this.refreshState();
    this.pollTimer = setInterval(() => {
      // Don't fight our own ducking: skip the poll while volume is lowered,
      // otherwise we'd read the ducked value and "restore" to that.
      if (!this.ducking) this.refreshState();
    }, intervalMs);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** The page itself, without query or hash — must match the Redirect URI
 *  you register in the Spotify dashboard, character for character. */
export function redirectURI() {
  return window.location.origin + window.location.pathname;
}

function cleanURL() {
  window.history.replaceState({}, document.title, redirectURI());
}

function randomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stampExpiry(tokens) {
  return { ...tokens, expires_at: Date.now() + (tokens.expires_in || 3600) * 1000 };
}

function readTokens() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeTokens(tokens) {
  try {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  } catch { /* storage full; you'll just have to log in again next time */ }
}
