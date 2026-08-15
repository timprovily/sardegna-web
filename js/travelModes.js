// How the guide behaves at different speeds.
//
// Everything in this app was originally sized for a car at eighty
// kilometres an hour. On a bicycle at twenty, or on foot at five, the
// same numbers are wrong in every direction: a story that starts nine
// hundred metres out finishes long before you arrive, a turn announced at
// three hundred metres is announced a minute and a half early, and seven
// minutes of silence is a long time when you're covering two kilometres
// in it.
//
// So rather than scaling one set of constants by speed, each mode carries
// its own. They're derived from *time*, which is what actually matters:
// roughly the same number of seconds between hearing about a place and
// reaching it, whatever you're travelling on.

export const MODES = {
  car: {
    id: 'car',
    icon: '🚗',
    label: { nl: 'Auto', en: 'Car' },
    // OSRM's public profiles. Only driving is guaranteed to be up on the
    // demo server; the others are handled with a fallback.
    osrmProfile: 'driving',
    typicalSpeedKmh: 55,
    // Metres from a place at which its story begins.
    highlightRadius: 900,
    // Announce a turn at these distances.
    announceThresholds: [300, 40],
    // Below this gap between manoeuvres, skip the advance warning.
    minGapForAdvance: 450,
    // Never two instructions closer together than this.
    cooldownMs: 7000,
    // Minutes of silence before an island fact.
    factInterval: 7,
    // Below this you count as stopped, so no filler.
    movingThresholdKmh: 12,
    // How far off the line before the guide stops telling stories.
    storyCorridor: 3000,
    // How far off before "you're off the route".
    offRouteThreshold: 70
  },

  bike: {
    id: 'bike',
    icon: '🚲',
    label: { nl: 'Fiets', en: 'Bike' },
    osrmProfile: 'bike',
    typicalSpeedKmh: 18,
    // A quarter of the car figure: at 18 km/h that's still fifty seconds
    // of approach, which is about right for a story to land as you
    // arrive rather than long before.
    highlightRadius: 250,
    announceThresholds: [100, 25],
    minGapForAdvance: 150,
    cooldownMs: 5000,
    // You cover far less ground per minute, so the same silence feels
    // much longer and the landscape changes more slowly.
    factInterval: 5,
    movingThresholdKmh: 4,
    // A cyclist on a parallel path is genuinely near the route; a car
    // three kilometres away is on a different road entirely.
    storyCorridor: 600,
    offRouteThreshold: 45
  },

  walk: {
    id: 'walk',
    icon: '🥾',
    label: { nl: 'Wandelen', en: 'Walking' },
    osrmProfile: 'foot',
    typicalSpeedKmh: 4.5,
    // Close enough that you're looking at the thing while hearing about
    // it. At walking pace even 120 m is a minute and a half of approach,
    // which is long enough to forget what you were told.
    highlightRadius: 70,
    announceThresholds: [30, 10],
    minGapForAdvance: 80,
    cooldownMs: 4000,
    factInterval: 4,
    movingThresholdKmh: 1.5,
    storyCorridor: 250,
    offRouteThreshold: 30
  }
};

export const DEFAULT_MODE = 'car';

export function getMode(id) {
  return MODES[id] || MODES[DEFAULT_MODE];
}

/** The mode a route was built for, defaulting to car for everything that
 *  predates this setting. */
export function modeOf(route) {
  return getMode(route?.travelMode);
}

/**
 * OSRM endpoint for a profile.
 *
 * The public demo server only reliably serves the driving profile. The
 * bike and foot profiles live on a separate community host which is
 * generally up but occasionally isn't — so a caller that fails should
 * fall back to driving rather than leaving someone without a line.
 */
export function osrmBaseFor(modeId) {
  const mode = getMode(modeId);
  if (mode.osrmProfile === 'driving') {
    return 'https://router.project-osrm.org/route/v1/driving/';
  }
  return `https://routing.openstreetmap.de/routed-${mode.osrmProfile}/route/v1/${mode.osrmProfile}/`;
}
