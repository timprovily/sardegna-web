// A proper Dutch voice, generated ahead of time.
//
// Why this exists: Safari only exposes Apple's compact voices to web
// pages. The Enhanced voice you can select in iOS Settings is reserved
// for VoiceOver and Spoken Content — a website never sees it. That's
// Apple's decision and there's no way round it in code, so the only path
// to a good Dutch voice in a browser is a cloud service.
//
// Google Cloud Text-to-Speech is free up to a million characters a month
// for the standard voices and four million for WaveNet, which puts all
// eight routes comfortably inside the free tier.
//
// Everything is generated before you leave and stored on the phone, for
// the same reason the expanded stories are: audio needs a connection at
// the moment of speaking, and the Supramonte doesn't have one. Generate
// on wifi, drive offline.

const API_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const KEY_STORAGE = 'sardegna.google.key';
const DB_NAME = 'sardegna-audio';
const DB_STORE = 'clips';

// The WaveNet and Neural2 voices are the ones worth having; Standard is
// noticeably flatter but costs a quarter as much against the quota.
export const GOOGLE_VOICES = {
  nl: [
    { id: 'nl-NL-Wavenet-E', label: 'Wavenet E', gender: 'female' },
    { id: 'nl-NL-Wavenet-D', label: 'Wavenet D', gender: 'female' },
    { id: 'nl-NL-Wavenet-A', label: 'Wavenet A', gender: 'female' },
    { id: 'nl-NL-Wavenet-B', label: 'Wavenet B', gender: 'male' },
    { id: 'nl-NL-Wavenet-C', label: 'Wavenet C', gender: 'male' },
    { id: 'nl-NL-Standard-E', label: 'Standard E', gender: 'female' },
    { id: 'nl-NL-Standard-A', label: 'Standard A', gender: 'female' }
  ],
  en: [
    { id: 'en-GB-Wavenet-A', label: 'Wavenet A', gender: 'female' },
    { id: 'en-GB-Wavenet-C', label: 'Wavenet C', gender: 'female' },
    { id: 'en-GB-Wavenet-B', label: 'Wavenet B', gender: 'male' },
    { id: 'en-GB-Wavenet-D', label: 'Wavenet D', gender: 'male' },
    { id: 'en-GB-Standard-A', label: 'Standard A', gender: 'female' }
  ]
};

export class CloudVoice extends EventTarget {
  constructor() {
    super();
    this.db = null;
    this.cancelled = false;
    this.playing = null;
  }

  // ── Key ─────────────────────────────────────────────────────────────

