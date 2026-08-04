// Import a GPX file and turn it into a full route with spoken highlights.
//
// This is the bridge to every other route planner. Komoot has no public
// API — they say so themselves, and the unofficial workarounds need your
// password and break whenever Komoot changes something. But Komoot,
// Strava, Wikiloc, RideWithGPS, Outdooractive and Garmin all export GPX,
// so GPX is the format that actually works everywhere.
//
// Finding the highlights is the interesting part. We walk along the track,
// ask Wikipedia's geosearch endpoint what it knows near each sample point,
// keep whatever sits close to the road, and turn the article summaries
// into narration. Free, no API key, and the same source the built-in
// routes already use for their online extras.

import { distanceMetres, distanceToPolyline } from './data.js';

const SAMPLE_SPACING_M = 4000;    // how often along the track we ask
const SEARCH_RADIUS_M = 6000;     // geosearch radius per sample (max 10000)
const MAX_DISTANCE_FROM_ROUTE_M = 2500;
const MAX_HIGHLIGHTS = 14;
const MIN_SPACING_BETWEEN_HIGHLIGHTS_M = 1500;
const SUMMARY_CONCURRENCY = 4;

/** Parses GPX text into an ordered list of {lat, lon} points. */
export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Dit lijkt geen geldig GPX-bestand.');
  }

  // Track points first; fall back to route points, then waypoints.
  let nodes = [...doc.getElementsByTagName('trkpt')];
  if (nodes.length === 0) nodes = [...doc.getElementsByTagName('rtept')];
  if (nodes.length === 0) nodes = [...doc.getElementsByTagName('wpt')];
  if (nodes.length === 0) {
    throw new Error('Geen track- of routepunten gevonden in dit bestand.');
  }

  const points = nodes
    .map((n) => ({
      lat: parseFloat(n.getAttribute('lat')),
      lon: parseFloat(n.getAttribute('lon'))
    }))
    .filter((p) => isFinite(p.lat) && isFinite(p.lon));

  if (points.length < 2) throw new Error('Te weinig punten in dit bestand.');

  // A name, if the file carries one.
  const nameNode = doc.querySelector('trk > name, rte > name, metadata > name');
  const name = nameNode ? nameNode.textContent.trim() : null;

  return { points, name };
}

/** Total length of a polyline in metres. */
export function trackLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += distanceMetres(points[i], points[i + 1]);
  }
  return total;
}

/** Picks points spaced roughly `spacing` metres apart along the track. */
function samplePoints(points, spacing) {
  const samples = [points[0]];
  let accumulated = 0;
  for (let i = 1; i < points.length; i++) {
    accumulated += distanceMetres(points[i - 1], points[i]);
    if (accumulated >= spacing) {
      samples.push(points[i]);
      accumulated = 0;
    }
  }
  const last = points[points.length - 1];
  if (distanceMetres(samples[samples.length - 1], last) > spacing / 2) samples.push(last);
  return samples;
}

/** Reduces a dense track to at most `max` points, for storage and drawing. */
function thin(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

/** Asks Wikipedia what it knows near a coordinate. */
async function geosearch(point, lang) {
  const url =
    `https://${lang}.wikipedia.org/w/api.php` +
    `?action=query&list=geosearch` +
    `&gscoord=${point.lat}%7C${point.lon}` +
    `&gsradius=${SEARCH_RADIUS_M}&gslimit=20&format=json&origin=*`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.query?.geosearch || [];
  } catch {
    return [];
  }
}

/** Fetches the short summary for a page title. */
async function summary(title, lang) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.extract || json.type === 'disambiguation') return null;
    return json.extract;
  } catch {
    return null;
  }
}

/** Runs async tasks with a cap on how many are in flight at once. */
async function pooled(items, limit, worker) {
  const results = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Trims an extract to something that reads well at 80 km/h. */
function shorten(text, maxSentences = 3) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  let out = sentences.slice(0, maxSentences).join(' ').trim();
  if (out.length > 600) out = out.slice(0, 600).replace(/\s\S*$/, '') + '…';
  return out;
}

/** Guesses a category from the article title, purely for the map icon. */
function guessKind(title) {
  const t = title.toLowerCase();
  if (/nuraghe|nuraxi|tomba|necropoli|domus|tharros|archeolog/.test(t)) return 'archaeology';
  if (/spiaggia|cala|beach|strand|playa/.test(t)) return 'beach';
  if (/monte|punta|cima|gola|grotta|parco|lago|isola|capo/.test(t)) return 'nature';
  if (/chiesa|basilica|castello|torre|museo|santuario|palazzo/.test(t)) return 'heritage';
  if (/miniera|minier/.test(t)) return 'mining';
  if (/passo|valico/.test(t)) return 'pass';
  return 'town';
}

