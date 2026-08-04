// Real turn-by-turn navigation, built on the free OSRM public API — no key,
// no account, no cost. Two things happen when a route starts:
//
//   1. The coarse waypoints from the route JSON are sent to OSRM, which
//      snaps them to actual roads and returns a manoeuvre-by-manoeuvre
//      list (turn left, roundabout exit 2, and so on).
//   2. That result is cached in localStorage, so the next time you drive
//      the same route it works with zero connection.
//
// OSRM's public demo server is meant for light, personal use — exactly
// this. If it's ever overloaded, routing falls back to the straight-line
// skeleton and the highlight/fact narration keeps working regardless;
// only the spoken turn prompts are lost.

import { distanceMetres, distanceToPolyline } from './data.js';
import { loadCachedGeometry, saveCachedGeometry } from './storage.js';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/';

const ANNOUNCE_THRESHOLDS_M = [400, 150, 35]; // announce at each of these distances
const ARRIVE_THRESHOLD_M = 25;                 // close enough to call a step "done"
const OFF_ROUTE_THRESHOLD_M = 70;
const OFF_ROUTE_PERSIST_MS = 12000;

const PHRASES = {
  nl: {
    depart: () => 'Vertrek.',
    arrive: () => 'Je bent op de bestemming.',
    turn: (m) => `${turnVerbNl(m)}.`,
    continue: () => 'Blijf dit volgen.',
    newName: (road) => road ? `Blijf rijden, de weg heet nu ${road}.` : 'Blijf rijden.',
    merge: (m) => `Voeg in naar ${sideNl(m)}.`,
    onRamp: (m) => `Neem de oprit naar ${sideNl(m)}.`,
    offRamp: (m) => `Neem de afrit naar ${sideNl(m)}.`,
    fork: (m) => `Houd ${sideNl(m)} aan bij de splitsing.`,
    endOfRoad: (m) => `Aan het einde van de weg, ${turnVerbNl(m)}.`,
    roundabout: (exit) => exit ? `Bij de rotonde, neem de ${exit}e afslag.` : 'Bij de rotonde, blijf opletten.',
    recalculating: () => 'Je bent van de route af. Ik bereken een nieuwe route.',
    distancePrefix: (m) => m >= 1000 ? `Over ${(m / 1000).toFixed(1)} kilometer, ` : `Over ${Math.round(m / 10) * 10} meter, `,
    now: 'Nu '
  },
  en: {
    depart: () => 'Setting off.',
    arrive: () => 'You have arrived.',
    turn: (m) => `${turnVerbEn(m)}.`,
    continue: () => 'Continue straight ahead.',
    newName: (road) => road ? `Continue, the road is now called ${road}.` : 'Continue straight ahead.',
    merge: (m) => `Merge ${sideEn(m)}.`,
    onRamp: (m) => `Take the ramp on the ${sideEn(m)}.`,
    offRamp: (m) => `Take the exit on the ${sideEn(m)}.`,
    fork: (m) => `Keep ${sideEn(m)} at the fork.`,
    endOfRoad: (m) => `At the end of the road, ${turnVerbEn(m)}.`,
    roundabout: (exit) => exit ? `At the roundabout, take the ${ordinalEn(exit)} exit.` : 'At the roundabout, stay alert.',
    recalculating: () => "You're off the route. Recalculating.",
    distancePrefix: (m) => m >= 1000 ? `In ${(m / 1000).toFixed(1)} kilometres, ` : `In ${Math.round(m / 10) * 10} metres, `,
    now: 'Now '
  }
};

