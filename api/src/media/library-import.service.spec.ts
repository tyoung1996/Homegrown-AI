import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaStatus } from '@prisma/client';

// paths.ts reads the environment when it loads, so point it at a scratch
// folder before anything imports it
let root: string;
let dropbox: string;
let LibraryImportService: any;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-media-'));
  dropbox = path.join(root, '_incoming');
  await fs.mkdir(dropbox, { recursive: true });
  process.env.MEDIA_ROOT = root;
  process.env.MEDIA_DROPBOX = dropbox;
  process.env.MEDIA_SETTLE_MS = '0';
  jest.resetModules();
  LibraryImportService =
    require('./library-import.service').LibraryImportService;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function services(match: any = null) {
  const media = {
    matchFile: jest.fn(async () => match),
    setStatus: jest.fn<Promise<void>, unknown[]>(async () => undefined),
    markImported: jest.fn(async () => undefined),
    // only Jellyfin seeing the file marks something ready; the sweep asks
    // after every pass
    confirmImported: jest.fn(async () => []),
    pollProviders: jest.fn(async () => 0),
    reconsiderWaiting: jest.fn(async () => 0),
  };
  const jellyfin = { refreshLibrary: jest.fn(async () => undefined) };
  return { media, jellyfin };
}

const drop = async (name: string, bytes = 32) => {
  const file = path.join(dropbox, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(bytes, 1));
  return file;
};

const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));

describe('LibraryImportService', () => {
  it('waits for a file to stop growing before touching it', async () => {
    process.env.MEDIA_SETTLE_MS = '60000';
    jest.resetModules();
    const Svc = require('./library-import.service').LibraryImportService;
    const { media, jellyfin } = services();
    const svc = new Svc(media, jellyfin);
    await drop('Interstellar.2014.1080p.mkv');

    const first = await svc.sweep();
    expect(first.imported).toEqual([]);
    expect(first.waiting).toEqual(['Interstellar.2014.1080p.mkv']);

    const second = await svc.sweep();
    expect(second.imported).toEqual([]);
    expect(
      await exists(path.join(dropbox, 'Interstellar.2014.1080p.mkv')),
    ).toBe(true);
  });

  it('files a film where jellyfin looks for it and refreshes the library', async () => {
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);
    await drop('Interstellar.2014.1080p.BluRay.x264.mkv');

    await svc.sweep(); // first pass records the size
    const out = await svc.sweep(); // second pass imports it

    expect(out.imported).toEqual([
      'Movies/Interstellar (2014)/Interstellar (2014).mkv',
    ]);
    expect(
      await exists(
        path.join(root, 'Movies/Interstellar (2014)/Interstellar (2014).mkv'),
      ),
    ).toBe(true);
    expect(
      await exists(
        path.join(dropbox, 'Interstellar.2014.1080p.BluRay.x264.mkv'),
      ),
    ).toBe(false);
    expect(jellyfin.refreshLibrary).toHaveBeenCalled();
  });

  it('files an episode into its season folder', async () => {
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);
    await drop('The.Office.S03E07.1080p.mkv');

    await svc.sweep();
    const out = await svc.sweep();

    expect(out.imported).toEqual([
      'Shows/The Office/Season 03/The Office - S03E07.mkv',
    ]);
  });

  it('marks the request it answers as almost ready, not ready', async () => {
    const { media, jellyfin } = services({ id: 'req1' });
    const svc = new LibraryImportService(media, jellyfin);
    await drop('Interstellar.2014.mkv');

    await svc.sweep();
    await svc.sweep();

    expect(media.setStatus).toHaveBeenCalledWith(
      'req1',
      MediaStatus.IMPORTING,
      expect.any(String),
    );
    expect(media.markImported).toHaveBeenCalledWith(
      'req1',
      path.join(root, 'Movies/Interstellar (2014)/Interstellar (2014).mkv'),
    );
  });

  it('leaves a file it cannot read the name of', async () => {
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);
    await drop('.mkv');

    await svc.sweep();
    const out = await svc.sweep();

    expect(out.imported).toEqual([]);
    expect(await exists(path.join(dropbox, '.mkv'))).toBe(true);
  });

  it('ignores files that are not video', async () => {
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);
    await drop('notes.txt');
    await drop('poster.jpg');

    await svc.sweep();
    const out = await svc.sweep();

    expect(out.imported).toEqual([]);
    expect(out.waiting).toEqual([]);
  });

  it('does not overwrite something already in the library', async () => {
    const { media, jellyfin } = services({ id: 'req2' });
    const svc = new LibraryImportService(media, jellyfin);
    const dest = path.join(
      root,
      'Movies/Interstellar (2014)/Interstellar (2014).mkv',
    );
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, 'the copy we already had');
    await drop('Interstellar.2014.mkv');

    await svc.sweep();
    await svc.sweep();

    expect(await fs.readFile(dest, 'utf8')).toBe('the copy we already had');
    expect(media.markImported).toHaveBeenCalled();
  });
});