/**
 * Turns a GPX file into a Route.
 *
 * `onProgress({phase, done, total, message})` is called as it goes, so the
 * UI can show something useful during what is a genuinely slow operation —
 * a long track means a lot of polite requests to Wikipedia.
 */
export async function buildRouteFromGPX(fileText, options) {
  const { language, fallbackName, onProgress = () => {} } = options;

  onProgress({ phase: 'parsing', message: 'Bestand lezen…' });
  const { points, name } = parseGPX(fileText);

  const lengthM = trackLength(points);
  const geometry = thin(points, 600);
  const waypoints = thin(points, 24).map((p) => ({ lat: p.lat, lon: p.lon }));

  const samples = samplePoints(points, SAMPLE_SPACING_M);
  onProgress({
    phase: 'searching',
    done: 0,
    total: samples.length,
    message: `Zoeken naar bezienswaardigheden op ${samples.length} punten…`
  });

  // Collect candidates, deduplicated by page id.
  const candidates = new Map();
  for (let i = 0; i < samples.length; i++) {
    const found = await geosearch(samples[i], language);
    for (const hit of found) {
      if (candidates.has(hit.pageid)) continue;
      const point = { lat: hit.lat, lon: hit.lon };
      const offRoute = distanceToPolyline(point, geometry);
      if (offRoute > MAX_DISTANCE_FROM_ROUTE_M) continue;
      candidates.set(hit.pageid, { ...hit, offRoute, point });
    }
    onProgress({
      phase: 'searching',
      done: i + 1,
      total: samples.length,
      message: `Zoeken… ${candidates.size} kandidaten gevonden`
    });
    // Be a good citizen towards a free public API.
    await new Promise((r) => setTimeout(r, 120));
  }

  // Prefer things close to the road, then spread them along the route so
  // you don't get six articles about the same village in a row.
  const ordered = [...candidates.values()].sort((a, b) => a.offRoute - b.offRoute);
  const chosen = [];
  for (const candidate of ordered) {
    if (chosen.length >= MAX_HIGHLIGHTS) break;
    const tooClose = chosen.some(
      (c) => distanceMetres(c.point, candidate.point) < MIN_SPACING_BETWEEN_HIGHLIGHTS_M
    );
    if (!tooClose) chosen.push(candidate);
  }

  // Put them back in the order you'll actually drive past them.
  const indexAlongTrack = (point) => {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < geometry.length; i++) {
      const d = distanceMetres(point, geometry[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };
  chosen.sort((a, b) => indexAlongTrack(a.point) - indexAlongTrack(b.point));

  onProgress({
    phase: 'summaries',
    done: 0,
    total: chosen.length,
    message: `Achtergrond ophalen voor ${chosen.length} plekken…`
  });

  let completed = 0;
  const extracts = await pooled(chosen, SUMMARY_CONCURRENCY, async (candidate) => {
    const text = await summary(candidate.title, language);
    completed++;
    onProgress({ phase: 'summaries', done: completed, total: chosen.length, message: 'Achtergrond ophalen…' });
    return text;
  });

  const highlights = chosen
    .map((candidate, i) => {
      const extract = extracts[i];
      if (!extract) return null;
      const script = shorten(extract);
      // Custom routes are built in one language. Rather than machine-
      // translating (and getting it subtly wrong), both slots hold the
      // same text and the UI says so.
      const both = { nl: script, en: script };
      return {
        id: `wiki-${candidate.pageid}`,
        kind: guessKind(candidate.title),
        lat: candidate.lat,
        lon: candidate.lon,
        radius: 900,
        name: { nl: candidate.title, en: candidate.title },
        script: both,
        wikipedia: { nl: candidate.title, en: candidate.title }
      };
    })
    .filter(Boolean);

  const routeName = fallbackName || name || 'Geïmporteerde route';
  const km = Math.round(lengthM / 1000);

  const summaryText =
    language === 'nl'
      ? `Geïmporteerde route van ${km} kilometer met ${highlights.length} plekken die de gids onderweg herkent.`
      : `Imported route of ${km} kilometres with ${highlights.length} places the guide recognises along the way.`;

  return {
    id: `custom-${Date.now()}`,
    custom: true,
    sourceLanguage: language,
    name: { nl: routeName, en: routeName },
    region: { nl: 'Eigen import', en: 'Your import' },
    summary: { nl: summaryText, en: summaryText },
    distanceKm: km,
    durationMinutes: Math.round((km / 55) * 60),
    character: { nl: 'Uit GPX-bestand', en: 'From a GPX file' },
    bestTime: { nl: '—', en: '—' },
    waypoints,
    geometry: geometry.map((p) => ({ lat: p.lat, lon: p.lon })),
    highlights,
    dining: []
  };
}
