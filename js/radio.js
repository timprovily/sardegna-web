// Internet radio, played by the app itself.
//
// TuneIn can't be remote-controlled: their Platform API is partner-only,
// behind an evaluation agreement and a certification process, aimed at
// Sonos and car manufacturers. So instead of pretending, the radio plays
// here, in this app, from an ordinary <audio> element.
//
// That turns out better than controlling TuneIn would have been. Because
// the audio is ours, ducking is exact and instant — a smooth fade down
// when a story starts and back up when it ends, rather than the blunt
// pause the browser does to other apps.
//
// Two constraints worth knowing:
//  · The page is served over HTTPS, so streams must be HTTPS too.
//    Browsers block mixed content, and a lot of older radio streams are
//    still plain HTTP. Those are filtered out rather than silently failing.
//  · Radio is streaming, so it needs a connection. In the dead zones on
//    the SS125 it will stall, same as anything else.

const RADIO_BROWSER = 'https://de1.api.radio-browser.info/json';

/** A small starting set so the list is never empty, even offline-first.
 *  Stream URLs do go stale over the years; the search below is the escape
 *  hatch, and you can always paste your own. */
export const BUILTIN_STATIONS = [
  { id: 'npo-radio-2', name: 'NPO Radio 2',  url: 'https://icecast.omroep.nl/radio2-bb-mp3' },
  { id: 'npo-3fm',     name: 'NPO 3FM',      url: 'https://icecast.omroep.nl/3fm-bb-mp3' },
  { id: 'npo-radio-1', name: 'NPO Radio 1',  url: 'https://icecast.omroep.nl/radio1-bb-mp3' },
  { id: 'npo-radio-4', name: 'NPO Radio 4',  url: 'https://icecast.omroep.nl/radio4-bb-mp3' },
  { id: 'npo-radio-5', name: 'NPO Radio 5',  url: 'https://icecast.omroep.nl/radio5-bb-mp3' }
];

export class RadioController extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'none';
    this.audio.crossOrigin = 'anonymous';
    this.station = null;
    this.baseVolume = 0.8;
    this.ducking = false;
    this._fade = null;

    this.audio.addEventListener('playing', () => this.emit());
    this.audio.addEventListener('pause', () => this.emit());
    this.audio.addEventListener('waiting', () => this.emit('buffering'));
    this.audio.addEventListener('error', () => {
      this.dispatchEvent(new CustomEvent('problem', {
        detail: 'Deze zender doet het niet. Streamadressen veranderen soms — zoek de zender opnieuw of plak een ander adres.'
      }));
      this.station = null;
      this.emit();
    });
  }

  get isPlaying() {
    return !this.audio.paused && !this.audio.ended;
  }

  emit(extra = null) {
    this.dispatchEvent(new CustomEvent('state', {
      detail: this.station ? { ...this.station, playing: this.isPlaying, status: extra } : null
    }));
  }

  /** Must be called from a tap: browsers only allow audio to start from
   *  a real user gesture, exactly like the speech engine. */
  play(station) {
    this.station = station;
    this.audio.src = station.url;
    this.audio.volume = this.ducking ? this.baseVolume * 0.15 : this.baseVolume;
    this.audio.play().catch(() => {
      this.dispatchEvent(new CustomEvent('problem', {
        detail: 'De browser wilde de radio niet starten. Tik nog een keer op de zender.'
      }));
    });
    this.emit();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.station = null;
    this.emit();
  }

  toggle(fallbackStation) {
    if (this.isPlaying) this.audio.pause();
    else if (this.station) this.audio.play().catch(() => {});
    else if (fallbackStation) this.play(fallbackStation);
    this.emit();
  }

  setVolume(fraction) {
    this.baseVolume = Math.max(0, Math.min(1, fraction));
    if (!this.ducking) this.audio.volume = this.baseVolume;
  }

  // ── Ducking ─────────────────────────────────────────────────────────

  duck(levelPercent) {
    this.ducking = true;
    this.fadeTo(this.baseVolume * (levelPercent / 100), 350);
  }

  unduck() {
    this.ducking = false;
    this.fadeTo(this.baseVolume, 600);
  }

  /** A short ramp rather than a jump — a hard volume step sounds like a
   *  fault, a fade sounds deliberate. */
  fadeTo(target, ms) {
    clearInterval(this._fade);
    const start = this.audio.volume;
    const steps = Math.max(1, Math.round(ms / 40));
    let i = 0;
    this._fade = setInterval(() => {
      i++;
      this.audio.volume = Math.max(0, Math.min(1, start + (target - start) * (i / steps)));
      if (i >= steps) clearInterval(this._fade);
    }, 40);
  }
}

/** Searches the open Radio Browser directory. Free, community-run, no key.
 *  Filtered to HTTPS because the app itself is served over HTTPS. */
export async function searchStations(query, { countryCode = 'NL', limit = 30 } = {}) {
  const base = query
    ? `${RADIO_BROWSER}/stations/search?name=${encodeURIComponent(query)}&limit=${limit * 3}`
    : `${RADIO_BROWSER}/stations/bycountrycodeexact/${countryCode}?limit=${limit * 3}&order=clickcount&reverse=true`;

  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return [];
    const list = await res.json();

    return list
      .map((s) => ({
        id: s.stationuuid,
        name: s.name.trim(),
        url: s.url_resolved || s.url,
        country: s.countrycode,
        bitrate: s.bitrate
      }))
      .filter((s) => s.url && s.url.startsWith('https://'))
      .filter((s, i, arr) => arr.findIndex((o) => o.name === s.name) === i)
      .slice(0, limit);
  } catch {
    return [];
  }
}
