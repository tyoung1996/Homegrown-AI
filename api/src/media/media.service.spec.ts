import { MediaKind, MediaRequest, MediaStatus, Role } from '@prisma/client';
import { MediaService } from './media.service';
import {
  AcquisitionRegistry,
  AcquisitionSource,
  ProviderResult,
} from './acquisition';

// small stand-ins for the real services; every test says what the catalogue
// and the shelf contain, then checks what the list does about it
function build(opts: {
  shelf?: { type: 'Movie' | 'Series'; catalogId: number; id: string }[];
  shelfEpisodes?: { seasonNumber: number; episodeNumber: number }[];
  /** what jellyfin's own search returns for a "watch this" query */
  playable?: { id: string; name: string; year?: number; type?: string }[];
  /** [seasonNumber, episodeCount] the catalogue lists for a show */
  catalogSeasons?: [number, number][];
  catalogMovies?: { catalogId: number; title: string; year?: number }[];
  catalogShows?: { catalogId: number; title: string; year?: number }[];
  rows?: any[];
  sourceAvailable?: boolean;
  /** what the acquisition provider reports when handed a request */
  sourceResult?: ProviderResult;
  /** the source blows up when asked to take something on */
  sourceThrows?: boolean;
  /** stand in a whole set of providers instead of the single default */
  providers?: AcquisitionSource[];
  screens?: { id: string; name: string; kind: string; ready: boolean }[];
}) {
  const rows: any[] = opts.rows ? [...opts.rows] : [];
  const prisma: any = {
    mediaRequest: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.status?.in) {
          return rows.filter((r) => where.status.in.includes(r.status));
        }
        return rows;
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          rows.find(
            (r) =>
              r.kind === where.kind &&
              r.catalogId === where.catalogId &&
              (r.seasonNumber ?? null) === where.seasonNumber &&
              (r.episodeNumber ?? null) === where.episodeNumber &&
              where.status.in.includes(r.status),
          ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `req${rows.length + 1}`,
          ...data,
          statusNote: null,
          source: null,
          filePath: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          user: { displayName: 'Sam' },
        };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row, user: { displayName: 'Sam' } };
      }),
      findUnique: jest.fn(
        async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      ),
      count: jest.fn(async ({ where }: any) =>
        where?.status?.in
          ? rows.filter((r) => where.status.in.includes(r.status)).length
          : rows.length,
      ),
    },
  };

  const catalog: any = {
    movie: jest.fn(async (id: number) => ({
      catalogId: id,
      title: 'Interstellar',
      year: 2014,
      kind: 'movie',
    })),
    series: jest.fn(async (id: number) => ({
      catalogId: id,
      title: 'The Office',
      year: 2005,
      kind: 'series',
    })),
    seasons: jest.fn(async () =>
      (
        opts.catalogSeasons ?? [
          [1, 6],
          [3, 25],
        ]
      ).map(([n, count]) => ({
        seasonNumber: n,
        name: `Season ${n}`,
        episodeCount: count,
      })),
    ),
    episodes: jest.fn(async (_id: number, season: number) => {
      const found = (opts.catalogSeasons ?? []).find(([n]) => n === season);
      const count = found ? found[1] : 0;
      return Array.from({ length: count }, (_, i) => ({
        seasonNumber: season,
        episodeNumber: i + 1,
        name: `Episode ${i + 1}`,
      }));
    }),
    collectionOf: jest.fn(async () => null),
    searchMovies: jest.fn(async () =>
      (opts.catalogMovies ?? []).map((m) => ({ ...m, kind: 'movie' })),
    ),
    searchSeries: jest.fn(async () =>
      (opts.catalogShows ?? []).map((m) => ({ ...m, kind: 'series' })),
    ),
    health: jest.fn(async () => ({ configured: true, ok: true })),
  };

  const jellyfin: any = {
    find: jest.fn(
      async (type: string, catalogId: number) =>
        (opts.shelf ?? []).find(
          (s) => s.type === type && s.catalogId === catalogId,
        ) ?? null,
    ),
    episodes: jest.fn(async () => opts.shelfEpisodes ?? []),
    items: jest.fn(async () =>
      (opts.shelf ?? []).map((s) => ({
        id: s.id,
        name: s.type === 'Series' ? 'The Office' : 'Interstellar',
        type: s.type,
        catalogId: s.catalogId,
      })),
    ),
    searchPlayable: jest.fn(async () => opts.playable ?? []),
    itemsById: jest.fn(async (ids: string[]) =>
      (opts.playable ?? []).filter((p) => ids.includes(p.id)),
    ),
    ownedEpisodes: jest.fn(async () => {
      const series = (opts.shelf ?? []).find((s) => s.type === 'Series');
      if (!series) return null;
      return {
        itemId: series.id,
        episodes: (opts.shelfEpisodes ?? []).map((e) => ({
          id: `jf-s${e.seasonNumber}e${e.episodeNumber}`,
          seriesId: series.id,
          ...e,
          name: `Episode ${e.episodeNumber}`,
        })),
      };
    }),
    health: jest.fn(async () => ({ configured: true, ok: true })),
  };

  // the real registry over a pretend provider, so the rules it enforces are
  // exercised rather than mocked away
  const provider: AcquisitionSource = {
    name: 'test-provider',
    label: 'Test provider',
    supports: () => true,
    available: async () => opts.sourceAvailable !== false,
    start: async () => {
      if (opts.sourceThrows) throw new Error('the provider is offline');
      return (
        opts.sourceResult ?? {
          status: MediaStatus.REQUESTED,
          note: 'On the list',
        }
      );
    },
  };
  const sources = new AcquisitionRegistry(opts.providers ?? [provider]);

  const screens: any = {
    list: jest.fn(async () => opts.screens ?? []),
    find: jest.fn(
      async (id: string) =>
        (opts.screens ?? []).find(
          (s: any) => s.id === id || s.name.toLowerCase() === id.toLowerCase(),
        ) ?? null,
    ),
    play: jest.fn(
      async (screen: any, item: any) =>
        `Playing ${item.name} on ${screen.name}`,
    ),
    stop: jest.fn(async (screen: any) => `Stopped ${screen.name}`),
  };

  // the real engine over the same fakes, so the two agree by construction
  const availability = new (
    require('./availability.service') as typeof import('./availability.service')
  ).AvailabilityService(prisma, catalog, jellyfin);

  return {
    service: new MediaService(
      prisma,
      catalog,
      jellyfin,
      sources,
      screens,
      availability,
    ),
    prisma,
    rows,
    jellyfin,
    catalog,
    screens,
    availability,
  };
}

