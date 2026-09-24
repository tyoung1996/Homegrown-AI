import { MediaKind, MediaRequest, MediaStatus } from '@prisma/client';
import {
  AcquisitionRegistry,
  AcquisitionSource,
  DropFolderSource,
  ProviderResult,
} from './acquisition';

// a provider that does whatever the test needs it to
function fake(
  name: string,
  opts: {
    kinds?: MediaKind[];
    up?: boolean;
    result?: ProviderResult;
    throwsOnStart?: boolean;
    throwsOnAvailable?: boolean;
    throwsOnSupports?: boolean;
    poll?: ProviderResult | null;
    throwsOnPoll?: boolean;
    health?: { ok: boolean; detail?: string };
  } = {},
): AcquisitionSource & { started: string[] } {
  const started: string[] = [];
  return {
    name,
    label: `${name} provider`,
    started,
    supports: (kind: MediaKind) => {
      if (opts.throwsOnSupports) throw new Error('boom');
      return (opts.kinds ?? Object.values(MediaKind)).includes(kind);
    },
    available: async () => {
      if (opts.throwsOnAvailable) throw new Error('cannot reach it');
      return opts.up !== false;
    },
    start: async (request: MediaRequest) => {
      if (opts.throwsOnStart) throw new Error('it fell over');
      started.push(request.id);
      return (
        opts.result ?? { status: MediaStatus.ACQUIRING, note: 'Working on it' }
      );
    },
    ...(opts.poll !== undefined || opts.throwsOnPoll
      ? {
          poll: async () => {
            if (opts.throwsOnPoll) throw new Error('no idea');
            return opts.poll ?? null;
          },
        }
      : {}),
    ...(opts.health ? { health: async () => opts.health! } : {}),
  };
}

const request = (kind: MediaKind = MediaKind.MOVIE): MediaRequest =>
  ({ id: 'r1', label: 'Interstellar (2014)', kind }) as MediaRequest;

const ORIGINAL_ORDER = process.env.ACQUISITION_ORDER;
afterEach(() => {
  if (ORIGINAL_ORDER === undefined) delete process.env.ACQUISITION_ORDER;
  else process.env.ACQUISITION_ORDER = ORIGINAL_ORDER;
});

