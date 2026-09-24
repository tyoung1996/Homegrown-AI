import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * A pretend machine for each test: an fstab, a kernel mount table, and a
 * /dev/disk tree mapping the library drive's UUID to a device — the same
 * three things the real check reads, so nothing here depends on the laptop
 * or server the tests happen to run on.
 */
let root: string;
let lib: string;
let dev: string;
let mod: typeof import('./storage');

const UUID = '01DA7B9C8EB54550';
const FSTAB = `UUID=${UUID}  LIB  ntfs3  uid=1000,nofail  0 0\n`;
// the library drive, mounted as it should be
const MOUNTED = (opts = 'rw,relatime') => `DEV/sda1 LIB ntfs3 ${opts} 0 0\n`;

async function machine(opts: {
  fstab?: string;
  mounts?: string;
  folders?: string[];
  name?: string;
  mountEnv?: boolean;
}) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-storage-'));
  lib = path.join(root, opts.name ?? 'drive');
  dev = path.join(root, 'dev');
  await fs.mkdir(lib, { recursive: true });
  for (const f of opts.folders ?? ['movies', 'shows', '_incoming']) {
    await fs.mkdir(path.join(lib, f), { recursive: true });
  }
  // two drives exist; the UUID in fstab belongs to sda1
  await fs.mkdir(path.join(dev, 'disk', 'by-uuid'), { recursive: true });
  await fs.writeFile(path.join(dev, 'sda1'), '');
  await fs.writeFile(path.join(dev, 'sdc1'), '');
  await fs.symlink('../../sda1', path.join(dev, 'disk', 'by-uuid', UUID));

  const fill = (t: string) =>
    t.replace(/LIB/g, lib.replace(/ /g, '\\040')).replace(/DEV/g, dev);
  await fs.writeFile(path.join(root, 'fstab'), fill(opts.fstab ?? ''));
  await fs.writeFile(path.join(root, 'mounts'), fill(opts.mounts ?? ''));

  process.env.MEDIA_ROOT = lib;
  process.env.MEDIA_DROPBOX = path.join(lib, '_incoming');
  process.env.MEDIA_MOVIES_SUBDIR = 'movies';
  process.env.MEDIA_SHOWS_SUBDIR = 'shows';
  process.env.MEDIA_FSTAB_FILE = path.join(root, 'fstab');
  process.env.MEDIA_MOUNTS_FILE = path.join(root, 'mounts');
  process.env.MEDIA_DISK_DIR = path.join(dev, 'disk');
  if (opts.mountEnv) process.env.MEDIA_MOUNT = lib;
  else delete process.env.MEDIA_MOUNT;
  jest.resetModules();
  mod = require('./storage') as typeof import('./storage');
}

afterEach(async () => {
  // put write permission back before removing, in case a test took it away
  await fs.chmod(path.join(lib, '_incoming'), 0o755).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true });
  for (const k of [
    'MEDIA_MOUNT',
    'MEDIA_FSTAB_FILE',
    'MEDIA_MOUNTS_FILE',
    'MEDIA_DISK_DIR',
  ]) {
    delete process.env[k];
  }
});

describe('the library drive, as it should be', () => {
  it('is mounted, is the right drive, and can be written to', async () => {
    await machine({ fstab: FSTAB, mounts: MOUNTED() });

    expect(mod.libraryMount()).toMatchObject({
      required: lib,
      mounted: true,
      expected: true,
      readOnly: false,
    });
    expect(mod.libraryWritable().ok).toBe(true);
    expect(await mod.storageHealth()).toMatchObject({
      ok: true,
      state: 'mounted',
      movies: true,
      shows: true,
      incoming: true,
      incomingWritable: true,
    });
  });

  it('knows it is expected because fstab mounts something at the library', async () => {
    await machine({ fstab: FSTAB });
    expect(mod.requiredMount()).toBe(lib);
  });

  it('expects no drive when the library is a plain folder', async () => {
    await machine({ fstab: 'UUID=abc / ext4 defaults 0 1\n' });
    expect(mod.requiredMount()).toBeNull();
    expect(mod.libraryWritable().ok).toBe(true);
    expect((await mod.storageHealth()).state).toBe('folder');
  });
});