describe('MediaService requests', () => {
  it('puts a film on the list and hands it to a source', async () => {
    const { service, rows } = build({});
    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('queued');
    expect(outcome.label).toBe('Interstellar (2014)');
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('test-provider');
    expect(rows[0].status).toBe(MediaStatus.REQUESTED);
  });

  it('says a film is already available instead of asking for it again', async () => {
    const { service, rows } = build({
      shelf: [{ type: 'Movie', catalogId: 157336, id: 'jf1' }],
    });
    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('already-available');
    expect(rows).toHaveLength(0);
  });

  it('does not add the same thing to the list twice', async () => {
    const { service, rows } = build({
      rows: [
        {
          id: 'req1',
          userId: 'u2',
          kind: MediaKind.MOVIE,
          catalogId: 157336,
          title: 'Interstellar',
          label: 'Interstellar (2014)',
          year: 2014,
          seasonNumber: null,
          episodeNumber: null,
          status: MediaStatus.REQUESTED,
          createdAt: new Date(),
          updatedAt: new Date(),
          user: { displayName: 'Alex' },
        },
      ],
    });
    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('already-requested');
    expect(rows).toHaveLength(1);
    if (outcome.result === 'already-requested') {
      expect(outcome.request.requestedBy).toBe('Alex');
      expect(outcome.request.mine).toBe(false);
    }
  });

  it('makes one row per season when seasons are named', async () => {
    const { service, rows } = build({});
    const outcomes = await service.requestSeries('u1', 2316, [3, 1, 3]);

    expect(outcomes).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual([
      'The Office — Season 1',
      'The Office — Season 3',
    ]);
    expect(rows.every((r) => r.kind === MediaKind.SEASON)).toBe(true);
  });

  it('asks for the whole show when no seasons are named', async () => {
    const { service, rows } = build({});
    await service.requestSeries('u1', 2316, []);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(MediaKind.SERIES);
    expect(rows[0].label).toBe('The Office — whole series');
  });

  it('skips an episode that is already on the shelf', async () => {
    const { service } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf9' }],
      shelfEpisodes: [{ seasonNumber: 3, episodeNumber: 7 }],
    });
    const [outcome] = await service.requestEpisodes('u1', 2316, [
      { season: 3, episode: 7 },
    ]);

    expect(outcome.result).toBe('already-available');
    expect(outcome.label).toBe('The Office — S3E7');
  });

  it('keeps a request on the list when nothing can bring files in', async () => {
    const { service, rows } = build({ sourceAvailable: false });
    await service.requestMovies('u1', [157336]);

    // wanted and not here yet is the truth; "couldn't add it" would be a
    // guess about the future
    expect(rows[0].status).toBe(MediaStatus.REQUESTED);
    expect(rows[0].statusNote).toBe(
      "On the list — we'll let you know when it's ready to watch.",
    );
    expect(rows[0].adminNote).toMatch(/no automatic source/i);
  });
});

