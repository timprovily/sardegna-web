import { loadRoutes, loadFacts, formatDistance, distanceMetres, distanceToPolyline, nearestIndex } from './data.js';
import { loadSettings, saveSettings, loadCustomRoutes, saveCustomRoute, deleteCustomRoute } from './storage.js';
import { SpeechService } from './speech.js';
import { LocationService } from './geo.js';
import { NavEngine, maneuverBanner } from './navEngine.js';
import { maneuverIconSVG } from './maneuverIcons.js';
import { reverseRoute, unreverseRoute } from './reverse.js';
import { MODES, DEFAULT_MODE, getMode, modeOf } from './travelModes.js';
import { groupRoutes, proximityLabel } from './regions.js';
import { FactSource } from './regionFacts.js';
import { TourEngine } from './tourEngine.js';
import { EnrichmentService } from './enrichment.js';
import { RouteMap } from './map.js';
import { OverviewMap, ROUTE_COLORS } from './overviewMap.js';
import { WakeLockManager } from './wakeLock.js';
import { t, applyStaticStrings } from './i18n.js';
import { ThemeManager } from './theme.js';
import { buildRouteFromGPX } from './gpxImport.js';
import { fetchWeather, describeCode, goldenHourDeparture, formatTime } from './weather.js';
import { SpotifyController, redirectURI } from './spotify.js';
import { RadioController, searchStations, BUILTIN_STATIONS } from './radio.js';
import { Storyteller, MODELS } from './storyteller.js';

// ─────────────────────────── State ───────────────────────────

const settings = loadSettings();
const speech = new SpeechService();
const location = new LocationService();
const enrichment = new EnrichmentService();
const storyteller = new Storyteller(enrichment);
const factSource = new FactSource(storyteller);
const tourEngine = new TourEngine({ speech, facts: [], settings, enrichment, storyteller, factSource });
const navEngine = new NavEngine(speech);
const wakeLock = new WakeLockManager();
const theme = new ThemeManager(settings);
const spotify = new SpotifyController(settings);
const radio = new RadioController();

let routes = [];
let currentRoute = null;
let detailMap = null;
let driveMap = null;
let overviewMap = null;
const appState = { listSortedByLocation: false };

syncSpeechFromSettings();

// ─────────────────────────── Boot ───────────────────────────

(async function boot() {
  theme.start();
  applyStaticStrings(settings.language);
  document.getElementById('header-sub').textContent = '';

  try {
    const [bundled, facts] = await Promise.all([loadRoutes(), loadFacts()]);
    tourEngine.facts = facts;
    tourEngine.baseFacts = facts;
    routes = [...bundled, ...loadCustomRoutes()];
  } catch (err) {
    document.getElementById('route-list').innerHTML =
      `<div class="panel"><div class="eyebrow tint-porphyry">Content</div><p>${escapeHTML(String(err))}</p></div>`;
    return;
  }

  document.getElementById('header-sub').textContent =
    settings.language === 'nl'
      ? `${routes.length} routes, offline. Zet 'm aan en rijden.`
      : `${routes.length} routes, offline. Start it and drive.`;

  renderRouteList();
  renderOverviewMap();
  wireGlobalControls();
  wireSettingsSheet();
  initMusic();
  updateAudioStatus();

  if ('mediaSession' in navigator) {
    // Lets iOS show the current story on the lock screen, same as a podcast.
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Sardegna' });
  }

  // Order the list by distance right away, but only if permission was
  // already granted on a previous drive — nobody should get a location
  // prompt just for opening the app.
  if (settings.locationGranted) {
    location.once().then(() => {
      appState.listSortedByLocation = true;
      renderRouteList();
    }).catch(() => {});
  }

  registerServiceWorker();
})();

// ─────────────────────────── Route list ───────────────────────────

function renderRouteList() {
  const lang = settings.language;
  const container = document.getElementById('route-list');
  container.innerHTML = '';

  const here = location.last;
  const groups = groupRoutes(routes, here, lang);

  if (!here) {
    const hint = document.createElement('p');
    hint.className = 'footnote';
    hint.textContent = t('region.noLocation', lang);
    container.appendChild(hint);
  }

  groups.forEach((country, countryIndex) => {
    const block = document.createElement('div');
    block.className = 'country-group' + (here && countryIndex === 0 ? ' nearest' : '');

    const head = document.createElement('div');
    head.className = 'country-head';
    head.innerHTML =
      `<span class="country-name">${escapeHTML(country.name)}</span>` +
      (here && countryIndex === 0 ? `<span class="nearby-flag">${t('region.nearby', lang)}</span>` : '') +
      (here ? `<span class="country-distance">${proximityLabel(country.distance, lang)}</span>` : '');
    block.appendChild(head);

    for (const region of country.regions) {
      const regionBlock = document.createElement('div');
      regionBlock.className = 'region-group';
      regionBlock.innerHTML =
        `<div class="region-head">` +
        `<span class="region-name">${escapeHTML(region.name)}</span>` +
        `<span class="region-count">${region.routes.length}</span>` +
        `</div>`;

      for (const route of region.routes) {
        regionBlock.appendChild(routeCard(route, lang, here));
      }
      block.appendChild(regionBlock);
    }
    container.appendChild(block);
  });
}

function routeCard(route, lang, here) {
  const card = document.createElement('button');
  card.className = 'panel route-card';
  const mode = modeOf(route);
  const badge = route.custom
    ? `<span class="custom-badge">${t('import.custom', lang)}</span>` : '';
  const distance = here && isFinite(route._distance)
    ? `<span class="route-distance">${proximityLabel(route._distance, lang)}</span>` : '';

  card.innerHTML = `
    <div class="eyebrow">${escapeHTML(route.region[lang])}${badge}
      <span class="mode-chip">${mode.icon} ${mode.label[lang]}</span>${distance}
    </div>
    <h2>${escapeHTML(route.name[lang])}</h2>
    <p class="summary">${escapeHTML(route.summary[lang])}</p>
    <div class="route-stats">
      <div class="stat">${route.distanceKm}<span>km</span></div>
      <div class="stat">${route.durationMinutes}<span>min</span></div>
      <div class="stat">${route.highlights.length}<span>${lang === 'nl' ? 'verhalen' : 'stories'}</span></div>
      <div class="chev">›</div>
    </div>`;
  card.addEventListener('click', () => openDetail(route));
  return card;
}

/** All eight routes on one map, so you can see where each one actually is
 *  before opening it — the thing a route name alone doesn't tell you. */
function renderOverviewMap() {
  if (routes.length === 0) return;
  const lang = settings.language;

  requestAnimationFrame(() => {
    if (!overviewMap) overviewMap = new OverviewMap('overview-map');
    overviewMap.invalidateSize();
    overviewMap.show(routes, (route) => openDetail(route));

    const legend = document.getElementById('overview-legend');
    legend.innerHTML = '';
    routes.forEach((route, index) => {
      const btn = document.createElement('button');
      const color = ROUTE_COLORS[index % ROUTE_COLORS.length];
      btn.innerHTML = `<span class="dot" style="background:${color}"></span>${route.name[lang]}`;
      btn.addEventListener('click', () => openDetail(route));
      legend.appendChild(btn);
    });
  });
}

// ─────────────────────────── Route detail ───────────────────────────

function openDetail(route) {
  currentRoute = route;
  const lang = settings.language;

  document.getElementById('detail-region').innerHTML =
    escapeHTML(route.region[lang]) +
    (route.reversed ? `<span class="custom-badge">${t('reverse.badge', lang)}</span>` : '');
  document.getElementById('detail-name').textContent = route.name[lang];
  document.getElementById('detail-summary').textContent =
    route.summary[lang] + (route.reversed ? ' ' + t('reverse.note', lang) : '');
  document.getElementById('detail-distance').textContent = `${route.distanceKm} km`;
  document.getElementById('detail-duration').textContent = `${route.durationMinutes} min`;
  document.getElementById('detail-count').textContent = route.highlights.length;
  document.getElementById('detail-character').textContent = route.character[lang];
  document.getElementById('detail-besttime').textContent = route.bestTime[lang];

  renderHighlightList(route);
  renderDining(route);
  renderCustomRouteControls(route);
  renderStoryBlock(route);
  renderFactsBlock(route);
  renderReverseButton(route);
  renderWeather(route);
  loadHighlightPhotos(route);
  updateMapsButton(route);
  // Only ask for a fix if permission was already given on an earlier
  // drive — nobody should get a location prompt just for reading about
  // a route.
  if (settings.locationGranted) {
    location.once().then(() => {
      if (currentRoute === route) updateMapsButton(route);
    }).catch(() => {});
  }
  showScreen('detail-screen');

  requestAnimationFrame(() => {
    if (!detailMap) detailMap = new RouteMap('map-preview');
    detailMap.invalidateSize();
    const skeleton = route.geometry && route.geometry.length > 2
      ? route.geometry.map((p) => ({ lat: p.lat, lon: p.lon }))
      : route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
    detailMap.showRoute(route, skeleton);
    detailMap.onHighlightTap = (h) => tourEngine.playHighlight(h);

    // Try to upgrade to a road-snapped line in the background.
    navEngine.load(route).then(() => {
      if (currentRoute === route) detailMap.updateGeometry(navEngine.geometry);
    });
  });
}

