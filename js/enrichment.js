// Fetches a short extra paragraph from Wikipedia's REST summary endpoint.
// That endpoint sends permissive CORS headers, so it can be called
// directly from the browser — no proxy server needed. Content is
// CC BY-SA; the guide credits Wikipedia whenever it uses this.

export class EnrichmentService {
  constructor() {
    this.cache = new Map();
  }

  async extract(pageTitle, lang) {
    const key = `${lang}:${pageTitle}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const host = `${lang}.wikipedia.org`;
    const url = `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json.extract) return null;

      const trimmed = firstSentences(json.extract, 2);
      this.cache.set(key, trimmed);
      return trimmed;
    } catch {
      return null; // offline, timed out, or the page moved — not a problem
    }
  }
}

function firstSentences(text, count) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, count).join(' ').trim();
}
