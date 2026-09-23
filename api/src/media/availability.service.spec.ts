import { MediaKind, MediaStatus } from '@prisma/client';
import { AvailabilityService } from './availability.service';

// a pretend house: a catalogue that knows what was made, a Jellyfin that
// knows what is on the shelf, and a list of what has been asked for
function build(
  opts: {
    /** episodes on the shelf, "s1e1" style */
    shelf?: string[];
    /** the show exists in Jellyfin at all */
    hasSeries?: boolean;
    /** seasons the catalogue lists: [number, episodeCount] */
    seasons?: [number, number][];
    films?: { catalogId: number; title: string; year?: number }[];
    ownedFilms?: number[];
    requests?: {
      kind: MediaKind;
      catalogId: number;
      seasonNumber?: number;
      episodeNumber?: number;
      status?: MediaStatus;
    }[];
    collection?: { collectionId: number; title: string; films: any[] } | null;
  } = {},
) {
  const seasons = opts.seasons ?? [
    [1, 3],
    [2, 3],
  ];

  const catalog: any = {
    movie: jest.fn(async (id: number) => {
      const f = (opts.films ?? []).find((x) => x.catalogId === id);
      return f
        ? { ...f, kind: 'movie' }
        : { catalogId: id, title: `Film ${id}`, year: 2000, kind: 'movie' };
    }),
    series: jest.fn(async (id: number) => ({
      catalogId: id,
      title: 'The Office',
      year: 2005,
      kind: 'series',
    })),
    seasons: jest.fn(async () =>
      seasons.map(([n, count]) => ({
        seasonNumber: n,
        name: `Season ${n}`,
        episodeCount: count,
      })),
    ),
    episodes: jest.fn(async (_id: number, season: number) => {
      const found = seasons.find(([n]) => n === season);
      const count = found ? found[1] : 0;
      return Array.from({ length: count }, (_, i) => ({
        seasonNumber: season,
        episodeNumber: i + 1,
        name: `Episode ${i + 1}`,
      }));
    }),
    collectionOf: jest.fn(async () => opts.collection ?? null),
  };

  const jellyfin: any = {
    find: jest.fn(async (type: string, catalogId: number) =>
      type === 'Movie'
        ? (opts.ownedFilms ?? []).includes(catalogId)
          ? { id: `jf-${catalogId}`, name: 'x', type: 'Movie' }
          : null
        : opts.hasSeries === false
          ? null
          : { id: 'jf-series', name: 'The Office', type: 'Series' },
    ),
    ownedEpisodes: jest.fn(async () =>
      opts.hasSeries === false
        ? null
        : {
            itemId: 'jf-series',
            episodes: (opts.shelf ?? []).map((k) => {
              const [, s, e] = /s(\d+)e(\d+)/.exec(k)!;
              return {
                id: `jf-${k}`,
                seriesId: 'jf-series',
                seasonNumber: Number(s),
                episodeNumber: Number(e),
                name: `Episode ${e}`,
              };
            }),
          },
    ),
  };

  const rows = (opts.requests ?? []).map((r) => ({
    ...r,
    status: r.status ?? MediaStatus.REQUESTED,
  }));
  const prisma: any = {
    mediaRequest: {
      findMany: jest.fn(async ({ where }: any) => {
        const open = ['REQUESTED', 'SEARCHING', 'ACQUIRING', 'IMPORTING'];
        return rows.filter(
          (r) =>
            open.includes(r.status) &&
            (where.catalogId?.in
              ? where.catalogId.in.includes(r.catalogId)
              : r.catalogId === where.catalogId),
        );
      }),
    },
  };

  return {
    service: new AvailabilityService(prisma, catalog, jellyfin),
    catalog,
    jellyfin,
  };
}

