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

import { distanceMetres, distanceToPolyline, nearestIndex } from './data.js';
import { loadCachedGeometry, saveCachedGeometry } from './storage.js';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving/';

// Two announcements per turn, not three. The middle one at 150 m was
// pure noise: on a road like the SS125 you'd still be hearing it as the
// final one arrived.
const ANNOUNCE_THRESHOLDS_M = [300, 40];
// An advance warning only earns its place if the previous manoeuvre was
// far enough back. In a string of bends the warnings pile onto each
// other, so there we say it once, close in.
const MIN_GAP_FOR_ADVANCE_M = 450;
// Never two spoken instructions within this window, unless the second is
// the immediate one.
const NAV_COOLDOWN_MS = 7000;
// Beyond this you are not "off the route", you are on your way to it.
const NOT_STARTED_M = 2500;
// To count as actually being on the route — and therefore to have
// covered the part behind you — you have to be near enough that no other
// road could plausibly be the one you're on.
const ON_LINE_M = 600;
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
    toStart: () => 'Je bent nog niet op de route. Ik breng je eerst naar het startpunt.',
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
    toStart: () => "You're not on the route yet. Taking you to the start first.",
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
    this.stepIndex = [];  // where each step sits along `geometry`
    this.stepGap = [];    // metres from the previous manoeuvre to this one
    this.lastNavAt = 0;
    // The furthest along the line you have genuinely been. Only ever
    // moves forward, and only counts when you were close to the line.
    this.maxReachedIndex = 0;
    this.quality = 'none'; // 'none' | 'skeleton' | 'routed'
    this.currentStepIndex = 0;
    this.announcedThisStep = new Set();
    this.offRouteSince = null;
    this.route = null;
    this.destination = null;
    // While guiding you to the start, the route's own line is parked here
    // and restored on arrival.
    this.approaching = false;
    this.baseGeometry = null;
    this.baseSteps = null;
    this.enabled = true;
  }

  /** Loads the best geometry available: cache, then a live OSRM call. */
  async load(route) {
    this.route = route;
    this.destination = route.waypoints[route.waypoints.length - 1];
    this.currentStepIndex = 0;
    this.announcedThisStep.clear();
    this.offRouteSince = null;
    this.maxReachedIndex = 0;
    // A fresh route is never mid-approach, even if the last one was.
    this.approaching = false;
    this.baseGeometry = null;
    this.baseSteps = null;

    const cached = loadCachedGeometry(route.id);
    if (cached && cached.geometry && cached.geometry.length > 2) {
      this.geometry = cached.geometry;
      this.steps = cached.steps;
      this.quality = 'routed';
      this._indexSteps();
      this._stashRouteLine();
      this._notifyGeometry();
      return;
    }

    // Show something immediately so the map isn't empty while we wait.
    // An imported GPX already carries a dense, accurate line — use that
    // rather than the coarse waypoint skeleton we derived from it.
    this.geometry = route.geometry && route.geometry.length > 2
      ? route.geometry.map((p) => ({ lat: p.lat, lon: p.lon }))
      : route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    this.steps = [];
    this.quality = 'skeleton';
    this._notifyGeometry();

    try {
      const routed = await fetchOSRM(route.waypoints);
      this.geometry = routed.geometry;
      this.steps = routed.steps;
      this.quality = 'routed';
      this._indexSteps();
      this._stashRouteLine();
      saveCachedGeometry(route.id, routed);
      this._notifyGeometry();
    } catch (err) {
      console.warn('OSRM routing failed, staying on the skeleton line:', err);
    }
  }

  /** Records where each manoeuvre sits along the line, so we can jump to
   *  the right one when you join a route partway. */
  _indexSteps() {
    this.stepIndex = this.steps.map(
      (step) => nearestIndex(step.location, this.geometry).index
    );
    this.stepGap = this.steps.map((step, i) =>
      i === 0 ? Infinity : distanceMetres(this.steps[i - 1].location, step.location)
    );
  }

  /**
   * Skips forward to the manoeuvre you're actually approaching.
   *
   * Starting at step zero when you joined the route halfway means being
   * told to turn left at a junction thirty kilometres behind you, and
   * then silence until the route happens to catch up.
   */
  syncToPosition(pos) {
    if (this.steps.length === 0 || this.geometry.length < 2) return;
    if (!this.stepIndex || this.stepIndex.length !== this.steps.length) this._indexSteps();

    const { index, distance } = nearestIndex(pos, this.geometry);
    // Too far off the route to say anything sensible about which turn is
    // next — leave it at the start and let rerouting handle it.
    if (distance > 3000) return;

    // Only treat the part behind you as covered if you are genuinely on
    // the road. Starting a reversed route from a hotel two kilometres
    // from the finish would otherwise read as "almost done".
    if (distance <= ON_LINE_M) this.maxReachedIndex = Math.max(this.maxReachedIndex, index);

    let next = this.stepIndex.findIndex((at) => at >= index);
    if (next === -1) next = this.steps.length - 1;

    this.currentStepIndex = next;
    this.announcedThisStep.clear();
  }

  /**
   * Recomputes the route from where you are, through the points you still
   * want, to the finish.
   *
   * Used when you skip a highlight: there's no sense continuing to steer
   * you down a detour towards something you've just said you don't want
   * to see. The result deliberately isn't cached — it's a one-off
   * personal detour, and writing it over the stored route would hand the
   * shortcut to every future drive.
   */
  async rerouteVia(from, viaPoints) {
    const points = [from, ...viaPoints].filter(Boolean);
    if (points.length < 2) return false;

    // The public OSRM service is a shared courtesy; keep the request
    // modest rather than throwing twenty waypoints at it.
    const trimmed = points.length > 12
      ? [points[0], ...thinEvenly(points.slice(1, -1), 9), points[points.length - 1]]
      : points;

    try {
      const routed = await fetchOSRM(trimmed);
      this.geometry = routed.geometry;
      this.steps = routed.steps;
      this.quality = 'routed';
      this.currentStepIndex = 0;
      this.announcedThisStep.clear();
      this.offRouteSince = null;
      // Same reasoning as in _reroute: this line begins under your wheels.
      this.maxReachedIndex = 0;
      this._indexSteps();
      this._notifyGeometry();
      return true;
    } catch {
      return false; // offline or the service is busy; keep the old line
    }
  }

  /** Forces a fresh route from `from` to the original destination — used for rerouting. */
  _stashRouteLine() {
    this.baseGeometry = this.geometry;
    this.baseSteps = this.steps;
  }

  /**
   * Recalculates, and decides first whether you are off the route or
   * simply not on it yet.
   *
   * Those are different problems and they need different answers. Merging
   * the drive to the start into one long line looks tidy but breaks
   * badly on exactly the routes people reverse: from Olbia, the quickest
   * way to Santa Maria Navarrese *is* the SS125, so the combined line
   * runs south down the road and then north back up it. A line that
   * doubles over itself has two nearby points for every position, and
   * progress snaps to whichever is marginally closer — which is how the
   * start ended up behind you on the second recalculation.
   *
   * So getting to the start is its own leg. The route's own line waits
   * untouched until you arrive.
   */
  async _reroute(from) {
    if (!this.route) return;

    const routeLine = this.baseGeometry && this.baseGeometry.length > 1
      ? this.baseGeometry
      : this.geometry;
    const notStarted =
      this.maxReachedIndex === 0 &&
      distanceToPolyline(from, routeLine) > NOT_STARTED_M;

    if (notStarted || this.approaching) {
      await this._approachStart(from);
      return;
    }

    const remaining = this._waypointsAhead(from);
    const points = [{ lat: from.lat, lon: from.lon }, ...remaining];
    const trimmed = points.length > 12
      ? [points[0], ...thinEvenly(points.slice(1, -1), 9), points[points.length - 1]]
      : points;

    try {
      const routed = await fetchOSRM(trimmed);
      this.geometry = routed.geometry;
      this.steps = routed.steps;
      this.currentStepIndex = 0;
      this.announcedThisStep.clear();
      // A rerouted line always starts where you are standing, so progress
      // along it begins at zero. Carrying the old number over is
      // meaningless — index 800 on the previous line points somewhere
      // else entirely on this one.
      this.maxReachedIndex = 0;
      this._indexSteps();
      this._stashRouteLine();
      this._notifyGeometry();
    } catch (err) {
      console.warn('Reroute failed:', err);
    }
  }

  /** A single leg from where you are to the beginning of the route. */
  async _approachStart(from) {
    const start = this.route.waypoints[0];
    try {
      const routed = await fetchOSRM([{ lat: from.lat, lon: from.lon }, start]);
      if (!this.approaching) this._stashRouteLine();
      this.approaching = true;
      this.geometry = routed.geometry;
      this.steps = routed.steps;
      this.currentStepIndex = 0;
      this.announcedThisStep.clear();
      this.maxReachedIndex = 0;
      this._indexSteps();
      this._notifyGeometry();
    } catch (err) {
      console.warn('Approach routing failed:', err);
    }
  }

  /** Hands control back to the route once you reach its beginning. */
  _finishApproach(lang) {
    if (!this.approaching || !this.baseGeometry) return;
    this.approaching = false;
    this.geometry = this.baseGeometry;
    this.steps = this.baseSteps || [];
    this.currentStepIndex = 0;
    this.announcedThisStep.clear();
    this.maxReachedIndex = 0;
    this.offRouteSince = null;
    this._indexSteps();
    this._notifyGeometry();

    this.speech.speakNow({
      title: lang === 'nl' ? 'Startpunt' : 'Start',
      body: lang === 'nl'
        ? 'Je bent bij het startpunt. De route begint hier.'
        : "You've reached the start. The route begins here.",
      source: 'nav'
    });
  }

  /**
   * The route points you still have to cover.
   *
   * Far enough off the line and the honest reading is that you haven't
   * begun yet — you're driving to the start — so the whole route counts
   * as remaining. Closer in, only what lies beyond your current position
   * does.
   */
  _waypointsAhead(from) {
    const all = this.route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    if (this.geometry.length < 2) return all;

    if (distanceToPolyline(from, this.geometry) > NOT_STARTED_M) return all;

    // How far you have actually got, not how close you happen to be to
    // some part of the line.
    const here = this.maxReachedIndex;
    const ahead = all.filter(
      (w) => nearestIndex(w, this.geometry).index > here
    );
    // Always finish where the route finishes.
    return ahead.length > 0 ? ahead : [all[all.length - 1]];
  }

  /** Called on every position update. */
  handlePosition(pos, lang) {
    // Reaching the start hands guidance back to the route itself.
    if (this.approaching && this.route) {
      const start = this.route.waypoints[0];
      if (distanceMetres(pos, start) < 250) this._finishApproach(lang);
    }

    if (!this.enabled || this.steps.length === 0) {
      this._trackOffRoute(pos, lang);
      return;
    }

    const step = this.steps[this.currentStepIndex];
    if (!step) return;

    const distanceToStep = distanceMetres(pos, step.location);

    for (const threshold of ANNOUNCE_THRESHOLDS_M) {
      const key = `${this.currentStepIndex}:${threshold}`;
      if (distanceToStep > threshold || this.announcedThisStep.has(key)) continue;

      const isImmediate = threshold === ANNOUNCE_THRESHOLDS_M[ANNOUNCE_THRESHOLDS_M.length - 1];

      if (!isImmediate) {
        // Bends coming thick and fast: skip the heads-up entirely rather
        // than talking over the previous one.
        if ((this.stepGap[this.currentStepIndex] ?? Infinity) < MIN_GAP_FOR_ADVANCE_M) {
          this.announcedThisStep.add(key);
          continue;
        }
        // Still inside the quiet window — leave the key unmarked so it
        // can be reconsidered on the next fix.
        if (Date.now() - this.lastNavAt < NAV_COOLDOWN_MS) continue;
      }

      this.announcedThisStep.add(key);
      this._announce(step, distanceToStep <= ARRIVE_THRESHOLD_M ? null : threshold, lang);
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
    if (distance <= ON_LINE_M && this.geometry.length > 1) {
      this.maxReachedIndex = Math.max(
        this.maxReachedIndex,
        nearestIndex(pos, this.geometry).index
      );
    }
    this.dispatchEvent(new CustomEvent('offroute', { detail: distance }));

    if (distance > OFF_ROUTE_THRESHOLD_M) {
      if (this.offRouteSince == null) this.offRouteSince = Date.now();
      if (Date.now() - this.offRouteSince > OFF_ROUTE_PERSIST_MS) {
        this.offRouteSince = null;
        const notStarted = !this.approaching && distance > NOT_STARTED_M;
        this.speech.speakNow({
          title: lang === 'nl' ? 'Herberekenen' : 'Recalculating',
          body: notStarted ? PHRASES[lang].toStart() : PHRASES[lang].recalculating(),
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
    const item = {
      title: lang === 'nl' ? 'Navigatie' : 'Navigation',
      body,
      source: 'nav'
    };

    // The early warning at 400 m can wait its turn: cutting a story in
    // half for a junction you won't reach for twenty seconds is worse
    // than hearing about it a moment later. Anything closer takes
    // priority immediately — you need that one before the junction, not
    // after it.
    this.lastNavAt = Date.now();
    const canWait = thresholdOrNull != null && thresholdOrNull >= 300;
    if (canWait && this.speech.isSpeaking) {
      this.speech.enqueue(item);
    } else {
      this.speech.speakNow(item);
    }
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

  return { geometry, steps: keepRealDecisions(steps) };
}

// Manoeuvre types that represent an actual decision. Everything else —
// "continue", "new name", "notification" — is OSRM telling you the road
// bent or changed name, which on a Sardinian coast road happens every few
// hundred metres. Announcing those was the bulk of the chatter.
const REAL_DECISIONS = new Set([
  'turn', 'fork', 'merge', 'on ramp', 'off ramp',
  'end of road', 'roundabout', 'rotary', 'arrive'
]);

/**
 * Strips the step list down to things worth saying out loud.
 *
 * Also drops "turn straight" and "fork straight", which mean "carry on"
 * dressed up as an instruction. The arrival step is always kept — you
 * want to be told you're there.
 */
function keepRealDecisions(steps) {
  const kept = steps.filter((step) => {
    if (step.type === 'arrive') return true;
    if (!REAL_DECISIONS.has(step.type)) return false;
    if ((step.type === 'turn' || step.type === 'fork') &&
        (!step.modifier || step.modifier === 'straight')) return false;
    return true;
  });

  // If a route somehow has no junctions at all, fall back rather than
  // leaving the driver with nothing.
  return kept.length > 0 ? kept : steps.slice(-1);
}

/** Keeps `count` points spread evenly across a list. */
function thinEvenly(points, count) {
  if (points.length <= count) return points;
  const step = points.length / count;
  return Array.from({ length: count }, (_, i) => points[Math.floor(i * step)]);
}

// ── Banner text ───────────────────────────────────────────────────────
//
// The spoken sentences above are written to be heard once, in passing.
// A banner is read at a glance, repeatedly, so it needs the opposite:
// two or three words and a symbol you recognise before you've read it.

const GLYPHS = {
  uturn: '⮌',
  'sharp left': '⬉',
  left: '⬅',
  'slight left': '⬀',
  straight: '⬆',
  'slight right': '⬈',
  right: '➡',
  'sharp right': '⬊'
};

function glyphFor(step) {
  const left = (step.modifier || '').includes('left');

  if (step.type === 'arrive') return '⚑';
  if (step.type === 'roundabout' || step.type === 'rotary') return '⟳';
  if (step.type === 'merge') return left ? '⬀' : '⬈';
  if (step.type === 'on ramp') return '⬈';
  if (step.type === 'off ramp') return left ? '⬋' : '⬊';
  // A fork is a lane choice, not a turn. OSRM labels it "left" or
  // "right", but a full ninety-degree arrow there tells you to swing the
  // wheel when all you need to do is stay left of the divider.
  if (step.type === 'fork') return left ? '⬀' : '⬈';

  return GLYPHS[step.modifier] || '⬆';
}

const BANNER = {
  nl: {
    uturn: 'Keren',
    'sharp left': 'Scherp linksaf',
    left: 'Linksaf',
    'slight left': 'Links aanhouden',
    straight: 'Rechtdoor',
    'slight right': 'Rechts aanhouden',
    right: 'Rechtsaf',
    'sharp right': 'Scherp rechtsaf',
    arrive: 'Bestemming',
    merge: 'Invoegen',
    onRamp: 'Oprit nemen',
    offRamp: 'Afrit nemen',
    endOfRoad: 'Einde weg',
    roundabout: (n) => (n ? `Rotonde, ${n}e afslag` : 'Rotonde'),
    fork: (left) => (left ? 'Links aanhouden' : 'Rechts aanhouden'),
    onto: 'naar'
  },
  en: {
    uturn: 'Make a U-turn',
    'sharp left': 'Sharp left',
    left: 'Turn left',
    'slight left': 'Keep left',
    straight: 'Straight on',
    'slight right': 'Keep right',
    right: 'Turn right',
    'sharp right': 'Sharp right',
    arrive: 'Destination',
    merge: 'Merge',
    onRamp: 'Take the ramp',
    offRamp: 'Take the exit',
    endOfRoad: 'End of road',
    roundabout: (n) => (n ? `Roundabout, exit ${n}` : 'Roundabout'),
    fork: (left) => (left ? 'Keep left' : 'Keep right'),
    onto: 'onto'
  }
};

/** Everything the banner needs for one manoeuvre. */
export function maneuverBanner(step, lang) {
  const b = BANNER[lang] || BANNER.nl;
  const left = (step.modifier || '').includes('left');
  let text;

  switch (step.type) {
    case 'arrive': text = b.arrive; break;
    case 'roundabout':
    case 'rotary': text = b.roundabout(step.exit); break;
    case 'merge': text = b.merge; break;
    case 'on ramp': text = b.onRamp; break;
    case 'off ramp': text = b.offRamp; break;
    case 'fork': text = b.fork(left); break;
    case 'end of road': text = `${b.endOfRoad}, ${(b[step.modifier] || b.straight).toLowerCase()}`; break;
    default: text = b[step.modifier] || b.straight;
  }

  return {
    // The icon is drawn as SVG by maneuverIcons.js; the glyph stays only
    // as a text fallback for anything that can't render inline SVG.
    glyph: glyphFor(step),
    step,
    text,
    // Only worth showing if the road actually has a name; OSRM leaves it
    // blank on plenty of Sardinian back roads.
    road: step.roadName ? `${b.onto} ${step.roadName}` : ''
  };
}