function renderHighlightList(route) {
  const lang = settings.language;
  const container = document.getElementById('highlight-list');
  container.innerHTML = `<div class="eyebrow" style="margin-bottom:10px">${lang === 'nl' ? 'Onderweg hoor je' : 'Along the way'}</div>`;

  for (const h of route.highlights) {
    const row = document.createElement('div');
    row.className = 'panel highlight-row';
    row.dataset.highlightId = h.id;
    row.innerHTML = `
      <div class="highlight-row-head">
        <div class="highlight-row-icon">${iconFor(h.kind)}</div>
        <div>
          <div class="highlight-row-title">${h.name[lang]}</div>
          <div class="highlight-row-meta">${t('detail.triggerAt', lang, { m: h.radius })}</div>
        </div>
        <button class="highlight-row-share" aria-label="${t('share.send', lang)}">↗</button>
        <button class="highlight-row-play">🔊</button>
      </div>
      <div class="highlight-row-body">${h.script[lang]}</div>`;

    row.querySelector('.highlight-row-play').addEventListener('click', (e) => {
      e.stopPropagation();
      tourEngine.playHighlight(h);
    });
    row.querySelector('.highlight-row-share').addEventListener('click', (e) => {
      e.stopPropagation();
      shareLocation(h.name[lang], h.lat, h.lon);
    });
    row.querySelector('.highlight-row-body').addEventListener('click', function () {
      this.classList.toggle('expanded');
    });
    container.appendChild(row);
  }
}

function iconFor(kind) {
  const map = { town: '🏘️', viewpoint: '🔭', nature: '🌿', beach: '🌊', archaeology: '🏛️', heritage: '📖', mining: '⛏️', culture: '🎭', pass: '⛰️' };
  return map[kind] || '📍';
}

/** Imported routes get a note about their single language and a way to
 *  remove them again — bundled routes get neither. */
function renderCustomRouteControls(route) {
  const lang = settings.language;
  const host = document.getElementById('dining-section').parentElement;
  document.getElementById('custom-route-controls')?.remove();
  if (!route.custom) return;

  const block = document.createElement('div');
  block.id = 'custom-route-controls';
  const note = route.sourceLanguage === 'en'
    ? t('import.singleLangEn', lang)
    : t('import.singleLang', lang);
  block.innerHTML = `<p class="import-hint">${escapeHTML(note)}</p>`;

  const del = document.createElement('button');
  del.className = 'btn-delete-route';
  del.textContent = t('import.delete', lang);
  del.addEventListener('click', () => removeCustomRoute(route));
  block.appendChild(del);
  host.appendChild(block);
}

// ─────────────────────────── Weather & photos ───────────────────────────

async function renderWeather(route) {
  const panel = document.getElementById('weather-panel');
  panel.style.display = 'none';
  if (!settings.onlineExtras) return;

  const start = route.waypoints[0];
  if (!start) return;

  const data = await fetchWeather(start.lat, start.lon);
  // Only paint if the user hasn't navigated elsewhere in the meantime.
  if (!data || currentRoute !== route) return;

  const lang = settings.language;
  const cond = describeCode(data.current?.weather_code, lang);
  const temp = Math.round(data.current?.temperature_2m ?? 0);
  const wind = Math.round(data.current?.wind_speed_10m ?? 0);
  const sunriseISO = data.daily?.sunrise?.[0];
  const sunsetISO = data.daily?.sunset?.[0];
  const rainChance = data.daily?.precipitation_probability_max?.[0];

  const golden = goldenHourDeparture(sunsetISO, route.durationMinutes);
  const departed = golden && golden.depart < new Date();

  panel.innerHTML = `
    <div class="weather-now">
      <span class="icon">${cond.icon}</span>
      <div>
        <div class="temp">${temp}°</div>
        <div class="cond">${cond.text}</div>
      </div>
      <div class="wind">
        ${wind} km/h${rainChance != null ? `<br>${rainChance}% ${lang === 'nl' ? 'regen' : 'rain'}` : ''}
      </div>
    </div>
    <div class="weather-sun">
      <div>${lang === 'nl' ? 'Zon op' : 'Sunrise'}<b>${formatTime(sunriseISO ? new Date(sunriseISO) : null, lang)}</b></div>
      <div>${lang === 'nl' ? 'Zon onder' : 'Sunset'}<b>${formatTime(sunsetISO ? new Date(sunsetISO) : null, lang)}</b></div>
    </div>
    ${golden ? `
      <div class="golden-hour">
        <div class="gh-label">${lang === 'nl' ? 'Voor het mooiste licht' : 'For the best light'}</div>
        <div class="gh-time">${lang === 'nl' ? 'Vertrek om' : 'Set off at'} ${formatTime(golden.depart, lang)}</div>
        <div class="gh-note">${
          departed
            ? (lang === 'nl'
                ? `Dat moment is vandaag voorbij. Morgen weer, of rijd 'm nu gewoon — hij is ook overdag de moeite.`
                : `That window has passed for today. Try tomorrow, or just drive it now — it's worth it in daylight too.`)
            : (lang === 'nl'
                ? `Dan ben je rond ${formatTime(golden.arrive, lang)} aan het eind, net voor zonsondergang. Inclusief ruime marge voor stoppen.`
                : `That puts you at the end around ${formatTime(golden.arrive, lang)}, just before sunset. Generous margin for stops included.`)
        }</div>
      </div>` : ''}
  `;
  panel.style.display = 'block';
}

/** Pulls a picture for each highlight that has a Wikipedia page, and
 *  slots it into the row it belongs to. Entirely optional: no connection
 *  or extras switched off simply means no photos. */
async function loadHighlightPhotos(route) {
  if (!settings.onlineExtras) return;
  const lang = settings.language;

  for (const highlight of route.highlights) {
    if (!highlight.wikipedia) continue;
    const title = highlight.wikipedia[lang];
    if (!title) continue;

    enrichment.image(title, lang).then((src) => {
      if (!src || currentRoute !== route) return;
      const row = document.querySelector(`[data-highlight-id="${cssEscape(highlight.id)}"]`);
      if (!row || row.querySelector('.highlight-photo')) return;

      const img = document.createElement('img');
      img.className = 'highlight-photo';
      img.loading = 'lazy';
      img.alt = highlight.name[lang];
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => img.remove());
      img.src = src;
      row.appendChild(img);

      const credit = document.createElement('div');
      credit.className = 'photo-credit';
      credit.textContent = 'Wikipedia';
      row.appendChild(credit);
    });
  }
}

/** Our ids are safe already, but building selectors from data without
 *  escaping is the kind of thing that breaks the day someone adds a
 *  route whose id contains a quote. */
function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

// ─────────────────────────── Dining ───────────────────────────
//
// A small, opinionated list per route rather than an open-ended search —
// closer to a printed city guide than a review site. Whichever meal
// matches the time of day (right now, or when you're about to start
// driving) is highlighted; the other two stay visible but dimmed, so you
// can also plan ahead for later in the day.

const MEAL_ICON = { breakfast: '☕', lunch: '🍽️', dinner: '🌙' };
const MEAL_LABEL = {
  nl: { breakfast: 'Ontbijt', lunch: 'Lunch', dinner: 'Diner' },
  en: { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' }
};

/** Which meal window the current local time falls into, if any. */
function currentMeal() {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 11) return 'breakfast';
  if (hour >= 12 && hour < 15) return 'lunch';
  if (hour >= 19 && hour < 22) return 'dinner';
  return null;
}

