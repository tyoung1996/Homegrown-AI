import { Injectable } from '@nestjs/common';
import { MediaKind, MediaStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CatalogEpisode, CatalogService } from './catalog.service';
import { JellyfinService } from './jellyfin.service';
import {
  Availability,
  CollectionAvailability,
  EpisodeAvailability,
  MovieAvailability,
  SeasonAvailability,
  SeriesAvailability,
  key,
  seriesState,
  stateOf,
} from './availability';

// a request that has not finished yet still counts as asked for
const OPEN: MediaStatus[] = [
  MediaStatus.REQUESTED,
  MediaStatus.SEARCHING,
  MediaStatus.ACQUIRING,
  MediaStatus.IMPORTING,
];

/**
 * The bridge between "what exists" and "what we can play tonight".
 *
 * The catalogue is asked what was made; Jellyfin is asked what is on the
 * shelf. Nothing here ever reads a catalogue entry as proof that something
 * can be played — that answer only ever comes from Jellyfin.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private prisma: PrismaService,
    private catalog: CatalogService,
    private jellyfin: JellyfinService,
  ) {}

  // ------------------------------------------------------------- films

  async movie(catalogId: number): Promise<MovieAvailability> {
    const film = await this.catalog.movie(catalogId);
    const [owned, requested] = await Promise.all([
      this.jellyfin.find('Movie', catalogId, film.title, film.year),
      this.openRequests([catalogId]),
    ]);
    return {
      kind: 'movie',
      catalogId,
      title: film.title,
      year: film.year,
      posterUrl: film.posterUrl,
      owned: !!owned,
      itemId: owned?.id,
      requested: requested.has(catalogId),
    };
  }

  /** The same answer for a list of films, with one pass over the shelf and
   * one over the request list rather than one of each per film. */
  async movies(
    films: {
      catalogId: number;
      title: string;
      year?: number;
      posterUrl?: string;
    }[],
  ): Promise<MovieAvailability[]> {
    const requested = await this.openRequests(films.map((f) => f.catalogId));
    return Promise.all(
      films.map(async (f) => {
        const owned = await this.jellyfin.find(
          'Movie',
          f.catalogId,
          f.title,
          f.year,
        );
        return {
          kind: 'movie' as const,
          catalogId: f.catalogId,
          title: f.title,
          year: f.year,
          posterUrl: f.posterUrl,
          owned: !!owned,
          itemId: owned?.id,
          requested: requested.has(f.catalogId),
        };
      }),
    );
  }

  /** The set a film belongs to, each part marked owned or not. Null when the
   * film stands alone. */
  async collection(
    movieCatalogId: number,
  ): Promise<CollectionAvailability | null> {
    const set = await this.catalog.collectionOf(movieCatalogId);
    if (!set || set.films.length < 2) return null;
    const films = await this.movies(set.films);
    return {
      kind: 'collection',
      collectionId: set.collectionId,
      title: set.title,
      posterUrl: set.posterUrl,
      films,
      missingCount: films.filter((f) => !f.owned).length,
    };
  }

  // ------------------------------------------------------------- shows

  /**
   * A show, season by season. Episode detail is only fetched for the seasons
   * that need it — a season nobody has is missing whatever the catalogue says
   * is in it, and a complete season is missing nothing, so neither needs a
   * call. `deep` forces the detail everywhere, for "what exactly is missing".
   */
  async series(
    catalogId: number,
    opts: { deep?: boolean; season?: number } = {},
  ): Promise<SeriesAvailability> {
    const [show, catalogSeasons] = await Promise.all([
      this.catalog.series(catalogId),
      this.catalog.seasons(catalogId),
    ]);
    const shelf = await this.jellyfin.ownedEpisodes(catalogId, show.title);
    const owned = new Map<string, string>();
    for (const e of shelf?.episodes ?? []) {
      if (e.seasonNumber == null || e.episodeNumber == null) continue;
      // specials live in season 0 and are nobody's idea of a missing episode
      if (e.seasonNumber === 0) continue;
      owned.set(key(e.seasonNumber, e.episodeNumber), e.id);
    }
    const requested = await this.openSeriesRequests(catalogId);

    const seasons: SeasonAvailability[] = [];
    for (const s of catalogSeasons) {
      if (opts.season != null && s.seasonNumber !== opts.season) continue;
      const ownedCount = [...owned.keys()].filter((k) =>
        k.startsWith(`s${s.seasonNumber}e`),
      ).length;
      const state = stateOf(ownedCount, s.episodeCount);
      const season: SeasonAvailability = {
        seasonNumber: s.seasonNumber,
        name: s.name,
        episodeCount: s.episodeCount,
        ownedCount,
        state,
        requested: requested.seasons.has(s.seasonNumber) || requested.whole,
      };
      // a part-owned season is the only one whose episodes we cannot infer
      if (opts.deep || opts.season != null || state === 'partial') {
        season.episodes = await this.episodesOf(
          catalogId,
          s.seasonNumber,
          owned,
          requested,
        );
      }
      seasons.push(season);
    }

    return {
      kind: 'series',
      catalogId,
      title: show.title,
      year: show.year,
      posterUrl: show.posterUrl,
      itemId: shelf?.itemId,
      state: seriesState(seasons),
      seasons,
      missingCount: seasons.reduce(
        (n, s) => n + Math.max(0, s.episodeCount - s.ownedCount),
        0,
      ),
    };
  }

  /** One episode: the answer to "play The Office S03E12". */
  async episode(
    catalogId: number,
    seasonNumber: number,
    episodeNumber: number,
  ): Promise<EpisodeAvailability & { seriesTitle: string }> {
    const show = await this.catalog.series(catalogId);
    const shelf = await this.jellyfin.ownedEpisodes(catalogId, show.title);
    const match = (shelf?.episodes ?? []).find(
      (e) =>
        e.seasonNumber === seasonNumber && e.episodeNumber === episodeNumber,
    );
    const requested = await this.openSeriesRequests(catalogId);
    const named = await this.catalog
      .episodes(catalogId, seasonNumber)
      .catch((): CatalogEpisode[] => []);
    const fromCatalog = named.find((e) => e.episodeNumber === episodeNumber);
    return {
      seriesTitle: show.title,
      seasonNumber,
      episodeNumber,
      name: fromCatalog?.name ?? match?.name ?? `Episode ${episodeNumber}`,
      owned: !!match,
      itemId: match?.id,
      requested:
        requested.whole ||
        requested.seasons.has(seasonNumber) ||
        requested.episodes.has(key(seasonNumber, episodeNumber)),
    };
  }

  /** Exactly what is missing from a show, ready to be turned into requests.
   * A season nobody has comes back as a season, not as twenty-odd episodes. */
  async missing(catalogId: number): Promise<{
    series: SeriesAvailability;
    seasons: SeasonAvailability[];
    episodes: EpisodeAvailability[];
  }> {
    const series = await this.series(catalogId);
    const seasons = series.seasons.filter((s) => s.state === 'missing');
    const episodes: EpisodeAvailability[] = [];
    for (const s of series.seasons) {
      if (s.state !== 'partial') continue;
      for (const e of s.episodes ?? []) if (!e.owned) episodes.push(e);
    }
    return { series, seasons, episodes };
  }

  // ------------------------------------------------------------- inside

  private async episodesOf(
    catalogId: number,
    seasonNumber: number,
    owned: Map<string, string>,
    requested: { whole: boolean; seasons: Set<number>; episodes: Set<string> },
  ): Promise<EpisodeAvailability[]> {
    const listed = await this.catalog
      .episodes(catalogId, seasonNumber)
      .catch((): CatalogEpisode[] => []);
    return listed.map((e) => {
      const k = key(seasonNumber, e.episodeNumber);
      return {
        seasonNumber,
        episodeNumber: e.episodeNumber,
        name: e.name,
        owned: owned.has(k),
        itemId: owned.get(k),
        requested:
          requested.whole ||
          requested.seasons.has(seasonNumber) ||
          requested.episodes.has(k),
      };
    });
  }

  /** Which of these films someone has already asked for. */
  private async openRequests(catalogIds: number[]): Promise<Set<number>> {
    if (!catalogIds.length) return new Set();
    const rows = await this.prisma.mediaRequest.findMany({
      where: { catalogId: { in: catalogIds }, status: { in: OPEN } },
      select: { catalogId: true },
    });
    return new Set(rows.map((r) => r.catalogId));
  }

  /** What has already been asked for of one show, at each level. */
  private async openSeriesRequests(catalogId: number) {
    const rows = await this.prisma.mediaRequest.findMany({
      where: { catalogId, status: { in: OPEN } },
      select: { kind: true, seasonNumber: true, episodeNumber: true },
    });
    const seasons = new Set<number>();
    const episodes = new Set<string>();
    let whole = false;
    for (const r of rows) {
      if (r.kind === MediaKind.SERIES) whole = true;
      else if (r.kind === MediaKind.SEASON && r.seasonNumber != null) {
        seasons.add(r.seasonNumber);
      } else if (
        r.kind === MediaKind.EPISODE &&
        r.seasonNumber != null &&
        r.episodeNumber != null
      ) {
        episodes.add(key(r.seasonNumber, r.episodeNumber));
      }
    }
    return { whole, seasons, episodes };
  }
}

export type { Availability };
