import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MediaKind, MediaRequest, MediaStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CatalogService, CatalogItem } from './catalog.service';
import { JellyfinService } from './jellyfin.service';
import { AcquisitionRegistry } from './acquisition';
import { titlesMatch } from './filename';

// what the family sees for each stage — no jargon anywhere in here
const STATUS_TEXT: Record<MediaStatus, string> = {
  REQUESTED: 'On the list',
  SEARCHING: 'Looking for it',
  ACQUIRING: 'Getting it',
  IMPORTING: 'Adding to the library',
  AVAILABLE: 'Ready to watch',
  UNAVAILABLE: "Couldn't get it",
  CANCELLED: 'Cancelled',
};

const OPEN_STATUSES: MediaStatus[] = [
  MediaStatus.REQUESTED,
  MediaStatus.SEARCHING,
  MediaStatus.ACQUIRING,
  MediaStatus.IMPORTING,
];

export interface MediaRequestView {
  id: string;
  kind: MediaKind;
  catalogId: number;
  title: string;
  label: string;
  year: number | null;
  posterUrl: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  status: MediaStatus;
  statusText: string;
  statusNote: string | null;
  requestedBy: string;
  mine: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CatalogItemView extends CatalogItem {
  inLibrary: boolean;
  requested: boolean;
}

export type RequestOutcome =
  | { result: 'queued'; label: string; request: MediaRequestView }
  | { result: 'already-available'; label: string }
  | { result: 'already-requested'; label: string; request: MediaRequestView };

@Injectable()
export class MediaService {
  private log = new Logger('Media');

  constructor(
    private prisma: PrismaService,
    private catalog: CatalogService,
    private jellyfin: JellyfinService,
    private sources: AcquisitionRegistry,
  ) {}

  async health() {
    const [catalog, jellyfin, source] = await Promise.all([
      this.catalog.health(),
      this.jellyfin.health(),
      this.sources.pick(),
    ]);
    return {
      catalog,
      jellyfin,
      source: source ? { name: source.name, label: source.label } : null,
      ready: catalog.ok,
    };
  }

  // ---------------------------------------------------------------- looking

  async searchMovies(query: string): Promise<CatalogItemView[]> {
    const found = await this.catalog.searchMovies(query);
    return this.annotate(found, 'Movie');
  }

  async searchSeries(query: string): Promise<CatalogItemView[]> {
    const found = await this.catalog.searchSeries(query);
    return this.annotate(found, 'Series');
  }

  // "requested" means someone in the house already asked for it — the list is
  // shared, so it does not matter who
  private async annotate(
    items: CatalogItem[],
    type: 'Movie' | 'Series',
  ): Promise<CatalogItemView[]> {
    const open = await this.prisma.mediaRequest.findMany({
      where: {
        catalogId: { in: items.map((i) => i.catalogId) },
        status: { in: OPEN_STATUSES },
      },
      select: { catalogId: true },
    });
    const requested = new Set(open.map((r) => r.catalogId));
    return Promise.all(
      items.map(async (i) => ({
        ...i,
        inLibrary: !!(await this.jellyfin.find(
          type,
          i.catalogId,
          i.title,
          i.year,
        )),
        requested: requested.has(i.catalogId),
      })),
    );
  }

  async seasons(catalogId: number) {
    const [series, seasons] = await Promise.all([
      this.catalog.series(catalogId),
      this.catalog.seasons(catalogId),
    ]);
    const shelf = await this.jellyfin.find(
      'Series',
      catalogId,
      series.title,
      series.year,
    );
    const have = shelf ? await this.jellyfin.episodes(shelf.id) : [];
    return {
      series,
      seasons: seasons.map((s) => {
        const mine = have.filter((e) => e.seasonNumber === s.seasonNumber);
        return {
          ...s,
          inLibrary: s.episodeCount > 0 && mine.length >= s.episodeCount,
          haveCount: mine.length,
        };
      }),
    };
  }

  async episodes(catalogId: number, seasonNumber: number) {
    const [series, episodes] = await Promise.all([
      this.catalog.series(catalogId),
      this.catalog.episodes(catalogId, seasonNumber),
    ]);
    const shelf = await this.jellyfin.find(
      'Series',
      catalogId,
      series.title,
      series.year,
    );
    const have = shelf ? await this.jellyfin.episodes(shelf.id) : [];
    const key = (s?: number, e?: number) => `${s ?? -1}x${e ?? -1}`;
    const owned = new Set(
      have.map((e) => key(e.seasonNumber, e.episodeNumber)),
    );
    return {
      series,
      episodes: episodes.map((e) => ({
        ...e,
        inLibrary: owned.has(key(e.seasonNumber, e.episodeNumber)),
      })),
    };
  }