function renderDining(route) {
  const section = document.getElementById('dining-section');
  const dining = route.dining || [];
  if (dining.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  const lang = settings.language;
  const active = currentMeal();

  document.getElementById('dining-eyebrow').textContent =
    lang === 'nl' ? 'Eten onderweg' : 'Eating along the way';
  document.getElementById('dining-intro').textContent = lang === 'nl'
    ? 'Geen lijstjes met sterren — een paar adressen die als eerste genoemd worden als je het aan iemand hier vraagt.'
    : "No star ratings — just a few addresses that come up first when you ask someone from here.";

  // breakfast, lunch, dinner, in that fixed order regardless of JSON order.
  const order = { breakfast: 0, lunch: 1, dinner: 2 };
  const sorted = [...dining].sort((a, b) => order[a.meal] - order[b.meal]);

  const list = document.getElementById('dining-list');
  list.innerHTML = sorted.map((item) => {
    const isCurrent = item.meal === active;
    return `
      <div class="dining-card ${isCurrent ? 'current' : ''}">
        <div class="dining-meal-row">
          <span class="meal-icon">${MEAL_ICON[item.meal]}</span>
          <span class="meal-label">${MEAL_LABEL[lang][item.meal]}</span>
          <span class="dining-town">${item.town[lang]}</span>
        </div>
        <div class="dining-name">${escapeHTML(item.name[lang])}</div>
        <p class="dining-tip">${escapeHTML(item.tip[lang])}</p>
        <div class="dining-footer">
          <span class="dining-specialty">${escapeHTML(item.specialty[lang])}</span>
          <span class="dining-price">${item.price}</span>
        </div>
      </div>`;
  }).join('');
}

// ─────────────────────────── Drive screen ───────────────────────────

function startDrive() {
  if (!currentRoute) return;

  if (!location.isSupported) {
    alert(settings.language === 'nl'
      ? 'Deze browser ondersteunt geen locatie.'
      : "This browser doesn't support location.");
    return;
  }

  showScreen('drive-screen');
  requestAnimationFrame(() => {
    if (!driveMap) driveMap = new RouteMap('drive-map');
    driveMap.invalidateSize();
    driveMap.setFollow(true);
    driveMap.showRoute(currentRoute, navEngine.geometry.length ? navEngine.geometry : currentRoute.waypoints);

    // Hand the engine the real road line and wherever we already know we
    // are, so joining a route halfway works from the first second.
    const line = navEngine.geometry.length > 1
      ? navEngine.geometry
      : (currentRoute.geometry && currentRoute.geometry.length > 2
          ? currentRoute.geometry
          : currentRoute.waypoints.map((w) => ({ lat: w.lat, lon: w.lon })));

    tourEngine.start(currentRoute, { geometry: line, position: location.last });
    if (location.last) navEngine.syncToPosition(location.last);
    navEngine.enabled = settings.turnByTurnEnabled;
    location.start();
    renderWakeLockPill(false);   // shown straight away, updated by the event
    wakeLock.enable();
    renderRibbon();
    renderNowPlaying();
    spotify.startPolling();
    renderMusicBar();
    // Measure after the card has been laid out with its real content.
    requestAnimationFrame(watchMapInsets);
  });
}

function endDrive() {
  tourEngine.stop();
  location.stop();
  wakeLock.disable();
  spotify.stopPolling();
  renderManeuverBanner(null);
  // The radio keeps playing on purpose — ending the tour shouldn't cut
  // your music off mid-song.
  navEngine.currentStepIndex = 0;
  navEngine.announcedThisStep.clear();
  showScreen('detail-screen');
}

wakeLock.addEventListener('change', (e) => {
  renderWakeLockPill(e.detail.active);
});

/** The pill stayed blank before because it only ever filled in on an
 *  event. Now the drive screen paints it on open, and the event just
 *  updates it. */
function renderWakeLockPill(active) {
  const el = document.getElementById('wakelock-pill');
  if (!el) return;
  const lang = settings.language;
  if (active) {
    el.textContent = `☀️ ${t('wake.on', lang)}`;
    el.classList.remove('warn');
  } else {
    el.textContent = `🔅 ${t('wake.off', lang)}`;
    el.classList.add('warn');
  }
}

location.addEventListener('position', (e) => {
  const pos = e.detail;
  document.getElementById('drive-speed').textContent = Math.round(pos.speedKmh);
  tourEngine.setSpeedKmh(pos.speedKmh);
  theme.setCoords(pos.lat, pos.lon);
  if (!settings.locationGranted) { settings.locationGranted = true; persist(); }
  // The list is ordered by distance, so the first fix changes it.
  if (!appState.listSortedByLocation) {
    appState.listSortedByLocation = true;
    renderRouteList();
  }
  if (currentRoute && document.getElementById('detail-screen').classList.contains('active')) {
    updateMapsButton(currentRoute);
  }

  if (driveMap) driveMap.updateUserPosition(pos);

  tourEngine.handlePosition(pos);
  navEngine.handlePosition(pos, settings.language);
  updateRibbonProgress();
});

function updateRibbonProgress() {
  const bar = document.querySelector('.ribbon-progress');
  if (!bar) return;
  bar.style.width = `${Math.round(routeProgressFraction() * 100)}%`;
}

tourEngine.addEventListener('highlightplayed', (e) => {
  if (driveMap) driveMap.markPlayed(e.detail.id);
  renderRibbon();
});

speech.addEventListener('itemstart', () => renderNowPlaying());
speech.addEventListener('itemend', () => renderNowPlaying());

navEngine.addEventListener('geometry', (e) => {
  // The map always shows whatever you're being steered along, including
  // the leg to the start.
  if (driveMap) driveMap.updateGeometry(e.detail.geometry);

  // The stories, though, belong to the route itself. Handing the tour
  // engine the approach line would index every highlight against a road
  // that doesn't contain any of them.
  if (tourEngine.isRunning && location.last && !navEngine.approaching) {
    tourEngine.setGeometry(e.detail.geometry);
    navEngine.syncToPosition(location.last);
    // Tick positions are measured against the line, so they move when a
    // coarse skeleton is replaced by the real road.
    renderRibbon();
  }
});

tourEngine.addEventListener('joined', () => {
  renderRibbon();
  renderNowPlaying();
});

navEngine.addEventListener('progress', (e) => renderManeuverBanner(e.detail));

navEngine.addEventListener('offroute', (e) => {
  const notice = document.getElementById('off-route-notice');
  if (e.detail > 3000) {
    notice.style.display = 'flex';
    notice.innerHTML = `⚠️ ${t('drive.offRoute', settings.language, { d: formatDistance(e.detail) })}`;
  } else {
    notice.style.display = 'none';
  }
});

function renderRibbon() {
  if (!currentRoute) return;
  const el = document.getElementById('ribbon');
  const highlights = currentRoute.highlights;
  const nextId = tourEngine.nextHighlight?.id;

  const positions = ribbonPositions(highlights);
  const ticks = highlights.map((h, i) => {
    const played = tourEngine.playedHighlightIds.has(h.id) || tourEngine.skippedHighlightIds.has(h.id);
    const isNext = h.id === nextId;
    return `<div class="ribbon-tick ${played ? 'played' : ''} ${isNext ? 'next' : ''}"
                 style="left:${positions[i]}%"></div>`;
  }).join('');

  el.innerHTML =
    `<div class="ribbon-track"></div>` +
    `<div class="ribbon-progress" style="width:${Math.round(routeProgressFraction() * 100)}%"></div>` +
    ticks;
}

/**
 * Where each place sits along the ribbon.
 *
 * Spacing the ticks evenly by their number was misleading: on the SS125,
 * Dorgali and Cala Gonone are a few kilometres apart while the pass and
 * Baunei are separated by half the drive, and evenly spaced dots imply
 * the opposite. These sit at their real distance along the line.
 */
function ribbonPositions(highlights) {
  const line = tourEngine.geometry;
  const usable = line && line.length > 1 && tourEngine.highlightIndex?.size;

  const raw = highlights.map((h, i) => {
    if (usable) {
      const at = tourEngine.highlightIndex.get(h.id);
      if (at != null) return Math.max(0, Math.min(100, (at / (line.length - 1)) * 100));
    }
    // Before a drive starts there is no line to measure against.
    return highlights.length > 1 ? (i / (highlights.length - 1)) * 100 : 50;
  });

  // Two places can genuinely sit at the same point — a village and the
  // turning just outside it — and then one dot hides the other. Nudge
  // them apart just enough to stay countable, first forwards and then
  // backwards if that pushed the last one off the end.
  const MIN_GAP = 4.5;
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] - raw[i - 1] < MIN_GAP) raw[i] = raw[i - 1] + MIN_GAP;
  }
  const overflow = raw[raw.length - 1] - 100;
  if (overflow > 0) {
    for (let i = raw.length - 1; i >= 0; i--) {
      raw[i] -= overflow;
      if (i > 0 && raw[i] - raw[i - 1] >= MIN_GAP) break;
    }
  }
  return raw.map((v) => Math.max(0, Math.min(100, Math.round(v * 10) / 10)));
}

