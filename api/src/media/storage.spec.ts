import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// the storage checks read the mount table and fstab; each test writes its
// own versions of both, so no test depends on the machine it runs on
let root: string;
let mod: typeof import('./storage');

async function setup(opts: {
  fstab?: string;
  mounts?: string;
  mountEnv?: string;
  folders?: string[];
  name?: string;
}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-storage-'));
  const lib = path.join(root, opts.name ?? 'drive');
  await fs.mkdir(lib, { recursive: true });
  for (const f of opts.folders ?? ['movies', 'shows', '_incoming']) {
    await fs.mkdir(path.join(lib, f), { recursive: true });
  }
  const fstab = path.join(root, 'fstab');
  const mounts = path.join(root, 'mounts');
  await fs.writeFile(fstab, (opts.fstab ?? '').replace(/LIB/g, lib));
  await fs.writeFile(mounts, (opts.mounts ?? '').replace(/LIB/g, lib));
  process.env.MEDIA_ROOT = lib;
  process.env.MEDIA_DROPBOX = path.join(lib, '_incoming');
  process.env.MEDIA_MOVIES_SUBDIR = 'movies';
  process.env.MEDIA_SHOWS_SUBDIR = 'shows';
  process.env.MEDIA_FSTAB_FILE = fstab;
  process.env.MEDIA_MOUNTS_FILE = mounts;
  if (opts.mountEnv)
    process.env.MEDIA_MOUNT = opts.mountEnv.replace(/LIB/g, lib);
  else delete process.env.MEDIA_MOUNT;
  jest.resetModules();
  mod = require('./storage') as typeof import('./storage');
  return lib;
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  for (const k of ['MEDIA_MOUNT', 'MEDIA_FSTAB_FILE', 'MEDIA_MOUNTS_FILE']) {
    delete process.env[k];
  }
});

const FSTAB = 'UUID=01DA  LIB  ntfs3  uid=1000,nofail  0 0\n';

describe('is the library drive really there', () => {
  it('knows a drive is expected when fstab mounts one at the library', async () => {
    const lib = await setup({ fstab: FSTAB });
    expect(mod.requiredMount()).toBe(lib);
  });

  it('expects nothing when the library is just a folder', async () => {
    await setup({ fstab: 'UUID=abc / ext4 defaults 0 1\n' });
    expect(mod.requiredMount()).toBeNull();
    expect(mod.libraryWritable().ok).toBe(true);
  });

  it('says mounted and writable when it is', async () => {
    await setup({
      fstab: FSTAB,
      mounts: '/dev/sda1 LIB ntfs3 rw,relatime,uid=1000 0 0\n',
    });
    expect(mod.libraryMount()).toMatchObject({
      mounted: true,
      readOnly: false,
    });
    expect(mod.libraryWritable().ok).toBe(true);

    const h = await mod.storageHealth();
    expect(h).toMatchObject({
      ok: true,
      state: 'mounted',
      movies: true,
      shows: true,
      incoming: true,
      incomingWritable: true,
    });
  });

  it('refuses to write when the drive is missing — even though the folder exists', async () => {
    // exactly the night it went wrong: the folder is there, the drive is not
    await setup({ fstab: FSTAB, mounts: '/dev/sdb2 / ext4 rw 0 0\n' });

    expect(mod.libraryMount().mounted).toBe(false);
    const w = mod.libraryWritable();
    expect(w.ok).toBe(false);
    expect(w.why).toMatch(/not mounted/);

    const h = await mod.storageHealth();
    expect(h.state).toBe('missing');
    expect(h.ok).toBe(false);
  });

  it('refuses to write when the drive came up read-only', async () => {
    await setup({
      fstab: FSTAB,
      mounts: '/dev/sda1 LIB ntfs3 ro,relatime 0 0\n',
    });

    expect(mod.libraryWritable()).toMatchObject({ ok: false });
    expect(mod.libraryWritable().why).toMatch(/read-only/);
    const h = await mod.storageHealth();
    expect(h.state).toBe('read-only');
    expect(h.incomingWritable).toBe(false);
  });

  it('notices a missing library folder on a mounted drive', async () => {
    await setup({
      fstab: FSTAB,
      mounts: '/dev/sda1 LIB ntfs3 rw 0 0\n',
      folders: ['movies', '_incoming'],
    });

    const h = await mod.storageHealth();
    expect(h.ok).toBe(false);
    expect(h.shows).toBe(false);
    expect(h.detail).toMatch(/shows is missing/);
  });

  it('takes MEDIA_MOUNT over fstab when it is set', async () => {
    const lib = await setup({ mountEnv: 'LIB', mounts: '' });
    expect(mod.requiredMount()).toBe(lib);
    expect(mod.libraryWritable().ok).toBe(false);
  });

  it('reads a mount point with a space in it the way the kernel writes it', async () => {
    // the mount table writes a space as \040, and a naive split would read
    // "my" and "drive" as two different fields
    const lib = await setup({ name: 'my drive', mountEnv: 'LIB' });
    await fs.writeFile(
      process.env.MEDIA_MOUNTS_FILE!,
      `/dev/sda1 ${lib.replace(/ /g, '\\040')} ntfs3 rw 0 0\n`,
    );
    expect(mod.libraryMount().mounted).toBe(true);
  });
});
