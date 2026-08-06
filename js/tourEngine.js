// Decides what the guide says about the island, as opposed to navEngine
// which decides what it says about the road. Same rules as the original
// app: a highlight you drive into always gets told, nothing interrupts a
// story once it starts (only a nav prompt can), and a fact fills a long
// silence while you're actually moving.

import { distanceMetres, distanceToPolyline, nearestIndex } from './data.js';
import { flipDirections } from './reverse.js';

const IDLE_CHECK_MS = 20000;
// How close to the route you must be for "joining partway" to make sense.
const JOIN_CORRIDOR_M = 3000;
// Slack in vertices, so a highlight right where you're standing isn't
// written off as already passed.
const JOIN_TOLERANCE_VERTICES = 2;
// You can be this far off the line and still be told the story. Wider
// than the trigger radius on purpose: a parallel street, a diversion or
// a car park shouldn't cost you the commentary.
const STORY_CORRIDOR_M = 3000;
const MIN_SPEED_FOR_FACTS_KMH = 12;

export class TourEngine extends EventTarget {
  constructor({ speech, facts, settings, enrichment, storyteller = null }) {
    super();
    this.speech = speech;
    this.storyteller = storyteller;
    this.facts = facts;
    this.settings = settings;
    this.enrichment = enrichment;

    this.route = null;
    this.isRunning = false;
    this.geometry = [];
    // Where each highlight sits along the route line, so we can tell
    // "already behind me" from "still to come".
    this.highlightIndex = new Map();
    this.progressIndex = 0;
    // Highlights deliberately passed over because you joined the route
    // after them. Distinct from "played": these were never told.
    this.skippedHighlightIds = new Set();
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

  start(route, { geometry = null, position = null } = {}) {
    this.route = route;
    this.playedHighlightIds = new Set();
    this.skippedHighlightIds = new Set();
    this.usedFactIds = new Set();
    this.isRunning = true;
    this.lastSpeechEndedAt = Date.now();

    this.geometry = (geometry && geometry.length > 1)
      ? geometry
      : route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));

    // Work out once where every highlight sits along the line.
    this.highlightIndex.clear();
    for (const h of route.highlights) {
      const { index } = nearestIndex({ lat: h.lat, lon: h.lon }, this.geometry);
      this.highlightIndex.set(h.id, index);
    }

    const lang = this.settings.language;
    const joined = this._joinRoute(position);

    let opening;
    if (joined.midRoute) {
      // You didn't start at the beginning, so don't pretend otherwise.
      const remaining = route.highlights.length - joined.skipped;
      opening = lang === 'nl'
        ? `Je pakt ${route.name.nl} op onderweg. ${joined.skipped} ${joined.skipped === 1 ? 'plek ligt' : 'plekken liggen'} al achter je; er ${remaining === 1 ? 'komt' : 'komen'} er nog ${remaining}.`
        : `Joining ${route.name.en} partway. ${joined.skipped} ${joined.skipped === 1 ? 'place is' : 'places are'} already behind you; ${remaining} still ${remaining === 1 ? 'lies' : 'lie'} ahead.`;
    } else {
      opening = lang === 'nl'
        ? `Route gestart: ${route.name.nl}. ${route.summary.nl}`
        : `Route started: ${route.name.en}. ${route.summary.en}`;
    }

    if (route.reversed) {
      // Links and rechts are corrected automatically; the opening and
      // closing lines of each story are not, and pretending otherwise
      // would be worse than admitting it.
      opening += lang === 'nl'
        ? ' Je rijdt deze route omgekeerd. Links en rechts worden meegedraaid, maar sommige verhalen zijn geschreven vanuit de andere richting, dus af en toe klopt een begin of een slot niet helemaal.'
        : " You're driving this route in reverse. Left and right are corrected, but some stories were written for the other direction, so an opening or closing line may not quite fit.";
    }
    this.speech.speakNow({ title: route.name[lang], body: opening, source: 'system' });