  get apiKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
  }

  set apiKey(value) {
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value.trim());
      else localStorage.removeItem(KEY_STORAGE);
    } catch { /* private browsing */ }
    this.dispatchEvent(new Event('keychange'));
  }

  get hasKey() {
    return this.apiKey.length > 20;
  }

  // ── Storage ─────────────────────────────────────────────────────────
  //
  // Audio goes in IndexedDB, not localStorage. A route's worth of speech
  // is several megabytes and localStorage caps out around five for
  // everything combined — it would fill up and start losing settings.

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = () => { this.db = request.result; resolve(this.db); };
      request.onerror = () => reject(request.error);
    });
  }

  async put(key, blob) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(blob, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async get(key) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async keysWithPrefix(prefix) {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).getAllKeys();
      request.onsuccess = () => resolve((request.result || []).filter((k) => String(k).startsWith(prefix)));
      request.onerror = () => resolve([]);
    });
  }

  async deletePrefix(prefix) {
    const keys = await this.keysWithPrefix(prefix);
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      for (const key of keys) store.delete(key);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
  }

  /** Total size of stored audio, so the settings screen can show it. */
  async storedBytes() {
    const db = await this.open();
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const request = tx.objectStore(DB_STORE).getAll();
      request.onsuccess = () =>
        resolve((request.result || []).reduce((sum, blob) => sum + (blob?.size || 0), 0));
      request.onerror = () => resolve(0);
    });
  }

  // ── Synthesis ───────────────────────────────────────────────────────

  clipKey(routeId, highlightId, lang, voiceId) {
    return `${routeId}|${highlightId}|${lang}|${voiceId}`;
  }

  /**
   * Turns text into audio.
   *
   * Google caps a single request at 5000 bytes, and an expanded story
   * comfortably exceeds that, so long text is split on sentence
   * boundaries and the resulting MP3s are concatenated. MP3 frames are
   * self-contained, so joining the files end to end plays back as one
   * continuous clip — which is not true of most other formats.
   */
  async synthesize(text, lang, voiceId) {
    const chunks = splitForTTS(text);
    const parts = [];

    for (const chunk of chunks) {
      const res = await fetch(`${API_URL}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: chunk },
          voice: {
            languageCode: lang === 'nl' ? 'nl-NL' : 'en-GB',
            name: voiceId
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: 1.0,
            pitch: 0
          }
        })
      });

      if (res.status === 400 || res.status === 403) {
        const body = await res.text();
        const err = new Error(readGoogleError(body));
        err.fatal = true;
        throw err;
      }
      if (!res.ok) throw new Error(`Google TTS ${res.status}`);

      const data = await res.json();
      if (!data.audioContent) throw new Error('Geen audio ontvangen.');
      parts.push(base64ToBytes(data.audioContent));
    }

    return new Blob(parts, { type: 'audio/mpeg' });
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Generates audio for every story on a route.
   *
   * Sequential and unhurried: this runs on the sofa the night before, not
   * in the car, and a burst of parallel requests only invites a rate
   * limit.
   */
  async generateRoute(route, { language, voiceId, scriptFor, onProgress = () => {} }) {
    if (!this.hasKey) throw new Error('Geen Google API-sleutel ingevuld.');
    this.cancelled = false;

    const todo = [];
    for (const highlight of route.highlights) {
      const key = this.clipKey(route.id, highlight.id, language, voiceId);
      if (!(await this.get(key))) todo.push({ highlight, key });
    }

    let done = 0;
    let failed = 0;
    let bytes = 0;
    onProgress({ done: 0, total: todo.length, message: `${todo.length} fragmenten te maken…` });

    for (const { highlight, key } of todo) {
      if (this.cancelled) break;
      try {
        const text = scriptFor(highlight);
        const blob = await this.synthesize(text, language, voiceId);
        await this.put(key, blob);
        bytes += blob.size;
      } catch (err) {
        if (err.fatal) throw err;
        failed++;
      }
      done++;
      onProgress({ done, total: todo.length, message: highlight.name[language] });
      await new Promise((r) => setTimeout(r, 250));
    }

    this.dispatchEvent(new Event('change'));
    return { done, failed, bytes, cancelled: this.cancelled, total: todo.length };
  }

  /** How many of a route's stories already have audio. Takes the route
   *  id rather than the object, so a reversed route can ask about the
   *  original's clips. */
  async countFor(routeId, language, voiceId) {
    const prefix = `${routeId}|`;
    const suffix = `|${language}|${voiceId}`;
    const keys = await this.keysWithPrefix(prefix);
    return keys.filter((k) => String(k).endsWith(suffix)).length;
  }

  // ── Playback ────────────────────────────────────────────────────────

  /**
   * Plays a stored clip. Resolves when it finishes, rejects if there is
   * nothing stored — the caller then falls back to the built-in voice.
   */
  async play(key, { volume = 1 } = {}) {
    const blob = await this.get(key);
    if (!blob) throw new Error('no clip');

    this.stop();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = volume;
    this.playing = { audio, url };

    return new Promise((resolve, reject) => {
      audio.onended = () => { this.stop(); resolve(); };
      audio.onerror = () => { this.stop(); reject(new Error('playback failed')); };
      audio.play().catch(reject);
    });
  }

  stop() {
    if (!this.playing) return;
    try {
      this.playing.audio.pause();
      URL.revokeObjectURL(this.playing.url);
    } catch { /* already gone */ }
    this.playing = null;
  }

  get isPlaying() {
    return !!this.playing && !this.playing.audio.paused;
  }

  /** A short sample, not stored — just to hear what a voice sounds like. */
  async preview(text, lang, voiceId) {
    const blob = await this.synthesize(text, lang, voiceId);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.stop();
    this.playing = { audio, url };
    audio.onended = () => this.stop();
    await audio.play();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Splits text into pieces Google will accept, on sentence boundaries. */
function splitForTTS(text, maxBytes = 4200) {
  const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
  const chunks = [];
  let buffer = '';

  for (const sentence of sentences) {
    if (byteLength(buffer + sentence) > maxBytes && buffer) {
      chunks.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

function byteLength(str) {
  return new TextEncoder().encode(str).length;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Google's errors are informative but buried; surface the useful part. */
function readGoogleError(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || '';
    if (message.includes('API key not valid')) {
      return 'De API-sleutel wordt niet geaccepteerd. Controleer hem in de Google Cloud Console.';
    }
    if (message.includes('has not been used') || message.includes('is disabled')) {
      return 'De Text-to-Speech API staat nog uit voor dit project. Zet hem aan in de Google Cloud Console en probeer het over een minuut opnieuw.';
    }
    if (message.includes('billing')) {
      return 'Google vraagt om een factureringsprofiel bij dit project. Dat moet je eenmalig instellen; binnen het gratis quotum wordt er niets afgeschreven.';
    }
    return message || 'Google weigerde het verzoek.';
  } catch {
    return 'Google weigerde het verzoek.';
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
