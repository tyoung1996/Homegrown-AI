import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { MediaStatus } from '@prisma/client';
import { MediaService } from './media.service';
import { JellyfinService } from './jellyfin.service';
import {
  DROPBOX_DIR,
  IMPORT_POLL_MS,
  IMPORT_SETTLE_MS,
  MEDIA_ROOT,
  MOVIES_SUBDIR,
  SHOWS_SUBDIR,
} from './paths';
import { libraryWritable } from './storage';
import { FAMILY_NOTE } from './acquisition';
import {
  VIDEO_EXTENSIONS,
  episodeTarget,
  movieTarget,
  parseMediaName,
} from './filename';

/**
 * Watches the drop folder and files whatever turns up into the library the way
 * Jellyfin expects, then tells Jellyfin to rescan. If the file answers an open
 * request, that request is marked ready to watch.
 *
 * Nothing here fetches anything: it only moves files that are already on the
 * server into place.
 */
@Injectable()
export class LibraryImportService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Import');
  private timer: NodeJS.Timeout | null = null;
  private seen = new Map<string, { size: number; at: number }>();
  private inflight: Promise<{ imported: string[]; waiting: string[] }> | null =
    null;
  // said once when the library goes missing, and once when it comes back
  private libraryDown: string | null = null;

  constructor(
    private media: MediaService,
    private jellyfin: JellyfinService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep().catch((e: unknown) =>
        this.log.warn(`sweep failed: ${(e as Error).message}`),
      );
    }, IMPORT_POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over the drop folder. Safe to call by hand (the admin button):
   * if the timer is mid-sweep, wait for that one and report what it did
   * rather than saying nothing happened. */
  async sweep(): Promise<{ imported: string[]; waiting: string[] }> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runSweep();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private async runSweep(): Promise<{
    imported: string[];
    waiting: string[];
  }> {
    const imported: string[] = [];
    const waiting: string[] = [];

    // with the library drive missing, the library folder is an empty folder
    // on the system disk. writing there — even creating the drop folder —
    // is exactly the mess this is here to prevent, so the sweep does only
    // the one thing that reads rather than writes: asking Jellyfin
    const disk = libraryWritable();
    if (!disk.ok) {
      if (this.libraryDown !== disk.why) {
        this.log.error(`library not writable, importing paused: ${disk.why}`);
        this.libraryDown = disk.why ?? 'unavailable';
      }
      await this.media
        .confirmImported()
        .catch((e: unknown) =>
          this.log.warn(`confirming failed: ${(e as Error).message}`),
        );
      return { imported, waiting };
    }
    if (this.libraryDown) {
      this.log.log('library is back; importing resumed');
      this.libraryDown = null;
    }

    await fs.mkdir(DROPBOX_DIR, { recursive: true });
    for (const file of await this.videoFiles(DROPBOX_DIR)) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      // a file still being copied keeps growing; wait for it to hold still
      const before = this.seen.get(file);
      if (!before || before.size !== stat.size) {
        this.seen.set(file, { size: stat.size, at: Date.now() });
        waiting.push(path.basename(file));
        continue;
      }
      if (Date.now() - before.at < IMPORT_SETTLE_MS) {
        waiting.push(path.basename(file));
        continue;
      }
      const placed = await this.importOne(file);
      if (placed) imported.push(placed);
      this.seen.delete(file);
    }
    if (imported.length) await this.jellyfin.refreshLibrary();
    // anything waiting is offered to a provider that could fetch it
    await this.media
      .reconsiderWaiting()
      .catch((e: unknown) =>
        this.log.warn(
          `reconsidering waiting requests failed: ${(e as Error).message}`,
        ),
      );
    // providers working in the background get asked how they are doing
    await this.media
      .pollProviders()
      .catch((e: unknown) =>
        this.log.warn(`polling providers failed: ${(e as Error).message}`),
      );
    // whether or not anything moved this time round, ask Jellyfin about the
    // ones already filed — a rescan from a previous pass may have landed
    await this.media
      .confirmImported()
      .catch((e: unknown) =>
        this.log.warn(`confirming failed: ${(e as Error).message}`),
      );
    return { imported, waiting };
  }

  private async videoFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 3) return [];
    const out: string[] = [];
    const entries = await fs
      .readdir(dir, { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...(await this.videoFiles(full, depth + 1)));
      } else if (
        VIDEO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()) &&
        !e.name.startsWith('.')
      ) {
        out.push(full);
      }
    }
    return out;
  }

  private async importOne(file: string): Promise<string | null> {
    const relative = path.relative(DROPBOX_DIR, file);
    const parsed = parseMediaName(relative);
    if (!parsed) {
      this.log.warn(`cannot tell what this is, leaving it: ${relative}`);
      return null;
    }
    const ext = path.extname(file).toLowerCase();
    const target =
      parsed.kind === 'episode'
        ? episodeTarget(
            parsed.title,
            parsed.season ?? 1,
            parsed.episode ?? 1,
            ext,
            SHOWS_SUBDIR,
          )
        : movieTarget(parsed.title, parsed.year, ext, MOVIES_SUBDIR);
    const dest = path.join(MEDIA_ROOT, target);

    const request = await this.media.matchFile(parsed);
    if (request) {
      await this.media.setStatus(
        request.id,
        MediaStatus.IMPORTING,
        FAMILY_NOTE.adding,
      );
    }

    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (await this.exists(dest)) {
        this.log.log(`already in the library, skipping: ${target}`);
        if (request) await this.media.markImported(request.id, dest);
        await fs.unlink(file).catch(() => undefined);
        return target;
      }
      await this.move(file, dest);
      this.log.log(`imported ${relative} -> ${target}`);
      if (request) await this.media.markImported(request.id, dest);
      return target;
    } catch (e) {
      this.log.error(`import failed for ${relative}: ${(e as Error).message}`);
      if (request) {
        // back on the list for the family; the reason is for the admin
        await this.media.setStatus(
          request.id,
          MediaStatus.REQUESTED,
          FAMILY_NOTE.waiting,
          `import failed for ${relative}: ${(e as Error).message}`,
        );
      }
      return null;
    }
  }

  private async exists(p: string) {
    return !!(await fs.stat(p).catch(() => null));
  }

  // rename is instant on the same disk; across disks fall back to a copy
  private async move(from: string, to: string) {
    try {
      await fs.rename(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await fs.copyFile(from, to);
      await fs.unlink(from);
    }
  }
}
