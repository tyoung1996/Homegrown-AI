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
import { JellyfinService, PlayableItem } from './jellyfin.service';
import { ScreensService, Screen } from './screens.service';
import {
  AcquisitionRegistry,
  FAMILY_NOTE,
  ProviderHealth,
  ProviderResult,
} from './acquisition';
import { AvailabilityService } from './availability.service';
import {
  CollectionAvailability,
  MovieAvailability,
  SeriesAvailability,
} from './availability';
import { parseEpisodeRef, titleGuesses, titleOf } from './query';
import { StorageHealth, storageHealth } from './storage';
import { titlesMatch } from './filename';

// what the family sees for each stage — no jargon anywhere in here
const STATUS_TEXT: Record<MediaStatus, string> = {
  REQUESTED: 'On the list',
  SEARCHING: 'Looking for it',
  ACQUIRING: 'Adding it to the library',
  IMPORTING: 'Almost ready',
  AVAILABLE: 'Ready to watch',
  UNAVAILABLE: "Couldn't add it",
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
  /** only ever present for an admin */
  adminNote?: string;
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

/** What came back when someone said they wanted to watch something. */
export type WatchLookup =
  // on the shelf: these can be played right now
  | { mode: 'owned'; query: string; items: PlayableItem[] }
  // not on the shelf, but the catalogue knows it — offer to add
  | { mode: 'missing'; query: string; films: MovieAvailability[] }
  // a show, season by season
  | { mode: 'series'; query: string; series: SeriesAvailability }
  // one episode, asked for by name
  | {
      mode: 'episode';
      query: string;
      catalogId: number;
      episode: {
        seriesTitle: string;
        seasonNumber: number;
        episodeNumber: number;
        name: string;
        owned: boolean;
        itemId?: string;
        requested: boolean;
      };
    }
  // nobody has heard of it
  | { mode: 'nothing'; query: string };

@Injectable()
export class MediaService {
  private log = new Logger('Media');

  constructor(
    private prisma: PrismaService,
    private catalog: CatalogService,
    private jellyfin: JellyfinService,
    private sources: AcquisitionRegistry,
    private screens: ScreensService,
    private availability: AvailabilityService,
  ) {}

  /**
   * For the admin panel: every part, separately, so a part that is down can
   * be seen to be down. Each one is asked on its own and a failure is that
   * part's failure — the app answering at all is itself the first line, and
   * nothing here can take the rest of it with them.
   */
  async health(role?: Role) {
    // the family page only needs to know whether search works and what the
    // library is called; drives, providers and diagnostics are for admins
    if (role !== Role.ADMIN) {
      const [catalog, jellyfin] = await Promise.all([
        this.catalog.health().catch(() => ({ configured: true, ok: false })),
        this.jellyfin.health().catch(() => ({ configured: true, ok: false })),
      ]);
      return {
        catalog: { configured: catalog.configured, ok: catalog.ok },
        jellyfin: {
          configured: jellyfin.configured,
          ok: jellyfin.ok,
          ...('name' in jellyfin && jellyfin.name
            ? { name: jellyfin.name }
            : {}),
        },
        ready: jellyfin.ok,
      };
    }
    return this.adminHealth();
  }

  private async adminHealth() {
    const [catalog, jellyfin, providers, screens, waiting, storage] =
      await Promise.all([
        this.catalog.health().catch((e: Error) => ({
          configured: true,
          ok: false,
          detail: e.message,
        })),
        this.jellyfin.health().catch((e: Error) => ({
          configured: true,
          ok: false,
          detail: e.message,
        })),
        this.sources.report().catch((): ProviderHealth[] => []),
        this.screens.list().catch((): Screen[] => []),
        this.prisma.mediaRequest
          .count({ where: { status: { in: OPEN_STATUSES } } })
          .catch(() => 0),
        storageHealth().catch((e: Error): StorageHealth => ({
          ok: false,
          state: 'missing',
          mountPoint: null,
          movies: false,
          shows: false,
          incoming: false,
          incomingWritable: false,
          detail: e.message,
        })),
      ]);
    return {
      app: { ok: true },
      storage,
      catalog,
      jellyfin,
      // the family never sees any of this; the admin panel does
      acquisition: {
        // "working" means at least one provider could take something on
        ok: providers.some((p) => p.ok),
        providers,
        // which provider would take each sort of request, as things stand
        routing: await this.sources
          .routing()
          .catch((): Record<string, string | null> => ({})),
        // and which of those would actually go and fetch it
        automatic: await this.sources
          .automatic()
          .catch((): Record<string, boolean> => ({})),
      },
      screens: screens.map((s) => ({
        name: s.name,
        kind: s.kind,
        ready: s.ready,
      })),
      openRequests: waiting,
      // playing what we own works whether or not anything can fetch files
      ready: jellyfin.ok,
    };
  }

  /** What this server can offer, without touching the network — the chat
   * asks this on every message, so it must not scan or call out. */
  capabilities(): { catalog: boolean; playback: boolean } {
    return {
      catalog: this.catalog.configured(),
      playback: this.jellyfin.configured(),
    };
  }

  // --------------------------------------------------------------- watching

  /** What we own that matches what they said. */
  watchable(query: string): Promise<PlayableItem[]> {
    return this.jellyfin.searchPlayable(query);
  }

  /**
   * Someone said they want to watch something. The shelf is asked first and
   * always: what comes back is either something that can be played now, or
   * an honest "we do not have that" with the catalogue's version of it so it
   * can be offered. Nothing here creates a request — being asked to watch
   * something is not being asked to go and get it.
   */
  async lookFor(query: string): Promise<WatchLookup> {
    const ref = parseEpisodeRef(query);
    const title = ref ? ref.title : titleOf(query);

    // "The Office S03E12" — one episode, and only that episode
    if (ref?.episode != null) {
      const shows = await this.catalog.searchSeries(title, 1).catch(() => []);
      if (shows.length) {
        const e = await this.availability.episode(
          shows[0].catalogId,
          ref.season,
          ref.episode,
        );
        return {
          mode: 'episode',
          query,
          catalogId: shows[0].catalogId,
          episode: e,
        };
      }
    }

    // "The Office season 3" or "The Office" — the shape of the whole show
    if (ref || (await this.looksLikeAShow(title))) {
      const shows = await this.catalog.searchSeries(title, 1).catch(() => []);
      if (shows.length) {
        const series = await this.availability.series(shows[0].catalogId, {
          season: ref?.season,
        });
        return { mode: 'series', query, series };
      }
    }

    // a film: what is on the shelf, and if nothing, what the catalogue has.
    // the shelf is asked about the whole phrase first and then about less
    // and less of it, so a question like "do we have harry potter" finds
    // the films rather than reporting we own nothing
    for (const guess of titleGuesses(query)) {
      const owned = await this.jellyfin.searchPlayable(guess);
      if (owned.length) return { mode: 'owned', query, items: owned };
    }

    const found = await this.catalog.searchMovies(title, 5).catch(() => []);
    if (!found.length) return { mode: 'nothing', query };
    const films = await this.availability.movies(found);
    return { mode: 'missing', query, films };
  }

  /** Is this a show rather than a film? Asked of the shelf first, so a show
   * the house already has is recognised without a catalogue round trip. */
  private async looksLikeAShow(title: string): Promise<boolean> {
    const shelf = await this.jellyfin.items();
    return shelf.some((i) => i.type === 'Series' && titlesMatch(i.name, title));
  }

  /** The other films that belong with one — the rest of the set. */
  collection(catalogId: number): Promise<CollectionAvailability | null> {
    return this.availability.collection(catalogId);
  }

  seriesAvailability(
    catalogId: number,
    opts: { deep?: boolean; season?: number } = {},
  ): Promise<SeriesAvailability> {
    return this.availability.series(catalogId, opts);
  }

  /** Exactly what a show is short of, ready to be offered. */
  missingOf(catalogId: number) {
    return this.availability.missing(catalogId);
  }

  /**
   * Ask for only the parts of a show that are not already here. A season
   * nobody has becomes one request, not twenty; anything already on the list
   * is left alone.
   */
  async requestMissing(
    userId: string,
    catalogId: number,
  ): Promise<RequestOutcome[]> {
    const { seasons, episodes } = await this.availability.missing(catalogId);
    const out: RequestOutcome[] = [];
    const wanted = seasons
      .filter((s) => !s.requested)
      .map((s) => s.seasonNumber);
    if (wanted.length) {
      out.push(...(await this.requestSeries(userId, catalogId, wanted)));
    }
    const gaps = episodes
      .filter((e) => !e.requested)
      .map((e) => ({ season: e.seasonNumber, episode: e.episodeNumber }));
    if (gaps.length) {
      out.push(...(await this.requestEpisodes(userId, catalogId, gaps)));
    }
    return out;
  }

  /** The films in a set that are not here yet. */
  async requestMissingFilms(
    userId: string,
    collectionOfCatalogId: number,
  ): Promise<RequestOutcome[]> {
    const set = await this.availability.collection(collectionOfCatalogId);
    if (!set) return [];
    const wanted = set.films
      .filter((f) => !f.owned && !f.requested)
      .map((f) => f.catalogId);
    return wanted.length ? this.requestMovies(userId, wanted) : [];
  }

  /** The TVs something can go on right now. */
  listScreens(force = false): Promise<Screen[]> {
    return this.screens.list(force);
  }

  /** Put a title on a TV. Both are what the family said — an item id from
   * watchable(), and a screen id or just the room's name. */
  async playOn(itemId: string, screenRef: string): Promise<string> {
    const screen = await this.screens.find(screenRef);
    if (!screen) {
      const names = (await this.screens.list()).map((s) => s.name).join(', ');
      throw new BadRequestException(
        names
          ? `I could not find that TV. Right now I can see: ${names}.`
          : 'I cannot see any TVs on the network right now.',
      );
    }
    const [item] = await this.jellyfin.itemsById([itemId]);
    if (!item) throw new NotFoundException('That is not in the library');
    const line = await this.screens.play(screen, item);
    this.log.log(line);
    return line;
  }

  async stopScreen(screenRef: string): Promise<string> {
    const screen = await this.screens.find(screenRef);
    if (!screen) throw new BadRequestException('I could not find that TV');
    return this.screens.stop(screen);
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

    // hand it to whatever can bring in this sort of thing. which provider
    // that is, and what it is allowed to say, is the registry's business —
    // nothing here knows one provider from another.
    //
    // anything in the catalogue can be asked for, whether or not something
    // can go and fetch it today. a request nobody can fetch stays on the
    // list, because that is what it is: wanted, and not here yet. saying
    // "couldn't add it" would be a lie about the future.
    const updated = await this.settle(
      created,
      await this.sources.claim(kind, created),
    );

    this.log.log(`requested ${label} (${updated.status})`);
    return { result: 'queued', label, request: this.view(updated, userId) };
  }

  private async applySource(
    request: MediaRequest,
    source: string,
    outcome: ProviderResult,
    adminNote?: string,
    retryAfter?: Date | null,
  ) {
    return this.prisma.mediaRequest.update({
      where: { id: request.id },
      data: {
        status: outcome.status,
        statusNote: outcome.note,
        source,
        adminNote: adminNote ?? outcome.detail ?? null,
        ...(retryAfter !== undefined ? { retryAfter } : {}),
        ...(outcome.ref ? { sourceRef: outcome.ref } : {}),
      },
      include: { user: { select: { displayName: true } } },
    });
  }

  /** When an automatic provider that turned something down may be asked
   * about it again. Long enough not to hammer anyone; short enough that
   * something added to a source today is found today. */
  private retryAt(): Date {
    const hours = Number(process.env.ACQUISITION_RETRY_HOURS ?? 6);
    return new Date(Date.now() + (hours > 0 ? hours : 6) * 3_600_000);
  }

  /**
   * Put the outcome of a claim on the request. Whatever declined is written
   * down for the admin; if anything that fetches declined, it is not asked
   * again until the retry window has passed.
   */
  private async settle(
    request: MediaRequest,
    claim: Awaited<ReturnType<AcquisitionRegistry['claim']>>,
  ) {
    const why = claim.declined
      .map((d) => `${d.name} declined: ${d.detail}`)
      .join(' · ');
    const retry = claim.declined.length ? this.retryAt() : null;

    if (!claim.source || !claim.result) return this.shelve(request, why, retry);

    const waiting = claim.source.automatic
      ? ''
      : 'No automatic source for this — waiting for a file.';
    return this.applySource(
      request,
      claim.source.name,
      claim.result,
      [why, waiting, claim.result.detail].filter(Boolean).join(' · ') ||
        undefined,
      retry,
    );
  }

  /** Nothing can take this on today. It stays on the list all the same —
   * the family asked for it, and a provider configured tomorrow will pick
   * it up. The reason is written down where only an admin will read it. */
  private async shelve(
    request: MediaRequest,
    why = '',
    retryAfter: Date | null = null,
  ) {
    return this.prisma.mediaRequest.update({
      where: { id: request.id },
      data: {
        status: MediaStatus.REQUESTED,
        statusNote: FAMILY_NOTE.waiting,
        source: null,
        sourceRef: null,
        retryAfter,
        adminNote:
          (why ? `${why} · ` : '') +
          'No automatic source currently available, and nothing is ' +
          'watching for a file either.',
      },
      include: { user: { select: { displayName: true } } },
    });
  }

  /**
   * Requests that are waiting, offered to something better. Runs every sweep.
   *
   * - nobody took it on: offered to everything, fetchers first
   * - the watched folder took it on: offered to fetchers only. the folder
   *   holds no state of its own, so nothing is lost if one takes it
   * - a fetcher has it: left alone. two providers working on one film is
   *   how you get two copies, and a different fetcher appearing is not a
   *   reason to walk away from one that is working
   * - ready to watch, or anything in progress: not touched at all
   *
   * A fetcher that declines is not asked again until the retry window has
   * passed, so a film nobody has a free copy of costs one search, not one
   * every sweep.
   */
  async reconsiderWaiting(): Promise<number> {
    const now = Date.now();
    const rows = await this.prisma.mediaRequest.findMany({
      where: { status: { in: [MediaStatus.REQUESTED] } },
      take: 50,
    });
    let moved = 0;
    for (const row of rows) {
      if (row.status !== MediaStatus.REQUESTED) continue;
      if (row.retryAfter && row.retryAfter.getTime() > now) continue;
      const current = this.sources.byName(row.source);
      if (current?.automatic) continue;

      if (!row.source) {
        const claim = await this.sources.claim(row.kind, row);
        if (claim.source) moved++;
        await this.settle(row, claim);
        continue;
      }

      const better = await this.sources.claim(row.kind, row, {
        automaticOnly: true,
      });
      if (better.source && better.result) {
        this.log.log(
          `${row.label}: moved from ${row.source} to ${better.source.name}`,
        );
        await this.applySource(
          row,
          better.source.name,
          better.result,
          `moved from ${row.source}` +
            (better.result.detail ? ` · ${better.result.detail}` : ''),
          null,
        );
        moved++;
      } else if (better.declined.length) {
        // still waiting on the folder; note why, and wait before asking again
        await this.prisma.mediaRequest.update({
          where: { id: row.id },
          data: {
            retryAfter: this.retryAt(),
            adminNote:
              better.declined
                .map((d) => `${d.name} declined: ${d.detail}`)
                .join(' · ') +
              ' · No automatic source for this — waiting for a file.',
          },
        });
      }
    }
    return moved;
  }

  /**
   * Ask the providers how the things they took on are getting along. This is
   * for providers that work in the background: rather than smuggling
   * progress out of start(), they are asked, and whatever they say is put
   * through the same rules — including the one about not being allowed to
   * call anything ready to watch.
   *
   * A fetch that fails does not write the request off. It goes back to
   * waiting — on the folder if there is one — with the reason noted for the
   * admin, and the fetcher is asked again after the retry window.
   */
  async pollProviders(): Promise<number> {
    const waiting = await this.prisma.mediaRequest.findMany({
      where: { status: { in: [MediaStatus.SEARCHING, MediaStatus.ACQUIRING] } },
    });
    let moved = 0;
    for (const row of waiting) {
      const source = this.sources.byName(row.source);
      if (!source?.poll) continue;
      const result = await this.sources.pollFor(source, row);
      if (!result || result.status === row.status) continue;

      if (result.status === MediaStatus.UNAVAILABLE) {
        const failed = `${source.name} failed: ${result.detail ?? result.note}`;
        this.log.warn(`${row.label}: ${failed}`);
        // offered to anything else — never straight back to the one that
        // just failed, which would only start the same fetch again. that
        // one gets another go after the retry window, via the sweep
        const fallback = await this.sources.claim(
          row.kind,
          { ...row, source: null, sourceRef: null },
          { exclude: [source.name] },
        );
        await this.prisma.mediaRequest.update({
          where: { id: row.id },
          data: { sourceRef: null },
        });
        if (fallback.source && fallback.result) {
          await this.applySource(
            row,
            fallback.source.name,
            fallback.result,
            [
              failed,
              fallback.source.automatic
                ? ''
                : 'No automatic source for this — waiting for a file.',
            ]
              .filter(Boolean)
              .join(' · '),
            this.retryAt(),
          );
        } else {
          await this.shelve(row, failed, this.retryAt());
        }
        moved++;
        continue;
      }

      await this.applySource(row, source.name, result);
      moved++;
    }
    await this.tidyProviders();
    return moved;
  }

  /**
   * Let each provider clear away what it kept for crash recovery. Asked
   * only after everything above has been written, and with a fresh read of
   * what is still in flight — so a request that has only just moved on is
   * already off the list, and one still going is on it. If that read fails
   * nobody is asked to tidy: an incomplete list would make a live marker
   * look spent.
   */
  private async tidyProviders(): Promise<void> {
    let inFlight: MediaRequest[];
    try {
      inFlight = await this.prisma.mediaRequest.findMany({
        where: {
          status: { in: [MediaStatus.SEARCHING, MediaStatus.ACQUIRING] },
        },
      });
    } catch (e) {
      this.log.warn(`not tidying providers: ${(e as Error).message}`);
      return;
    }
    for (const source of this.sources.sources()) {
      const mine = inFlight.filter(
        (r) => r.source?.toLowerCase() === source.name.toLowerCase(),
      );
      try {
        await source.tidy?.(mine);
      } catch (e) {
        this.log.warn(`${source.name} could not tidy: ${(e as Error).message}`);
      }
    }
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

  async list(
    userId: string,
    includeDone = true,
    role?: Role,
  ): Promise<MediaRequestView[]> {
    const rows = await this.prisma.mediaRequest.findMany({
      where: includeDone
        ? {}
        : { status: { in: [...OPEN_STATUSES, MediaStatus.AVAILABLE] } },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
      include: { user: { select: { displayName: true } } },
    });
    return rows.map((r) => this.view(r, userId, role));
  }

  async get(
    id: string,
    userId: string,
    role?: Role,
  ): Promise<MediaRequestView> {
    const row = await this.prisma.mediaRequest.findUnique({
      where: { id },
      include: { user: { select: { displayName: true } } },
    });
    if (!row) throw new NotFoundException('No such request');
    return this.view(row, userId, role);
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

  /** Move a request along. `note` is what the family sees; `adminNote` is
   * the technical why, which they never do. */
  async setStatus(
    id: string,
    status: MediaStatus,
    note?: string,
    adminNote?: string,
  ) {
    return this.prisma.mediaRequest.update({
      where: { id },
      data: {
        status,
        ...(note ? { statusNote: note } : {}),
        ...(adminNote ? { adminNote } : {}),
      },
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

  /**
   * A file has been filed away where Jellyfin will find it. That is not the
   * same as being able to watch it, so this goes no further than almost —
   * only Jellyfin saying it can see the thing moves it to ready.
   */
  async markImported(id: string, filePath: string) {
    await this.prisma.mediaRequest.update({
      where: { id },
      data: {
        status: MediaStatus.IMPORTING,
        statusNote: FAMILY_NOTE.almost,
        filePath,
      },
    });
  }

  /**
   * Ask Jellyfin whether the things we are waiting on have actually turned
   * up. This is the only thing in the app that marks something ready to
   * watch: a file on disk, or any provider reporting itself finished, is not
   * evidence that it can be played.
   */
  async confirmImported(): Promise<MediaRequestView[]> {
    const waiting = await this.prisma.mediaRequest.findMany({
      where: { status: MediaStatus.IMPORTING },
      include: { user: { select: { displayName: true } } },
    });
    const ready: MediaRequestView[] = [];
    for (const row of waiting) {
      const seen = await this.seenByJellyfin(row);
      if (!seen) continue;
      const updated = await this.prisma.mediaRequest.update({
        where: { id: row.id },
        data: {
          status: MediaStatus.AVAILABLE,
          statusNote: FAMILY_NOTE.ready,
          jellyfinId: seen,
        },
        include: { user: { select: { displayName: true } } },
      });
      this.log.log(`${row.label} is ready to watch`);
      ready.push(this.view(updated, row.userId));
    }
    return ready;
  }

  /** The Jellyfin id of what this request asked for, or null while Jellyfin
   * still cannot see it. */
  private async seenByJellyfin(row: MediaRequest): Promise<string | null> {
    if (row.kind === MediaKind.MOVIE) {
      const found = await this.jellyfin.find(
        'Movie',
        row.catalogId,
        row.title,
        row.year ?? undefined,
      );
      return found?.id ?? null;
    }
    // a show: the episode, the season or the lot, depending on what was asked
    const shelf = await this.jellyfin.ownedEpisodes(row.catalogId, row.title);
    if (!shelf) return null;
    if (row.kind === MediaKind.EPISODE) {
      const hit = shelf.episodes.find(
        (e) =>
          e.seasonNumber === row.seasonNumber &&
          e.episodeNumber === row.episodeNumber,
      );
      return hit?.id ?? null;
    }
    const series = await this.availability.series(row.catalogId, {
      season:
        row.kind === MediaKind.SEASON
          ? (row.seasonNumber ?? undefined)
          : undefined,
    });
    const complete =
      row.kind === MediaKind.SEASON
        ? series.seasons.every((x) => x.state === 'complete')
        : series.state === 'complete';
    return complete ? shelf.itemId : null;
  }

  view(
    row: MediaRequest & { user?: { displayName: string } },
    viewerId: string,
    role?: Role,
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
      // the technical why never leaves the admin panel
      ...(role === Role.ADMIN && row.adminNote
        ? { adminNote: row.adminNote }
        : {}),
      requestedBy: row.user?.displayName ?? 'someone',
      mine: row.userId === viewerId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

export { STATUS_TEXT, OPEN_STATUSES };