describe('MediaService matchFile', () => {
  const open = (extra: any) => ({
    id: 'r1',
    userId: 'u1',
    status: MediaStatus.REQUESTED,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  });

  it('matches a film by title and year', async () => {
    const { service } = build({
      rows: [
        open({
          kind: MediaKind.MOVIE,
          catalogId: 1,
          title: 'Interstellar',
          label: 'Interstellar (2014)',
          year: 2014,
          seasonNumber: null,
          episodeNumber: null,
        }),
      ],
    });
    const hit = await service.matchFile({
      kind: 'movie',
      title: 'interstellar',
      year: 2014,
    });
    expect(hit?.id).toBe('r1');
  });

  it('does not match a different year', async () => {
    const { service } = build({
      rows: [
        open({
          kind: MediaKind.MOVIE,
          catalogId: 1,
          title: 'Dune',
          label: 'Dune (2021)',
          year: 2021,
          seasonNumber: null,
          episodeNumber: null,
        }),
      ],
    });
    expect(
      await service.matchFile({ kind: 'movie', title: 'Dune', year: 1984 }),
    ).toBeNull();
  });

  it('matches an episode against a season request', async () => {
    const { service } = build({
      rows: [
        open({
          kind: MediaKind.SEASON,
          catalogId: 2,
          title: 'The Office',
          label: 'The Office — Season 3',
          year: null,
          seasonNumber: 3,
          episodeNumber: null,
        }),
      ],
    });
    const hit = await service.matchFile({
      kind: 'episode',
      title: 'The Office',
      season: 3,
      episode: 7,
    });
    expect(hit?.id).toBe('r1');
  });

  it('matches an episode against a whole-series request', async () => {
    const { service } = build({
      rows: [
        open({
          kind: MediaKind.SERIES,
          catalogId: 2,
          title: 'The Office',
          label: 'The Office — whole series',
          year: null,
          seasonNumber: null,
          episodeNumber: null,
        }),
      ],
    });
    expect(
      (
        await service.matchFile({
          kind: 'episode',
          title: 'the office',
          season: 9,
          episode: 1,
        })
      )?.id,
    ).toBe('r1');
  });

  it('will not hand a film file to an episode request', async () => {
    const { service } = build({
      rows: [
        open({
          kind: MediaKind.EPISODE,
          catalogId: 2,
          title: 'The Office',
          label: 'The Office — S3E7',
          year: null,
          seasonNumber: 3,
          episodeNumber: 7,
        }),
      ],
    });
    expect(
      await service.matchFile({ kind: 'movie', title: 'The Office' }),
    ).toBeNull();
  });
});

describe('MediaService permissions', () => {
  const row = {
    id: 'r1',
    userId: 'owner',
    kind: MediaKind.MOVIE,
    catalogId: 1,
    title: 'Interstellar',
    label: 'Interstellar (2014)',
    year: 2014,
    seasonNumber: null,
    episodeNumber: null,
    status: MediaStatus.REQUESTED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('lets the person who asked cancel it', async () => {
    const { service, rows } = build({ rows: [{ ...row }] });
    await service.cancel('r1', 'owner', Role.ADULT);
    expect(rows[0].status).toBe(MediaStatus.CANCELLED);
  });

  it('lets an admin cancel someone else’s', async () => {
    const { service, rows } = build({ rows: [{ ...row }] });
    await service.cancel('r1', 'someone-else', Role.ADMIN);
    expect(rows[0].status).toBe(MediaStatus.CANCELLED);
  });

  it('stops other people cancelling it', async () => {
    const { service } = build({ rows: [{ ...row }] });
    await expect(
      service.cancel('r1', 'someone-else', Role.CHILD),
    ).rejects.toThrow(/not your request/i);
  });

  it('will not cancel something already in the library', async () => {
    const { service } = build({
      rows: [{ ...row, status: MediaStatus.AVAILABLE }],
    });
    await expect(service.cancel('r1', 'owner', Role.ADULT)).rejects.toThrow(
      /already in the library/i,
    );
  });
});

describe('someone says they want to watch something', () => {
  it('offers what is on the shelf, and asks for nothing', async () => {
    const { service, rows } = build({
      playable: [{ id: 'jf-1', name: 'Interstellar', year: 2014 }],
    });

    const found = await service.lookFor('I want to watch Interstellar');

    expect(found.mode).toBe('owned');
    if (found.mode === 'owned')
      expect(found.items[0].name).toBe('Interstellar');
    // being asked to watch something is not being asked to go and get it
    expect(rows).toHaveLength(0);
  });

  it('says plainly when we do not have it, and does not request it', async () => {
    const { service, rows } = build({
      playable: [],
      catalogMovies: [{ catalogId: 157336, title: 'Interstellar', year: 2014 }],
    });

    const found = await service.lookFor('I want to watch Interstellar');

    expect(found.mode).toBe('missing');
    if (found.mode === 'missing') {
      expect(found.films[0].title).toBe('Interstellar');
      expect(found.films[0].owned).toBe(false);
    }
    expect(rows).toHaveLength(0);
  });

  it('says nobody has heard of it when the catalogue is blank too', async () => {
    const { service } = build({ playable: [], catalogMovies: [] });

    expect((await service.lookFor('watch Gibberish')).mode).toBe('nothing');
  });

  it('recognises a show we own and answers season by season', async () => {
    const { service } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      catalogShows: [{ catalogId: 2316, title: 'The Office' }],
      catalogSeasons: [
        [1, 2],
        [2, 2],
      ],
      shelfEpisodes: [
        { seasonNumber: 1, episodeNumber: 1 },
        { seasonNumber: 1, episodeNumber: 2 },
      ],
    });

    const found = await service.lookFor('I want to watch The Office');

    expect(found.mode).toBe('series');
    if (found.mode === 'series') {
      expect(found.series.seasons.map((s) => s.state)).toEqual([
        'complete',
        'missing',
      ]);
      expect(found.series.missingCount).toBe(2);
    }
  });

  it('answers about one episode when one episode was asked for', async () => {
    const { service } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      catalogShows: [{ catalogId: 2316, title: 'The Office' }],
      catalogSeasons: [[3, 12]],
      shelfEpisodes: [{ seasonNumber: 3, episodeNumber: 12 }],
    });

    const found = await service.lookFor('Play The Office S03E12');

    expect(found.mode).toBe('episode');
    if (found.mode === 'episode') {
      expect(found.episode.owned).toBe(true);
      expect(found.episode.seasonNumber).toBe(3);
      expect(found.episode.episodeNumber).toBe(12);
    }
  });

  it('does not offer the whole show when one episode is missing', async () => {
    const { service, rows } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      catalogShows: [{ catalogId: 2316, title: 'The Office' }],
      catalogSeasons: [[3, 12]],
      shelfEpisodes: [{ seasonNumber: 3, episodeNumber: 1 }],
    });

    const found = await service.lookFor('Play The Office S03E12');

    expect(found.mode).toBe('episode');
    if (found.mode === 'episode') expect(found.episode.owned).toBe(false);
    expect(rows).toHaveLength(0);
  });
});