/** Progress along the route, from the engine's own forward-only counter
 *  rather than wherever the last fix happened to land. A GPS wobble at a
 *  hairpin used to snap the bar backwards. */
function routeProgressFraction() {
  const line = tourEngine.geometry;
  if (!tourEngine.isRunning || !line || line.length < 2) return 0;
  return Math.max(0, Math.min(1, tourEngine.progressIndex / (line.length - 1)));
}

function renderNowPlaying() {
  const lang = settings.language;
  const container = document.getElementById('now-content');
  const current = speech.current;

  if (current) {
    const isFact = current.source.startsWith('fact');
    const isNav = current.source === 'nav';
    const label = isNav ? (lang === 'nl' ? 'Navigatie' : 'Navigation') : isFact ? (lang === 'nl' ? 'Weetje' : 'Island fact') : t('drive.now', lang);
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <div class="speaking-indicator active"><span></span><span></span><span></span></div>
        <div class="eyebrow tint-porphyry">${label}</div>
      </div>
      <div class="now-head">
        <div class="now-text"><div class="now-title">${escapeHTML(current.title)}</div></div>
      </div>`;
    showNowPhoto(current, container);
  } else if (tourEngine.nextHighlight) {
    const next = tourEngine.nextHighlight;
    container.innerHTML = `
      <div class="eyebrow">${t('drive.nextUp', lang)}</div>
      <div class="next-row">
        <div class="next-text">
          <div class="now-title">${escapeHTML(next.name[lang])}</div>
          <div class="now-distance">${formatDistance(tourEngine.distanceToNext)}</div>
        </div>
        <button class="send-btn" id="send-next" aria-label="${t('share.send', lang)}">
          <span class="send-icon">↗</span>
          <span class="send-label">${t('share.short', lang)}</span>
        </button>
      </div>`;
    document.getElementById('send-next')?.addEventListener('click', () =>
      shareLocation(next.name[lang], next.lat, next.lon)
    );
  } else {
    container.innerHTML = `
      <div class="eyebrow">${t('drive.allTold', lang)}</div>
      <div class="now-title" style="font-size:22px">${t('drive.allTold', lang)}</div>
      <p style="color:var(--ash);font-size:13px;margin-top:6px">${t('drive.allToldSub', lang)}</p>`;
  }
}

/** A small picture of the place currently being described. It sits next
 *  to the title rather than above it, so the card doesn't jump in height
 *  while you're driving. */
function showNowPhoto(item, container) {
  if (!settings.onlineExtras || !currentRoute) return;
  // Both the story and its Wikipedia follow-up are about the same place,
  // so both deserve the picture.
  const prefix = ['highlight:', 'extra:'].find((p) => item.source?.startsWith(p));
  if (!prefix) return;

  const id = item.source.slice(prefix.length);
  const highlight = currentRoute.highlights.find((h) => h.id === id);
  if (!highlight || !highlight.wikipedia) return;

  const lang = settings.language;
  enrichment.image(highlight.wikipedia[lang], lang).then((src) => {
    if (!src) return;
    const head = container.querySelector('.now-head');
    if (!head || head.querySelector('.now-photo')) return;
    const img = document.createElement('img');
    img.className = 'now-photo';
    img.alt = '';
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    img.src = src;
    head.insertBefore(img, head.firstChild);
  });
}

/**
 * The skip button.
 *
 * Skipping used to mean only "stop talking". It now means "I don't want
 * this one" in full: the story stops, the place is written off, and the
 * route is recomputed from where you are straight to the next thing you
 * do want — no point steering you down a detour to something you've just
 * dismissed.
 */
async function handleSkip() {
  const lang = settings.language;

  if (!tourEngine.isRunning || !currentRoute) {
    speech.skip();
    return;
  }

  const dropped = tourEngine.skipHighlight(speech.current);
  speech.skip();
  renderRibbon();
  renderNowPlaying();

  if (!dropped) return;

  const next = tourEngine.nextHighlight;
  if (!next) {
    speech.speakNow({
      title: lang === 'nl' ? 'Overgeslagen' : 'Skipped',
      body: lang === 'nl'
        ? `${dropped.name.nl} overgeslagen. Dat was de laatste; we rijden door naar het eind.`
        : `Skipping ${dropped.name.en}. That was the last one; heading for the finish.`,
      source: 'system'
    });
    return;
  }

  speech.speakNow({
    title: lang === 'nl' ? 'Nieuwe route' : 'New route',
    body: lang === 'nl'
      ? `${dropped.name.nl} overgeslagen. Ik zoek de snelste weg naar ${next.name.nl}.`
      : `Skipping ${dropped.name.en}. Finding the quickest way to ${next.name.en}.`,
    source: 'system'
  });

  if (!settings.turnByTurnEnabled || !location.last) return;

  const ok = await navEngine.rerouteVia(location.last, buildViaPoints(currentRoute, next));
  if (ok) {
    tourEngine.setGeometry(navEngine.geometry);
    if (driveMap) driveMap.updateGeometry(navEngine.geometry);
  } else {
    speech.enqueue({
      title: lang === 'nl' ? 'Navigatie' : 'Navigation',
      body: lang === 'nl'
        ? 'Geen verbinding om een nieuwe route te berekenen. Ik houd de bestaande aan.'
        : "No connection to work out a new route. Sticking with the current one.",
      source: 'system'
    });
  }
}

/** The next highlight, then the original route points that come after it,
 *  so skipping shortcuts the detour without abandoning the scenic road
 *  for everything beyond it. */
function buildViaPoints(route, fromHighlight) {
  const line = tourEngine.geometry.length > 1
    ? tourEngine.geometry
    : route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));

  const fromIdx = nearestIndex({ lat: fromHighlight.lat, lon: fromHighlight.lon }, line).index;
  const after = route.waypoints.filter(
    (w) => nearestIndex({ lat: w.lat, lon: w.lon }, line).index > fromIdx
  );

  const points = [{ lat: fromHighlight.lat, lon: fromHighlight.lon }, ...after];
  // Always finish where the route finishes, even if the filter dropped it.
  const end = route.waypoints[route.waypoints.length - 1];
  const last = points[points.length - 1];
  if (!last || last.lat !== end.lat || last.lon !== end.lon) points.push({ lat: end.lat, lon: end.lon });
  return points;
}

/**
 * Keeps the map centred on the strip you can actually see.
 *
 * The card at the bottom changes height constantly — a music bar appears,
 * a place name wraps to two lines, an off-route warning shows up. Rather
 * than guessing at a fixed number, this measures the real panels and
 * re-measures whenever they change size.
 */
function syncMapInsets() {
  if (!driveMap) return;
  const card = document.querySelector('#drive-screen .now-playing');
  const topBar = document.querySelector('#drive-screen .drive-top-stack');
  driveMap.setInsets({
    top: topBar ? topBar.offsetHeight + 12 : 0,
    bottom: card ? card.offsetHeight + 12 : 0
  });
}

let mapInsetObserver = null;

function watchMapInsets() {
  if (mapInsetObserver || typeof ResizeObserver === 'undefined') {
    syncMapInsets();
    return;
  }
  const card = document.querySelector('#drive-screen .now-playing');
  if (!card) return;
  mapInsetObserver = new ResizeObserver(() => syncMapInsets());
  mapInsetObserver.observe(card);
  syncMapInsets();
}

/**
 * The manoeuvre banner.
 *
 * Fed by the nav engine on every fix, so the distance counts down as you
 * approach rather than jumping between announcements. Turns solid at
 * 120 metres — that's the point where you should already be in the right
 * lane and looking for the junction rather than reading a screen.
 */
function renderManeuverBanner(detail) {
  const banner = document.getElementById('maneuver-banner');
  if (!banner) return;

  const usable =
    settings.turnByTurnEnabled &&
    navEngine.enabled &&
    navEngine.steps.length > 0 &&
    detail &&
    isFinite(detail.distanceToStep);

  if (!usable) {
    if (banner.style.display !== 'none') {
      banner.style.display = 'none';
      syncMapInsets();
    }
    return;
  }

  const step = navEngine.steps[detail.stepIndex];
  if (!step) return;

  const lang = settings.language;
  const info = maneuverBanner(step, lang);

  const wasHidden = banner.style.display === 'none';
  banner.style.display = 'flex';

  document.getElementById('mb-glyph').innerHTML = maneuverIconSVG(step);
  document.getElementById('mb-instruction').textContent = info.text;
  document.getElementById('mb-road').textContent = info.road;
  document.getElementById('mb-distance').textContent = formatDistance(detail.distanceToStep);

  banner.classList.toggle('imminent', detail.distanceToStep <= 120);

  // Appearing changes the height of the top column, which the map centre
  // depends on.
  if (wasHidden) syncMapInsets();
}

/**
 * Flips the current route end for end.
 *
 * A new object rather than a mutation, so the original in the list stays
 * untouched and you can flip back without anything having been lost. The
 * cached road geometry is keyed off the id, and the reverse of a road is
 * a genuinely different set of turns, so the reversed copy gets its own
 * id and its own cache entry.
 */
function toggleReverse() {
  if (!currentRoute) return;
  const lang = settings.language;

  currentRoute = currentRoute.reversed
    ? unreverseRoute(currentRoute, routes)
    : reverseRoute(currentRoute, lang);

  // openDetail calls navEngine.load, which keys its cached geometry on the
  // route id. The reversed copy carries its own id, so it fetches and
  // stores its own line rather than reusing the outbound one.
  openDetail(currentRoute);
}

function renderReverseButton(route) {
  const lang = settings.language;
  const label = document.getElementById('reverse-label');
  if (label) {
    label.textContent = route.reversed ? t('reverse.undo', lang) : t('reverse.do', lang);
  }
}

// ─────────────────────────── Expanded stories ───────────────────────────

function renderStoryBlock(route) {
  const lang = settings.language;
  const block = document.getElementById('story-block');
  if (!block) return;

  const total = route.highlights.length;
  const have = storyteller.countFor(route, lang);

  document.getElementById('story-eyebrow').textContent = t('ai.storiesTitle', lang);

  const status = document.getElementById('story-status');
  if (!storyteller.hasKey) {
    status.textContent = t('ai.explain', lang);
  } else if (have === 0) {
    status.textContent = t('ai.none', lang);
  } else if (have >= total) {
    status.textContent = t('ai.all', lang, { total }) + ' ' + t('ai.offlineNote', lang);
  } else {
    status.textContent = t('ai.some', lang, { n: have, total });
  }

  const button = document.getElementById('story-generate');
  button.textContent = !storyteller.hasKey
    ? t('ai.needKey', lang)
    : (have >= total ? t('ai.regenerate', lang) : t('ai.generate', lang));
  button.disabled = false;

  button.onclick = () => {
    if (!storyteller.hasKey) {
      document.getElementById('sheet-backdrop').classList.add('open');
      document.getElementById('settings-sheet').classList.add('open');
      document.getElementById('ai-key').focus();
      return;
    }
    if (have >= total) storyteller.clearRoute(route, lang);
    runStoryGeneration(route);
  };

  document.getElementById('story-cancel').textContent = t('ai.cancel', lang);
}

async function runStoryGeneration(route) {
  const lang = settings.language;
  const progress = document.getElementById('story-progress');
  const msg = document.getElementById('story-msg');
  const fill = document.getElementById('story-bar-fill');
  const errorEl = document.getElementById('story-error');
  const button = document.getElementById('story-generate');

  errorEl.style.display = 'none';
  progress.style.display = 'block';
  button.disabled = true;
  msg.textContent = t('ai.working', lang);
  fill.style.width = '2%';

  document.getElementById('story-cancel').onclick = () => storyteller.cancel();

  try {
    const result = await storyteller.generateRoute(route, {
      language: lang,
      model: settings.aiModel || MODELS[0].id,
      onProgress: ({ done, total, message }) => {
        msg.textContent = total ? `${done}/${total} — ${message}` : message;
        if (total) fill.style.width = `${Math.max(2, (done / total) * 100)}%`;
      }
    });
    msg.textContent = t('ai.doneMsg', lang, { done: result.done - result.failed, failed: result.failed });
    setTimeout(() => { progress.style.display = 'none'; }, 4000);
  } catch (err) {
    progress.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = err.message || String(err);
  } finally {
    button.disabled = false;
    if (currentRoute === route) renderStoryBlock(route);
  }
}

function wireStorySettings() {
  const lang = settings.language;
  document.getElementById('ai-explain').textContent = t('ai.explain', lang);

  const keyField = document.getElementById('ai-key');
  keyField.value = storyteller.apiKey;
  keyField.addEventListener('change', () => {
    storyteller.apiKey = keyField.value;
    updateAIStatus();
    if (currentRoute) renderStoryBlock(currentRoute);
  });

  const modelRow = document.getElementById('ai-model');
  modelRow.innerHTML = '';
  for (const model of MODELS) {
    const btn = document.createElement('button');
    btn.textContent = model.label;
    btn.classList.toggle('active', (settings.aiModel || MODELS[0].id) === model.id);
    btn.addEventListener('click', () => {
      settings.aiModel = model.id;
      persist();
      modelRow.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    });
    modelRow.appendChild(btn);
  }
  updateAIStatus();
}

function updateAIStatus() {
  const lang = settings.language;
  document.getElementById('ai-status').textContent =
    storyteller.hasKey ? t('ai.ready', lang) : t('ai.noKey', lang);
}

// ─────────────────────────── Regional facts ───────────────────────────

async function renderFactsBlock(route) {
  const lang = settings.language;
  const block = document.getElementById('facts-block');
  if (!block) return;

  const place = FactSource.placeOf(route);
  const key = FactSource.keyFor(place);
  const region = place.region || place.country || '—';

  // Sardinia already ships with forty hand-written facts; offering to
  // fetch more there would be noise.
  const bundled = await factSource.bundledFor(key);
  if (bundled?.length && key === 'it--sardegna') {
    block.style.display = 'none';
    return;
  }
  block.style.display = 'block';

  document.getElementById('facts-eyebrow').textContent = t('facts.title', lang);

  const stored = factSource.countFor(key, lang);
  const status = document.getElementById('facts-status');
  if (bundled?.length) {
    status.textContent = t('facts.bundled', lang, { region });
  } else if (stored) {
    status.textContent = t('facts.have', lang, { n: stored, region });
  } else {
    status.textContent =
      t('facts.none', lang, { region }) +
      (storyteller.hasKey ? '' : ' ' + t('facts.noKey', lang));
  }

  const button = document.getElementById('facts-generate');
  button.textContent = stored ? t('facts.redo', lang) : t('facts.get', lang);
  button.disabled = false;
  button.onclick = () => fetchRegionFacts(route, key, region);

  const exportBtn = document.getElementById('facts-export');
  exportBtn.textContent = t('facts.export', lang);
  exportBtn.style.display = stored ? 'block' : 'none';
  exportBtn.onclick = () => exportRegionFacts(key);
}

async function fetchRegionFacts(route, key, region) {
  const lang = settings.language;
  const progress = document.getElementById('facts-progress');
  const msg = document.getElementById('facts-msg');
  const errorEl = document.getElementById('facts-error');
  const button = document.getElementById('facts-generate');

  errorEl.style.display = 'none';
  progress.style.display = 'block';
  button.disabled = true;
  msg.textContent = t('facts.working', lang);

  try {
    if (factSource.countFor(key, lang)) factSource.clear(key, lang);
    const result = await factSource.generate(route, lang, {
      onProgress: ({ message }) => { msg.textContent = message; }
    });
    msg.textContent = t('facts.done', lang, { n: result.count, region: result.name });
    setTimeout(() => { progress.style.display = 'none'; }, 4000);

    // If this is the route you're driving, swap the facts in immediately.
    if (tourEngine.isRunning && tourEngine.route === route) {
      tourEngine.facts = await factSource.factsFor(route, lang, tourEngine.baseFacts);
    }
  } catch (err) {
    progress.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = err.message || String(err);
  } finally {
    button.disabled = false;
    if (currentRoute === route) renderFactsBlock(route);
  }
}

/**
 * Downloads the facts as the exact file the app would ship.
 *
 * The app cannot commit this to GitHub itself, and shouldn't be able to:
 * that would mean a write token sitting in a public web page, usable by
 * anyone who opened it. Handing you the file to drop in yourself gets the
 * same result with nothing to leak.
 */
function exportRegionFacts(key) {
  const lang = settings.language;
  const file = factSource.exportFile(key, lang);
  if (!file) return;

  const blob = new Blob([file.contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(url);

  showToast(t('facts.exported', lang));
}

// ─────────────────────────── Send a place to the car ───────────────────

/**
 * Hands a single place to whatever can navigate to it.
 *
 * On iPhone this opens the system share sheet, where the Tesla app
 * appears alongside Messages and the rest — picking it drops the
 * destination straight into the car's navigation, exactly as sharing from
 * Apple or Google Maps does.
 *
 * The link deliberately is a proper Google Maps URL rather than bare
 * coordinates: owners have long found the Tesla app refuses raw lat/lon,
 * while a real maps link resolves fine.
 *
 * If the Tesla app isn't in the sheet, it has to be switched on once:
 * scroll the row of apps to the end, tap More, and enable Tesla.
 */
async function shareLocation(name, lat, lon) {
  const lang = settings.language;
  const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`;
  const label = `${name} — ${currentRoute ? currentRoute.name[lang] : 'Sardegna'}`;

  if (navigator.share) {
    try {
      await navigator.share({ title: name, text: label, url });
      return;
    } catch (err) {
      // Tapping outside the sheet counts as an abort, and is not a failure.
      if (err && err.name === 'AbortError') return;
    }
  }

  // No share sheet (desktop, or an older browser): put it on the
  // clipboard so it can still be pasted somewhere useful.
  try {
    await navigator.clipboard.writeText(url);
    showToast(lang === 'nl' ? 'Link gekopieerd' : 'Link copied');
  } catch {
    window.open(url, '_blank');
  }
}

function showToast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.remove('show'), 2200);
}

