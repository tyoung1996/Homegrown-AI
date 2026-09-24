// Choosing something to watch. Pure: no network, no database — the library
// and one person's viewing come in, a ranked list comes out, and every rule
// can be tested on its own.

import type { LibraryEntry } from './jellyfin.service';

export type Mood =
  | 'funny'
  | 'scary'
  | 'dark'
  | 'light'
  | 'exciting'
  | 'thoughtful'
  | 'romantic'
  | 'family';

export const MOODS: Mood[] = [
  'funny',
  'scary',
  'dark',
  'light',
  'exciting',
  'thoughtful',
  'romantic',
  'family',
];

/** What someone asked for. Everything is optional. */
export interface Ask {
  kind?: 'movie' | 'show' | 'any';
  mood?: Mood;
  genres?: string[];
  /** suitable for the whole family: a G/PG-type certificate */
  forFamily?: boolean;
  maxMinutes?: number;
  aroundMinutes?: number;
  /** include what this person has already finished ("what do I have") */
  includeWatched?: boolean;
  /** "something like X": turns a mood from a filter into a leaning */
  like?: string;
}

// the catalogue's genre names, and the words people use, reduced to one
// small vocabulary. film and TV genres differ ("Sci-Fi & Fantasy")
const ALIASES: Record<string, string[]> = {
  'sci-fi': ['science fiction'],
  'sci fi': ['science fiction'],
  scifi: ['science fiction'],
  'sci-fi & fantasy': ['science fiction', 'fantasy'],
  'action & adventure': ['action', 'adventure'],
  'war & politics': ['war'],
  funny: ['comedy'],
  comedies: ['comedy'],
  scary: ['horror'],
  'rom-com': ['romance', 'comedy'],
  romcom: ['romance', 'comedy'],
  romantic: ['romance'],
  kids: ['family', 'animation'],
  "children's": ['family'],
  cartoon: ['animation'],
  cartoons: ['animation'],
  animated: ['animation'],
  doc: ['documentary'],
  documentaries: ['documentary'],
  musical: ['music'],
  'tv movie': ['tv movie'],
};

/** "Sci-Fi & Fantasy" -> ["science fiction", "fantasy"] */
export function genreWords(genre: string): string[] {
  const k = genre.toLowerCase().trim();
  return ALIASES[k] ?? [k];
}

const MOOD_GENRES: Record<Mood, { want: string[]; avoid: string[] }> = {
  funny: { want: ['comedy'], avoid: ['horror', 'war'] },
  scary: { want: ['horror', 'thriller'], avoid: ['family', 'animation'] },
  dark: {
    want: ['horror', 'thriller', 'crime', 'mystery', 'war'],
    avoid: ['family', 'animation', 'comedy'],
  },
  light: {
    want: ['comedy', 'family', 'animation', 'romance', 'adventure'],
    avoid: ['horror', 'war', 'crime'],
  },
  exciting: {
    want: ['action', 'adventure', 'thriller', 'science fiction'],
    avoid: [],
  },
  thoughtful: {
    want: ['drama', 'documentary', 'history', 'mystery'],
    avoid: [],
  },
  romantic: { want: ['romance'], avoid: ['horror'] },
  family: { want: ['family', 'animation', 'adventure'], avoid: ['horror'] },
};

const GENTLE: Mood[] = ['funny', 'light', 'family', 'romantic'];

export function moodGenres(mood: Mood) {
  return MOOD_GENRES[mood];
}

const words = (e: { genres: string[] }) => e.genres.flatMap(genreWords);

/** A certificate suitable for the whole family. No certificate counts as
 * not suitable: nobody has said it is. */
export function familyFriendly(certificate?: string): boolean {
  if (!certificate) return false;
  return /^(?:[A-Z]{2}-)?(G|PG|TV-Y|TV-Y7|TV-Y7-FV|TV-G|TV-PG|U)$/i.test(
    certificate.trim(),
  );
}

