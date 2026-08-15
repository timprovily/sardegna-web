// Island facts, except not only about the island.
//
// The original forty facts are about Sardinia, which is exactly right on
// the SS125 and completely useless on a cycle route through Friesland.
// So facts are now looked up per region, from three sources in order of
// preference:
//
//   1. Bundled — anything shipped in data/facts-<region>.json. Always
//      available, no connection needed, and the best writing.
//   2. Generated — written once by Claude for the region you're in and
//      stored on the phone. Needs the API key and a connection, once.
//   3. Wikipedia — a fallback that works with no key at all: the region's
//      own article, trimmed into speakable pieces.
//
// On storing these in the repository: the app can't write to GitHub, and
// shouldn't be able to. That would need a write token embedded in a
// public web page, which would let anyone who opened it commit to the
// repository. Instead there's an export button that hands you the exact
// JSON file to drop into data/ yourself — same result, no token.

const STORAGE_KEY = 'sardegna.regionFacts.v1';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export class FactSource extends EventTarget {
  constructor(storyteller) {
    super();
    this.storyteller = storyteller;   // borrows its API key and model
    this.generated = readStore();
    this.bundled = new Map();          // regionKey -> facts[]
    this.bundledIndex = null;
  }

  /** A stable key for a region, independent of display language. */
  static keyFor(place) {
    if (!place) return 'sardinia';
    const parts = [place.countryCode || place.country, place.region]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    return parts.join('--') || 'sardinia';
  }

  /** The place a route belongs to, falling back to Sardinia for the
   *  bundled routes, which carry no explicit place. */
  static placeOf(route) {
    if (route?.place) return route.place;
    return { country: 'Italië', countryCode: 'IT', region: 'Sardegna' };
  }

  // ── Bundled files ───────────────────────────────────────────────────

  /** Reads data/facts-index.json, which lists any extra regional files.
   *  Missing or malformed is fine — that's the normal state until you
   *  export one. */
  async loadIndex() {
    if (this.bundledIndex) return this.bundledIndex;
    try {
      const res = await fetch('data/facts-index.json', { cache: 'force-cache' });
      this.bundledIndex = res.ok ? await res.json() : { regions: {} };
    } catch {
      this.bundledIndex = { regions: {} };
    }
    return this.bundledIndex;
  }

  async bundledFor(regionKey) {
    if (this.bundled.has(regionKey)) return this.bundled.get(regionKey);

    const index = await this.loadIndex();
    const file = index.regions?.[regionKey];
    if (!file) {
      this.bundled.set(regionKey, null);
      return null;
    }
    try {
      const res = await fetch(`data/${file}`, { cache: 'force-cache' });
      const data = res.ok ? await res.json() : null;
      const facts = data?.facts || null;
      this.bundled.set(regionKey, facts);
      return facts;
    } catch {
      this.bundled.set(regionKey, null);
      return null;
    }
  }

  // ── Stored, generated facts ─────────────────────────────────────────

  storedFor(regionKey, lang) {
    return this.generated[`${regionKey}|${lang}`] || null;
  }

  countFor(regionKey, lang) {
    return (this.storedFor(regionKey, lang) || []).length;
  }

  clear(regionKey, lang) {
    delete this.generated[`${regionKey}|${lang}`];
    writeStore(this.generated);
    this.dispatchEvent(new Event('change'));
  }

  /**
   * Everything available for a region, best source first.
   *
   * The default Sardinian set is only used for Sardinia. Elsewhere, an
   * empty result is the honest answer — better silence than a fact about
   * a cheese four hundred kilometres away.
   */
  async factsFor(route, lang, fallbackSardinia) {
    const place = FactSource.placeOf(route);
    const key = FactSource.keyFor(place);

    if (key === 'it--sardegna' || key === 'sardinia') {
      const bundled = await this.bundledFor(key);
      return bundled || fallbackSardinia || [];
    }

    const bundled = await this.bundledFor(key);
    if (bundled?.length) return bundled;

    const stored = this.storedFor(key, lang);
    if (stored?.length) return stored;

    return [];
  }

  // ── Generating ──────────────────────────────────────────────────────

  cancel() {
    this.cancelled = true;
  }

  /**
   * Writes a set of facts for a region.
   *
   * With an API key this asks Claude, seeded with the region's Wikipedia
   * article so it elaborates rather than invents. Without one it falls
   * back to shaping that article into speakable pieces directly — worse
   * writing, but it works with no account at all.
   */
  async generate(route, lang, { onProgress = () => {} } = {}) {
    this.cancelled = false;
    const place = FactSource.placeOf(route);
    const key = FactSource.keyFor(place);
    const name = place.region || place.country;

    onProgress({ message: lang === 'nl' ? `Achtergrond over ${name} ophalen…` : `Fetching background on ${name}…` });
    const background = await wikipediaBackground(name, place.country, lang);

    let facts;
    if (this.storyteller?.hasKey) {
      onProgress({ message: lang === 'nl' ? 'Weetjes schrijven…' : 'Writing facts…' });
      facts = await this.askClaude(place, lang, background);
    } else {
      if (!background) {
        throw new Error(
          lang === 'nl'
            ? `Geen achtergrond gevonden over ${name}, en zonder API-sleutel kan ik er niets van maken.`
            : `No background found for ${name}, and without an API key there is nothing to build from.`
        );
      }
      facts = factsFromText(background, key, lang);
    }

    if (!facts?.length) {
      throw new Error(lang === 'nl' ? 'Er kwamen geen bruikbare weetjes uit.' : 'No usable facts came back.');
    }

    this.generated[`${key}|${lang}`] = facts;
    writeStore(this.generated);
    this.dispatchEvent(new Event('change'));
    return { key, name, count: facts.length };
  }

  async askClaude(place, lang, background) {
    const name = place.region || place.country;
    const country = place.country || '';

    const system = lang === 'nl'
      ? [
          'Je schrijft korte gesproken weetjes voor een reisgids-app, die worden voorgelezen terwijl iemand door de streek reist.',
          '',
          'Eisen:',
          '- Elk weetje is één alinea van twee tot vier zinnen, lopende tekst, geen opsomming.',
          '- Concreet en verrassend. Geen brochuretaal, geen superlatieven, geen "wist je dat".',
          '- Alles wordt hardop voorgelezen: geen kopjes, geen markdown, geen emoji, geen haakjes met jaartallen erin.',
          '- Baseer je op het meegeleverde bronmateriaal en op wat je zeker weet. Verzin geen jaartallen of namen.',
          '- Varieer: geschiedenis, taal, natuur, eten, gebruiken, industrie, geografie.'
        ].join('\n')
      : [
          'You write short spoken facts for a travel guide app, read aloud while someone is travelling through the area.',
          '',
          'Requirements:',
          '- Each fact is one paragraph of two to four sentences, continuous prose, not a list.',
          '- Concrete and surprising. No brochure language, no superlatives, no "did you know".',
          '- All of it is read aloud: no headings, no markdown, no emoji, no bracketed dates.',
          '- Work from the source material and from what you are confident about. Do not invent dates or names.',
          '- Vary the subjects: history, language, nature, food, customs, industry, geography.'
        ].join('\n');

    const user = [
      lang === 'nl' ? `Streek: ${name}${country ? `, ${country}` : ''}` : `Region: ${name}${country ? `, ${country}` : ''}`,
      '',
      background ? (lang === 'nl' ? 'BRONMATERIAAL:' : 'SOURCE MATERIAL:') : '',
      background || '',
      '',
      lang === 'nl'
        ? 'Schrijf twintig weetjes over deze streek. Geef ze terug als JSON: een array van objecten met de velden "category" (history, language, nature, food, culture, geography, modern) en "text". Geef uitsluitend de JSON terug, zonder toelichting en zonder markdown-hekjes.'
        : 'Write twenty facts about this region. Return them as JSON: an array of objects with the fields "category" (history, language, nature, food, culture, geography, modern) and "text". Return only the JSON, with no commentary and no markdown fences.'
    ].join('\n');

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.storyteller.apiKey,
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }]
      })
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error(lang === 'nl' ? 'De API-sleutel wordt geweigerd.' : 'The API key was refused.');
    }
    if (!res.ok) {
      throw new Error(`API ${res.status}`);
    }

    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return parseFactJSON(text, FactSource.keyFor(place), lang);
  }

  /** The exact file to drop into data/ so a region ships with the app. */
  exportFile(regionKey, lang) {
    const facts = this.storedFor(regionKey, lang);
    if (!facts?.length) return null;
    return {
      filename: `facts-${regionKey}.json`,
      contents: JSON.stringify({ region: regionKey, facts }, null, 2)
    };
  }
}