describe('asking for only what is missing', () => {
  it('asks for a whole absent season as one request, and gaps one by one', async () => {
    const { service } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      catalogSeasons: [
        [1, 2],
        [2, 3],
        [3, 2],
      ],
      shelfEpisodes: [
        { seasonNumber: 1, episodeNumber: 1 },
        { seasonNumber: 1, episodeNumber: 2 },
        { seasonNumber: 2, episodeNumber: 1 },
      ],
    });

    const out = await service.requestMissing('u1', 2316);
    const labels = out.map((o) => o.label);

    expect(labels).toContain('The Office — Season 3');
    expect(labels).toContain('The Office — S2E2');
    expect(labels).toContain('The Office — S2E3');
    // season 1 is complete and season 3 went as a season, not as episodes
    expect(labels).not.toContain('The Office — S3E1');
    expect(labels).not.toContain('The Office — S1E1');
  });

  it('asks for nothing when the show is already complete', async () => {
    const { service } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      catalogSeasons: [[1, 2]],
      shelfEpisodes: [
        { seasonNumber: 1, episodeNumber: 1 },
        { seasonNumber: 1, episodeNumber: 2 },
      ],
    });

    expect(await service.requestMissing('u1', 2316)).toHaveLength(0);
  });

  it('does not ask twice for something already on the list', async () => {
    const { service } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      catalogSeasons: [[2, 3]],
      shelfEpisodes: [{ seasonNumber: 2, episodeNumber: 1 }],
      rows: [
        {
          id: 'existing',
          kind: MediaKind.EPISODE,
          catalogId: 2316,
          seasonNumber: 2,
          episodeNumber: 2,
          status: MediaStatus.REQUESTED,
          label: 'The Office — S2E2',
          title: 'The Office',
        },
      ],
    });

    const out = await service.requestMissing('u1', 2316);

    expect(out.map((o) => o.label)).toEqual(['The Office — S2E3']);
  });
});

describe('nothing is ready to watch until Jellyfin says so', () => {
  it('leaves a filed file short of ready, however finished it looks', async () => {
    const { service, rows } = build({
      rows: [
        {
          id: 'r1',
          kind: MediaKind.MOVIE,
          catalogId: 157336,
          title: 'Interstellar',
          label: 'Interstellar (2014)',
          year: 2014,
          status: MediaStatus.REQUESTED,
        },
      ],
    });

    await service.markImported('r1', '/srv/media/Movies/Interstellar.mkv');

    // the file is on disk and the provider is done — still not watchable
    expect(rows[0].status).toBe(MediaStatus.IMPORTING);
    expect(rows[0].status).not.toBe(MediaStatus.AVAILABLE);
  });

  it('will not call it ready while Jellyfin cannot see it', async () => {
    const { service, rows } = build({
      shelf: [],
      rows: [
        {
          id: 'r1',
          kind: MediaKind.MOVIE,
          catalogId: 157336,
          title: 'Interstellar',
          label: 'Interstellar (2014)',
          year: 2014,
          status: MediaStatus.IMPORTING,
        },
      ],
    });

    expect(await service.confirmImported()).toHaveLength(0);
    expect(rows[0].status).toBe(MediaStatus.IMPORTING);
  });

  it('calls it ready the moment Jellyfin can see it', async () => {
    const { service, rows } = build({
      shelf: [{ type: 'Movie', catalogId: 157336, id: 'jf-42' }],
      rows: [
        {
          id: 'r1',
          kind: MediaKind.MOVIE,
          catalogId: 157336,
          title: 'Interstellar',
          label: 'Interstellar (2014)',
          year: 2014,
          status: MediaStatus.IMPORTING,
        },
      ],
    });

    const ready = await service.confirmImported();

    expect(ready).toHaveLength(1);
    expect(rows[0].status).toBe(MediaStatus.AVAILABLE);
    expect(rows[0].jellyfinId).toBe('jf-42');
  });

  it('will not call an episode ready until that episode is on the shelf', async () => {
    const { service, rows } = build({
      shelf: [{ type: 'Series', catalogId: 2316, id: 'jf-office' }],
      shelfEpisodes: [{ seasonNumber: 3, episodeNumber: 1 }],
      rows: [
        {
          id: 'r1',
          kind: MediaKind.EPISODE,
          catalogId: 2316,
          seasonNumber: 3,
          episodeNumber: 12,
          title: 'The Office',
          label: 'The Office — S3E12',
          status: MediaStatus.IMPORTING,
        },
      ],
    });

    // the series is there and so are other episodes — not this one
    expect(await service.confirmImported()).toHaveLength(0);
    expect(rows[0].status).toBe(MediaStatus.IMPORTING);
  });
});

