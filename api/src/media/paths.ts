import * as os from 'os';
import * as path from 'path';

// where the library lives and where new files are picked up from. both are
// plain folders on the server, set in api/.env by the installer.
export const MEDIA_ROOT =
  process.env.MEDIA_ROOT ?? path.join(os.homedir(), 'media');

export const DROPBOX_DIR =
  process.env.MEDIA_DROPBOX ?? path.join(MEDIA_ROOT, '_incoming');

// the folders inside MEDIA_ROOT that jellyfin scans. defaults suit a fresh
// install; point them at an existing library's folder names to file into it
export const MOVIES_SUBDIR = process.env.MEDIA_MOVIES_SUBDIR ?? 'Movies';
export const SHOWS_SUBDIR = process.env.MEDIA_SHOWS_SUBDIR ?? 'Shows';

// how often the importer looks in the drop folder, and how long a file has to
// stop growing before it is treated as finished copying
export const IMPORT_POLL_MS = Number(process.env.MEDIA_POLL_MS ?? 15_000);
export const IMPORT_SETTLE_MS = Number(process.env.MEDIA_SETTLE_MS ?? 20_000);
