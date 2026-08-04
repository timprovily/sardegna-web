// Fetches a short extra paragraph from Wikipedia's REST summary endpoint.
// That endpoint sends permissive CORS headers, so it can be called
// directly from the browser — no proxy server needed. Content is
// CC BY-SA; the guide credits Wikipedia whenever it uses this.

export class EnrichmentService {
  constructor() {
    this.cache = new Map();
  }

  /** Fetches the summary once and keeps both the text and the image. */
  async fetchPage(pageTitle, lang) {
    const key = `${lang}:${pageTitle}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return null;
      const json = await res.json();
      if (!json.extract) return null;

      const result = {
        extract: firstSentences(json.extract, 2),
        // The REST summary hands us a ready-made thumbnail, so there is no
        // second request and no image-licensing guesswork on our side.
        image: (json.thumbnail && json.thumbnail.source) || null
      };
      this.cache.set(key, result);
      return result;
    } catch {
      return null; // offline, timed out, or the page moved — not a problem
    }
  }

  /** Two sentences of extra context, or null if unavailable offline. */
  async extract(pageTitle, lang) {
    const page = await this.fetchPage(pageTitle, lang);
    return page ? page.extract : null;
  }

  /** Just the picture, for the highlight list and the drive screen. */
  async image(pageTitle, lang) {
    const page = await this.fetchPage(pageTitle, lang);
    return page ? page.image : null;
  }
}

function firstSentences(text, count) {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  return sentences.slice(0, count).join(' ').trim();
}
