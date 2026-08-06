// Driving a route the other way round.
//
// Reversing the line and the order of the stops is the easy half. The
// awkward half is the writing: a guide that says "on your right stands
// Torre Argentina" is simply wrong once you approach from the south, and
// a story that opens with "you're leaving Alghero" now plays at the end.
//
// Left and right are fixable, and are fixed here. The opening and closing
// framing is not — that would need the text rewriting, not patching — so
// the app says so out loud at the start of a reversed drive rather than
// quietly reading something that doesn't match what you can see.

/** Swaps the two halves of a name like "Alghero → Bosa: de Litoranea". */
function swapName(name) {
  const arrow = name.includes('→') ? '→' : null;
  if (!arrow) return null;

  // Keep anything after a colon — that's the road's own name, not a direction.
  const [route, ...rest] = name.split(':');
  const parts = route.split(arrow).map((p) => p.trim());
  if (parts.length !== 2) return null;

  const flipped = `${parts[1]} ${arrow} ${parts[0]}`;
  return rest.length ? `${flipped}:${rest.join(':')}` : flipped;
}

function reversedName(name, lang) {
  const swapped = swapName(name);
  if (swapped) return swapped;
  return lang === 'nl' ? `${name} (omgekeerd)` : `${name} (reversed)`;
}

/**
 * Flips left and right in a piece of spoken text.
 *
 * Dutch is safe to swap wholesale: "rechts" only ever means the
 * direction, and compounds like "rechtdoor" and "rechtsaf" don't match on
 * a word boundary.
 *
 * English is not. "The right ones", "in his own right", "right away" all
 * mean something else entirely, and swapping those produces nonsense. So
 * English only flips inside phrases that can only be spatial.
 */
export function flipDirections(text, lang) {
  if (!text) return text;

  if (lang === 'nl') {
    // An explicit list, not a wildcard. A pattern like /rechts\w*/ looks
    // tidier but turns "rechtstreeks" into "linkstreeks" and "de rechter"
    // — a judge — into "de linker". Word boundaries plus a fixed list
    // leave every compound alone.
    const PAIRS = {
      links: 'rechts', rechts: 'links',
      linksaf: 'rechtsaf', rechtsaf: 'linksaf',
      linkerhand: 'rechterhand', rechterhand: 'linkerhand',
      linkerkant: 'rechterkant', rechterkant: 'linkerkant',
      linkerzijde: 'rechterzijde', rechterzijde: 'linkerzijde'
    };
    const pattern = new RegExp(
      `\\b(${Object.keys(PAIRS).sort((a, b) => b.length - a.length).join('|')})\\b`,
      'gi'
    );
    return text.replace(pattern, (word) => {
      const swapped = PAIRS[word.toLowerCase()];
      return word[0] === word[0].toUpperCase()
        ? swapped[0].toUpperCase() + swapped.slice(1)
        : swapped;
    });
  }

  return text.replace(
    /\b(on|to|at|along) (your|the) (right|left)\b/gi,
    (match, prep, poss, side) => {
      const swapped = side.toLowerCase() === 'right' ? 'left' : 'right';
      const cased = side[0] === side[0].toUpperCase()
        ? swapped[0].toUpperCase() + swapped.slice(1)
        : swapped;
      return `${prep} ${poss} ${cased}`;
    }
  );
}

/**
 * Builds the mirror image of a route.
 *
 * The id gains a suffix so cached road geometry doesn't collide — the
 * reverse of a road is genuinely a different set of turns — while baseId
 * keeps pointing at the original, so any long stories already written for
 * this route are still found.
 */
export function reverseRoute(route, lang) {
  return {
    ...route,
    id: `${route.id}--rev`,
    baseId: route.baseId || route.id,
    reversed: true,
    name: {
      nl: reversedName(route.name.nl, 'nl'),
      en: reversedName(route.name.en, 'en')
    },
    waypoints: [...route.waypoints].reverse(),
    geometry: route.geometry ? [...route.geometry].reverse() : undefined,
    highlights: [...route.highlights].reverse(),
    bestTime: {
      nl: route.bestTime.nl,
      en: route.bestTime.en
    }
  };
}

/** Turns a reversed route back into the original. */
export function unreverseRoute(reversed, allRoutes) {
  return allRoutes.find((r) => r.id === reversed.baseId) || reversed;
}
