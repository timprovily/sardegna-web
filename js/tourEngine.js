// Decides what the guide says about the island, as opposed to navEngine
// which decides what it says about the road. Same rules as the original
// app: a highlight you drive into always gets told, nothing interrupts a
// story once it starts (only a nav prompt can), and a fact fills a long
// silence while you're actually moving.

import { distanceMetres } from './data.js';

const IDLE_CHECK_MS = 20000;
const MIN_SPEED_FOR_FACTS_KMH = 12;

export class TourEngine extends EventTarget {
  constructor({ speech, facts, settings, enrichment }) {
    super();
    this.speech = speech;
    this.facts = facts;
    this.settings = settings;
    this.enrichment = enrichment;

    this.route = null;
    this.isRunning = false;
    this.playedHighlightIds = new Set();
    this.usedFactIds = new Set();
    this.nextHighlight = null;
    this.distanceToNext = null;
    this.lastSpeechEndedAt = Date.now();
    this._idleTimer = null;

    this.speech.addEventListener('itemend', () => {
      this.lastSpeechEndedAt = Date.now();
    });
  }

  start(route) {
    this.route = route;
    this.playedHighlightIds = new Set();
    this.usedFactIds = new Set();
    this.isRunning = true;
    this.lastSpeechEndedAt = Date.now();

    const lang = this.settings.language;
    const opening = lang === 'nl'
      ? `Route gestart: ${route.name.nl}. ${route.summary.nl}`
      : `Route started: ${route.name.en}. ${route.summary.en}`;
    this.speech.speakNow({ title: route.name[lang], body: opening, source: 'system' });

    this._idleTimer = setInterval(() => this._considerFact(), IDLE_CHECK_MS);
  }

  stop() {
    this.isRunning = false;
    clearInterval(this._idleTimer);
    this._idleTimer = null;
    this.speech.stopAll();
    this.route = null;
    this.nextHighlight = null;
    this.distanceToNext = null;
  }

  handlePosition(pos) {
    if (!this.isRunning || !this.route) return;
    const lang = this.settings.language;

    const hits = this.route.highlights
      .filter((h) => !this.playedHighlightIds.has(h.id))
      .map((h) => ({ h, d: distanceMetres(pos, { lat: h.lat, lon: h.lon }) }))
      .filter((x) => x.d <= x.h.radius)
      .sort((a, b) => a.d - b.d);

    if (hits.length > 0) {
      const { h } = hits[0];
      this.playedHighlightIds.add(h.id);
      this.speech.enqueue({ title: h.name[lang], body: h.script[lang], source: `highlight:${h.id}` });
      this._scheduleEnrichment(h);
      this.dispatchEvent(new CustomEvent('highlightplayed', { detail: h }));
    }

    this._recomputeNext(pos);
  }

  playHighlight(highlight) {
    const lang = this.settings.language;
    this.speech.enqueue({ title: highlight.name[lang], body: highlight.script[lang], source: `highlight:${highlight.id}` });
    this.playedHighlightIds.add(highlight.id);
    this._scheduleEnrichment(highlight);
    this.dispatchEvent(new CustomEvent('highlightplayed', { detail: highlight }));
  }

  speakRandomFact() {
    const fact = this._pickFact();
    if (!fact) return;
    this.usedFactIds.add(fact.id);
    const lang = this.settings.language;
    const title = lang === 'nl' ? 'Weetje over Sardinië' : 'About Sardinia';
    this.speech.enqueue({ title, body: fact.text[lang], source: `fact:${fact.id}` });
  }

  _recomputeNext(pos) {
    const remaining = this.route.highlights.filter((h) => !this.playedHighlightIds.has(h.id));
    if (remaining.length === 0) {
      this.nextHighlight = null;
      this.distanceToNext = null;
      return;
    }
    const withDist = remaining
      .map((h) => ({ h, d: distanceMetres(pos, { lat: h.lat, lon: h.lon }) }))
      .sort((a, b) => a.d - b.d);
    this.nextHighlight = withDist[0].h;
    this.distanceToNext = withDist[0].d;
  }

  _considerFact() {
    if (!this.isRunning || !this.settings.factsEnabled) return;
    if (this.speech.isSpeaking) return;
    const speedOk = this._lastSpeedKmh >= MIN_SPEED_FOR_FACTS_KMH;
    if (!speedOk) return;

    const silenceMs = Date.now() - this.lastSpeechEndedAt;
    if (silenceMs < this.settings.factInterval * 60 * 1000) return;

    if (this.nextHighlight && this.distanceToNext != null && this.distanceToNext < this.nextHighlight.radius * 1.6) {
      return;
    }
    this.speakRandomFact();
  }

  /** The drive screen feeds speed in separately, since geo.js owns it. */
  setSpeedKmh(kmh) {
    this._lastSpeedKmh = kmh;
  }

  _pickFact() {
    const unused = this.facts.filter((f) => !this.usedFactIds.has(f.id));
    if (unused.length === 0) {
      this.usedFactIds.clear();
      return this.facts[Math.floor(Math.random() * this.facts.length)];
    }
    return unused[Math.floor(Math.random() * unused.length)];
  }

  _scheduleEnrichment(highlight) {
    if (!this.settings.onlineExtras || !highlight.wikipedia) return;
    const lang = this.settings.language;
    const title = highlight.wikipedia[lang];

    this.enrichment.extract(title, lang).then((extract) => {
      if (!extract || !this.isRunning) return;
      const lead = lang === 'nl' ? 'Nog iets over ' : 'One more thing about ';
      const body = `${lead}${highlight.name[lang]}. ${extract}`;
      this.speech.enqueue({
        title: `${highlight.name[lang]} — Wikipedia`,
        body,
        source: `highlight:${highlight.id}`
      });
    });
  }
}
