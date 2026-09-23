import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

// the film and tv catalogue the app looks titles up in (themoviedb.org).
// it is only ever called from the server — the key never reaches a browser.
const TMDB = 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p/w342';

export interface CatalogItem {
  catalogId: number;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
  kind: 'movie' | 'series';
}

export interface CatalogSeason {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  year?: number;
  posterUrl?: string;
}

export interface CatalogCollection {
  collectionId: number;
  title: string;
  posterUrl?: string;
  films: CatalogItem[];
}

export interface CatalogEpisode {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview?: string;
  airDate?: string;
}

// only the fields this app reads, so the responses are typed end to end
interface TmdbMovie {
  id: number;
  title?: string;
  original_title?: string;
  release_date?: string;
  overview?: string;
  poster_path?: string | null;
  belongs_to_collection?: { id: number; name?: string } | null;
}

interface TmdbSeries {
  id: number;
  name?: string;
  original_name?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string | null;
  seasons?: TmdbSeason[];
}

interface TmdbSeason {
  season_number: number;
  name?: string;
  episode_count?: number;
  air_date?: string;
  poster_path?: string | null;
}

interface TmdbEpisode {
  episode_number: number;
  name?: string;
  overview?: string;
  air_date?: string;
}

const yearOf = (date?: string) => {
  const y = Number((date ?? '').slice(0, 4));
  return Number.isFinite(y) && y > 1870 ? y : undefined;
};

@Injectable()
export class CatalogService {
  private log = new Logger('Catalog');
  private key = process.env.TMDB_API_KEY ?? '';

  configured(): boolean {
    return this.key.trim().length > 0;
  }

  private async get<T>(path: string, params: Record<string, string> = {}) {
    if (!this.configured()) {
      throw new ServiceUnavailableException(
        'Film and TV lookup is not set up on this server yet.',
      );
    }
    const url = new URL(TMDB + path);
    url.searchParams.set('api_key', this.key);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      this.log.warn(`${path} -> ${res.status}`);
      throw new ServiceUnavailableException(
        res.status === 401
          ? 'The film catalogue rejected this server’s key.'
          : 'The film catalogue is not answering right now.',
      );
    }
    return (await res.json()) as T;
  }

  async health() {
    if (!this.configured()) {
      return { configured: false, ok: false, detail: 'No catalogue key set' };
    }
    try {
      await this.get('/configuration');
      return { configured: true, ok: true };
    } catch (e) {
      return { configured: true, ok: false, detail: (e as Error).message };
    }
  }

  async searchMovies(query: string, limit = 12): Promise<CatalogItem[]> {
    const data = await this.get<{ results?: TmdbMovie[] }>('/search/movie', {
      query,
      include_adult: 'false',
    });
    return (data.results ?? [])
      .map((r) => ({
        catalogId: Number(r.id),
        title: String(r.title ?? r.original_title ?? 'Untitled'),
        year: yearOf(r.release_date),
        overview: r.overview ? String(r.overview) : undefined,
        posterUrl: r.poster_path ? IMAGES + String(r.poster_path) : undefined,
        kind: 'movie' as const,
      }))
      .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999))
      .slice(0, limit);
  }

  async searchSeries(query: string, limit = 8): Promise<CatalogItem[]> {
    const data = await this.get<{ results?: TmdbSeries[] }>('/search/tv', {
      query,
      include_adult: 'false',
    });
    return (data.results ?? [])
      .map((r) => ({
        catalogId: Number(r.id),
        title: String(r.name ?? r.original_name ?? 'Untitled'),
        year: yearOf(r.first_air_date),
        overview: r.overview ? String(r.overview) : undefined,
        posterUrl: r.poster_path ? IMAGES + String(r.poster_path) : undefined,
        kind: 'series' as const,
      }))
      .slice(0, limit);
  }

  async movie(catalogId: number): Promise<CatalogItem> {
    const r = await this.get<TmdbMovie>(`/movie/${catalogId}`);
    return {
      catalogId: Number(r.id),
      title: String(r.title ?? 'Untitled'),
      year: yearOf(r.release_date),
      overview: r.overview ? String(r.overview) : undefined,
      posterUrl: r.poster_path ? IMAGES + String(r.poster_path) : undefined,
      kind: 'movie',
    };
  }

  async series(catalogId: number): Promise<CatalogItem> {
    const r = await this.get<TmdbSeries>(`/tv/${catalogId}`);
    return {
      catalogId: Number(r.id),
      title: String(r.name ?? 'Untitled'),
      year: yearOf(r.first_air_date),
      overview: r.overview ? String(r.overview) : undefined,
      posterUrl: r.poster_path ? IMAGES + String(r.poster_path) : undefined,
      kind: 'series',
    };
  }

  /** The set a film belongs to, if it belongs to one: ask for one Harry
   * Potter and the answer is really about eight films. Null for a film that
   * stands alone, which is most of them. */
  async collectionOf(catalogId: number): Promise<CatalogCollection | null> {
    const film = await this.get<TmdbMovie>(`/movie/${catalogId}`);
    const belongs = film.belongs_to_collection;
    if (!belongs?.id) return null;
    return this.collection(Number(belongs.id));
  }

  async collection(collectionId: number): Promise<CatalogCollection> {
    const r = await this.get<{
      id: number;
      name?: string;
      poster_path?: string | null;
      parts?: TmdbMovie[];
    }>(`/collection/${collectionId}`);
    return {
      collectionId: Number(r.id),
      title: String(r.name ?? 'Collection'),
      posterUrl: r.poster_path ? IMAGES + String(r.poster_path) : undefined,
      films: (r.parts ?? [])
        // an announced film with no release date yet is not something anyone
        // can be missing
        .filter((p) => yearOf(p.release_date))
        .map((p) => ({
          catalogId: Number(p.id),
          title: String(p.title ?? p.original_title ?? 'Untitled'),
          year: yearOf(p.release_date),
          overview: p.overview ? String(p.overview) : undefined,
          posterUrl: p.poster_path ? IMAGES + String(p.poster_path) : undefined,
          kind: 'movie' as const,
        }))
        .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999)),
    };
  }

  // specials (season 0) are hidden — nobody asks for them by name
  async seasons(catalogId: number): Promise<CatalogSeason[]> {
    const r = await this.get<{ seasons?: TmdbSeason[] }>(`/tv/${catalogId}`);
    return (r.seasons ?? [])
      .filter((s) => Number(s.season_number) > 0)
      .map((s) => ({
        seasonNumber: Number(s.season_number),
        name: String(s.name ?? `Season ${s.season_number}`),
        episodeCount: Number(s.episode_count ?? 0),
        year: yearOf(s.air_date),
        posterUrl: s.poster_path ? IMAGES + String(s.poster_path) : undefined,
      }));
  }

  async episodes(
    catalogId: number,
    seasonNumber: number,
  ): Promise<CatalogEpisode[]> {
    const r = await this.get<{ episodes?: TmdbEpisode[] }>(
      `/tv/${catalogId}/season/${seasonNumber}`,
    );
    return (r.episodes ?? []).map((e) => ({
      seasonNumber,
      episodeNumber: Number(e.episode_number),
      name: String(e.name ?? `Episode ${e.episode_number}`),
      overview: e.overview ? String(e.overview) : undefined,
      airDate: e.air_date ? String(e.air_date) : undefined,
    }));
  }
}
