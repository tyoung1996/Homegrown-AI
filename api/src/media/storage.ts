import { readFileSync, promises as fs } from 'fs';
import * as path from 'path';
import { DROPBOX_DIR, MEDIA_ROOT, MOVIES_SUBDIR, SHOWS_SUBDIR } from './paths';

/**
 * Is the library actually there?
 *
 * The library usually lives on its own drive, mounted at a folder on the
 * system disk. When that drive does not mount — a dirty volume, a loose
 * cable, a boot that gave up waiting — the folder is still there, just
 * empty, and on the wrong disk. Anything written into it then fills the
 * system disk and vanishes from view the moment the real drive comes back.
 *
 * So before anything is written, the mount is checked: by the mount table,
 * not by whether a folder exists, because the whole problem is that a
 * folder always exists.
 */

interface MountEntry {
  point: string;
  options: string[];
}

// the kernel encodes spaces and friends in the mount table
const unescape = (s: string) =>
  s.replace(/\\([0-7]{3})/g, (_m, o: string) =>
    String.fromCharCode(parseInt(o, 8)),
  );

function readTable(file: string): MountEntry[] {
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/))
      .filter((f) => f.length >= 4)
      .map((f) => ({ point: unescape(f[1]), options: f[3].split(',') }));
  } catch {
    return [];
  }
}

const mountsFile = () => process.env.MEDIA_MOUNTS_FILE ?? '/proc/self/mounts';
const fstabFile = () => process.env.MEDIA_FSTAB_FILE ?? '/etc/fstab';

/** The folder that must be a mounted drive for the library to be real, or
 * null when the library is simply a folder on the system disk. Taken from
 * MEDIA_MOUNT if set, otherwise from fstab: if fstab mounts something at or
 * above the library folder, that mount is expected. */
export function requiredMount(): string | null {
  const configured = process.env.MEDIA_MOUNT?.trim();
  if (configured) return path.resolve(configured);
  const root = path.resolve(MEDIA_ROOT);
  const candidates = readTable(fstabFile())
    .map((e) => path.resolve(e.point))
    .filter((p) => p !== '/' && (root === p || root.startsWith(p + path.sep)))
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

export interface LibraryMount {
  /** a separate drive is expected here */
  required: string | null;
  mounted: boolean;
  readOnly: boolean;
}

/** Cheap enough to ask before every write: one read of the mount table. */
export function libraryMount(): LibraryMount {
  const required = requiredMount();
  if (!required) return { required: null, mounted: true, readOnly: false };
  const entry = readTable(mountsFile())
    .reverse() // the last mount at a point is the one in effect
    .find((e) => path.resolve(e.point) === required);
  return {
    required,
    mounted: !!entry,
    readOnly: !!entry && entry.options.includes('ro'),
  };
}

/** May files be written into the library right now? */
export function libraryWritable(): { ok: boolean; why?: string } {
  const m = libraryMount();
  if (!m.mounted) {
    return { ok: false, why: `${m.required} is not mounted` };
  }
  if (m.readOnly)
    return { ok: false, why: `${m.required} is mounted read-only` };
  return { ok: true };
}

const exists = async (p: string) => !!(await fs.stat(p).catch(() => null));

/** Actually writing is the only honest test — permission checks give the
 * wrong answer on some NTFS drivers, so a scratch file is made and removed. */
async function canWrite(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.cb-write-probe-${process.pid}`);
  try {
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

export interface StorageHealth {
  ok: boolean;
  state: 'mounted' | 'read-only' | 'missing' | 'folder';
  mountPoint: string | null;
  movies: boolean;
  shows: boolean;
  incoming: boolean;
  incomingWritable: boolean;
  detail?: string;
}

/** Everything an admin needs to know about the library disk. */
export async function storageHealth(): Promise<StorageHealth> {
  const m = libraryMount();
  const movies = path.join(MEDIA_ROOT, MOVIES_SUBDIR);
  const shows = path.join(MEDIA_ROOT, SHOWS_SUBDIR);
  if (!m.mounted) {
    return {
      ok: false,
      state: 'missing',
      mountPoint: m.required,
      movies: false,
      shows: false,
      incoming: false,
      incomingWritable: false,
      detail: `${m.required} is expected to be a mounted drive and is not — nothing will be written until it is`,
    };
  }
  const [hasMovies, hasShows, hasIncoming] = await Promise.all([
    exists(movies),
    exists(shows),
    exists(DROPBOX_DIR),
  ]);
  const writable = !m.readOnly && hasIncoming && (await canWrite(DROPBOX_DIR));
  const state = !m.required ? 'folder' : m.readOnly ? 'read-only' : 'mounted';
  const problems = [
    m.readOnly && `${m.required} is mounted read-only`,
    !hasMovies && `${movies} is missing`,
    !hasShows && `${shows} is missing`,
    !hasIncoming && `${DROPBOX_DIR} is missing`,
    hasIncoming &&
      !m.readOnly &&
      !writable &&
      `${DROPBOX_DIR} cannot be written to`,
  ].filter(Boolean) as string[];
  return {
    ok: problems.length === 0,
    state,
    mountPoint: m.required,
    movies: hasMovies,
    shows: hasShows,
    incoming: hasIncoming,
    incomingWritable: writable,
    ...(problems.length ? { detail: problems.join('; ') } : {}),
  };
}