/** Does this fit what they asked? */
export function fits(e: LibraryEntry, ask: Ask, linked: boolean): boolean {
  if (ask.kind === 'movie' && e.type !== 'Movie') return false;
  if (ask.kind === 'show' && e.type !== 'Series') return false;
  // only this person's own viewing, and only when we know who they are
  if (!ask.includeWatched && linked && e.played) return false;
  if (
    (ask.forFamily || ask.mood === 'family') &&
    !familyFriendly(e.certificate)
  ) {
    return false;
  }
  const have = words(e);
  const wanted = (ask.genres ?? []).flatMap(genreWords);
  if (wanted.length && !wanted.some((w) => have.includes(w))) return false;
  // a mood is a filter on its own; with "like X" it is only a leaning.
  // gentle moods also rule out what clashes: nothing with horror in it is
  // "something funny" or "something for the family"
  if (ask.mood && !ask.like) {
    const { want, avoid } = MOOD_GENRES[ask.mood];
    if (!want.some((w) => have.includes(w))) return false;
    if (GENTLE.includes(ask.mood) && avoid.some((w) => have.includes(w))) {
      return false;
    }
  }
  const length = e.runtimeMinutes;
  if (ask.maxMinutes && (!length || length > ask.maxMinutes)) return false;
  if (
    ask.aroundMinutes &&
    (!length || Math.abs(length - ask.aroundMinutes) > 20)
  ) {
    return false;
  }
  return true;
}

/**
 * How much this person has been watching each genre lately: their ten
 * most recent films and shows, newer counting for more, scaled so it can
 * lean a list but not take it over.
 */
export function historyWeights(library: LibraryEntry[]): Map<string, number> {
  const recent = library
    .filter((e) => e.lastPlayed && (e.played || e.started))
    .sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''))
    .slice(0, 10);
  const raw = new Map<string, number>();
  recent.forEach((e, i) => {
    for (const w of new Set(words(e))) {
      raw.set(w, (raw.get(w) ?? 0) + Math.pow(0.85, i));
    }
  });
  const top = Math.max(0, ...raw.values());
  const out = new Map<string, number>();
  for (const [w, v] of raw) out.set(w, top ? (v / top) * 2 : 0);
  return out;
}

export interface Leanings {
  /** genre -> how much this person has been watching it (0-2) */
  history: Map<string, number>;
  /** catalogue ids the catalogue recommends alongside what was named */
  similar: Set<number>;
  /** genres of the title they named */
  likeGenres: string[];
  /** what to say when something is one of the similar ones */
  similarBecause?: string;
}

/** A score, and the reasons worth saying out loud. */
export function score(
  e: LibraryEntry,
  ask: Ask,
  lean: Leanings,
): { score: number; why: string[] } {
  const have = words(e);
  const why: string[] = [];
  let s = e.rating ?? 6;

  if (ask.mood) {
    const { want, avoid } = MOOD_GENRES[ask.mood];
    s += Math.min(4, 2 * want.filter((w) => have.includes(w)).length);
    s -= 3 * avoid.filter((w) => have.includes(w)).length;
  }
  for (const w of (ask.genres ?? []).flatMap(genreWords)) {
    if (have.includes(w)) s += 2;
  }
  if (e.catalogId && lean.similar.has(e.catalogId)) {
    s += 6;
    why.push(lean.similarBecause ?? 'it goes with what you like');
  }
  const shared = lean.likeGenres.filter((w) => have.includes(w));
  s += Math.min(4.5, 1.5 * shared.length);
  let fromHistory = 0;
  let favourite = '';
  for (const w of new Set(have)) {
    const v = lean.history.get(w) ?? 0;
    fromHistory += v;
    if (v >= 2 && !favourite) favourite = w;
  }
  s += Math.min(3, fromHistory);
  if (favourite) why.push(`you've been watching a lot of ${favourite}`);
  if (ask.aroundMinutes && e.runtimeMinutes) {
    s += 1 - Math.abs(e.runtimeMinutes - ask.aroundMinutes) / 20;
  }
  if (e.started) why.push("you've started it");
  return { score: s, why };
}

/** "comedy · 1h 34m · rated 7.8 · PG" */
export function about(e: {
  genres: string[];
  runtimeMinutes?: number;
  rating?: number;
  certificate?: string;
  type?: string;
}): string {
  const parts: string[] = [];
  if (e.genres.length)
    parts.push(e.genres.slice(0, 2).join(' / ').toLowerCase());
  if (e.runtimeMinutes) {
    const h = Math.floor(e.runtimeMinutes / 60);
    const m = e.runtimeMinutes % 60;
    parts.push(
      e.type === 'Series'
        ? `${e.runtimeMinutes}-minute episodes`
        : h
          ? `${h}h ${m}m`
          : `${m} minutes`,
    );
  }
  if (typeof e.rating === 'number') parts.push(`rated ${e.rating.toFixed(1)}`);
  if (e.certificate) parts.push(e.certificate);
  return parts.join(' · ');
}