// ─────────────────────────── Music ───────────────────────────
//
// Two sources, one bar. Spotify is a remote control over the network:
// it can steer whatever is already playing on your phone, but it needs a
// connection and lags by a second or so. The radio plays here in the app,
// which means it is instant and — the real reason it exists — can be
// ducked precisely instead of bluntly paused.

let musicSource = 'spotify';   // 'spotify' | 'radio'
let stationResults = [];

function initMusic() {
  // Coming back from the Spotify approval page.
  spotify.handleRedirect()
    .then((didLogin) => { if (didLogin) refreshSpotifySettingsUI(); })
    .catch((err) => showMusicProblem(err.message));

  spotify.addEventListener('state', () => renderMusicBar());
  spotify.addEventListener('authchange', () => { refreshSpotifySettingsUI(); renderMusicBar(); });
  spotify.addEventListener('problem', (e) => showMusicProblem(e.detail));
  radio.addEventListener('state', () => renderMusicBar());
  radio.addEventListener('problem', (e) => showMusicProblem(e.detail));
  radio.addEventListener('capabilities', () => updateVolumeNote());

  radio.setVolume(settings.radioVolume ?? 0.8);

  // Ducking, driven by the guide itself.
  speech.addEventListener('itemstart', () => {
    if (!settings.duckEnabled) return;
    radio.duck(settings.duckLevel);
    spotify.duck(settings.duckLevel);
  });
  speech.addEventListener('itemend', () => {
    if (!settings.duckEnabled) return;
    radio.unduck();
    spotify.unduck();
  });

  document.getElementById('music-toggle').addEventListener('click', () => {
    if (musicSource === 'spotify') spotify.toggle();
    else radio.toggle(lastStation());
  });
  // With the radio there is no "next track", so those two buttons earn
  // their keep as volume instead — you should never have to open
  // Settings while driving to turn the music down.
  document.getElementById('music-next').addEventListener('click', () => {
    if (musicSource === 'spotify') spotify.next();
    else nudgeRadioVolume(+0.1);
  });
  document.getElementById('music-prev').addEventListener('click', () => {
    if (musicSource === 'spotify') spotify.prev();
    else nudgeRadioVolume(-0.1);
  });

  document.querySelectorAll('#music-source button').forEach((btn) => {
    btn.addEventListener('click', () => {
      musicSource = btn.dataset.source;
      if (musicSource === 'spotify') radio.stop();
      renderMusicBar();
    });
  });
}