    this._idleTimer = setInterval(() => this._considerFact(), IDLE_CHECK_MS);
    // If there was no fix yet, do the same work on the first one that
    // arrives rather than assuming you're at the start line.
    this._needsJoin = !position;
    if (position) this._recomputeNext(position);
    return joined;
  }

  /**
   * Figures out where on the route you currently are and writes off
   * everything behind you.
   *
   * Without this, joining a route halfway means the guide sits waiting
   * for a highlight you passed twenty minutes ago, and stays silent the
   * whole way.
   */
  _joinRoute(position) {
    if (!position || this.geometry.length < 2) {
      this.progressIndex = 0;
      return { midRoute: false, skipped: 0 };
    }

    const { index, distance } = nearestIndex(position, this.geometry);
    // If you're nowhere near the route, don't skip anything — you're
    // presumably driving to the start.
    if (distance > JOIN_CORRIDOR_M) {
      this.progressIndex = 0;
      return { midRoute: false, skipped: 0 };
    }

    this.progressIndex = index;

    let skipped = 0;
    for (const h of this.route.highlights) {
      const at = this.highlightIndex.get(h.id) ?? 0;
      // A small tolerance so a highlight you're standing right next to
      // still gets told rather than written off by a metre or two.
      if (at + JOIN_TOLERANCE_VERTICES < index) {
        this.skippedHighlightIds.add(h.id);
        skipped++;
      }
    }

    const fraction = index / (this.geometry.length - 1);
    return { midRoute: fraction > 0.02 && skipped > 0, skipped, fraction };
  }

  /**
   * Swaps in a better route line mid-drive.
   *
   * Routing usually lands a few seconds after you set off, replacing the
   * coarse skeleton with real roads. Everything positional is derived
   * from that line, so it all has to be recomputed — assigning the new
   * geometry alone would leave every highlight pointing at a vertex
   * number from the old one.
   */
  setGeometry(geometry) {
    if (!geometry || geometry.length < 2 || !this.route) return;

    // Remember where we were in real terms before the indices change.
    const wasAt = this.geometry.length > 1 && this.progressIndex > 0
      ? this.geometry[Math.min(this.progressIndex, this.geometry.length - 1)]
      : null;

    this.geometry = geometry;
    this.highlightIndex.clear();
    for (const h of this.route.highlights) {
      const { index } = nearestIndex({ lat: h.lat, lon: h.lon }, geometry);
      this.highlightIndex.set(h.id, index);
    }
    this.progressIndex = wasAt ? nearestIndex(wasAt, geometry).index : 0;
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
    this._lastPosition = pos;
    const lang = this.settings.language;

    // First fix after starting: work out where we joined before deciding
    // anything is due, otherwise every highlight behind us fires at once.
    if (this._needsJoin) {
      this._needsJoin = false;
      const joined = this._joinRoute(pos);
      if (joined.midRoute) {
        const remaining = this.route.highlights.length - joined.skipped;
        this.speech.enqueue({
          title: this.route.name[lang],
          body: lang === 'nl'
            ? `Je zit al op de route. ${joined.skipped} ${joined.skipped === 1 ? 'plek ligt' : 'plekken liggen'} achter je; er ${remaining === 1 ? 'komt' : 'komen'} er nog ${remaining}.`
            : `You're already on the route. ${joined.skipped} ${joined.skipped === 1 ? 'place is' : 'places are'} behind you; ${remaining} still to come.`,
          source: 'system'
        });
        this.dispatchEvent(new CustomEvent('joined', { detail: joined }));
      }
      this._recomputeNext(pos);
      return;
    }

    // How far along the route we now are, and how far off it.
    if (this.geometry.length > 1) {
      const { index } = nearestIndex(pos, this.geometry);
      // Only ever move forwards. A GPS wobble near a hairpin can snap to
      // a vertex from the other side of the bend; letting that rewind
      // progress would replay stories you already heard.
      if (index > this.progressIndex) this.progressIndex = index;
    }
    const offRoute = this.geometry.length > 1
      ? distanceToPolyline(pos, this.geometry)
      : 0;

    const pending = this.route.highlights.filter(
      (h) => !this.playedHighlightIds.has(h.id) && !this.skippedHighlightIds.has(h.id)
    );

    const due = pending
      .map((h) => {
        const straightLine = distanceMetres(pos, { lat: h.lat, lon: h.lon });
        const at = this.highlightIndex.get(h.id) ?? 0;
        return {
          h,
          d: straightLine,
          // Two independent reasons to tell a story:
          //  1. you came close to the place itself, or
          //  2. you've driven past its point on the route while still
          //     following that route. The second is what rescues the case
          //     where you're a few hundred metres off, or took a slightly
          //     different line through a village.
          near: straightLine <= h.radius,
          passed: this.progressIndex >= at && offRoute <= STORY_CORRIDOR_M
        };
      })
      .filter((x) => x.near || x.passed)
      .sort((a, b) => (this.highlightIndex.get(a.h.id) ?? 0) - (this.highlightIndex.get(b.h.id) ?? 0));

    // Queue everything that's become due, in route order. Normally that's
    // one; after a tunnel or a signal gap it can be a couple, and they'll
    // play back to back rather than being lost.
    for (const { h } of due) {
      this.playedHighlightIds.add(h.id);
      this.speech.enqueue({ title: h.name[lang], body: this.scriptFor(h), source: `highlight:${h.id}` });
      this._scheduleEnrichment(h);
      this.dispatchEvent(new CustomEvent('highlightplayed', { detail: h }));
    }

    this._recomputeNext(pos);
  }

  /** The text to speak for a place: the long version if one has been
   *  generated, otherwise the hand-written one that ships with the app. */
  scriptFor(highlight) {
    const lang = this.settings.language;
    // Long stories are written per place, not per direction, so a
    // reversed route looks them up under the original id.
    const key = this.route ? (this.route.baseId || this.route.id) : null;
    const expanded = this.storyteller && key
      ? this.storyteller.get(key, highlight.id, lang)
      : null;
    const text = expanded || highlight.script[lang];
    return this.route?.reversed ? flipDirections(text, lang) : text;
  }

  /**
   * Writes off a highlight on purpose.
   *
   * Returns the one that was dropped, so the caller can go and find a
   * quicker way onward. If a story is playing, that's the one you mean;
   * otherwise it's the one coming up.
   */
  skipHighlight(current = null) {
    if (!this.route) return null;

    let target = null;
    if (current && typeof current.source === 'string' && current.source.startsWith('highlight:')) {
      const id = current.source.slice('highlight:'.length);
      target = this.route.highlights.find((h) => h.id === id) || null;
    }
    if (!target) target = this.nextHighlight;
    if (!target) return null;

    this.skippedHighlightIds.add(target.id);
    this.playedHighlightIds.delete(target.id);
    this._recomputeNext(this._lastPosition);
    this.dispatchEvent(new CustomEvent('highlightskipped', { detail: target }));
    return target;
  }

  playHighlight(highlight) {
    const lang = this.settings.language;
    this.speech.enqueue({ title: highlight.name[lang], body: this.scriptFor(highlight), source: `highlight:${highlight.id}` });
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
    if (!pos || !this.route) return;
    const remaining = this.route.highlights.filter(
      (h) => !this.playedHighlightIds.has(h.id) && !this.skippedHighlightIds.has(h.id)
    );
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
        // Deliberately not `highlight:` — this plays *after* you've
        // already been told about the place, so silencing it must not be
        // read as "skip this stop".
        source: `extra:${highlight.id}`
      });
    });
  }
}