describe('availability: films', () => {
  it('says a film we own is owned, and hands back the id to play it', async () => {
    const { service } = build({
      films: [{ catalogId: 157336, title: 'Interstellar', year: 2014 }],
      ownedFilms: [157336],
    });

    const a = await service.movie(157336);

    expect(a.owned).toBe(true);
    expect(a.itemId).toBe('jf-157336');
    expect(a.requested).toBe(false);
  });

  it('says a film we do not own is missing, without claiming it is on the way', async () => {
    const { service } = build({
      films: [{ catalogId: 157336, title: 'Interstellar', year: 2014 }],
      ownedFilms: [],
    });

    const a = await service.movie(157336);

    expect(a.owned).toBe(false);
    expect(a.itemId).toBeUndefined();
    expect(a.requested).toBe(false);
  });

  it('knows when someone has already asked for it', async () => {
    const { service } = build({
      films: [{ catalogId: 157336, title: 'Interstellar' }],
      requests: [{ kind: MediaKind.MOVIE, catalogId: 157336 }],
    });

    expect((await service.movie(157336)).requested).toBe(true);
  });

  it('does not count a finished or cancelled request as still asked for', async () => {
    const { service } = build({
      films: [{ catalogId: 157336, title: 'Interstellar' }],
      requests: [
        {
          kind: MediaKind.MOVIE,
          catalogId: 157336,
          status: MediaStatus.CANCELLED,
        },
      ],
    });

    expect((await service.movie(157336)).requested).toBe(false);
  });

  it('marks up a collection, owned and missing side by side', async () => {
    const films = [
      { catalogId: 671, title: "Philosopher's Stone", year: 2001 },
      { catalogId: 672, title: 'Chamber of Secrets', year: 2002 },
      { catalogId: 673, title: 'Prisoner of Azkaban', year: 2004 },
    ];
    const { service } = build({
      films,
      ownedFilms: [671, 672],
      collection: { collectionId: 1241, title: 'Harry Potter', films },
    });

    const set = (await service.collection(671))!;

    expect(set.films.map((f) => [f.title, f.owned])).toEqual([
      ["Philosopher's Stone", true],
      ['Chamber of Secrets', true],
      ['Prisoner of Azkaban', false],
    ]);
    expect(set.missingCount).toBe(1);
  });

  it('has nothing to say about a film that stands alone', async () => {
    const { service } = build({ collection: null });
    expect(await service.collection(157336)).toBeNull();
  });
});

describe('availability: shows', () => {
  it('calls a show complete when every episode is on the shelf', async () => {
    const { service } = build({
      seasons: [
        [1, 2],
        [2, 2],
      ],
      shelf: ['s1e1', 's1e2', 's2e1', 's2e2'],
    });

    const a = await service.series(100);

    expect(a.state).toBe('complete');
    expect(a.missingCount).toBe(0);
    expect(a.seasons.map((s) => s.state)).toEqual(['complete', 'complete']);
  });

  it('calls a show missing when Jellyfin has never heard of it', async () => {
    const { service } = build({ hasSeries: false, seasons: [[1, 3]] });

    const a = await service.series(100);

    expect(a.state).toBe('missing');
    expect(a.itemId).toBeUndefined();
    expect(a.missingCount).toBe(3);
  });

  it('works out a part-owned season episode by episode', async () => {
    const { service } = build({
      seasons: [
        [1, 3],
        [2, 3],
      ],
      shelf: ['s1e1', 's1e2', 's1e3', 's2e1'],
    });

    const a = await service.series(100);

    expect(a.state).toBe('partial');
    const [s1, s2] = a.seasons;
    expect(s1.state).toBe('complete');
    expect(s2.state).toBe('partial');
    expect(s2.ownedCount).toBe(1);
    expect(s2.episodes?.map((e) => e.owned)).toEqual([true, false, false]);
  });

  it('does not ask the catalogue about seasons it can answer by counting', async () => {
    // a season nobody has is missing all of it; a full one is missing none
    const { service, catalog } = build({
      seasons: [
        [1, 3],
        [2, 3],
      ],
      shelf: ['s1e1', 's1e2', 's1e3'],
    });

    await service.series(100);

    expect(catalog.episodes).not.toHaveBeenCalled();
  });

  it('counts specials as neither owned nor missing', async () => {
    const { service } = build({
      seasons: [[1, 2]],
      shelf: ['s0e1', 's0e2', 's1e1', 's1e2'],
    });

    const a = await service.series(100);

    expect(a.state).toBe('complete');
    expect(a.missingCount).toBe(0);
    expect(a.seasons).toHaveLength(1);
  });

  it('reports a mixed show honestly across three kinds of season', async () => {
    const { service } = build({
      seasons: [
        [1, 2],
        [2, 2],
        [3, 2],
      ],
      shelf: ['s1e1', 's1e2', 's2e1'],
    });

    const a = await service.series(100);

    expect(a.seasons.map((s) => s.state)).toEqual([
      'complete',
      'partial',
      'missing',
    ]);
    expect(a.missingCount).toBe(3);
  });
});

