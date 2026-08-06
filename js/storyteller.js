// Longer stories, written by Claude, generated before you leave.
//
// The design decision that matters: this runs *ahead of time*, on wifi,
// and writes the result to the phone. It is never called while driving.
// Generating live would fail in exactly the places this app is for — the
// Supramonte, the SS125, the Barbagia — and would put a network round
// trip between you and a story you're already driving past.
//
// The API key lives only in this browser's storage. It is never committed
// to the repository and never sent anywhere except Anthropic. It is,
// however, present in a web page, so it deserves its own key with a spend
// limit rather than one you use elsewhere.
//
// On accuracy: the model is given the hand-written script and the
// Wikipedia summary as source material and told to work from those. That
// sharply reduces invention, but does not eliminate it. Expanded stories
// are marked as such in the app so you always know which you're hearing.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const KEY_STORAGE = 'sardegna.ai.key';
const STORY_STORAGE = 'sardegna.ai.stories.v1';

export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet — beste verhalen' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku — sneller en goedkoper' }
];

export class Storyteller extends EventTarget {
  constructor(enrichment) {
    super();
    this.enrichment = enrichment;
    this.stories = readStories();
    this.cancelled = false;
  }

  // ── Key handling ────────────────────────────────────────────────────

  get apiKey() {
    try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; }
  }

  set apiKey(value) {
    try {
      if (value) localStorage.setItem(KEY_STORAGE, value.trim());
      else localStorage.removeItem(KEY_STORAGE);
    } catch { /* private browsing */ }
    this.dispatchEvent(new Event('keychange'));
  }

  get hasKey() {
    return this.apiKey.startsWith('sk-');
  }

  // ── Stored stories ──────────────────────────────────────────────────

  storyKey(routeId, highlightId, lang) {
    return `${routeId}|${highlightId}|${lang}`;
  }

  /** The expanded story for a place, or null if it hasn't been written. */
  get(routeId, highlightId, lang) {
    return this.stories[this.storyKey(routeId, highlightId, lang)] || null;
  }

  /** How many of a route's places already have a long story. */
  countFor(route, lang) {
    return route.highlights.filter((h) => this.get(route.id, h.id, lang)).length;
  }

  clearRoute(route, lang) {
    for (const h of route.highlights) delete this.stories[this.storyKey(route.id, h.id, lang)];
    writeStories(this.stories);
    this.dispatchEvent(new Event('storieschange'));
  }

  // ── Generation ──────────────────────────────────────────────────────

  cancel() {
    this.cancelled = true;
  }

  /**
   * Writes a long story for every place on a route.
   *
   * Sequential on purpose: a burst of parallel requests is a good way to
   * meet a rate limit, and there is no hurry — you're doing this on the
   * sofa the night before.
   */
  async generateRoute(route, { language, model, onProgress = () => {} }) {
    if (!this.hasKey) throw new Error('Geen API-sleutel ingevuld.');
    this.cancelled = false;

    const todo = route.highlights.filter((h) => !this.get(route.id, h.id, language));
    let done = 0;
    let failed = 0;

    onProgress({ done: 0, total: todo.length, message: `${todo.length} verhalen te schrijven…` });

    for (const highlight of todo) {
      if (this.cancelled) break;
      try {
        const text = await this.generateOne(route, highlight, language, model);
        if (text) {
          this.stories[this.storyKey(route.id, highlight.id, language)] = text;
          writeStories(this.stories);
        } else {
          failed++;
        }
      } catch (err) {
        // A single failure shouldn't abandon the whole route — but an
        // auth problem will fail identically every time, so stop there.
        if (err.fatal) throw err;
        failed++;
      }
      done++;
      onProgress({ done, total: todo.length, message: highlight.name[language] });
      // Gentle spacing, well under any rate limit.
      await new Promise((r) => setTimeout(r, 400));
    }

    this.dispatchEvent(new Event('storieschange'));
    return { done, failed, cancelled: this.cancelled, total: todo.length };
  }

  async generateOne(route, highlight, language, model) {
    // Give the model everything we know, so it elaborates rather than invents.
    let wiki = null;
    if (highlight.wikipedia) {
      const page = await this.enrichment.fetchPage(highlight.wikipedia[language], language);
      wiki = page ? page.extract : null;
    }

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1600,
        system: systemPrompt(language),
        messages: [{ role: 'user', content: userPrompt(route, highlight, language, wiki) }]
      })
    });

    if (res.status === 401 || res.status === 403) {
      const err = new Error('De API-sleutel wordt geweigerd. Controleer hem in de Anthropic-console.');
      err.fatal = true;
      throw err;
    }
    if (res.status === 400) {
      const body = await res.text();
      const err = new Error(`Verzoek geweigerd: ${body.slice(0, 160)}`);
      err.fatal = true;
      throw err;
    }
    if (res.status === 429) {
      // Back off once, then let the caller count it as a failure.
      await new Promise((r) => setTimeout(r, 4000));
      return null;
    }
    if (!res.ok) return null;

    const data = await res.json();
    const text = (data.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return text ? cleanForSpeech(text) : null;
  }
}