describe('the library drive, when it is not right', () => {
  it('refuses to write when the right drive is mounted read-only', async () => {
    await machine({ fstab: FSTAB, mounts: MOUNTED('ro,relatime') });

    const w = mod.libraryWritable();
    expect(w.ok).toBe(false);
    expect(w.why).toMatch(/read-only/);
    const h = await mod.storageHealth();
    expect(h.state).toBe('read-only');
    expect(h.incomingWritable).toBe(false);
  });

  it('refuses to write when nothing is mounted at all', async () => {
    await machine({ fstab: FSTAB, mounts: '' });

    expect(mod.libraryWritable()).toMatchObject({ ok: false });
    expect(mod.libraryWritable().why).toMatch(/not mounted/);
    expect((await mod.storageHealth()).state).toBe('missing');
  });

  it('refuses to write into the empty folder left when the drive does not mount', async () => {
    // the night it went wrong: the folder is there, writable, on the system
    // disk — and the drive that belongs there is not
    await machine({ fstab: FSTAB, mounts: `DEV/sdb2 / ext4 rw 0 0\n` });
    const probe = path.join(lib, '_incoming', 'x');
    await fs.writeFile(probe, 'the folder itself is perfectly writable');
    await fs.unlink(probe);

    expect(mod.libraryWritable().ok).toBe(false);
    const h = await mod.storageHealth();
    expect(h.state).toBe('missing');
    expect(h.ok).toBe(false);
    // and the health check did not write into it to find out
    expect(await fs.readdir(path.join(lib, '_incoming'))).toEqual([]);
  });

  it('refuses a different drive mounted where the library should be', async () => {
    await machine({ fstab: FSTAB, mounts: `DEV/sdc1 LIB ntfs3 rw 0 0\n` });

    const w = mod.libraryWritable();
    expect(w.ok).toBe(false);
    expect(w.why).toMatch(/sdc1 is mounted/);
    expect(w.why).toMatch(/expects UUID=01DA7B9C8EB54550/);
    expect((await mod.storageHealth()).state).toBe('wrong-drive');
  });

  it('refuses the right drive mounted as the wrong kind of filesystem', async () => {
    await machine({ fstab: FSTAB, mounts: `DEV/sda1 LIB vfat rw 0 0\n` });

    expect(mod.libraryWritable().why).toMatch(
      /mounted as vfat; fstab expects ntfs3/,
    );
    expect((await mod.storageHealth()).state).toBe('wrong-drive');
  });

  it('refuses anything when the library drive is not even plugged in', async () => {
    // fstab names a UUID that no attached device has
    await machine({
      fstab: `UUID=DEADBEEF  LIB  ntfs3  nofail  0 0\n`,
      mounts: MOUNTED(),
    });

    expect(mod.libraryWritable().why).toMatch(/UUID=DEADBEEF is not attached/);
  });
});

describe('the folders on the library drive', () => {
  it('notices the films folder is missing', async () => {
    await machine({
      fstab: FSTAB,
      mounts: MOUNTED(),
      folders: ['shows', '_incoming'],
    });
    const h = await mod.storageHealth();
    expect(h).toMatchObject({ ok: false, movies: false, shows: true });
    expect(h.detail).toMatch(/movies is missing/);
  });

  it('notices the shows folder is missing', async () => {
    await machine({
      fstab: FSTAB,
      mounts: MOUNTED(),
      folders: ['movies', '_incoming'],
    });
    const h = await mod.storageHealth();
    expect(h).toMatchObject({ ok: false, movies: true, shows: false });
    expect(h.detail).toMatch(/shows is missing/);
  });

  it('notices the drop folder is missing', async () => {
    await machine({
      fstab: FSTAB,
      mounts: MOUNTED(),
      folders: ['movies', 'shows'],
    });
    const h = await mod.storageHealth();
    expect(h).toMatchObject({
      ok: false,
      incoming: false,
      incomingWritable: false,
    });
    expect(h.detail).toMatch(/_incoming is missing/);
  });

  it('notices the drop folder cannot be written to', async () => {
    await machine({ fstab: FSTAB, mounts: MOUNTED() });
    await fs.chmod(path.join(lib, '_incoming'), 0o555);

    const h = await mod.storageHealth();
    expect(h).toMatchObject({
      ok: false,
      incoming: true,
      incomingWritable: false,
    });
    expect(h.detail).toMatch(/cannot be written to/);
  });

  it('leaves nothing behind after checking it can write', async () => {
    await machine({ fstab: FSTAB, mounts: MOUNTED() });
    await mod.storageHealth();
    expect(await fs.readdir(path.join(lib, '_incoming'))).toEqual([]);
  });
});

describe('reading the tables', () => {
  it('reads a mount point with a space in it the way the kernel writes it', async () => {
    // the mount table writes a space as \040; a naive split would read
    // "my" and "drive" as two separate fields
    await machine({ name: 'my drive', fstab: FSTAB, mounts: MOUNTED() });
    expect(mod.libraryMount()).toMatchObject({ mounted: true, expected: true });
  });

  it('takes MEDIA_MOUNT over fstab, and can only ask that it is mounted', async () => {
    await machine({ mountEnv: true, mounts: MOUNTED() });
    expect(mod.requiredMount()).toBe(lib);
    expect(mod.libraryWritable().ok).toBe(true);
  });
});