function nudgeRadioVolume(delta) {
  const next = Math.max(0, Math.min(1, (settings.radioVolume ?? 0.55) + delta));
  settings.radioVolume = next;
  radio.setVolume(next);
  persist();

  const slider = document.getElementById('radio-volume');
  if (slider) {
    slider.value = Math.round(next * 100);
    document.getElementById('radio-volume-value').textContent = `${slider.value}%`;
  }
  renderMusicBar();
}

function lastStation() {
  if (!settings.lastStationUrl) return BUILTIN_STATIONS[0];
  return {
    id: settings.lastStationId,
    name: settings.lastStationName,
    url: settings.lastStationUrl
  };
}

function showMusicProblem(message) {
  if (!message) return;
  const sub = document.getElementById('music-sub');
  if (sub) sub.textContent = message;
  const status = document.getElementById('spotify-status');
  if (status && document.getElementById('sheet-backdrop').classList.contains('open')) {
    status.textContent = message;
  }
}

function renderMusicBar() {
  const bar = document.getElementById('music-bar');
  const sourceRow = document.getElementById('music-source');
  const onDriveScreen = document.getElementById('drive-screen').classList.contains('active');
  if (!bar || !onDriveScreen) { if (bar) bar.style.display = 'none'; if (sourceRow) sourceRow.style.display = 'none'; return; }

  const lang = settings.language;
  const usable = spotify.isLoggedIn || radio.station || settings.lastStationUrl;
  bar.style.display = usable ? 'flex' : 'none';
  sourceRow.style.display = spotify.isLoggedIn ? 'flex' : 'none';
  if (!usable) return;

  document.querySelectorAll('#music-source button').forEach((b) =>
    b.classList.toggle('active', b.dataset.source === musicSource)
  );

  const art = document.getElementById('music-art');
  const title = document.getElementById('music-title');
  const sub = document.getElementById('music-sub');
  const toggle = document.getElementById('music-toggle');

  if (musicSource === 'spotify') {
    const s = spotify.state;
    if (s) {
      if (s.art) art.src = s.art; else art.removeAttribute('src');
      title.textContent = s.title;
      sub.textContent = s.artist + (s.device ? ` · ${s.device}` : '');
      toggle.textContent = s.isPlaying ? '⏸' : '▶';
    } else {
      art.removeAttribute('src');
      title.textContent = t('music.nothing', lang);
      sub.textContent = t('music.startInApp', lang);
      toggle.textContent = '▶';
    }
  } else {
    const station = radio.station || lastStation();
    art.removeAttribute('src');
    title.textContent = station?.name || t('music.radioLabel', lang);
    const pct = Math.round((settings.radioVolume ?? 0.55) * 100);
    sub.textContent = radio.isPlaying
      ? `${t('music.radioLabel', lang)} · ${pct}%`
      : '—';
    toggle.textContent = radio.isPlaying ? '⏸' : '▶';
  }

  bar.classList.toggle('ducked', radio.ducking || spotify.ducking);

  const prev = document.getElementById('music-prev');
  const nextBtn = document.getElementById('music-next');
  if (musicSource === 'spotify') {
    prev.textContent = '⏮'; nextBtn.textContent = '⏭';
    prev.setAttribute('aria-label', lang === 'nl' ? 'Vorige' : 'Previous');
    nextBtn.setAttribute('aria-label', lang === 'nl' ? 'Volgende' : 'Next');
  } else {
    prev.textContent = '🔉'; nextBtn.textContent = '🔊';
    prev.setAttribute('aria-label', lang === 'nl' ? 'Zachter' : 'Quieter');
    nextBtn.setAttribute('aria-label', lang === 'nl' ? 'Harder' : 'Louder');
  }
  prev.style.opacity = '1';
  nextBtn.style.opacity = '1';
}