describe('availability: one episode', () => {
  it('finds an episode we own', async () => {
    const { service } = build({ seasons: [[3, 12]], shelf: ['s3e12'] });

    const e = await service.episode(100, 3, 12);

    expect(e.owned).toBe(true);
    expect(e.itemId).toBe('jf-s3e12');
    expect(e.seriesTitle).toBe('The Office');
  });

  it('says an episode is missing even when we own the rest of the show', async () => {
    const { service } = build({
      seasons: [[3, 12]],
      shelf: Array.from({ length: 11 }, (_, i) => `s3e${i + 1}`),
    });

    const e = await service.episode(100, 3, 12);

    expect(e.owned).toBe(false);
    expect(e.name).toBe('Episode 12');
  });

  it('counts an episode as asked for when the whole series was asked for', async () => {
    const { service } = build({
      seasons: [[3, 12]],
      requests: [{ kind: MediaKind.SERIES, catalogId: 100 }],
    });

    expect((await service.episode(100, 3, 12)).requested).toBe(true);
  });

  it('counts an episode as asked for when its season was asked for', async () => {
    const { service } = build({
      seasons: [[3, 12]],
      requests: [{ kind: MediaKind.SEASON, catalogId: 100, seasonNumber: 3 }],
    });

    expect((await service.episode(100, 3, 12)).requested).toBe(true);
    expect((await service.episode(100, 2, 1)).requested).toBe(false);
  });
});

describe('availability: what exactly is missing', () => {
  it('gives whole seasons as seasons and gaps as episodes', async () => {
    const { service } = build({
      seasons: [
        [1, 2],
        [2, 3],
        [3, 2],
      ],
      shelf: ['s1e1', 's1e2', 's2e1'],
    });

    const { seasons, episodes } = await service.missing(100);

    // season 3 is absent entirely — one request, not two
    expect(seasons.map((s) => s.seasonNumber)).toEqual([3]);
    // season 2 is short two, named individually
    expect(
      episodes.map((e) => `s${e.seasonNumber}e${e.episodeNumber}`),
    ).toEqual(['s2e2', 's2e3']);
  });

  it('has nothing to offer for a show we already own outright', async () => {
    const { service } = build({ seasons: [[1, 2]], shelf: ['s1e1', 's1e2'] });

    const { seasons, episodes } = await service.missing(100);

    expect(seasons).toHaveLength(0);
    expect(episodes).toHaveLength(0);
  });

  it('marks what is already on the list so it is not asked for twice', async () => {
    const { service } = build({
      seasons: [[2, 3]],
      shelf: ['s2e1'],
      requests: [
        {
          kind: MediaKind.EPISODE,
          catalogId: 100,
          seasonNumber: 2,
          episodeNumber: 2,
        },
      ],
    });

    const { episodes } = await service.missing(100);

    expect(episodes.map((e) => [e.episodeNumber, e.requested])).toEqual([
      [2, true],
      [3, false],
    ]);
  });
});
