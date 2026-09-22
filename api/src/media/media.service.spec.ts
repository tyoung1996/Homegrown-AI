import { MediaKind, MediaStatus, Role } from '@prisma/client';
import { MediaService } from './media.service';

// small stand-ins for the real services; every test says what the catalogue
// and the shelf contain, then checks what the list does about it
function build(opts: {
  shelf?: { type: 'Movie' | 'Series'; catalogId: number; id: string }[];
  shelfEpisodes?: { seasonNumber: number; episodeNumber: number }[];
  rows?: any[];
  sourceAvailable?: boolean;
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
          user: { displayName: 'Tyler' },
        };
        rows.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return { ...row, user: { displayName: 'Tyler' } };
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
    seasons: jest.fn(async () => [
      { seasonNumber: 1, name: 'Season 1', episodeCount: 6 },
      { seasonNumber: 3, name: 'Season 3', episodeCount: 25 },
    ]),
    episodes: jest.fn(async () => []),
    searchMovies: jest.fn(async () => []),
    searchSeries: jest.fn(async () => []),
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
    health: jest.fn(async () => ({ configured: true, ok: true })),
  };

  const sources: any = {
    pick: jest.fn(async () =>
      opts.sourceAvailable === false
        ? null
        : {
            name: 'drop-folder',
            label: 'Watched folder',
            start: async () => ({
              status: MediaStatus.REQUESTED,
              note: 'On the list',
            }),
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

  return {
    service: new MediaService(prisma, catalog, jellyfin, sources, screens),
    prisma,
    rows,
    jellyfin,
    catalog,
    screens,
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
          user: { displayName: 'Emilie' },
        },
      ],
    });
    const [outcome] = await service.requestMovies('u1', [157336]);

    expect(outcome.result).toBe('already-requested');
    expect(rows).toHaveLength(1);
    if (outcome.result === 'already-requested') {
      expect(outcome.request.requestedBy).toBe('Emilie');
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
