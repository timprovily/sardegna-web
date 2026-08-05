// Loads everything that ships with the app: the eight routes and the
// island facts. All of this is static JSON served from the same origin,
// so it works offline once the service worker has cached it once.

export async function loadRoutes() {
  const manifest = await fetchJSON('data/routes-manifest.json');
  const routes = [];
  for (const file of manifest.files) {
    try {
      routes.push(await fetchJSON(`data/${file}`));
    } catch (err) {
      console.error(`Kon ${file} niet laden:`, err);
    }
  }
  return routes;
}

export async function loadFacts() {
  const wrapper = await fetchJSON('data/facts.json');
  return wrapper.facts;
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// --- Small geometry helpers shared across modules ---------------------

/** Haversine distance in metres between two {lat, lon} points. */
export function distanceMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Shortest distance in metres from a point to a polyline. */
export function distanceToPolyline(point, polyline) {
  if (!polyline || polyline.length === 0) return Infinity;
  if (polyline.length === 1) return distanceMetres(point, polyline[0]);

  let best = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = distanceToSegment(point, polyline[i], polyline[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function distanceToSegment(p, a, b) {
  // Work in a local flat approximation — fine at the scale of a road segment.
  const toXY = (pt, origin) => ({
    x: (pt.lon - origin.lon) * 111320 * Math.cos((origin.lat * Math.PI) / 180),
    y: (pt.lat - origin.lat) * 110540
  });
  const A = toXY(a, a);
  const B = toXY(b, a);
  const P = toXY(p, a);

  const abx = B.x - A.x;
  const aby = B.y - A.y;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((P.x - A.x) * abx + (P.y - A.y) * aby) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));

  const projX = A.x + t * abx;
  const projY = A.y + t * aby;
  const dx = P.x - projX;
  const dy = P.y - projY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Index of the polyline vertex closest to a point, with its distance.
 *  This is how the app knows *where along* a route you are, as opposed to
 *  merely how far you are from it. */
export function nearestIndex(point, polyline) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const d = distanceMetres(point, polyline[i]);
    if (d < bestDistance) { bestDistance = d; bestIndex = i; }
  }
  return { index: bestIndex, distance: bestDistance };
}

/** Fraction (0–1) of the way along a polyline, based on the nearest vertex
 *  to the given point. Same approach the native app used for its ribbon. */
export function progressFraction(point, polyline) {
  if (!polyline || polyline.length < 2) return 0;
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const d = distanceMetres(point, polyline[i]);
    if (d < bestDistance) { bestDistance = d; bestIndex = i; }
  }
  return bestIndex / (polyline.length - 1);
}

export function formatDistance(metres, lang) {
  if (metres == null || !isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
