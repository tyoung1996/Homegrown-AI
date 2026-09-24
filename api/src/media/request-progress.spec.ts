/**
 * How a request is getting on, as the family hears it: measured progress
 * only, and "ready" only once Jellyfin has it — told once, to whoever asked.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaKind, MediaRequest, MediaStatus } from '@prisma/client';

jest.mock('./storage', () => ({
  ...jest.requireActual<typeof import('./storage')>('./storage'),
  libraryWritable: () => ({ ok: true }),
}));

import { requestLine, spokenRequest } from './request-words';
import { MediaService } from './media.service';
import { encodeRef } from './internet-archive';

const base = {
  kind: MediaKind.MOVIE,
  title: 'Harbour Lights',
  seasonNumber: null,
  episodeNumber: null,
  progress: null,
};

describe('saying where a request stands', () => {
  it.each<[MediaStatus, number | null, string]>([
    [MediaStatus.REQUESTED, null, 'Harbour Lights is on the list.'],
    [MediaStatus.SEARCHING, null, 'Looking for Harbour Lights.'],
    [
      MediaStatus.ACQUIRING,
      null,
      'Harbour Lights is being added to the library.',
    ],
    [
      MediaStatus.ACQUIRING,
      63.8,
      'Harbour Lights is downloading — about 63% complete.',
    ],
    [
      MediaStatus.ACQUIRING,
      0,
      "Harbour Lights is downloading — it's only just started.",
    ],
    [
      MediaStatus.ACQUIRING,
      100,
      'Harbour Lights is downloading — about 99% complete.',
    ],
    [MediaStatus.IMPORTING, null, 'Harbour Lights is almost ready.'],
    [MediaStatus.AVAILABLE, null, 'Harbour Lights is ready to watch.'],
    [MediaStatus.UNAVAILABLE, null, "I couldn't add Harbour Lights."],
  ])('%s at %p', (status, progress, line) => {
    expect(requestLine({ ...base, status, progress })).toBe(line);
  });

  it('names the part of a show that was asked for', () => {
    const show = { ...base, title: 'Night Shift' };
    expect(spokenRequest({ ...show, kind: MediaKind.SERIES })).toBe(
      'Night Shift',
    );
    expect(
      spokenRequest({ ...show, kind: MediaKind.SEASON, seasonNumber: 2 }),
    ).toBe('Night Shift Season 2');
    expect(
      requestLine({
        ...show,
        kind: MediaKind.EPISODE,
        seasonNumber: 3,
        episodeNumber: 4,
        status: MediaStatus.AVAILABLE,
      }),
    ).toBe('Night Shift Season 3 Episode 4 is ready to watch.');
  });
});

// ------------------------------------------------ the requests themselves

type Row = Record<string, any>;
function service(rows: Row[], poll?: (r: MediaRequest) => unknown) {
  const matches = (r: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'in' in v)
        return (v.in as unknown[]).includes(r[k]);
      return r[k] === v;
    });
  const prisma = {
    mediaRequest: {
      findMany: jest.fn(async ({ where }: { where: Row }) =>
        rows.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      ),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return { ...r };
      }),
      updateMany: jest.fn(
        async ({ where, data }: { where: Row; data: Row }) => {
          const hit = rows.filter((r) => matches(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        },
      ),
    },
  };
  const sources = {
    byName: () => ({ name: 'archive', poll }),
    pollFor: async (_s: unknown, r: MediaRequest) => poll?.(r) ?? null,
    tidy: async () => undefined,
    sources: () => [],
  };
  const s = new MediaService(
    prisma as never,
    {} as never,
    {} as never,
    sources as never,
    {} as never,
    {} as never,
  );
  (s as unknown as { tidyProviders: () => Promise<void> }).tidyProviders =
    async () => undefined;
  return { s, rows, prisma };
}

const row = (over: Row): Row => ({
  id: 'r1',
  userId: 'ann',
  kind: MediaKind.MOVIE,
  catalogId: 1,
  title: 'Harbour Lights',
  label: 'Harbour Lights (1951)',
  year: 1951,
  posterUrl: null,
  seasonNumber: null,
  episodeNumber: null,
  status: MediaStatus.ACQUIRING,
  statusNote: null,
  adminNote: null,
  source: 'archive',
  sourceRef: null,
  progress: null,
  readySeenAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  user: { displayName: 'Ann' },
  ...over,
});

describe('progress', () => {
  it('a measured percentage is kept even while the stage stays the same', async () => {
    const { s, rows } = service([row({})], () => ({
      status: MediaStatus.ACQUIRING,
      note: 'Adding it to the library',
      progress: 41,
    }));
    await s.pollProviders();
    expect(rows[0].progress).toBe(41);
    const [view] = await s.waiting('ann');
    expect(view.line).toBe(
      'Harbour Lights is downloading — about 41% complete.',
    );
    expect(view.progress).toBe(41);
  });

  it('no percentage is shown once it has moved past acquiring', async () => {
    const { s } = service([
      row({ status: MediaStatus.IMPORTING, progress: 99 }),
    ]);
    const [view] = await s.waiting('ann');
    expect(view.progress).toBeNull();
    expect(view.line).toBe('Harbour Lights is almost ready.');
  });

  it('the family view never carries the technical note', async () => {
    const { s } = service([
      row({ adminNote: 'archive: GET /download/x -> 503 at /srv/media/_work' }),
    ]);
    const [view] = await s.waiting('ann');
    expect(JSON.stringify(view)).not.toMatch(/503|srv|archive:/);
  });
});

describe('ready, and telling the person who asked', () => {
  it('lists only their own newly ready requests, and only until told', async () => {
    const { s } = service([
      row({ id: 'a', status: MediaStatus.AVAILABLE }),
      row({ id: 'b', status: MediaStatus.AVAILABLE, userId: 'ben' }),
      row({ id: 'c', status: MediaStatus.AVAILABLE, readySeenAt: new Date() }),
      row({ id: 'd', status: MediaStatus.IMPORTING }),
    ]);
    expect((await s.newlyReady('ann')).map((r) => r.id)).toEqual(['a']);
    expect((await s.newlyReady('ann'))[0].line).toBe(
      'Harbour Lights is ready to watch.',
    );

    expect(await s.markReadySeen('ann', ['b'])).toBe(0); // not theirs
    expect(await s.markReadySeen('ann')).toBe(1);
    expect(await s.newlyReady('ann')).toEqual([]);
    expect((await s.newlyReady('ben')).map((r) => r.id)).toEqual(['b']);
  });

  it('is only ever marked by Jellyfin seeing it, which also makes it news again', async () => {
    const { s, rows } = service([
      row({
        status: MediaStatus.IMPORTING,
        readySeenAt: new Date(0),
        progress: 97,
      }),
    ]);
    (s as unknown as { seenByJellyfin: () => Promise<string> }).seenByJellyfin =
      async () => 'jf-1';
    await s.confirmImported();
    expect(rows[0]).toMatchObject({
      status: MediaStatus.AVAILABLE,
      readySeenAt: null,
      progress: null,
      jellyfinId: 'jf-1',
    });
  });

  it('nothing is ready while Jellyfin cannot see it', async () => {
    const { s, rows } = service([row({ status: MediaStatus.IMPORTING })]);
    (s as unknown as { seenByJellyfin: () => Promise<null> }).seenByJellyfin =
      async () => null;
    await s.confirmImported();
    expect(rows[0].status).toBe(MediaStatus.IMPORTING);
    expect(await s.newlyReady('ann')).toEqual([]);
  });
});

describe('the public-domain archive source', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-progress-'));
    process.env.MEDIA_ROOT = root;
    process.env.MEDIA_DROPBOX = path.join(root, '_incoming');
    process.env.IA_WORK_DIR = path.join(root, '_work');
    process.env.IA_ENABLED = 'true';
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('reports the bytes it has actually received, as a percentage', async () => {
    const { InternetArchiveSource } = jest.requireActual<
      typeof import('./internet-archive.source')
    >('./internet-archive.source');
    const src = new InternetArchiveSource() as unknown as {
      running: Set<string>;
      jobs: Map<string, { received: number; total: number }>;
      poll: (
        r: MediaRequest,
      ) => Promise<{ status: string; progress?: number } | null>;
    };
    const ref = { id: 'harbour_lights_1951', file: 'harbour.mp4', size: 1000 };
    const key = encodeRef(ref);
    src.running.add(key);
    src.jobs.set(key, { received: 634, total: 1000 });

    const got = await src.poll({ id: 'r1', sourceRef: key } as MediaRequest);

    expect(got).toMatchObject({ status: MediaStatus.ACQUIRING, progress: 63 });
  });
});