  // --------------------------------------------------------------- asking

  async requestMovies(
    userId: string,
    catalogIds: number[],
  ): Promise<RequestOutcome[]> {
    const out: RequestOutcome[] = [];
    for (const id of catalogIds.slice(0, 25)) {
      const movie = await this.catalog.movie(id);
      const label = movie.year ? `${movie.title} (${movie.year})` : movie.title;
      out.push(
        await this.create(userId, {
          kind: MediaKind.MOVIE,
          item: movie,
          label,
          libraryType: 'Movie',
        }),
      );
    }
    return out;
  }

  /** Whole series when `seasons` is empty, otherwise one request per season. */
  async requestSeries(
    userId: string,
    catalogId: number,
    seasons: number[] = [],
  ): Promise<RequestOutcome[]> {
    const series = await this.catalog.series(catalogId);
    if (!seasons.length) {
      return [
        await this.create(userId, {
          kind: MediaKind.SERIES,
          item: series,
          label: `${series.title} — whole series`,
          libraryType: 'Series',
        }),
      ];
    }
    const out: RequestOutcome[] = [];
    for (const n of [...new Set(seasons)].sort((a, b) => a - b).slice(0, 40)) {
      out.push(
        await this.create(userId, {
          kind: MediaKind.SEASON,
          item: series,
          label: `${series.title} — Season ${n}`,
          seasonNumber: n,
          libraryType: 'Series',
        }),
      );
    }
    return out;
  }

  async requestEpisodes(
    userId: string,
    catalogId: number,
    episodes: { season: number; episode: number }[],
  ): Promise<RequestOutcome[]> {
    const series = await this.catalog.series(catalogId);
    const out: RequestOutcome[] = [];
    for (const { season, episode } of episodes.slice(0, 60)) {
      out.push(
        await this.create(userId, {
          kind: MediaKind.EPISODE,
          item: series,
          label: `${series.title} — S${season}E${episode}`,
          seasonNumber: season,
          episodeNumber: episode,
          libraryType: 'Series',
        }),
      );
    }
    return out;
  }

  private async create(
    userId: string,
    spec: {
      kind: MediaKind;
      item: CatalogItem;
      label: string;
      seasonNumber?: number;
      episodeNumber?: number;
      libraryType: 'Movie' | 'Series';
    },
  ): Promise<RequestOutcome> {
    const { kind, item, label, seasonNumber, episodeNumber } = spec;

    // already on the shelf? then there is nothing to ask for
    if (await this.onShelf(spec)) {
      return { result: 'already-available', label };
    }

    // already on the list? hand back the one that exists
    const existing = await this.prisma.mediaRequest.findFirst({
      where: {
        kind,
        catalogId: item.catalogId,
        seasonNumber: seasonNumber ?? null,
        episodeNumber: episodeNumber ?? null,
        status: { in: OPEN_STATUSES },
      },
      include: { user: { select: { displayName: true } } },
    });
    if (existing) {
      return {
        result: 'already-requested',
        label,
        request: this.view(existing, userId),
      };
    }

    const created = await this.prisma.mediaRequest.create({
      data: {
        userId,
        kind,
        catalogId: item.catalogId,
        title: item.title,
        label,
        year: item.year ?? null,
        posterUrl: item.posterUrl ?? null,
        overview: item.overview ?? null,
        seasonNumber: seasonNumber ?? null,
        episodeNumber: episodeNumber ?? null,
        status: MediaStatus.REQUESTED,
      },
      include: { user: { select: { displayName: true } } },
    });

    // hand it to whatever can actually bring it in
    const source = await this.sources.pick();
    const updated = source
      ? await this.applySource(
          created,
          source.name,
          await source.start(created),
        )
      : await this.setStatus(
          created.id,
          MediaStatus.UNAVAILABLE,
          'No way to add files is set up on this server yet.',
        );

    this.log.log(`requested ${label} (${updated.status})`);
    return { result: 'queued', label, request: this.view(updated, userId) };
  }

  private async applySource(
    request: MediaRequest,
    source: string,
    outcome: { status: MediaStatus; note: string },
  ) {
    return this.prisma.mediaRequest.update({
      where: { id: request.id },
      data: { status: outcome.status, statusNote: outcome.note, source },
      include: { user: { select: { displayName: true } } },
    });
  }

