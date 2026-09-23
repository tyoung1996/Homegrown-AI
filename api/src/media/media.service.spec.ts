import { MediaKind, MediaStatus, Role } from '@prisma/client';
import { MediaService } from './media.service';

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
  /** what the acquisition source reports when handed a request */
  sourceResult?: { status: MediaStatus; note: string };
  /** the source blows up when asked to take something on */
  sourceThrows?: boolean;
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

  const sources: any = {
    pick: jest.fn(async () =>
      opts.sourceAvailable === false
        ? null
        : {
            name: 'drop-folder',
            label: 'Watched folder',
            start: async () => {
              if (opts.sourceThrows) throw new Error('the provider is offline');
              return (
                opts.sourceResult ?? {
                  status: MediaStatus.REQUESTED,
                  note: 'On the list',
                }
              );
            },
          },
    ),
  };

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
    expect(rows[0].source).toBe('drop-folder');
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

  it('marks a request unavailable when nothing can bring files in', async () => {
    const { service, rows } = build({ sourceAvailable: false });
    await service.requestMovies('u1', [157336]);

    expect(rows[0].status).toBe(MediaStatus.UNAVAILABLE);
    expect(rows[0].statusNote).toMatch(/no way to add files/i);
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
  it('keeps the request when the provider refuses to take it', async () => {
    const { service, rows } = build({ sourceThrows: true });

    await expect(service.requestMovies('u1', [157336])).rejects.toThrow();

    // the ask is not lost just because the provider fell over
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('Interstellar (2014)');
  });

  it('still takes the request when there is no provider at all', async () => {
    const { service } = build({ sourceAvailable: false });

    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('queued');
    if (outcome.result === 'queued') {
      expect(outcome.request.status).toBe(MediaStatus.UNAVAILABLE);
      expect(outcome.request.statusText).toBe("Couldn't add it");
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
