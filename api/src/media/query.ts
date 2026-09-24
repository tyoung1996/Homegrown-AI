// Reading what someone actually asked for out of a sentence.
//
// "Play The Office S03E12" is a different request from "Play The Office",
// and getting that wrong means adding a whole series when one episode was
// wanted. Pure functions, no io, so the awkward phrasings can be tested.

export interface EpisodeRef {
  /** what is left once the season and episode have been taken out */
  title: string;
  season: number;
  /** absent when a whole season was asked for */
  episode?: number;
}

// s03e12 · s3 e12 · 3x12 · season 3 episode 12 · season 3
const PATTERNS: RegExp[] = [
  /\bs(?:eason)?\s*(\d{1,2})\s*[\s._-]*e(?:p(?:isode)?)?\s*(\d{1,3})\b/i,
  /\b(\d{1,2})\s*x\s*(\d{1,3})\b/,
  /\bseason\s*(\d{1,2})\b()/i,
];

// the words people put in front of a title, and after it. "the" is not in
// either list on purpose — plenty of titles start with it.
const LEAD = new Set([
  'please',
  'can',
  'could',
  'would',
  'will',
  'you',
  'we',
  'i',
  'us',
  'let',
  'lets',
  "let's",
  'want',
  'wanna',
  'to',
  'put',
  'on',
  'play',
  'watch',
  'show',
  'me',
  'add',
  'get',
  'start',
  'find',
  'pull',
  'up',
  'of',
  'some',
]);
const TRAIL = new Set([
  'please',
  'tonight',
  'now',
  'for',
  'me',
  'on',
  'the',
  'tv',
  'telly',
  'upstairs',
  'downstairs',
  'in',
  'here',
]);

/** Strip the words people wrap a title in, so "play the office please"
 * searches for "the office". Never strips the last word standing, because
 * one of those words is a Pixar film. */
export function titleOf(query: string): string {
  const words = query
    .replace(/\s{2,}/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (
    words.length > 1 &&
    LEAD.has(words[0].toLowerCase().replace(/[,.:]+$/, ''))
  ) {
    words.shift();
  }
  while (
    words.length > 1 &&
    TRAIL.has(words[words.length - 1].toLowerCase().replace(/[,.:!?]+$/, ''))
  ) {
    words.pop();
  }
  return words
    .join(' ')
    .replace(/^[\s,.:-]+|[\s,.:-]+$/g, '')
    .trim();
}

/**
 * The title, then shorter and shorter versions of it by dropping a leading
 * word at a time. No list of filler words will ever be complete, so rather
 * than insist on stripping exactly right, the caller can try the most
 * specific version first and fall back — "do we have harry potter" gets to
 * "harry potter" whether or not every word in front was recognised.
 */
export function titleGuesses(query: string, most = 4): string[] {
  const first = titleOf(query);
  const words = first.split(' ').filter(Boolean);
  const out: string[] = [];
  for (let drop = 0; drop <= Math.min(most, words.length - 1); drop++) {
    const guess = words.slice(drop).join(' ');
    if (guess && !out.includes(guess)) out.push(guess);
  }
  return out;
}

/** Pull a season and maybe an episode out of a request. Null when neither
 * was mentioned — which is most of the time. */
export function parseEpisodeRef(query: string): EpisodeRef | null {
  for (const re of PATTERNS) {
    const m = re.exec(query);
    if (!m) continue;
    const season = Number(m[1]);
    const episode = m[2] ? Number(m[2]) : undefined;
    if (!Number.isFinite(season)) continue;
    // a year is not a season: "Dune 2021" must not read as season 20
    if (/^(19|20)\d{2}$/.test(m[0].trim())) continue;
    const title = titleOf(
      query.slice(0, m.index) + ' ' + query.slice(m.index + m[0].length),
    );
    return {
      title,
      season,
      ...(episode != null && Number.isFinite(episode) ? { episode } : {}),
    };
  }
  return null;
}

/** Did they ask for "the rest" of something, rather than the thing itself? */
export function asksForMissing(query: string): boolean {
  return /\b(the rest of|rest of|missing|what(?:'s| is) missing|remaining|complete (the|my)|fill in)\b/i.test(
    query,
  );
}
