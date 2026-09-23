import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { MediaRequest, MediaStatus } from '@prisma/client';
import { DROPBOX_DIR } from './paths';

/**
 * How a request turns into a file.
 *
 * The app keeps the list, the catalogue lookup, the pickers and the import —
 * none of that cares where a file comes from. A source is the one piece that
 * does: it is handed a request and reports back what is happening to it.
 *
 * Built in is the drop folder: you put a file you are entitled to copy into
 * the watched folder — a disc you ripped, a recording, a download you are
 * licensed for — and the importer files it and the request moves on. Other
 * sources implement this same interface and are added to the registry below
 * without touching anything else.
 *
 * What a source is responsible for, and only this:
 *   - say whether it can do anything on this server right now
 *   - take a request and report which status it should move to
 *
 * What a source must never do:
 *   - mark anything AVAILABLE. Ready to watch is Jellyfin's word alone, and
 *     it is given in MediaService.confirmImported() once Jellyfin can
 *     actually see the thing. A source reporting itself finished only ever
 *     gets a request as far as IMPORTING.
 *   - leak its own name into anything the family reads. `label` is what they
 *     might see; the status note should say what is happening, not who is
 *     doing it.
 *
 * Where the file ends up is not a source's business either: anything that
 * lands in the drop folder is named and filed by LibraryImportService, so a
 * source that fetches a file need only put it there.
 */
export interface AcquisitionSource {
  /** stable id stored on the request */
  readonly name: string;
  /** what the family sees if it is mentioned at all */
  readonly label: string;
  /** can this source do anything on this server right now? */
  available(): Promise<boolean>;
  /** take the request on; report the status it should move to */
  start(request: MediaRequest): Promise<{ status: MediaStatus; note: string }>;
}

/** The default: a watched folder on the server. Passive — it waits for a file
 * to appear and lets LibraryImportService do the rest. */
@Injectable()
export class DropFolderSource implements AcquisitionSource {
  readonly name = 'drop-folder';
  readonly label = 'Watched folder';
  private log = new Logger('DropFolder');

  async available(): Promise<boolean> {
    try {
      await fs.mkdir(DROPBOX_DIR, { recursive: true });
      return true;
    } catch (e) {
      this.log.warn(`drop folder unusable: ${(e as Error).message}`);
      return false;
    }
  }

  start(request: MediaRequest): Promise<{ status: MediaStatus; note: string }> {
    this.log.log(`waiting on a file for ${request.label}`);
    return Promise.resolve({
      status: MediaStatus.REQUESTED,
      note: 'On the list — it will appear here once the file is added.',
    });
  }
}

/** Picks the first source that can work, in order. */
@Injectable()
export class AcquisitionRegistry {
  constructor(private dropFolder: DropFolderSource) {}

  sources(): AcquisitionSource[] {
    return [this.dropFolder];
  }

  async pick(): Promise<AcquisitionSource | null> {
    for (const s of this.sources()) {
      if (await s.available()) return s;
    }
    return null;
  }
}