describe('when the way files arrive is having a bad day', () => {
  it('keeps the request when the provider falls over, and says so kindly', async () => {
    const { service, rows } = build({ sourceThrows: true });

    const [outcome] = await service.requestMovies('u1', [157336]);

    // the ask is not lost, and the family is not shown a stack trace
    expect(rows).toHaveLength(1);
    expect(outcome.result).toBe('queued');
    if (outcome.result === 'queued') {
      // still on the list; the crash is the admin's business, not theirs
      expect(outcome.request.status).toBe(MediaStatus.REQUESTED);
      expect(outcome.request.statusText).toBe('On the list');
    }
    expect(rows[0].adminNote).toMatch(/threw: the provider is offline/);
    expect(rows[0].retryAfter).toBeInstanceOf(Date);
  });

  it('still takes the request when there is no provider at all', async () => {
    const { service } = build({ sourceAvailable: false });

    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('queued');
    if (outcome.result === 'queued') {
      expect(outcome.request.status).toBe(MediaStatus.REQUESTED);
      expect(outcome.request.statusText).toBe('On the list');
    }
  });

  it('keeps answering about the library when no provider is configured', async () => {
    const { service } = build({
      sourceAvailable: false,
      playable: [{ id: 'jf-1', name: 'Interstellar', year: 2014 }],
      screens: [
        { id: 'cast:1', name: 'Living room', kind: 'cast', ready: true },
      ],
    });

    // watching what we already own does not go anywhere near a provider
    const found = await service.lookFor('watch Interstellar');
    expect(found.mode).toBe('owned');
    expect(await service.listScreens()).toHaveLength(1);
  });

  it('reports what a provider said without repeating it to the family', async () => {
    const { service } = build({
      sourceResult: {
        status: MediaStatus.ACQUIRING,
        note: 'Adding it to the library',
      },
    });

    const [outcome] = await service.requestMovies('u1', [157336]);

    if (outcome.result === 'queued') {
      expect(outcome.request.statusText).toBe('Adding it to the library');
      // no provider names anywhere near what the family reads
      expect(JSON.stringify(outcome.request)).not.toMatch(
        /radarr|sonarr|provider|indexer|download/i,
      );
    }
  });
});

describe('two people asking for the same thing', () => {
  it('puts it on the list once', async () => {
    const { service, rows } = build({});

    const first = await service.requestMovies('u1', [157336]);
    const second = await service.requestMovies('u2', [157336]);

    expect(first[0].result).toBe('queued');
    expect(second[0].result).toBe('already-requested');
    expect(rows).toHaveLength(1);
  });
});

describe('the list with more than one provider behind it', () => {
  // a provider that only does one kind of thing, so routing has something
  // to choose between
  const provider = (
    name: string,
    kinds: MediaKind[],
    opts: { up?: boolean; result?: ProviderResult } = {},
  ): AcquisitionSource => ({
    name,
    label: `${name} provider`,
    supports: (kind) => kinds.includes(kind),
    available: async () => opts.up !== false,
    start: async () =>
      opts.result ?? { status: MediaStatus.ACQUIRING, note: 'Working on it' },
  });

  it('sends a film and a show to different providers', async () => {
    const { service, rows } = build({
      providers: [
        provider('films', [MediaKind.MOVIE]),
        provider('shows', [
          MediaKind.SERIES,
          MediaKind.SEASON,
          MediaKind.EPISODE,
        ]),
      ],
    });

    await service.requestMovies('u1', [157336]);
    await service.requestSeries('u1', 2316, []);

    expect(rows.find((r) => r.kind === MediaKind.MOVIE).source).toBe('films');
    expect(rows.find((r) => r.kind === MediaKind.SERIES).source).toBe('shows');
  });

  it('carries on with the one that works when the other is down', async () => {
    const { service, rows } = build({
      providers: [
        provider('films', [MediaKind.MOVIE], { up: false }),
        provider('anything', [
          MediaKind.MOVIE,
          MediaKind.SERIES,
          MediaKind.SEASON,
          MediaKind.EPISODE,
        ]),
      ],
    });

    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('queued');
    expect(rows[0].source).toBe('anything');
  });

  it('keeps a kind nobody handles on the list, and says why to an admin', async () => {
    const { service } = build({
      providers: [provider('films', [MediaKind.MOVIE])],
    });

    const [outcome] = await service.requestSeries('u1', 2316, []);

    if (outcome.result === 'queued') {
      expect(outcome.request.status).toBe(MediaStatus.REQUESTED);
      expect(outcome.request.statusText).toBe('On the list');
    }
    const [admin] = await service.list('u1', true, Role.ADMIN);
    expect(admin.adminNote).toMatch(/no automatic source/i);
  });

  it('will not let any provider make something ready to watch', async () => {
    const { service, rows } = build({
      providers: [
        provider('liar', [MediaKind.MOVIE], {
          result: { status: MediaStatus.AVAILABLE, note: 'Done' } as never,
        }),
      ],
    });

    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(rows[0].status).toBe(MediaStatus.IMPORTING);
    if (outcome.result === 'queued') {
      expect(outcome.request.statusText).toBe('Almost ready');
    }
  });

  it('asks background providers how they are doing, and moves them on', async () => {
    const poller: AcquisitionSource = {
      name: 'slow',
      label: 'Slow provider',
      supports: () => true,
      available: async () => true,
      start: async () => ({
        status: MediaStatus.ACQUIRING,
        note: 'Adding it to the library',
      }),
      poll: async () => ({
        status: MediaStatus.IMPORTING,
        note: 'Almost ready',
      }),
    };
    const { service, rows } = build({ providers: [poller] });
    await service.requestMovies('u1', [157336]);
    expect(rows[0].status).toBe(MediaStatus.ACQUIRING);

    const moved = await service.pollProviders();

    expect(moved).toBe(1);
    expect(rows[0].status).toBe(MediaStatus.IMPORTING);
    // and still not ready — that is Jellyfin's to give
    expect(rows[0].status).not.toBe(MediaStatus.AVAILABLE);
  });

  it('leaves alone a request whose provider has nothing new to say', async () => {
    const quiet: AcquisitionSource = {
      name: 'quiet',
      label: 'Quiet provider',
      supports: () => true,
      available: async () => true,
      start: async () => ({
        status: MediaStatus.ACQUIRING,
        note: 'Adding it to the library',
      }),
      poll: async () => null,
    };
    const { service, rows } = build({ providers: [quiet] });
    await service.requestMovies('u1', [157336]);

    expect(await service.pollProviders()).toBe(0);
    expect(rows[0].status).toBe(MediaStatus.ACQUIRING);
  });
});

