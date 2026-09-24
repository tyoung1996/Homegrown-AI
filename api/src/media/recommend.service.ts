import { Injectable, Logger } from '@nestjs/common';
import { MediaStatus } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CatalogPick, CatalogService } from './catalog.service';
import { JellyfinService, LibraryEntry } from './jellyfin.service';
import { WatchStateService } from './watch-state.service';
import { titlesMatch } from './filename';
import {
  Ask,
  MOODS,
  Mood,
  about,
  fits,
  genreWords,
  historyWeights,
  knownGenre,
  moodGenres,
  score,
} from './recommend-rules';

export interface RecommendAsk extends Ask {
  /** "what should I watch next, based on what I've been watching" */
  basedOnHistory?: boolean;
  /** they asked for something new, not only what the house already has */
  wantNew?: boolean;
}

/** Something on the shelf, ready to put on. */
export interface OnShelf {
  itemId: string;
  title: string;
  year?: number;
  kind: 'film' | 'show';
  about: string;
  why?: string;
  partWatched?: boolean;
}

/** Something that is not in the library. Suggested only — never added. */
export interface NotOnShelf {
  catalogId: number;
  title: string;
  year?: number;
  kind: 'film' | 'show';
  about: string;
  why?: string;
  /** already on the family list, waiting */
  alreadyRequested: boolean;
}

export interface Recommendations {
  /** false when this person has no linked account: nothing personal used */
  linked: boolean;
  /** true only when their own viewing actually shaped the list */
  historyUsed: boolean;
  availableNow: OnShelf[];
  notInLibrary: NotOnShelf[];
}

const OPEN: MediaStatus[] = [
  MediaStatus.REQUESTED,
  MediaStatus.SEARCHING,
  MediaStatus.ACQUIRING,
  MediaStatus.IMPORTING,
];

/**
 * Something to watch, for one person. What the house already has comes
 * first; things it does not have are only suggested, clearly marked, and
 * never requested from here. The only viewing ever consulted is the signed-
 * in person's own, through their own linked Jellyfin account.
 */
@Injectable()
export class RecommendService {
  private log = new Logger('Recommend');

  constructor(
    private jellyfin: JellyfinService,
    private catalog: CatalogService,
    private watchState: WatchStateService,
    private prisma: PrismaService,
  ) {}