function wireMusicSettings() {
  const lang = settings.language;

  // Ducking
  const duckToggle = document.getElementById('duck-toggle');
  duckToggle.classList.toggle('on', settings.duckEnabled);
  duckToggle.addEventListener('click', () => {
    settings.duckEnabled = !settings.duckEnabled;
    duckToggle.classList.toggle('on', settings.duckEnabled);
    persist();
  });

  const duckSlider = document.getElementById('duck-slider');
  duckSlider.value = settings.duckLevel;
  document.getElementById('duck-value').textContent = `${settings.duckLevel}%`;
  duckSlider.addEventListener('input', () => {
    settings.duckLevel = parseInt(duckSlider.value, 10);
    document.getElementById('duck-value').textContent = `${settings.duckLevel}%`;
    persist();
  });

  // Spotify
  const idField = document.getElementById('spotify-client-id');
  idField.value = settings.spotifyClientId || '';
  idField.addEventListener('change', () => {
    settings.spotifyClientId = idField.value.trim();
    persist();
    refreshSpotifySettingsUI();
  });

  document.getElementById('spotify-redirect-note').textContent =
    `${t('music.redirect', lang)} ${redirectURI()}`;

  document.getElementById('spotify-login').addEventListener('click', () => {
    settings.spotifyClientId = idField.value.trim();
    persist();
    spotify.login().catch((err) => showMusicProblem(err.message));
  });
  document.getElementById('spotify-logout').addEventListener('click', () => {
    spotify.logout();
    refreshSpotifySettingsUI();
  });
  refreshSpotifySettingsUI();

  // Radio
  const volSlider = document.getElementById('radio-volume');
  volSlider.value = Math.round((settings.radioVolume ?? 0.55) * 100);
  document.getElementById('radio-volume-value').textContent = `${volSlider.value}%`;
  volSlider.addEventListener('input', () => {
    settings.radioVolume = parseInt(volSlider.value, 10) / 100;
    document.getElementById('radio-volume-value').textContent = `${volSlider.value}%`;
    radio.setVolume(settings.radioVolume);
    persist();
  });
  updateVolumeNote();

  document.getElementById('station-search-btn').addEventListener('click', runStationSearch);
  document.getElementById('station-query').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runStationSearch();
  });

  renderStations(BUILTIN_STATIONS);
}

/** Says plainly whether the slider can do anything. On a stream without
 *  CORS headers the app can only hand the audio straight to the browser,
 *  and on iOS that means the hardware buttons are the only volume there
 *  is — better to say so than to leave a slider that quietly does
 *  nothing. */
function updateVolumeNote() {
  const note = document.getElementById('radio-volume-note');
  if (!note) return;
  const lang = settings.language;
  const slider = document.getElementById('radio-volume');

  if (radio.station && !radio.hasGainControl) {
    note.textContent = lang === 'nl'
      ? 'Deze zender laat softwarematig volume niet toe. Gebruik de volumeknoppen van je telefoon, of kies een andere zender.'
      : 'This station does not allow software volume. Use your phone\'s volume buttons, or pick another station.';
    note.style.display = 'block';
    if (slider) slider.style.opacity = '0.4';
  } else {
    note.style.display = 'none';
    if (slider) slider.style.opacity = '1';
  }
}

function refreshSpotifySettingsUI() {
  const lang = settings.language;
  const status = document.getElementById('spotify-status');
  const loginBtn = document.getElementById('spotify-login');
  const logoutBtn = document.getElementById('spotify-logout');
  if (!status) return;

  if (spotify.isLoggedIn) {
    status.textContent = t('music.connected', lang);
    loginBtn.style.display = 'none';
    logoutBtn.style.display = 'flex';
  } else {
    status.textContent = spotify.isConfigured ? t('music.notConnected', lang) : t('music.needsId', lang);
    loginBtn.style.display = 'flex';
    logoutBtn.style.display = 'none';
    loginBtn.textContent = t('music.connect', lang);
  }
  logoutBtn.textContent = t('music.disconnect', lang);
}

async function runStationSearch() {
  const lang = settings.language;
  const query = document.getElementById('station-query').value.trim();
  const list = document.getElementById('station-list');
  list.innerHTML = `<p class="import-hint">${t('music.searching', lang)}</p>`;

  const found = await searchStations(query);
  if (found.length === 0) {
    list.innerHTML = `<p class="import-hint">${t('music.noStations', lang)}</p>`;
    return;
  }
  renderStations(found);
}

function renderStations(stations) {
  stationResults = stations;
  const list = document.getElementById('station-list');
  list.innerHTML = '';

  for (const station of stations) {
    const btn = document.createElement('button');
    btn.className = 'station-item';
    if (station.id === settings.lastStationId) btn.classList.add('current');
    btn.innerHTML = `<span class="st-name"></span><span class="st-meta">${station.bitrate ? station.bitrate + 'k' : ''}</span>`;
    btn.querySelector('.st-name').textContent = station.name;
    btn.addEventListener('click', () => {
      settings.lastStationId = station.id;
      settings.lastStationName = station.name;
      settings.lastStationUrl = station.url;
      persist();
      musicSource = 'radio';
      // Started from a tap, which is what the browser requires.
      radio.play(station);
      renderStations(stations);
      renderMusicBar();
      setTimeout(updateVolumeNote, 1200);
    });
    list.appendChild(btn);
  }
}

// ─────────────────────────── Global controls ───────────────────────────

function wireGlobalControls() {
  wireImport();
  document.getElementById('back-to-list').addEventListener('click', () => showScreen('list-screen'));
  document.getElementById('start-drive').addEventListener('click', startDrive);
  document.getElementById('reverse-route').addEventListener('click', toggleReverse);
  document.getElementById('open-osm').addEventListener('click', () => openInMapsApp(mapsTarget));
  document.getElementById('open-osm-alt').addEventListener('click', () =>
    openInMapsApp(mapsTarget === 'start' ? 'end' : 'start'));

  document.getElementById('end-drive').addEventListener('click', () => {
    const lang = settings.language;
    if (confirm(t('drive.endConfirm', lang))) endDrive();
  });

  document.getElementById('ctrl-repeat').addEventListener('click', () => speech.repeatLast());
  document.getElementById('ctrl-skip').addEventListener('click', handleSkip);
  document.getElementById('ctrl-fact').addEventListener('click', () => tourEngine.speakRandomFact());

  document.getElementById('test-audio').addEventListener('click', () => {
    speech.speakNow({ title: 'Test', body: t('test.text', settings.language), source: 'system' });
  });
}

// ─────────────────────────── GPX import ───────────────────────────

function wireImport() {
  const lang = settings.language;
  document.getElementById('import-label').textContent = t('import.label', lang);
  document.getElementById('import-hint').textContent = t('import.hint', lang);
  renderModePicker();

  const input = document.getElementById('gpx-input');
  document.getElementById('import-gpx').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await handleGPXFile(file);
    input.value = ''; // so picking the same file again still fires
  });
}

/** Car, bike or walking. The choice changes far more than the routing
 *  profile — every distance in the guide is derived from it. */
function renderModePicker() {
  const lang = settings.language;
  const picker = document.getElementById('mode-picker');
  if (!picker) return;
  picker.innerHTML = '';

  for (const mode of Object.values(MODES)) {
    const btn = document.createElement('button');
    btn.innerHTML = `<span class="mp-icon">${mode.icon}</span><span>${mode.label[lang]}</span>`;
    btn.classList.toggle('active', (settings.importMode || DEFAULT_MODE) === mode.id);
    btn.addEventListener('click', () => {
      settings.importMode = mode.id;
      persist();
      renderModePicker();
    });
    picker.appendChild(btn);
  }
}

async function handleGPXFile(file) {
  const lang = settings.language;
  const progress = document.getElementById('import-progress');
  const msg = document.getElementById('import-msg');
  const fill = document.getElementById('import-bar-fill');
  const errorEl = document.getElementById('import-error');
  const button = document.getElementById('import-gpx');

  errorEl.style.display = 'none';
  progress.style.display = 'block';
  button.disabled = true;
  msg.textContent = t('import.working', lang);
  fill.style.width = '2%';

  try {
    const text = await file.text();
    const suggestedName = file.name.replace(/\.gpx$/i, '').replace(/[_-]+/g, ' ');

    const route = await buildRouteFromGPX(text, {
      language: lang,
      fallbackName: suggestedName,
      travelMode: settings.importMode || DEFAULT_MODE,
      onProgress: ({ phase, done, total, message }) => {
        msg.textContent = message;
        if (total) {
          // Searching is the long half, summaries the short one.
          const base = phase === 'summaries' ? 60 : 5;
          const span = phase === 'summaries' ? 38 : 55;
          fill.style.width = `${base + (done / total) * span}%`;
        }
      }
    });

    const result = saveCustomRoute(route);
    if (!result.ok) throw new Error(result.error);

    routes = [...routes, route];
    fill.style.width = '100%';
    msg.textContent = route.highlights.length === 0
      ? t('import.noHighlights', lang)
      : `${t('import.done', lang)}: ${route.name[lang]} — ${route.highlights.length} ${lang === 'nl' ? 'plekken' : 'places'}`;

    renderRouteList();
    renderOverviewMap();

    setTimeout(() => { progress.style.display = 'none'; }, 6000);
  } catch (err) {
    progress.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.textContent = err.message || String(err);
  } finally {
    button.disabled = false;
  }
}