describe('with every provider down', () => {
  const dead: AcquisitionSource = {
    name: 'dead',
    label: 'Dead provider',
    supports: () => true,
    available: async () => false,
    start: async () => {
      throw new Error('should never be asked');
    },
  };

  it('still plays what we already own', async () => {
    const { service } = build({
      providers: [dead],
      playable: [{ id: 'jf-1', name: 'Interstellar', year: 2014 }],
      screens: [
        { id: 'cast:1', name: 'Living room', kind: 'cast', ready: true },
      ],
    });

    const found = await service.lookFor('watch Interstellar');

    expect(found.mode).toBe('owned');
    expect(await service.listScreens()).toHaveLength(1);
    expect(await service.playOn('jf-1', 'Living room')).toMatch(
      /Playing .* on Living room/,
    );
  });

  it('still says honestly what we do not have', async () => {
    const { service } = build({
      providers: [dead],
      playable: [],
      catalogMovies: [{ catalogId: 157336, title: 'Interstellar', year: 2014 }],
    });

    expect((await service.lookFor('watch Interstellar')).mode).toBe('missing');
  });

  it('still reports the library list', async () => {
    const { service } = build({ providers: [dead] });

    await expect(service.list('u1')).resolves.toEqual([]);
  });

  it('reports itself unhealthy without taking anything else down', async () => {
    const { service } = build({ providers: [dead] });

    const health = (await service.health(Role.ADMIN)) as any;

    expect(health.app.ok).toBe(true);
    expect(health.acquisition.ok).toBe(false);
    expect(health.acquisition.providers[0]).toMatchObject({
      name: 'dead',
      ok: false,
    });
  });
});

describe('anything in the catalogue can be asked for', () => {
  // a provider that fetches, and one that only waits
  const fetcher = (kinds: MediaKind[], up = true): AcquisitionSource => ({
    name: 'fetcher',
    label: 'Fetcher',
    automatic: true,
    supports: (k) => kinds.includes(k),
    available: async () => up,
    start: async () => ({
      status: MediaStatus.ACQUIRING,
      note: 'Adding it to the library',
    }),
  });
  const waiter: AcquisitionSource = {
    name: 'waiter',
    label: 'Watched folder',
    automatic: false,
    supports: () => true,
    available: async () => true,
    start: async () => ({
      status: MediaStatus.REQUESTED,
      note: "On the list — we'll let you know when it's ready to watch.",
    }),
  };

  it('keeps a film nothing can fetch on the list rather than failing it', async () => {
    const { service, rows } = build({ providers: [fetcher([], false)] });

    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('queued');
    expect(rows[0].status).toBe(MediaStatus.REQUESTED);
    if (outcome.result === 'queued') {
      expect(outcome.request.statusText).toBe('On the list');
      expect(outcome.request.status).not.toBe(MediaStatus.UNAVAILABLE);
    }
  });

  it('tells an admin why, and tells the family nothing technical', async () => {
    const { service, rows } = build({ providers: [fetcher([], false)] });
    await service.requestMovies('u1', [157336]);

    const [family] = await service.list('u1');
    const [admin] = await service.list('u1', true, Role.ADMIN);

    expect(admin.adminNote).toMatch(/no automatic source/i);
    expect(family.adminNote).toBeUndefined();
    // and nothing technical leaks through the note the family does see
    expect(JSON.stringify(family)).not.toMatch(
      /provider|source|fetch|archive|automatic/i,
    );
    expect(rows[0].adminNote).toBeTruthy();
  });

  it('prefers a provider that fetches over one that only waits', async () => {
    const { service, rows } = build({
      providers: [waiter, fetcher([MediaKind.MOVIE])],
    });

    await service.requestMovies('u1', [157336]);

    expect(rows[0].source).toBe('fetcher');
    expect(rows[0].status).toBe(MediaStatus.ACQUIRING);
  });

  it('falls back to waiting for a kind nothing can fetch', async () => {
    const { service, rows } = build({
      providers: [waiter, fetcher([MediaKind.MOVIE])],
    });

    await service.requestSeries('u1', 2316, []);

    expect(rows[0].source).toBe('waiter');
    expect(rows[0].status).toBe(MediaStatus.REQUESTED);
    // an admin can see that nothing will go and get it by itself
    const [admin] = await service.list('u1', true, Role.ADMIN);
    expect(admin.adminNote).toMatch(/no automatic source/i);
  });

  it('picks up what was waiting once a provider can take it', async () => {
    const { service, rows } = build({ providers: [fetcher([], false)] });
    await service.requestMovies('u1', [157336]);
    expect(rows[0].source).toBeNull();

    // the same request, now that something can fetch films
    const { service: later } = build({
      providers: [fetcher([MediaKind.MOVIE])],
      rows,
    });
    const claimed = await later.reconsiderWaiting();

    expect(claimed).toBe(1);
    expect(rows[0].source).toBe('fetcher');
    expect(rows[0].status).toBe(MediaStatus.ACQUIRING);
  });

  it('does not narrow what can be searched for to what can be fetched', async () => {
    // nothing can fetch anything, and Oppenheimer is still findable
    const { service } = build({
      providers: [fetcher([], false)],
      catalogMovies: [{ catalogId: 872585, title: 'Oppenheimer', year: 2023 }],
      playable: [],
    });

    const found = await service.lookFor('watch Oppenheimer');

    expect(found.mode).toBe('missing');
    if (found.mode === 'missing') {
      expect(found.films[0].title).toBe('Oppenheimer');
    }
    expect(await service.searchMovies('Oppenheimer')).toHaveLength(1);
  });
});