  private async onShelf(spec: {
    kind: MediaKind;
    item: CatalogItem;
    seasonNumber?: number;
    episodeNumber?: number;
    libraryType: 'Movie' | 'Series';
  }): Promise<boolean> {
    const shelf = await this.jellyfin.find(
      spec.libraryType,
      spec.item.catalogId,
      spec.item.title,
      spec.item.year,
    );
    if (!shelf) return false;
    if (spec.kind === MediaKind.MOVIE || spec.kind === MediaKind.SERIES) {
      return true;
    }
    const have = await this.jellyfin.episodes(shelf.id);
    if (spec.kind === MediaKind.SEASON) {
      const count = have.filter(
        (e) => e.seasonNumber === spec.seasonNumber,
      ).length;
      const wanted = (await this.catalog.seasons(spec.item.catalogId)).find(
        (s) => s.seasonNumber === spec.seasonNumber,
      );
      return (
        !!wanted && wanted.episodeCount > 0 && count >= wanted.episodeCount
      );
    }
    return have.some(
      (e) =>
        e.seasonNumber === spec.seasonNumber &&
        e.episodeNumber === spec.episodeNumber,
    );
  }

  // --------------------------------------------------------------- the list

  async list(userId: string, includeDone = true): Promise<MediaRequestView[]> {
    const rows = await this.prisma.mediaRequest.findMany({
      where: includeDone
        ? {}
        : { status: { in: [...OPEN_STATUSES, MediaStatus.AVAILABLE] } },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
      include: { user: { select: { displayName: true } } },
    });
    return rows.map((r) => this.view(r, userId));
  }

  async get(id: string, userId: string): Promise<MediaRequestView> {
    const row = await this.prisma.mediaRequest.findUnique({
      where: { id },
      include: { user: { select: { displayName: true } } },
    });
    if (!row) throw new NotFoundException('No such request');
    return this.view(row, userId);
  }

  async cancel(id: string, userId: string, role: Role) {
    const row = await this.prisma.mediaRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('No such request');
    if (row.userId !== userId && role !== Role.ADMIN) {
      throw new ForbiddenException('That is not your request');
    }
    if (row.status === MediaStatus.AVAILABLE) {
      throw new BadRequestException('That one is already in the library');
    }
    await this.prisma.mediaRequest.update({
      where: { id },
      data: { status: MediaStatus.CANCELLED, statusNote: 'Cancelled' },
    });
    return { ok: true };
  }

  async setStatus(id: string, status: MediaStatus, note?: string) {
    return this.prisma.mediaRequest.update({
      where: { id },
      data: { status, ...(note ? { statusNote: note } : {}) },
      include: { user: { select: { displayName: true } } },
    });
  }

  /** Called by the importer when a file lands: find the request it satisfies
   * (same title, and same season/episode when it is an episode). */
  async matchFile(parsed: {
    kind: 'movie' | 'episode';
    title: string;
    year?: number;
    season?: number;
    episode?: number;
  }): Promise<MediaRequest | null> {
    const open = await this.prisma.mediaRequest.findMany({
      where: { status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'asc' },
    });
    return (
      open.find((r) => {
        if (!titlesMatch(r.title, parsed.title)) return false;
        if (parsed.kind === 'movie') {
          return (
            r.kind === MediaKind.MOVIE &&
            (!parsed.year || !r.year || r.year === parsed.year)
          );
        }
        if (r.kind === MediaKind.SERIES) return true;
        if (r.kind === MediaKind.SEASON)
          return r.seasonNumber === parsed.season;
        return (
          r.kind === MediaKind.EPISODE &&
          r.seasonNumber === parsed.season &&
          r.episodeNumber === parsed.episode
        );
      }) ?? null
    );
  }

  async markImported(id: string, filePath: string) {
    await this.prisma.mediaRequest.update({
      where: { id },
      data: {
        status: MediaStatus.AVAILABLE,
        statusNote: 'In the library — ready to watch',
        filePath,
      },
    });
  }

  view(
    row: MediaRequest & { user?: { displayName: string } },
    viewerId: string,
  ): MediaRequestView {
    return {
      id: row.id,
      kind: row.kind,
      catalogId: row.catalogId,
      title: row.title,
      label: row.label,
      year: row.year,
      posterUrl: row.posterUrl,
      seasonNumber: row.seasonNumber,
      episodeNumber: row.episodeNumber,
      status: row.status,
      statusText: STATUS_TEXT[row.status],
      statusNote: row.statusNote,
      requestedBy: row.user?.displayName ?? 'someone',
      mine: row.userId === viewerId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export { STATUS_TEXT, OPEN_STATUSES };
