// Speaks the guide out loud through window.speechSynthesis.
//
// Three iOS/Safari quirks this works around:
//
// 1. Autoplay policy — the very first utterance in a session must be
//    triggered synchronously from a user tap. Every "Start" button in this
//    app calls speak() directly inside its click handler, before any
//    await, so the browser counts it as gesture-triggered.
// 2. Chrome silently cuts utterances longer than ~250 characters. Our
//    highlight stories are longer than that, so long text is split into
//    sentence-sized chunks and queued back to back — it sounds identical
//    but never gets truncated.
// 3. getVoices() can return an empty list on first call; the voiceschanged
//    event fires once the OS has actually loaded them in.
//
// There is no equivalent of iOS's AVAudioSession ducking here. Background
// music from another app will typically pause rather than fade — that's a
// real step down from the native app, not something this code can fix.

export class SpeechService extends EventTarget {
  constructor() {
    super();
    this.synth = window.speechSynthesis;
    this.language = 'nl';
    this.rate = 0.95;
    this.playChime = true;
    // Name of the voice the user picked, or null for automatic.
    this.preferredVoiceName = null;
    // Unique per voice, unlike the name — an Enhanced and a compact voice
    // can both be called Claire.
    this.preferredVoiceURI = null;

    this.normalQueue = [];
    this.current = null;      // the SpokenItem currently narrating
    this.isSpeaking = false;
    this.history = [];

    this._voicesReady = false;
    this._pendingChunks = [];
    // Bumped every time we start a new item or forcibly cancel. Utterance
    // callbacks close over the token they were created with, so a stray
    // onend/onerror from a just-cancelled utterance can never advance the
    // chunk queue of whatever we spoke next.
    this._token = 0;
    // Our own busy flag. The engine's `speaking` is not trustworthy on iOS.
    this._active = false;
    this._watchdog = null;

    if ('onvoiceschanged' in this.synth) {
      this.synth.onvoiceschanged = () => { this._voicesReady = true; };
    }
  }

  /** Best available voice for a language, preferring an on-device voice. */
  /**
   * Every voice installed for a language, best first.
   *
   * The ordering matters more than it looks. iOS ships a compact default
   * that sounds distinctly synthetic, and hides much better voices behind
   * a download in Settings. Enhanced and Premium voices don't announce
   * themselves through this API, but they do carry distinguishing names,
   * so those are recognised and floated to the top.
   */
  voicesFor(lang) {
    const prefix = lang.slice(0, 2);
    const preferredRegion = prefix === 'nl' ? 'nl-nl' : 'en-gb';

    return this.synth.getVoices()
      .filter((v) => v.lang.toLowerCase().startsWith(prefix))
      .map((v) => ({
        voice: v,
        name: v.name,
        lang: v.lang,
        gender: guessGender(v, prefix),
        quality: qualityRank(v),
        local: !!v.localService,
        exactRegion: v.lang.toLowerCase() === preferredRegion
      }))
      .sort((a, b) =>
        b.quality - a.quality ||
        (b.exactRegion ? 1 : 0) - (a.exactRegion ? 1 : 0) ||
        (b.local ? 1 : 0) - (a.local ? 1 : 0) ||
        a.name.localeCompare(b.name)
      );
  }

  /** The voice to speak with: the chosen one if it's still installed,
   *  otherwise the best available. */
  bestVoice(lang) {
    const list = this.voicesFor(lang);
    if (list.length === 0) return null;

    if (this.preferredVoiceURI) {
      const exact = list.find((v) => v.voice.voiceURI === this.preferredVoiceURI);
      if (exact) return exact.voice;
    }
    if (this.preferredVoiceName) {
      const byName = list.find((v) => v.name === this.preferredVoiceName);
      if (byName) return byName.voice;
      // Chosen voice has been removed from the phone, or we've switched
      // to a language it doesn't cover — fall through rather than going
      // silent.
    }
    return list[0].voice;
  }

  /** Adds a story to the back of the normal queue. Never interrupts. */
  enqueue(item) {
    this.normalQueue.push(item);
    this._pump();
  }

  /** Speaks immediately, cancelling and dropping anything mid-sentence.
   *  Used for turn-by-turn prompts and the "Test" button — safety and
   *  explicit user actions both outrank a story in progress. */
  speakNow(item) {
    this._token++;
    this.normalQueue = [];
    this._pendingChunks = [];
    this._hardStop();
    this.normalQueue.unshift(item);
    this._pump();
  }

  skip() {
    this._token++;
    this._pendingChunks = [];
    const had = this.current;
    this.current = null;
    this.isSpeaking = false;
    this._hardStop();
    if (had) this.dispatchEvent(new Event('itemend'));
    this._pump();
  }

  stopAll() {
    this._token++;
    this.normalQueue = [];
    this._pendingChunks = [];
    this._hardStop();
    this.current = null;
    this.isSpeaking = false;
  }

  repeatLast() {
    const last = this.history[this.history.length - 1];
    if (last) this.speakNow({ ...last });
  }

  /**
   * Stops the engine and releases our own busy flag.
   *
   * On iOS, speechSynthesis.cancel() regularly leaves `speaking` stuck on
   * true and never fires the utterance's onend. Anything that waits for
   * `speaking` to go false therefore waits forever — which is exactly why
   * the skip button did nothing. So we keep our own flag and never ask
   * the engine whether it is busy.
   *
   * The paired resume() is the other half of the same folklore: a
   * cancelled engine can be left in a paused state where subsequent
   * speak() calls are silently swallowed.
   */
  _hardStop() {
    this._active = false;
    try { this.synth.cancel(); } catch { /* nothing useful to do */ }
    try { this.synth.resume(); } catch { /* not paused; fine */ }
  }