describe('a request moving to a better provider', () => {
  // the folder: waits for a file, never declines, holds no state
  const folder = (): AcquisitionSource => ({
    name: 'drop-folder',
    label: 'Watched folder',
    automatic: false,
    supports: () => true,
    available: async () => true,
    start: async () => ({
      status: MediaStatus.REQUESTED,
      note: "On the list — we'll let you know when it's ready to watch.",
    }),
  });
  // a fetcher that can be switched on, made to decline, or made to fail
  const fetcher = (
    name: string,
    opts: {
      up?: () => boolean;
      decline?: boolean;
      poll?: ProviderResult | null;
    } = {},
  ): AcquisitionSource & { starts: number } => {
    const f = {
      name,
      label: name,
      automatic: true,
      starts: 0,
      supports: (k: MediaKind) => k === MediaKind.MOVIE,
      available: async () => (opts.up ? opts.up() : true),
      start: async () => {
        f.starts++;
        return opts.decline
          ? {
              status: MediaStatus.UNAVAILABLE,
              note: "Couldn't add it",
              detail: 'no approved copy',
            }
          : {
              status: MediaStatus.ACQUIRING,
              note: 'Adding it to the library',
              ref: `${name}-ref`,
            };
      },
      poll: async () => opts.poll ?? null,
    };
    return f;
  };

  it('moves from the folder to a fetcher that comes online later', async () => {
    let online = false;
    const archive = fetcher('archive', { up: () => online });
    const { service, rows } = build({ providers: [archive, folder()] });

    await service.requestMovies('u1', [157336]);
    expect(rows[0].source).toBe('drop-folder');
    expect(rows[0].status).toBe(MediaStatus.REQUESTED);

    online = true;
    expect(await service.reconsiderWaiting()).toBe(1);

    expect(rows[0].source).toBe('archive');
    expect(rows[0].status).toBe(MediaStatus.ACQUIRING);
    expect(rows[0].sourceRef).toBe('archive-ref');
    expect(rows[0].adminNote).toMatch(/moved from drop-folder/);
  });

  it('leaves a working fetcher alone when another one appears', async () => {
    const first = fetcher('first');
    let secondUp = false;
    const second = fetcher('second', { up: () => secondUp });
    const { service, rows } = build({ providers: [first, second, folder()] });

    await service.requestMovies('u1', [157336]);
    expect(rows[0].source).toBe('first');

    secondUp = true;
    await service.reconsiderWaiting();

    expect(rows[0].source).toBe('first');
    expect(rows[0].sourceRef).toBe('first-ref');
    expect(second.starts).toBe(0);
  });

  it('never starts a second copy by promoting twice', async () => {
    let online = false;
    const archive = fetcher('archive', { up: () => online });
    const { service } = build({ providers: [archive, folder()] });
    await service.requestMovies('u1', [157336]);

    online = true;
    await service.reconsiderWaiting();
    await service.reconsiderWaiting();
    await service.reconsiderWaiting();

    expect(archive.starts).toBe(1);
  });

  it('falls back to the folder when a fetcher declines, instead of failing', async () => {
    // the bug behind the stuck Little Mermaid requests
    const archive = fetcher('archive', { decline: true });
    const { service, rows } = build({ providers: [archive, folder()] });

    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(rows[0].source).toBe('drop-folder');
    expect(rows[0].status).toBe(MediaStatus.REQUESTED);
    if (outcome.result === 'queued') {
      expect(outcome.request.statusText).toBe('On the list');
    }
    expect(rows[0].adminNote).toMatch(/archive declined: no approved copy/);
  });

  it('does not ask a fetcher that declined again until the window has passed', async () => {
    const archive = fetcher('archive', { decline: true });
    const { service, rows } = build({ providers: [archive, folder()] });
    await service.requestMovies('u1', [157336]);
    expect(archive.starts).toBe(1);

    await service.reconsiderWaiting();
    await service.reconsiderWaiting();
    expect(archive.starts).toBe(1);

    // the window passes
    rows[0].retryAfter = new Date(Date.now() - 1000);
    await service.reconsiderWaiting();
    expect(archive.starts).toBe(2);
  });

  it('puts a failed fetch back on the list rather than writing it off', async () => {
    const archive = fetcher('archive', {
      poll: {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it",
        detail: 'incomplete: 8 of 64 bytes',
      },
    });
    const { service, rows } = build({ providers: [archive, folder()] });
    await service.requestMovies('u1', [157336]);
    expect(rows[0].status).toBe(MediaStatus.ACQUIRING);

    await service.pollProviders();

    expect(rows[0].status).toBe(MediaStatus.REQUESTED);
    expect(rows[0].source).toBe('drop-folder');
    expect(rows[0].sourceRef).toBeNull();
    expect(rows[0].adminNote).toMatch(/archive failed: incomplete/);
    expect(rows[0].retryAfter).toBeInstanceOf(Date);
    // not straight back to the one that just failed
    expect(archive.starts).toBe(1);
  });

  it('never touches something already ready to watch', async () => {
    const archive = fetcher('archive');
    const { service, rows } = build({
      providers: [archive, folder()],
      rows: [
        {
          id: 'done',
          kind: MediaKind.MOVIE,
          catalogId: 1,
          title: 'x',
          label: 'x',
          status: MediaStatus.AVAILABLE,
          source: 'drop-folder',
        },
      ],
    });

    await service.reconsiderWaiting();
    await service.pollProviders();

    expect(rows[0].status).toBe(MediaStatus.AVAILABLE);
    expect(archive.starts).toBe(0);
  });

  it('picks up after a restart from what is stored, not what was in memory', async () => {
    let online = false;
    const { service, rows } = build({
      providers: [fetcher('archive', { up: () => online }), folder()],
    });
    await service.requestMovies('u1', [157336]);

    // a fresh process, same database, the fetcher now working
    online = true;
    const fresh = fetcher('archive');
    const { service: restarted } = build({
      providers: [fresh, folder()],
      rows,
    });
    await restarted.reconsiderWaiting();

    expect(rows[0].source).toBe('archive');
    expect(fresh.starts).toBe(1);

    // and a second restart does not start it again
    const { service: again } = build({ providers: [fresh, folder()], rows });
    await again.reconsiderWaiting();
    expect(fresh.starts).toBe(1);
  });
});