function turnVerbNl(modifier) {
  switch (modifier) {
    case 'uturn': return 'keer om';
    case 'sharp left': return 'sla scherp linksaf';
    case 'left': return 'sla linksaf';
    case 'slight left': return 'houd links aan';
    case 'straight': return 'rijd rechtdoor';
    case 'slight right': return 'houd rechts aan';
    case 'right': return 'sla rechtsaf';
    case 'sharp right': return 'sla scherp rechtsaf';
    default: return 'rijd verder';
  }
}
function turnVerbEn(modifier) {
  switch (modifier) {
    case 'uturn': return 'make a U-turn';
    case 'sharp left': return 'turn sharp left';
    case 'left': return 'turn left';
    case 'slight left': return 'bear left';
    case 'straight': return 'go straight ahead';
    case 'slight right': return 'bear right';
    case 'right': return 'turn right';
    case 'sharp right': return 'turn sharp right';
    default: return 'continue';
  }
}
function sideNl(modifier) { return (modifier || '').includes('left') ? 'links' : 'rechts'; }
function sideEn(modifier) { return (modifier || '').includes('left') ? 'the left' : 'the right'; }
function ordinalEn(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export class NavEngine extends EventTarget {
  constructor(speech) {
    super();
    this.speech = speech;
    this.geometry = [];   // [{lat, lon}, ...] road-snapped line
    this.steps = [];      // [{ location:{lat,lon}, type, modifier, roadName, exit }]
    this.quality = 'none'; // 'none' | 'skeleton' | 'routed'
    this.currentStepIndex = 0;
    this.announcedThisStep = new Set();
    this.offRouteSince = null;
    this.destination = null;
    this.enabled = true;
  }

  /** Loads the best geometry available: cache, then a live OSRM call. */
  async load(route) {
    this.destination = route.waypoints[route.waypoints.length - 1];
    this.currentStepIndex = 0;
    this.announcedThisStep.clear();
    this.offRouteSince = null;

    const cached = loadCachedGeometry(route.id);
    if (cached && cached.geometry && cached.geometry.length > 2) {
      this.geometry = cached.geometry;
      this.steps = cached.steps;
      this.quality = 'routed';
      this._notifyGeometry();
      return;
    }

    // Show the coarse skeleton immediately so the map isn't empty while we wait.
    this.geometry = route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    this.steps = [];
    this.quality = 'skeleton';
    this._notifyGeometry();

    try {
      const routed = await fetchOSRM(route.waypoints);
      this.geometry = routed.geometry;
      this.steps = routed.steps;
      this.quality = 'routed';
      saveCachedGeometry(route.id, routed);
      this._notifyGeometry();
    } catch (err) {
      console.warn('OSRM routing failed, staying on the skeleton line:', err);
    }
  }

  /** Forces a fresh route from `from` to the original destination — used for rerouting. */
  async _reroute(from) {
    try {
      const routed = await fetchOSRM([
        { lat: from.lat, lon: from.lon },
        this.destination
      ]);
      this.geometry = routed.geometry;
      this.steps = routed.steps;
      this.currentStepIndex = 0;
      this.announcedThisStep.clear();
      this._notifyGeometry();
    } catch (err) {
      console.warn('Reroute failed:', err);
    }
  }

  /** Called on every position update. */
  handlePosition(pos, lang) {
    if (!this.enabled || this.steps.length === 0) {
      this._trackOffRoute(pos, lang);
      return;
    }

    const step = this.steps[this.currentStepIndex];
    if (!step) return;

    const distanceToStep = distanceMetres(pos, step.location);

    for (const threshold of ANNOUNCE_THRESHOLDS_M) {
      const key = `${this.currentStepIndex}:${threshold}`;
      if (distanceToStep <= threshold && !this.announcedThisStep.has(key)) {
        this.announcedThisStep.add(key);
        this._announce(step, distanceToStep <= ARRIVE_THRESHOLD_M ? null : threshold, lang);
      }
    }

    if (distanceToStep <= ARRIVE_THRESHOLD_M) {
      this.currentStepIndex = Math.min(this.currentStepIndex + 1, this.steps.length - 1);
    }

    this.dispatchEvent(new CustomEvent('progress', {
      detail: { stepIndex: this.currentStepIndex, distanceToStep }
    }));

    this._trackOffRoute(pos, lang);
  }

  _trackOffRoute(pos, lang) {
    const distance = distanceToPolyline(pos, this.geometry);
    this.dispatchEvent(new CustomEvent('offroute', { detail: distance }));

    if (distance > OFF_ROUTE_THRESHOLD_M) {
      if (this.offRouteSince == null) this.offRouteSince = Date.now();
      if (Date.now() - this.offRouteSince > OFF_ROUTE_PERSIST_MS) {
        this.offRouteSince = null;
        this.speech.speakNow({
          title: lang === 'nl' ? 'Herberekenen' : 'Recalculating',
          body: PHRASES[lang].recalculating(),
          source: 'nav'
        });
        this._reroute(pos);
      }
    } else {
      this.offRouteSince = null;
    }
  }

  _announce(step, thresholdOrNull, lang) {
    const p = PHRASES[lang];
    const sentence = maneuverSentence(step, p);
    const prefix = thresholdOrNull ? p.distancePrefix(thresholdOrNull) : p.now;
    const body = prefix + lowerFirst(sentence);
    this.speech.speakNow({
      title: lang === 'nl' ? 'Navigatie' : 'Navigation',
      body,
      source: 'nav'
    });
  }

  _notifyGeometry() {
    this.dispatchEvent(new CustomEvent('geometry', {
      detail: { geometry: this.geometry, quality: this.quality }
    }));
  }
}

function maneuverSentence(step, p) {
  switch (step.type) {
    case 'depart': return p.depart();
    case 'arrive': return p.arrive();
    case 'roundabout':
    case 'rotary': return p.roundabout(step.exit);
    case 'merge': return p.merge(step.modifier);
    case 'on ramp': return p.onRamp(step.modifier);
    case 'off ramp': return p.offRamp(step.modifier);
    case 'fork': return p.fork(step.modifier);
    case 'end of road': return p.endOfRoad(step.modifier);
    case 'new name': return p.newName(step.roadName);
    case 'continue': return p.continue();
    case 'turn':
    default: return p.turn(step.modifier);
  }
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Calls OSRM and flattens the response into our simpler geometry/steps shape. */
async function fetchOSRM(waypoints) {
  const coords = waypoints.map((w) => `${w.lon},${w.lat}`).join(';');
  const url = `${OSRM_BASE}${coords}?geometries=geojson&overview=full&steps=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes || json.routes.length === 0) {
    throw new Error(`OSRM: ${json.code || 'no route'}`);
  }

  const route = json.routes[0];
  const geometry = route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }));

  const steps = [];
  for (const leg of route.legs) {
    for (const s of leg.steps) {
      const [lon, lat] = s.maneuver.location;
      steps.push({
        location: { lat, lon },
        type: s.maneuver.type,
        modifier: s.maneuver.modifier,
        roadName: s.name || null,
        exit: s.maneuver.exit || null
      });
    }
  }

  return { geometry, steps };
}