  _pump() {
    if (this._pendingChunks.length > 0) {
      this._speakChunk(this._token);
      return;
    }
    // Our own flag, not synth.speaking — see _hardStop above.
    if (this._active || this.normalQueue.length === 0) return;

    const item = this.normalQueue.shift();
    this.current = item;
    this.isSpeaking = true;
    this.history.push(item);
    if (this.history.length > 60) this.history.shift();
    this.dispatchEvent(new CustomEvent('itemstart', { detail: item }));

    this._pendingChunks = chunkText(item.body);
    const token = this._token;
    if (this.playChime) {
      this._chime();
      setTimeout(() => this._speakChunk(token), 400);
    } else {
      this._speakChunk(token);
    }
  }

  _speakChunk(token) {
    // A callback from an utterance we already cancelled — ignore it, the
    // current generation's own chain is driving playback now.
    if (token !== this._token) return;

    const text = this._pendingChunks.shift();
    if (text === undefined) {
      this._active = false;
      this.isSpeaking = false;
      this.current = null;
      this.dispatchEvent(new Event('itemend'));
      this._pump();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this.bestVoice(this.language);
    if (voice) utterance.voice = voice;
    utterance.lang = this.language === 'nl' ? 'nl-NL' : 'en-GB';
    utterance.rate = this.rate;

    const done = () => {
      if (token !== this._token) return;
      this._active = false;
      this._speakChunk(token);
    };
    utterance.onend = done;
    utterance.onerror = done;

    // A chunk that never reports back would strand the queue. iOS drops
    // an onend now and then, so a watchdog sized to the text moves things
    // along instead of leaving the guide mute for the rest of the drive.
    const expectedMs = Math.max(4000, (text.length / 12) * 1000 / Math.max(0.5, this.rate));
    clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (token !== this._token || !this._active) return;
      this._active = false;
      this._speakChunk(token);
    }, expectedMs + 5000);

    this._active = true;
    this.synth.speak(utterance);
  }

  _chime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      [880, 1175].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.001, now + i * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.14 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.14 + 0.18);
        osc.start(now + i * 0.14);
        osc.stop(now + i * 0.14 + 0.2);
      });
      setTimeout(() => ctx.close(), 500);
    } catch {
      // Silently skip the chime if AudioContext is unavailable.
    }
  }
}

/** Splits text into utterance-sized chunks on sentence boundaries. */
function chunkText(text, maxLen = 200) {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const chunks = [];
  let buffer = '';
  for (const sentence of sentences) {
    if ((buffer + sentence).length > maxLen && buffer.length > 0) {
      chunks.push(buffer.trim());
      buffer = sentence;
    } else {
      buffer += sentence;
    }
  }
  if (buffer.trim()) chunks.push(buffer.trim());
  return chunks;
}

// ── Voice classification ──────────────────────────────────────────────
//
// The Web Speech API exposes no gender and no quality field, so both have
// to be inferred from the name. That is unavoidably a heuristic, which is
// why the settings screen shows the real name alongside and lets you play
// each one — the label is a hint to sort by, not a promise.

const KNOWN_FEMALE = new Set([
  // Dutch
  'ellen', 'claire', 'lotte', 'saskia', 'xander_female', 'femke',
  // English
  'kate', 'serena', 'moira', 'tessa', 'fiona', 'karen', 'samantha',
  'susan', 'allison', 'ava', 'joanna', 'zoe', 'stephanie', 'martha',
  'sonia', 'libby', 'hazel', 'amy', 'emma', 'nicky', 'siri female'
]);

const KNOWN_MALE = new Set([
  'xander', 'frank', 'ruben', 'bram',
  'daniel', 'oliver', 'alex', 'fred', 'tom', 'aaron', 'arthur',
  'gordon', 'rishi', 'ryan', 'george', 'guy', 'brian', 'siri male'
]);

function guessGender(voice, prefix) {
  const name = `${voice.name || ''} ${voice.voiceURI || ''}`.toLowerCase();
  if (/\bfemale\b|\(vrouw|\bvrouw\b/.test(name)) return 'female';
  if (/\bmale\b|\(man|\bman\b/.test(name)) return 'male';

  for (const known of KNOWN_FEMALE) if (name.includes(known)) return 'female';
  for (const known of KNOWN_MALE) if (name.includes(known)) return 'male';
  return 'unknown';
}

function qualityRank(voice) {
  const uri = (voice.voiceURI || '').toLowerCase();
  const name = (voice.name || '').toLowerCase();
  const both = `${uri} ${name}`;

  if (/\bpremium\b|\.premium\b|voice\.premium/.test(both)) return 3;
  if (/\benhanced\b|\.enhanced\b|voice\.enhanced|\bverbeterd\b/.test(both)) return 2;
  // Siri voices are neural and sound at least as good as Enhanced.
  if (/siri/.test(both)) return 2;
  if (/\bcompact\b|\.compact\b|voice\.compact/.test(both)) return 0;

  // Cloud voices from Google and Microsoft are generally well ahead of a
  // local compact voice, even when nothing in the name says so.
  if (!voice.localService) return 2;
  if (/google|microsoft|natural|neural|wavenet/.test(both)) return 2;

  return 1;
}

export function voiceQualityLabel(rank, lang) {
  const labels = {
    nl: { 3: 'Premium', 2: 'Verbeterd', 1: '', 0: 'Compact' },
    en: { 3: 'Premium', 2: 'Enhanced', 1: '', 0: 'Compact' }
  };
  return (labels[lang] || labels.nl)[rank] || '';
}

export function voiceGenderLabel(gender, lang) {
  const labels = {
    nl: { female: 'vrouw', male: 'man', unknown: '' },
    en: { female: 'female', male: 'male', unknown: '' }
  };
  return (labels[lang] || labels.nl)[gender] || '';
}