describe('with the library drive missing', () => {
  // the drive is expected at the library root, and the mount table says it
  // is not there — the state the server booted into that night
  const unmount = async () => {
    const mounts = path.join(root, 'mounts');
    await fs.writeFile(mounts, '/dev/sdb2 / ext4 rw 0 0\n');
    process.env.MEDIA_MOUNT = root;
    process.env.MEDIA_MOUNTS_FILE = mounts;
    jest.resetModules();
    LibraryImportService =
      require('./library-import.service').LibraryImportService;
  };
  afterEach(() => {
    delete process.env.MEDIA_MOUNT;
    delete process.env.MEDIA_MOUNTS_FILE;
  });

  it('does not create the drop folder on the system disk', async () => {
    await fs.rm(dropbox, { recursive: true, force: true });
    await unmount();
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);

    await svc.sweep();

    expect(await exists(dropbox)).toBe(false);
  });

  it('files nothing, even with a file sitting there', async () => {
    const file = await drop('Interstellar.2014.1080p.mkv');
    await unmount();
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);

    await svc.sweep();
    await svc.sweep();

    expect(await exists(file)).toBe(true);
    expect(await exists(path.join(root, 'Movies'))).toBe(false);
    expect(media.markImported).not.toHaveBeenCalled();
    // and nothing else that might write is started either
    expect(media.pollProviders).not.toHaveBeenCalled();
    expect(media.reconsiderWaiting).not.toHaveBeenCalled();
  });

  it('still asks Jellyfin about what is already filed, which only reads', async () => {
    await unmount();
    const { media, jellyfin } = services();
    const svc = new LibraryImportService(media, jellyfin);

    await svc.sweep();

    expect(media.confirmImported).toHaveBeenCalled();
  });
});

describe('what the family is told when an import goes wrong', () => {
  it('puts it back on the list with a family sentence, and the reason for the admin', async () => {
    const file = await drop('Interstellar.2014.1080p.mkv');
    const { media, jellyfin } = services({
      id: 'r1',
      label: 'Interstellar (2014)',
    });
    const svc = new LibraryImportService(media, jellyfin);
    // make the move fail: the films folder cannot be created because a
    // plain file is sitting where it should be
    await fs.writeFile(path.join(root, 'Movies'), 'not a folder');

    await svc.sweep(); // first look: waits for the file to settle
    await svc.sweep(); // second look: tries to file it, and fails

    const last = media.setStatus.mock.calls.at(-1)!;
    expect(last[1]).toBe(MediaStatus.REQUESTED);
    expect(last[2]).toBe(
      "On the list — we'll let you know when it's ready to watch.",
    );
    expect(last[2]).not.toMatch(/file|server|log/i);
    expect(last[3]).toMatch(/import failed/);
    expect(await exists(file)).toBe(true);
  });
});
