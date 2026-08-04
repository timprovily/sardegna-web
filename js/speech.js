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

    if ('onvoiceschanged' in this.synth) {
      this.synth.onvoiceschanged = () => { this._voicesReady = true; };
    }
  }

  /** Best available voice for a language, preferring an on-device voice. */
  bestVoice(lang) {
    const prefix = lang.slice(0, 2);
    const voices = this.synth.getVoices();
    const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith(prefix));
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.localService ? 1 : 0) - (a.localService ? 1 : 0));
    const exact = candidates.find((v) => v.lang.toLowerCase() === (prefix === 'nl' ? 'nl-nl' : 'en-gb'));
    return exact || candidates[0];
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
    if (this.synth.speaking || this.synth.pending) {
      this.synth.cancel();
    }
    this.normalQueue.unshift(item);
    this._pump();
  }

  skip() {
    this._token++;
    if (this.synth.speaking) this.synth.cancel();
    this.isSpeaking = false;
    this.current = null;
    this._pendingChunks = [];
    this._pump();
  }

  stopAll() {
    this._token++;
    this.normalQueue = [];
    this._pendingChunks = [];
    this.synth.cancel();
    this.current = null;
    this.isSpeaking = false;
  }

  repeatLast() {
    const last = this.history[this.history.length - 1];
    if (last) this.speakNow({ ...last });
  }

  _pump() {
    if (this._pendingChunks.length > 0) {
      this._speakChunk(this._token);
      return;
    }
    if (this.synth.speaking || this.normalQueue.length === 0) return;

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
    utterance.onend = () => this._speakChunk(token);
    utterance.onerror = () => this._speakChunk(token);
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
