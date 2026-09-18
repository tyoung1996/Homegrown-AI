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
 * licensed for — and the importer files it and marks the request done. Other
 * sources (a TV tuner recording a broadcast, a disc ripper) implement this
 * same interface and register in MEDIA_SOURCES without touching anything else.
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