function removeCustomRoute(route) {
  const lang = settings.language;
  if (!confirm(t('import.deleteConfirm', lang))) return;
  deleteCustomRoute(route.id);
  routes = routes.filter((r) => r.id !== route.id);
  currentRoute = null;
  renderRouteList();
  renderOverviewMap();
  showScreen('list-screen');
}

// Which end of the route the maps button will take you to. Recomputed
// whenever the detail screen opens and whenever a fresh GPS fix lands.
let mapsTarget = 'start';

const ON_ROUTE_THRESHOLD_M = 1500;

/**
 * Decides where "open in maps" should send you.
 *
 * The old behaviour always aimed at the finish, which is exactly wrong
 * when you're still at the hotel: these routes are the point, not the
 * destination, so getting to the start is what you actually need.
 *
 * The test is proximity to the route *line*, not to the start point. Ask
 * "how far from the start" and someone standing halfway along the drive
 * gets sent back to the beginning, which is the last thing they want.
 */
function updateMapsButton(route) {
  const button = document.getElementById('open-osm');
  const alt = document.getElementById('open-osm-alt');
  if (!button || !route) return;

  const lang = settings.language;
  const start = route.waypoints[0];
  const here = location.last;
  const line = route.geometry && route.geometry.length > 2
    ? route.geometry
    : route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));

  let note = '';

  if (!here || !start) {
    // No fix yet — assume you still have to get there.
    mapsTarget = 'start';
  } else {
    const offRoute = distanceToPolyline(here, line);
    mapsTarget = offRoute <= ON_ROUTE_THRESHOLD_M ? 'end' : 'start';
    if (mapsTarget === 'start') {
      note = ` · ${formatDistance(distanceMetres(here, { lat: start.lat, lon: start.lon }))}`;
    }
  }

  button.innerHTML =
    `🗺 <span>${mapsTarget === 'start'
      ? t('detail.navToStart', lang)
      : t('detail.navToEnd', lang)}${note}</span>`;

  // The other end stays one tap away, so the choice is never taken from you.
  if (alt) {
    alt.textContent = mapsTarget === 'start'
      ? t('detail.navToEndAlt', lang)
      : t('detail.navToStartAlt', lang);
  }
}

function openInMapsApp(which = mapsTarget) {
  if (!currentRoute) return;
  const points = currentRoute.waypoints;
  const target = which === 'start' ? points[0] : points[points.length - 1];
  if (!target) return;

  // Apple Maps understands this URL scheme on iOS without any SDK or key;
  // on other platforms it falls back to a geo: URI that Android resolves too.
  const ua = navigator.userAgent;
  const label = encodeURIComponent(
    `${currentRoute.name[settings.language]} — ${
      which === 'start'
        ? (settings.language === 'nl' ? 'start' : 'start')
        : (settings.language === 'nl' ? 'einde' : 'finish')
    }`
  );
  const url = /iPhone|iPad|Macintosh/.test(ua)
    ? `https://maps.apple.com/?daddr=${target.lat},${target.lon}&dirflg=d`
    : `geo:${target.lat},${target.lon}?q=${target.lat},${target.lon}(${label})`;
  window.open(url, '_blank');
}

function updateAudioStatus() {
  // The browser has no direct "is Bluetooth connected" API. This is an
  // honest best-effort: it reflects output only once audio has actually
  // played, via the same route-detection trick browsers expose for
  // Bluetooth headsets, and otherwise just invites you to press Test.
  const lang = settings.language;
  document.getElementById('audio-name').textContent = t('audio.notConnected', lang);
  document.getElementById('audio-detail').textContent =
    lang === 'nl' ? 'Druk op Test om te controleren' : 'Press Test to check';
  const drivePill = document.getElementById('drive-audio-name');
  if (drivePill) drivePill.textContent = lang === 'nl' ? 'telefoon/auto' : 'phone/car';
}

// ─────────────────────────── Settings sheet ───────────────────────────

function wireSettingsSheet() {
  const backdrop = document.getElementById('sheet-backdrop');
  const sheet = document.getElementById('settings-sheet');

  const openSheet = () => {
    backdrop.classList.add('open');
    sheet.classList.add('open');
  };
  const closeSheet = () => {
    backdrop.classList.remove('open');
    sheet.classList.remove('open');
  };

  document.getElementById('open-settings').addEventListener('click', openSheet);
  document.getElementById('close-settings').addEventListener('click', closeSheet);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeSheet(); });

  const langButtons = document.querySelectorAll('#lang-toggle button');
  langButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lang === settings.language);
    btn.addEventListener('click', () => {
      settings.language = btn.dataset.lang;
      persist();
      langButtons.forEach((b) => b.classList.toggle('active', b === btn));
      applyStaticStrings(settings.language);
      document.getElementById('import-label').textContent = t('import.label', settings.language);
      document.getElementById('import-hint').textContent = t('import.hint', settings.language);
      refreshThemeUI();
      renderRouteList();
      renderOverviewMap();
      if (currentRoute) openDetail(currentRoute);
    });
  });

  const themeButtons = document.querySelectorAll('#theme-toggle button');
  const refreshThemeUI = () => {
    themeButtons.forEach((b) =>
      b.classList.toggle('active', b.dataset.themeMode === (settings.theme || 'auto'))
    );
    document.getElementById('theme-explain').textContent = theme.describe(settings.language);
  };
  themeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.theme = btn.dataset.themeMode;
      persist();
      theme.apply();
      refreshThemeUI();
    });
  });
  refreshThemeUI();

  const rateSlider = document.getElementById('rate-slider');
  rateSlider.value = settings.speechRate;
  document.getElementById('rate-value').textContent = settings.speechRate.toFixed(2);
  rateSlider.addEventListener('input', () => {
    settings.speechRate = parseFloat(rateSlider.value);
    document.getElementById('rate-value').textContent = settings.speechRate.toFixed(2);
    syncSpeechFromSettings();
    persist();
  });

  const intervalSlider = document.getElementById('interval-slider');
  intervalSlider.value = settings.factInterval;
  document.getElementById('interval-value').textContent = `${settings.factInterval} min`;
  intervalSlider.addEventListener('input', () => {
    settings.factInterval = parseInt(intervalSlider.value, 10);
    document.getElementById('interval-value').textContent = `${settings.factInterval} min`;
    persist();
  });

  wireToggle('chime-toggle', 'chimeBeforeSpeech', () => syncSpeechFromSettings());
  wireToggle('nav-toggle', 'turnByTurnEnabled', () => {
    navEngine.enabled = settings.turnByTurnEnabled;
    if (!settings.turnByTurnEnabled) renderManeuverBanner(null);
  });
  wireToggle('facts-toggle', 'factsEnabled');
  wireToggle('wiki-toggle', 'onlineExtras');

  wireStorySettings();
  wireMusicSettings();

  document.getElementById('voice-sample').addEventListener('click', () => {
    speech.speakNow({ title: 'Sample', body: t('sample.text', settings.language), source: 'system' });
  });
}

function wireToggle(id, key, onChange) {
  const el = document.getElementById(id);
  el.classList.toggle('on', settings[key]);
  el.addEventListener('click', () => {
    settings[key] = !settings[key];
    el.classList.toggle('on', settings[key]);
    persist();
    onChange?.();
  });
}

function persist() {
  saveSettings(settings);
}

function syncSpeechFromSettings() {
  speech.language = settings.language;
  speech.rate = settings.speechRate;
  speech.playChime = settings.chimeBeforeSpeech;
}

// ─────────────────────────── Screen switching ───────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id !== 'drive-screen') {
    document.body.style.overflow = '';
  } else {
    document.body.style.overflow = 'hidden';
  }
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline app-shell caching just won't be available — the rest of
      // the app still works fine online.
    });
  }
}

// Screen-on handling lives in wakeLock.js and is wired up above, next to
// startDrive()/endDrive().