describe('who gets to see what is wrong', () => {
  it.each([Role.ADULT, Role.CHILD, undefined])(
    'shows %s only whether search works, nothing technical',
    async (role) => {
      const { service } = build({});

      const family = await service.health(role);

      expect(Object.keys(family).sort()).toEqual([
        'catalog',
        'jellyfin',
        'ready',
      ]);
      expect(JSON.stringify(family)).not.toMatch(
        /storage|acquisition|provider|mount|drive|incoming|detail/i,
      );
    },
  );

  it('shows an admin the library drive and the providers', async () => {
    const { service } = build({});

    const admin = (await service.health(Role.ADMIN)) as any;

    expect(admin.storage).toBeDefined();
    expect(admin.acquisition).toBeDefined();
  });
});

describe('providers tidying up after themselves', () => {
  const tidier = (seen: MediaRequest[][]): AcquisitionSource => ({
    name: 'tidy',
    label: 'Tidy',
    automatic: true,
    supports: () => true,
    available: async () => true,
    start: async () => ({
      status: MediaStatus.ACQUIRING,
      note: 'Adding it to the library',
      ref: 'r',
    }),
    // the first request finishes; the second is still going
    poll: async (r) =>
      r.id === 'a'
        ? { status: MediaStatus.IMPORTING, note: 'Almost ready' }
        : null,
    tidy: async (inFlight) => {
      seen.push(inFlight);
    },
  });
  const row = (id: string) => ({
    id,
    kind: MediaKind.MOVIE,
    catalogId: 1,
    title: id,
    label: id,
    status: MediaStatus.ACQUIRING,
    source: 'tidy',
    sourceRef: 'r',
  });

  it('is told only about what is still in flight after this round', async () => {
    const seen: MediaRequest[][] = [];
    const { service } = build({
      providers: [tidier(seen)],
      rows: [row('a'), row('b')],
    });

    await service.pollProviders();

    // "a" moved on in this very round, so it is not on the list
    expect(seen).toHaveLength(1);
    expect(seen[0].map((r) => r.id)).toEqual(['b']);
  });

  it('is not asked to tidy at all if the list could not be read', async () => {
    const seen: MediaRequest[][] = [];
    const { service, prisma } = build({
      providers: [tidier(seen)],
      rows: [row('b')],
    });
    const real = prisma.mediaRequest.findMany;
    let calls = 0;
    prisma.mediaRequest.findMany = jest.fn(async (args: any) => {
      // the poll's own read works; the fresh read for tidying fails
      if (++calls > 1) throw new Error('database went away');
      return real(args);
    });

    await service.pollProviders();

    expect(seen).toHaveLength(0);
  });
});
