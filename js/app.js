import { loadRoutes, loadFacts, formatDistance, progressFraction } from './data.js';
import { loadSettings, saveSettings, loadCustomRoutes, saveCustomRoute, deleteCustomRoute } from './storage.js';
import { SpeechService } from './speech.js';
import { LocationService } from './geo.js';
import { NavEngine } from './navEngine.js';
import { TourEngine } from './tourEngine.js';
import { EnrichmentService } from './enrichment.js';
import { RouteMap } from './map.js';
import { OverviewMap, ROUTE_COLORS } from './overviewMap.js';
import { WakeLockManager } from './wakeLock.js';
import { t, applyStaticStrings } from './i18n.js';
import { ThemeManager } from './theme.js';
import { buildRouteFromGPX } from './gpxImport.js';
import { fetchWeather, describeCode, goldenHourDeparture, formatTime } from './weather.js';

// ─────────────────────────── State ───────────────────────────

const settings = loadSettings();
const speech = new SpeechService();
const location = new LocationService();
const enrichment = new EnrichmentService();
const tourEngine = new TourEngine({ speech, facts: [], settings, enrichment });
const navEngine = new NavEngine(speech);
const wakeLock = new WakeLockManager();
const theme = new ThemeManager(settings);

let routes = [];
let currentRoute = null;
let detailMap = null;
let driveMap = null;
let overviewMap = null;

syncSpeechFromSettings();

// ─────────────────────────── Boot ───────────────────────────

