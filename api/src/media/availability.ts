// What the house owns, set against what exists.
//
// Two different questions run through this file and they must never be
// confused: the catalogue says what was ever made, Jellyfin says what can
// actually be played tonight. Only Jellyfin can answer the second one, so
// nothing here calls something ready to watch on the strength of a
// catalogue entry.

export type Availability = 'complete' | 'partial' | 'missing';

export interface MovieAvailability {
  kind: 'movie';
  catalogId: number;
  title: string;
  year?: number;
  posterUrl?: string;
  /** Jellyfin has it and can play it */
  owned: boolean;
  /** the id to play, when it is owned */
  itemId?: string;
  /** someone in the house already asked for it */
  requested: boolean;
}

export interface EpisodeAvailability {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  owned: boolean;
  itemId?: string;
  requested: boolean;
}

export interface SeasonAvailability {
  seasonNumber: number;
  name: string;
  /** how many the catalogue says there are */
  episodeCount: number;
  /** how many of those Jellyfin has */
  ownedCount: number;
  state: Availability;
  requested: boolean;
  /** filled in for seasons worth looking at episode by episode */
  episodes?: EpisodeAvailability[];
}

export interface SeriesAvailability {
  kind: 'series';
  catalogId: number;
  title: string;
  year?: number;
  posterUrl?: string;
  /** the Jellyfin series, when any of it is owned */
  itemId?: string;
  state: Availability;
  seasons: SeasonAvailability[];
  /** episodes the catalogue lists that Jellyfin does not have */
  missingCount: number;
}

/** A film and the others that belong with it — "Harry Potter" is eight
 * films, and the interesting part is usually the one that is missing. */
export interface CollectionAvailability {
  kind: 'collection';
  collectionId: number;
  title: string;
  posterUrl?: string;
  films: MovieAvailability[];
  missingCount: number;
}

export const key = (season: number, episode: number) => `s${season}e${episode}`;

/** complete / partial / missing from two counts, said once so every caller
 * agrees. A season the catalogue knows nothing about counts as missing. */
export function stateOf(owned: number, total: number): Availability {
  if (total <= 0) return owned > 0 ? 'complete' : 'missing';
  if (owned <= 0) return 'missing';
  return owned >= total ? 'complete' : 'partial';
}

/** Roll a series' seasons up into one answer for the whole show. */
export function seriesState(seasons: SeasonAvailability[]): Availability {
  if (!seasons.length) return 'missing';
  if (seasons.every((s) => s.state === 'complete')) return 'complete';
  if (seasons.every((s) => s.state === 'missing')) return 'missing';
  return 'partial';
}
