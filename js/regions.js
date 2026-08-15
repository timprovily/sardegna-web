// Working out where a route actually is, so the home screen can group by
// country and region instead of presenting one undifferentiated list.
//
// The lookup is a single reverse-geocode of the route's midpoint against
// Nominatim — free, no key, and the same OpenStreetMap data the map
// tiles come from. It happens once per imported route and the answer is
// stored with it, so nothing is looked up again on later launches and the
// grouping works offline.
//
// Nominatim asks for light use and a real identifying User-Agent. One
// request per import, cached forever, is well within that.

import { distanceMetres } from './data.js';

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

/** Reverse-geocodes a point into { country, region }. */
export async function lookupRegion(lat, lon, lang = 'nl') {
  const url =
    `${NOMINATIM}?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}` +
    `&zoom=8&accept-language=${lang}`;

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(9000),
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const a = data.address || {};

    // Nominatim's granularity varies by country: an Italian province, a
    // Dutch province and a French department all land in different
    // fields, so take the first that's actually filled.
    const region =
      a.state ||
      a.province ||
      a.region ||
      a.county ||
      a.state_district ||
      a.city ||
      null;

    return {
      country: a.country || null,
      countryCode: (a.country_code || '').toUpperCase() || null,
      region
    };
  } catch {
    return null;
  }
}

/** The middle of a route, which is more representative than either end. */
export function routeMidpoint(route) {
  const points = route.waypoints || [];
  if (points.length === 0) return null;
  const mid = points[Math.floor(points.length / 2)];
  return { lat: mid.lat, lon: mid.lon };
}

/** Shortest distance from a position to any part of a route. */
export function distanceToRoute(position, route) {
  if (!position || !route.waypoints?.length) return Infinity;
  let best = Infinity;
  for (const w of route.waypoints) {
    const d = distanceMetres(position, { lat: w.lat, lon: w.lon });
    if (d < best) best = d;
  }
  return best;
}

const FALLBACK = { nl: 'Onbekende regio', en: 'Unknown region' };

function labelsFor(route, lang) {
  const place = route.place || {};
  // Bundled routes carry a hand-written region name and are all Italian.
  const region = place.region || route.region?.[lang] || FALLBACK[lang];
  const country = place.country || (route.custom ? null : 'Italië');
  return { country, region };
}

/**
 * Groups routes by country, then by region, and orders both by how close
 * they are to you.
 *
 * Distance-first is the whole point of this screen: land at Olbia and the
 * Sardinian routes should be the first thing you see, without scrolling
 * past Friesland. With no location fix, it falls back to alphabetical,
 * which is at least stable and predictable.
 */
export function groupRoutes(routes, position, lang) {
  const countries = new Map();

  for (const route of routes) {
    const { country, region } = labelsFor(route, lang);
    const countryKey = country || (lang === 'nl' ? 'Overig' : 'Elsewhere');

    if (!countries.has(countryKey)) {
      countries.set(countryKey, { name: countryKey, regions: new Map(), distance: Infinity });
    }
    const countryEntry = countries.get(countryKey);

    if (!countryEntry.regions.has(region)) {
      countryEntry.regions.set(region, { name: region, routes: [], distance: Infinity });
    }
    const regionEntry = countryEntry.regions.get(region);

    const distance = distanceToRoute(position, route);
    route._distance = distance;
    regionEntry.routes.push(route);
    regionEntry.distance = Math.min(regionEntry.distance, distance);
    countryEntry.distance = Math.min(countryEntry.distance, distance);
  }

  const byDistanceThenName = (a, b) => {
    if (position) {
      if (a.distance !== b.distance) return a.distance - b.distance;
    }
    return a.name.localeCompare(b.name, lang);
  };

  return [...countries.values()]
    .map((country) => ({
      ...country,
      regions: [...country.regions.values()]
        .map((region) => ({
          ...region,
          routes: region.routes.sort((a, b) =>
            position ? a._distance - b._distance : a.name[lang].localeCompare(b.name[lang], lang)
          )
        }))
        .sort(byDistanceThenName)
    }))
    .sort(byDistanceThenName);
}

/** "12 km", "340 km" — or nothing at all when we don't know where you are. */
export function proximityLabel(metres, lang) {
  if (!isFinite(metres)) return '';
  if (metres < 1000) return lang === 'nl' ? 'hier' : 'here';
  if (metres < 100000) return `${Math.round(metres / 1000)} km`;
  return `${Math.round(metres / 10000) * 10} km`;
}