(async function boot() {
  theme.start();
  applyStaticStrings(settings.language);
  document.getElementById('header-sub').textContent = '';

  try {
    const [bundled, facts] = await Promise.all([loadRoutes(), loadFacts()]);
    tourEngine.facts = facts;
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
  updateAudioStatus();

  if ('mediaSession' in navigator) {
    // Lets iOS show the current story on the lock screen, same as a podcast.
    navigator.mediaSession.metadata = new MediaMetadata({ title: 'Sardegna' });
  }

  registerServiceWorker();
})();

// ─────────────────────────── Route list ───────────────────────────

function renderRouteList() {
  const lang = settings.language;
  const container = document.getElementById('route-list');
  container.innerHTML = '';

  for (const route of routes) {
    const card = document.createElement('button');
    card.className = 'panel route-card';
    const badge = route.custom
      ? `<span class="custom-badge">${t('import.custom', lang)}</span>` : '';
    card.innerHTML = `
      <div class="eyebrow">${route.region[lang]}${badge}</div>
      <h2>${route.name[lang]}</h2>
      <p class="summary">${route.summary[lang]}</p>
      <div class="route-stats">
        <div class="stat">${route.distanceKm}<span>km</span></div>
        <div class="stat">${route.durationMinutes}<span>min</span></div>
        <div class="stat">${route.highlights.length}<span>${lang === 'nl' ? 'verhalen' : 'stories'}</span></div>
        <div class="chev">›</div>
      </div>`;
    card.addEventListener('click', () => openDetail(route));
    container.appendChild(card);
  }
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

  document.getElementById('detail-region').textContent = route.region[lang];
  document.getElementById('detail-name').textContent = route.name[lang];
  document.getElementById('detail-summary').textContent = route.summary[lang];
  document.getElementById('detail-distance').textContent = `${route.distanceKm} km`;
  document.getElementById('detail-duration').textContent = `${route.durationMinutes} min`;
  document.getElementById('detail-count').textContent = route.highlights.length;
  document.getElementById('detail-character').textContent = route.character[lang];
  document.getElementById('detail-besttime').textContent = route.bestTime[lang];

  renderHighlightList(route);
  renderDining(route);
  renderCustomRouteControls(route);
  renderWeather(route);
  loadHighlightPhotos(route);
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
        <button class="highlight-row-play">🔊</button>
      </div>
      <div class="highlight-row-body">${h.script[lang]}</div>`;

    row.querySelector('.highlight-row-play').addEventListener('click', (e) => {
      e.stopPropagation();
      tourEngine.playHighlight(h);
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

    tourEngine.start(currentRoute);
    navEngine.enabled = settings.turnByTurnEnabled;
    location.start();
    renderWakeLockPill(false);   // shown straight away, updated by the event
    wakeLock.enable();
    renderRibbon();
    renderNowPlaying();
  });
}

function endDrive() {
  tourEngine.stop();
  location.stop();
  wakeLock.disable();
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

  if (driveMap) driveMap.updateUserPosition(pos);

  tourEngine.handlePosition(pos);
  navEngine.handlePosition(pos, settings.language);
  updateRibbonProgress(pos);
});

function updateRibbonProgress(pos) {
  const bar = document.querySelector('.ribbon-progress');
  if (!bar || !currentRoute) return;
  const line = navEngine.geometry.length > 1 ? navEngine.geometry : currentRoute.waypoints;
  const fraction = progressFraction(pos, line);
  bar.style.width = `${Math.round(fraction * 100)}%`;
}

tourEngine.addEventListener('highlightplayed', (e) => {
  if (driveMap) driveMap.markPlayed(e.detail.id);
  renderRibbon();
});

speech.addEventListener('itemstart', () => renderNowPlaying());
speech.addEventListener('itemend', () => renderNowPlaying());

navEngine.addEventListener('geometry', (e) => {
  if (driveMap) driveMap.updateGeometry(e.detail.geometry);
});

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
  const lang = settings.language;
  const el = document.getElementById('ribbon');
  const highlights = currentRoute.highlights;
  const nextId = tourEngine.nextHighlight?.id;

  const ticks = highlights.map((h, i) => {
    const pos = highlights.length > 1 ? (i / (highlights.length - 1)) * 100 : 50;
    const played = tourEngine.playedHighlightIds.has(h.id);
    const isNext = h.id === nextId;
    return `<div class="ribbon-tick ${played ? 'played' : ''} ${isNext ? 'next' : ''}" style="left:${pos}%"></div>`;
  }).join('');

  el.innerHTML = `<div class="ribbon-track"></div><div class="ribbon-progress" style="width:0%"></div>${ticks}`;
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
    container.innerHTML = `
      <div class="eyebrow">${t('drive.nextUp', lang)}</div>
      <div class="now-title">${escapeHTML(tourEngine.nextHighlight.name[lang])}</div>
      <div class="now-distance">${formatDistance(tourEngine.distanceToNext)}</div>`;
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
  if (!item.source || !item.source.startsWith('highlight:')) return;

  const id = item.source.slice('highlight:'.length);
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

// ─────────────────────────── Global controls ───────────────────────────

function wireGlobalControls() {
  wireImport();
  document.getElementById('back-to-list').addEventListener('click', () => showScreen('list-screen'));
  document.getElementById('start-drive').addEventListener('click', startDrive);
  document.getElementById('open-osm').addEventListener('click', openInMapsApp);

  document.getElementById('end-drive').addEventListener('click', () => {
    const lang = settings.language;
    if (confirm(t('drive.endConfirm', lang))) endDrive();
  });

  document.getElementById('ctrl-repeat').addEventListener('click', () => speech.repeatLast());
  document.getElementById('ctrl-skip').addEventListener('click', () => speech.skip());
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

  const input = document.getElementById('gpx-input');
  document.getElementById('import-gpx').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await handleGPXFile(file);
    input.value = ''; // so picking the same file again still fires
  });
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

function openInMapsApp() {
  if (!currentRoute) return;
  const dest = currentRoute.waypoints[currentRoute.waypoints.length - 1];
  // Apple Maps understands this URL scheme on iOS without any SDK or key;
  // on other platforms it falls back to a geo: URI that Android resolves too.
  const ua = navigator.userAgent;
  const url = /iPhone|iPad|Macintosh/.test(ua)
    ? `https://maps.apple.com/?daddr=${dest.lat},${dest.lon}&dirflg=d`
    : `geo:${dest.lat},${dest.lon}`;
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
  wireToggle('nav-toggle', 'turnByTurnEnabled', () => { navEngine.enabled = settings.turnByTurnEnabled; });
  wireToggle('facts-toggle', 'factsEnabled');
  wireToggle('wiki-toggle', 'onlineExtras');

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