// ── Prompts ───────────────────────────────────────────────────────────

function systemPrompt(language) {
  if (language === 'nl') {
    return [
      'Je bent een gesproken reisgids voor iemand die op dit moment over Sardinië rijdt.',
      '',
      'Schrijf zoals een goede gids praat: vertellend, concreet, met oog voor het detail dat een plek anders maakt dan de vorige. Geen reisbrochure, geen opsomming van bezienswaardigheden, geen superlatieven.',
      '',
      'Harde eisen:',
      '- Uitsluitend lopende tekst. Geen kopjes, geen opsommingstekens, geen markdown, geen emoji. Alles wordt hardop voorgelezen.',
      '- Begin midden in het verhaal. Geen "Welkom bij" of "We bevinden ons nu".',
      '- Spreek de luisteraar aan met "je", en verwijs naar wat hij nu ziet: rechts, links, voor je, boven je.',
      '- Baseer je op het meegeleverde bronmateriaal. Verzin GEEN jaartallen, namen, afmetingen of gebeurtenissen die daar niet in staan. Weet je iets niet zeker, blijf dan algemener of laat het weg.',
      '- Getallen voluit in woorden waar dat natuurlijk klinkt, want dit wordt door een computerstem uitgesproken.',
      '- Lengte naar wat de plek verdient: een klein uitzichtpunt krijgt tweehonderdvijftig woorden, een stad met een verhaal mag naar zeshonderd. Rek niets op om lengte te halen.',
      '- Eindig af, niet met een vraag of een uitnodiging.'
    ].join('\n');
  }
  return [
    'You are a spoken road guide for someone driving across Sardinia right now.',
    '',
    'Write the way a good guide talks: narrative, concrete, alert to the detail that makes this place different from the last one. Not a brochure, not a list of attractions, no superlatives.',
    '',
    'Hard requirements:',
    '- Continuous prose only. No headings, no bullet points, no markdown, no emoji. All of this is read aloud.',
    '- Start inside the story. No "Welcome to" or "We are now at".',
    '- Address the listener as "you", and point at what they can see now: on your right, ahead, above you.',
    '- Work from the source material provided. Do NOT invent dates, names, measurements or events that are not in it. If unsure, stay general or leave it out.',
    '- Length as the place deserves: a small viewpoint gets two hundred and fifty words, a town with a real story may run to six hundred. Never pad to reach a length.',
    '- Finish cleanly, not with a question or an invitation.'
  ].join('\n');
}

function userPrompt(route, highlight, language, wiki) {
  const lines = [];
  const L = (nl, en) => lines.push(language === 'nl' ? nl : en);

  L(`Route: ${route.name.nl} (${route.region.nl})`, `Route: ${route.name.en} (${route.region.en})`);
  L(`Plek: ${highlight.name.nl}`, `Place: ${highlight.name.en}`);
  L(`Soort: ${highlight.kind}`, `Type: ${highlight.kind}`);
  L(`Coördinaten: ${highlight.lat}, ${highlight.lon}`, `Coordinates: ${highlight.lat}, ${highlight.lon}`);
  lines.push('');
  L('BRONMATERIAAL — bestaande gidstekst:', 'SOURCE MATERIAL — existing guide text:');
  lines.push(highlight.script[language]);

  if (wiki) {
    lines.push('');
    L('BRONMATERIAAL — Wikipedia:', 'SOURCE MATERIAL — Wikipedia:');
    lines.push(wiki);
  }

  lines.push('');
  L(
    'Schrijf hier een uitgebreider gesproken verhaal van. Behoud alles wat er feitelijk in staat, en werk het uit met context, achtergrond en sfeer die je zeker weet. Geef alleen de tekst terug.',
    'Expand this into a fuller spoken story. Keep every fact that is there, and develop it with context, background and atmosphere you are confident about. Return only the text.'
  );
  return lines.join('\n');
}

/** Strips anything that would be read out as punctuation soup. */
function cleanForSpeech(text) {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/^[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Storage ───────────────────────────────────────────────────────────

function readStories() {
  try {
    const raw = localStorage.getItem(STORY_STORAGE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStories(stories) {
  try {
    localStorage.setItem(STORY_STORAGE, JSON.stringify(stories));
  } catch {
    // Roughly 5 MB available; a full set of long stories for every route
    // sits well inside that, but a very large GPX import could push it.
    console.warn('Kon de verhalen niet opslaan: opslag vol.');
  }
}