describe('providers living side by side', () => {
  it('keeps several registered at once', () => {
    const registry = new AcquisitionRegistry([fake('a'), fake('b')]);

    expect(registry.sources().map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('picks the same one every time, given the same providers', async () => {
    const registry = new AcquisitionRegistry([fake('a'), fake('b')]);

    const picks = await Promise.all([
      registry.pickFor(MediaKind.MOVIE),
      registry.pickFor(MediaKind.MOVIE),
      registry.pickFor(MediaKind.MOVIE),
    ]);

    expect(picks.map((p) => p?.name)).toEqual(['a', 'a', 'a']);
  });

  it('prefers the order it was configured in, not the order it was built in', async () => {
    process.env.ACQUISITION_ORDER = 'b';
    const registry = new AcquisitionRegistry([fake('a'), fake('b')]);

    expect((await registry.pickFor(MediaKind.MOVIE))?.name).toBe('b');
    expect(registry.sources().map((s) => s.name)).toEqual(['b', 'a']);
  });

  it('leaves unnamed providers behind the named ones, in registration order', () => {
    process.env.ACQUISITION_ORDER = 'c';
    const registry = new AcquisitionRegistry([fake('a'), fake('b'), fake('c')]);

    expect(registry.sources().map((s) => s.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('sending a request to a provider that can handle it', () => {
  it('routes by what each provider says it handles', async () => {
    const films = fake('films', { kinds: [MediaKind.MOVIE] });
    const shows = fake('shows', {
      kinds: [MediaKind.SERIES, MediaKind.SEASON, MediaKind.EPISODE],
    });
    const registry = new AcquisitionRegistry([films, shows]);

    expect((await registry.pickFor(MediaKind.MOVIE))?.name).toBe('films');
    expect((await registry.pickFor(MediaKind.SERIES))?.name).toBe('shows');
    expect((await registry.pickFor(MediaKind.SEASON))?.name).toBe('shows');
    expect((await registry.pickFor(MediaKind.EPISODE))?.name).toBe('shows');
  });

  it('has nobody for a kind no provider handles', async () => {
    const registry = new AcquisitionRegistry([
      fake('films', { kinds: [MediaKind.MOVIE] }),
    ]);

    expect(await registry.pickFor(MediaKind.EPISODE)).toBeNull();
  });

  it('skips a provider that is down and uses one that is not', async () => {
    const down = fake('down', { up: false });
    const up = fake('up');
    const registry = new AcquisitionRegistry([down, up]);

    expect((await registry.pickFor(MediaKind.MOVIE))?.name).toBe('up');
  });

  it('treats a provider that cannot be asked as down, not as an error', async () => {
    const registry = new AcquisitionRegistry([
      fake('broken', { throwsOnAvailable: true }),
      fake('fine'),
    ]);

    expect((await registry.pickFor(MediaKind.MOVIE))?.name).toBe('fine');
  });

  it('ignores a provider that cannot even say what it handles', async () => {
    const registry = new AcquisitionRegistry([
      fake('broken', { throwsOnSupports: true }),
      fake('fine'),
    ]);

    expect(registry.capableOf(MediaKind.MOVIE).map((s) => s.name)).toEqual([
      'fine',
    ]);
  });

  it('gives up cleanly when every provider is down', async () => {
    const registry = new AcquisitionRegistry([
      fake('a', { up: false }),
      fake('b', { up: false }),
    ]);

    expect(await registry.pickFor(MediaKind.MOVIE)).toBeNull();
  });
});

describe('the rule no provider may break', () => {
  it('will not let a provider call something ready to watch', async () => {
    const liar = fake('liar', {
      // a provider that ignores the type and says it is done
      result: { status: MediaStatus.AVAILABLE, note: 'Done!' } as never,
    });
    const registry = new AcquisitionRegistry([liar]);

    const out = await registry.handOff(liar, request());

    expect(out.status).toBe(MediaStatus.IMPORTING);
    expect(out.status).not.toBe(MediaStatus.AVAILABLE);
  });

  it('lets a provider get as far as almost ready', async () => {
    const p = fake('p', {
      result: { status: MediaStatus.IMPORTING, note: 'Almost ready' },
    });
    const registry = new AcquisitionRegistry([p]);

    expect((await registry.handOff(p, request())).status).toBe(
      MediaStatus.IMPORTING,
    );
  });

  it('turns a provider falling over into something the family can read', async () => {
    const p = fake('p', { throwsOnStart: true });
    const registry = new AcquisitionRegistry([p]);

    const out = await registry.handOff(p, request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.note).not.toMatch(/fell over|error|stack/i);
    expect(out.note).toMatch(/couldn't add it/i);
  });

  it('keeps the provider reference it hands back, for it to recognise later', async () => {
    const p = fake('p', {
      result: {
        status: MediaStatus.ACQUIRING,
        note: 'Working on it',
        ref: 'their-id-42',
      },
    });
    const registry = new AcquisitionRegistry([p]);

    expect((await registry.handOff(p, request())).ref).toBe('their-id-42');
  });
});

describe('asking a provider how it is getting on', () => {
  it('says nothing for a provider that does not do progress', async () => {
    const p = fake('p');
    const registry = new AcquisitionRegistry([p]);

    expect(await registry.pollFor(p, request())).toBeNull();
  });

  it('passes on progress, held to the same rule', async () => {
    const p = fake('p', {
      poll: { status: MediaStatus.AVAILABLE, note: 'All done' } as never,
    });
    const registry = new AcquisitionRegistry([p]);

    expect((await registry.pollFor(p, request()))?.status).toBe(
      MediaStatus.IMPORTING,
    );
  });

  it('shrugs off a provider that cannot answer', async () => {
    const p = fake('p', { throwsOnPoll: true });
    const registry = new AcquisitionRegistry([p]);

    expect(await registry.pollFor(p, request())).toBeNull();
  });
});

describe('what the admin panel is told', () => {
  it('reports each provider, what it handles and whether it works', async () => {
    const registry = new AcquisitionRegistry([
      fake('films', { kinds: [MediaKind.MOVIE] }),
      fake('down', { up: false, health: { ok: false, detail: 'no key set' } }),
    ]);

    const report = await registry.report();

    expect(report[0]).toMatchObject({
      name: 'films',
      ok: true,
      kinds: [MediaKind.MOVIE],
    });
    expect(report[1]).toMatchObject({
      name: 'down',
      ok: false,
      detail: 'no key set',
    });
  });

  it('says which provider would take each sort of request', async () => {
    const registry = new AcquisitionRegistry([
      fake('films', { kinds: [MediaKind.MOVIE] }),
      fake('shows', { kinds: [MediaKind.SERIES, MediaKind.SEASON] }),
    ]);

    expect(await registry.routing()).toEqual({
      MOVIE: 'films',
      SERIES: 'shows',
      SEASON: 'shows',
      EPISODE: null,
    });
  });

  it('finds a provider by the name stored on a request', () => {
    const registry = new AcquisitionRegistry([fake('films')]);

    expect(registry.byName('films')?.name).toBe('films');
    expect(registry.byName('FILMS')?.name).toBe('films');
    expect(registry.byName('gone')).toBeNull();
    expect(registry.byName(null)).toBeNull();
  });
});

describe('the watched folder still works', () => {
  // held as the interface, which is how the registry sees it
  const drop: AcquisitionSource = new DropFolderSource();

  it('takes on anything, because a file is a file', () => {
    for (const kind of Object.values(MediaKind)) {
      expect(drop.supports(kind)).toBe(true);
    }
  });

  it('puts a request on the list and waits', async () => {
    const out = await drop.start(request());

    expect(out.status).toBe(MediaStatus.REQUESTED);
    expect(out.note).toMatch(/once the file is added/i);
  });

  it('is the one that gets used when it is the only one registered', async () => {
    const registry = new AcquisitionRegistry([drop]);

    expect((await registry.pickFor(MediaKind.EPISODE))?.name).toBe(
      'drop-folder',
    );
  });

  it('never claims something is ready to watch', async () => {
    const registry = new AcquisitionRegistry([drop]);

    const out = await registry.handOff(drop, request());

    expect(out.status).not.toBe(MediaStatus.AVAILABLE);
  });
});

describe('the watched folder with its drive missing', () => {
  afterEach(() => {
    delete process.env.MEDIA_MOUNT;
    delete process.env.MEDIA_MOUNTS_FILE;
  });

  it('is unavailable, and does not create its folder on the system disk', async () => {
    const fsp = require('fs').promises;
    const os = require('os');
    const path = require('path');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cb-drop-'));
    const mounts = path.join(root, 'mounts');
    await fsp.writeFile(mounts, '/dev/sdb2 / ext4 rw 0 0\n');
    process.env.MEDIA_ROOT = root;
    process.env.MEDIA_DROPBOX = path.join(root, '_incoming');
    process.env.MEDIA_MOUNT = root;
    process.env.MEDIA_MOUNTS_FILE = mounts;
    jest.resetModules();
    const { DropFolderSource: Fresh } = require('./acquisition');

    expect(await new Fresh().available()).toBe(false);
    expect(
      await fsp.stat(path.join(root, '_incoming')).catch(() => null),
    ).toBeNull();
    await fsp.rm(root, { recursive: true, force: true });
  });
});