// ── Wikipedia fallback ────────────────────────────────────────────────

async function wikipediaBackground(region, country, lang) {
  for (const title of [region, `${region} (${country})`, country].filter(Boolean)) {
    try {
      const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.type === 'disambiguation' || !data.extract) continue;

      // The summary is short; the full lead section gives far more to
      // work with and is still one request.
      const lead = await wikipediaLead(title, lang);
      return lead || data.extract;
    } catch {
      // try the next candidate title
    }
  }
  return null;
}

async function wikipediaLead(title, lang) {
  try {
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts` +
      `&exintro=1&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pages = data?.query?.pages || {};
    const first = Object.values(pages)[0];
    return first?.extract || null;
  } catch {
    return null;
  }
}

/** Shapes an article into speakable chunks when there's no API key. */
function factsFromText(text, regionKey, lang) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
  const facts = [];
  let buffer = [];

  for (const sentence of sentences) {
    const clean = sentence.replace(/\s+/g, ' ').trim();
    // Wikipedia leads open with pronunciation guides and bracketed
    // clutter that reads terribly out loud.
    if (/^\W|\(|\[/.test(clean) && clean.length < 40) continue;
    buffer.push(clean);
    if (buffer.length >= 3) {
      facts.push(buffer.join(' '));
      buffer = [];
    }
  }
  if (buffer.length >= 2) facts.push(buffer.join(' '));

  return facts.slice(0, 12).map((body, i) => ({
    id: `${regionKey}-wiki-${i}`,
    category: 'geography',
    text: { nl: body, en: body },
    source: 'wikipedia'
  }));
}

function parseFactJSON(raw, regionKey, lang) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) return null;

  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  return parsed
    .filter((f) => f && typeof f.text === 'string' && f.text.trim().length > 40)
    .map((f, i) => ({
      id: `${regionKey}-ai-${i}`,
      category: f.category || 'geography',
      // Generated in one language; both slots hold it so the rest of the
      // app doesn't need to special-case them.
      text: { nl: f.text.trim(), en: f.text.trim() },
      source: 'generated',
      language: lang
    }));
}

// ── Storage ───────────────────────────────────────────────────────────

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    console.warn('Kon regionale weetjes niet opslaan: opslag vol.');
  }
}