  async recommend(userId: string, ask: RecommendAsk): Promise<Recommendations> {
    // what was asked, never who asked or what they have watched
    this.log.log(`asked for ${JSON.stringify(ask)}`);
    const person = await this.watchState.personFor(userId);
    const library = await this.jellyfin.libraryFor(person);
    const history = person
      ? historyWeights(library)
      : new Map<string, number>();

    // "something like X": what the catalogue pairs with it, and its genres
    const similar = new Set<number>();
    const alongside: CatalogPick[] = [];
    let likeGenres: string[] = [];
    let likeId: string | undefined;
    if (ask.like) {
      const own = library.find((e) => titlesMatch(e.name, ask.like!));
      const kind: 'movie' | 'series' =
        own?.type === 'Series' || ask.kind === 'show' ? 'series' : 'movie';
      let catalogId = own?.catalogId;
      if (own) {
        likeId = own.id;
        likeGenres = own.genres.flatMap(genreWords);
      }
      if (!catalogId) {
        const found = await this.quietly(() =>
          kind === 'series'
            ? this.catalog.searchSeries(ask.like!, 1)
            : this.catalog.searchMovies(ask.like!, 1),
        );
        catalogId = found?.[0]?.catalogId;
        if (catalogId && !likeGenres.length) {
          likeGenres = (
            (await this.quietly(() =>
              this.catalog.genresOf(kind, catalogId!),
            )) ?? []
          ).flatMap(genreWords);
        }
      }
      if (catalogId) {
        const recs =
          (await this.quietly(() =>
            this.catalog.recommendedWith(kind, catalogId),
          )) ?? [];
        recs.forEach((r) => similar.add(r.catalogId));
        alongside.push(...recs);
      }
    }

    // "based on what I've been watching": what goes with their last few
    if (ask.basedOnHistory && person) {
      const recent = library
        .filter((e) => e.lastPlayed && e.catalogId)
        .sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''))
        .slice(0, 3);
      for (const e of recent) {
        const recs =
          (await this.quietly(() =>
            this.catalog.recommendedWith(
              e.type === 'Series' ? 'series' : 'movie',
              e.catalogId!,
            ),
          )) ?? [];
        recs.forEach((r) => similar.add(r.catalogId));
        alongside.push(...recs);
      }
    }

    const lean = {
      history,
      similar,
      likeGenres,
      similarBecause: ask.like
        ? `recommended for people who liked ${ask.like}`
        : "it goes with what you've been watching",
    };
    const ranked = library
      .filter((e) => e.id !== likeId && fits(e, ask, !!person))
      .map((e) => ({ e, ...score(e, ask, lean) }))
      .sort((a, b) => b.score - a.score);
    const limit = ask.includeWatched ? 10 : 5;
    const availableNow = ranked
      .slice(0, limit)
      .map(({ e, why }) => shelf(e, why));

    // what the house does not have: only when it helps, only ever suggested
    let notInLibrary: NotOnShelf[] = [];
    const wantsMore =
      ask.wantNew ||
      ((ask.like || ask.basedOnHistory) && availableNow.length < 3);
    if (wantsMore && !ask.includeWatched) {
      notInLibrary = await this.beyondShelf(ask, library, alongside);
    }

    return {
      linked: !!person,
      historyUsed: history.size > 0,
      availableNow,
      notInLibrary,
    };
  }

  private async beyondShelf(
    ask: RecommendAsk,
    library: LibraryEntry[],
    alongside: CatalogPick[],
  ): Promise<NotOnShelf[]> {
    const kind: 'movie' | 'series' = ask.kind === 'show' ? 'series' : 'movie';
    const owned = new Set(library.map((e) => e.catalogId).filter(Boolean));
    const wanted = [
      ...(ask.genres ?? []).flatMap(genreWords),
      ...(ask.mood ? moodGenres(ask.mood).want : []),
    ];

    // a family pick has to carry a family certificate, which only the
    // catalogue's filtered search can promise
    let pool: CatalogPick[] =
      ask.forFamily || ask.mood === 'family' ? [] : [...alongside];
    if (ask.wantNew && (!pool.length || wanted.length || ask.forFamily)) {
      const ids: number[] = [];
      for (const w of new Set(wanted)) {
        const id = await this.quietly(() => this.catalog.genreId(kind, w));
        if (id) ids.push(id);
      }
      pool.push(
        ...((await this.quietly(() =>
          this.catalog.discover(kind, {
            genreIds: ids,
            maxMinutes:
              ask.maxMinutes ??
              (ask.aroundMinutes ? ask.aroundMinutes + 20 : undefined),
            family: ask.forFamily || ask.mood === 'family',
          }),
        )) ?? []),
      );
    }

    const seen = new Set<number>();
    pool = pool.filter((p) => {
      if (owned.has(p.catalogId) || seen.has(p.catalogId)) return false;
      seen.add(p.catalogId);
      if (!wanted.length || ask.like) return true;
      const have = p.genres.flatMap(genreWords);
      return wanted.some((w) => have.includes(w));
    });
    const top = pool
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, 3);
    if (!top.length) return [];

    const waiting = await this.prisma.mediaRequest.findMany({
      where: {
        catalogId: { in: top.map((p) => p.catalogId) },
        status: { in: OPEN },
      },
      select: { catalogId: true },
    });
    const onList = new Set(waiting.map((w) => w.catalogId));
    return top.map((p) => ({
      catalogId: p.catalogId,
      title: p.title,
      year: p.year,
      kind: p.kind === 'series' ? ('show' as const) : ('film' as const),
      about: about({ genres: p.genres, rating: p.rating }),
      why:
        ask.like && alongside.some((a) => a.catalogId === p.catalogId)
          ? `recommended for people who liked ${ask.like}`
          : undefined,
      alreadyRequested: onList.has(p.catalogId),
    }));
  }

  /** The catalogue is a nice-to-have here: if it is down or not set up,
   * recommendations carry on from the library alone. */
  private async quietly<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      this.log.warn(`catalogue: ${(e as Error).message}`);
      return null;
    }
  }
}

function shelf(e: LibraryEntry, why: string[]): OnShelf {
  return {
    itemId: e.id,
    title: e.name,
    year: e.year,
    kind: e.type === 'Series' ? 'show' : 'film',
    about: about(e),
    ...(why.length ? { why: why.join('; ') } : {}),
    ...(e.started ? { partWatched: true } : {}),
  };
}

/** What the chat model asked for, checked: anything it made up is dropped. */
export function readAsk(raw: Record<string, unknown>): RecommendAsk {
  const text = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const flag = (x: unknown) => x === true || x === 'true';
  const minutes = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 10 && n <= 600
      ? Math.round(n)
      : undefined;
  };
  const kind = text(raw.kind);
  const mood = text(raw.mood).toLowerCase();
  const genres = (
    Array.isArray(raw.genres)
      ? raw.genres.map(text)
      : text(raw.genres)
        ? [text(raw.genres)]
        : []
  )
    .filter((g) => g && knownGenre(g))
    .slice(0, 5);
  return {
    ...(kind === 'movie' || kind === 'show' ? { kind } : {}),
    ...(MOODS.includes(mood as Mood) ? { mood: mood as Mood } : {}),
    ...(genres.length ? { genres } : {}),
    ...(text(raw.like) ? { like: text(raw.like) } : {}),
    ...(flag(raw.forFamily) ? { forFamily: true } : {}),
    ...(minutes(raw.maxMinutes) ? { maxMinutes: minutes(raw.maxMinutes) } : {}),
    ...(minutes(raw.aroundMinutes)
      ? { aroundMinutes: minutes(raw.aroundMinutes) }
      : {}),
    ...(flag(raw.includeWatched) ? { includeWatched: true } : {}),
    ...(flag(raw.wantNew) ? { wantNew: true } : {}),
    ...(flag(raw.basedOnHistory) ? { basedOnHistory: true } : {}),
  };
}
