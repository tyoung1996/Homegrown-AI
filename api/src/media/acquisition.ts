import { Inject, Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { MediaKind, MediaRequest, MediaStatus } from '@prisma/client';
import { DROPBOX_DIR } from './paths';
import { libraryWritable } from './storage';

/**
 * How a request turns into a file.
 *
 * The app keeps the list, the catalogue lookup, the pickers, the import and
 * the TVs — none of that cares where a file comes from. A provider is the one
 * piece that does: it is handed a request and reports what is happening to it.
 *
 * Providers live side by side. Which one takes a given request is decided by
 * what each can handle and the order they are configured in, not by anything
 * MediaService knows about them — it asks the registry and is handed one.
 *
 * Built in is the drop folder: put a file you are entitled to copy into the
 * watched folder and the importer files it. Anything else — a tuner recording
 * off an antenna, a disc ripper, a library manager — implements the same
 * interface and is added to the registry without touching another file.
 */

/**
 * The only things the family is ever told about a request. Providers pick
 * from these rather than writing their own, so nothing about files,
 * downloads, sources or searches can leak into the family's list — what
 * went wrong goes in a result's `detail`, which only an admin sees.
 */
export const FAMILY_NOTE = {
  waiting: "On the list — we'll let you know when it's ready to watch.",
  adding: 'Adding it to the library',
  almost: 'Almost ready',
  ready: 'In the library — ready to watch',
  failed: "Couldn't add it",
} as const;

/**
 * What a provider is allowed to say. AVAILABLE is deliberately not in here:
 * ready to watch is Jellyfin's word and nobody else's, given in
 * MediaService.confirmImported() once Jellyfin can actually see the thing.
 * The registry enforces this at runtime too, so a provider that ignores the
 * type cannot get past it either.
 */
export type ProviderStatus =
  | typeof MediaStatus.REQUESTED
  | typeof MediaStatus.SEARCHING
  | typeof MediaStatus.ACQUIRING
  | typeof MediaStatus.IMPORTING
  | typeof MediaStatus.UNAVAILABLE;

export interface ProviderResult {
  status: ProviderStatus;
  /** one plain line for the family — no provider names, no jargon */
  note: string;
  /** the provider's own id for this, so it can recognise it again later */
  ref?: string;
  /** what actually went wrong, for the admin panel. never shown to the
   * family, and never needed to be — the note is for them */
  detail?: string;
}

export interface ProviderHealth {
  name: string;
  label: string;
  ok: boolean;
  kinds: MediaKind[];
  detail?: string;
}

export interface AcquisitionSource {
  /** stable id, stored on the request */
  readonly name: string;
  /** what the admin panel calls it; the family never sees this */
  readonly label: string;
  /**
   * Does this provider go and get things by itself? A watched folder does
   * not — it takes a request on and waits for someone to put a file there,
   * which is a perfectly good answer but not an automatic one. Providers
   * that fetch say true and are preferred when both could take a request.
   */
  readonly automatic?: boolean;

  /** Can this provider do anything about this sort of thing at all? Asked
   * before availability, because it never changes. */
  supports(kind: MediaKind): boolean;

  /** Can it do anything on this server right now? Configuration missing, a
   * service down, a folder gone — all false, none of them an error. */
  available(): Promise<boolean>;

  /** Take the request on and say what is happening to it. */
  start(request: MediaRequest): Promise<ProviderResult>;

  /**
   * For providers that work in the background: asked periodically about
   * requests it has taken on, so progress does not have to be smuggled out
   * of start(). Return null when there is nothing new to report. Providers
   * that finish synchronously can leave this out.
   */
  poll?(request: MediaRequest): Promise<ProviderResult | null>;

  /** Optional detail for the admin panel when it is not working. */
  health?(): Promise<{ ok: boolean; detail?: string }>;

  /**
   * Tidy up whatever the provider kept for crash recovery, now that the app
   * has safely recorded where each request stands. `inFlight` is every
   * request this provider still holds that has not moved on yet — anything
   * kept for one of those must stay. Anything else is spent. Only ever
   * called with a complete list, so an absence really means "done with".
   */
  tidy?(inFlight: MediaRequest[]): Promise<void>;
}

/** Everything a provider may return. Anything else is a bug in the provider
 * and is treated as one. */
const ALLOWED: ProviderStatus[] = [
  MediaStatus.REQUESTED,
  MediaStatus.SEARCHING,
  MediaStatus.ACQUIRING,
  MediaStatus.IMPORTING,
  MediaStatus.UNAVAILABLE,
];

const ALL_KINDS: MediaKind[] = [
  MediaKind.MOVIE,
  MediaKind.SERIES,
  MediaKind.SEASON,
  MediaKind.EPISODE,
];

/** The default: a watched folder on the server. Passive — it waits for a
 * file to appear and lets LibraryImportService do the rest. Handles anything,
 * because a file is a file. */
@Injectable()
export class DropFolderSource implements AcquisitionSource {
  readonly name = 'drop-folder';
  readonly label = 'Watched folder';
  // it waits for a file; it does not go and find one
  readonly automatic = false;
  private log = new Logger('DropFolder');

  /** anything: a file is a file, whatever it is of */
  supports(): boolean {
    return true;
  }

  async available(): Promise<boolean> {
    // not before the drive is really there — the mkdir below would
    // otherwise quietly create the drop folder on the system disk
    if (!libraryWritable().ok) return false;
    try {
      await fs.mkdir(DROPBOX_DIR, { recursive: true });
      return true;
    } catch (e) {
      this.log.warn(`drop folder unusable: ${(e as Error).message}`);
      return false;
    }
  }

  start(request: MediaRequest): Promise<ProviderResult> {
    this.log.log(`waiting on a file for ${request.label}`);
    return Promise.resolve({
      status: MediaStatus.REQUESTED,
      note: FAMILY_NOTE.waiting,
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    const disk = libraryWritable();
    if (!disk.ok) return { ok: false, detail: disk.why };
    return (await this.available())
      ? { ok: true }
      : { ok: false, detail: `Cannot use ${DROPBOX_DIR}` };
  }
}

/**
 * Who gets a request, and the rules they are held to.
 *
 * Order comes from ACQUISITION_ORDER — a comma-separated list of provider
 * names, best first. Anything not named goes after the ones that are, in the
 * order they were registered, so adding a provider never silently promotes
 * it above one that was working.
 */
/** What the registry is handed. Adding a provider is a line in the factory
 * in media.module.ts and nothing else — no other file learns its name. */
export const ACQUISITION_SOURCES = Symbol('ACQUISITION_SOURCES');

@Injectable()
export class AcquisitionRegistry {
  private log = new Logger('Acquisition');

  constructor(
    @Inject(ACQUISITION_SOURCES)
    private registered: AcquisitionSource[],
  ) {}

  /** Every provider on this server, in the order they should be preferred. */
  sources(): AcquisitionSource[] {
    const registered = this.registered;
    const order = (process.env.ACQUISITION_ORDER ?? '')
      .split(',')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    if (!order.length) return registered;
    const rank = (s: AcquisitionSource) => {
      const at = order.indexOf(s.name.toLowerCase());
      return at === -1 ? order.length : at;
    };
    // a stable sort, so providers of equal rank keep their registered order
    return registered
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
      .map(({ s }) => s);
  }

  /** Which providers could ever take this sort of request. */
  capableOf(kind: MediaKind): AcquisitionSource[] {
    return this.sources().filter((s) => {
      try {
        return s.supports(kind);
      } catch {
        return false;
      }
    });
  }

  /**
   * The provider that should take this request: the first one that both
   * handles this kind and can work right now. Deterministic — the same
   * providers in the same state always give the same answer. A provider that
   * throws while being asked is treated as unavailable, not as a failure of
   * the request.
   */
  async pickFor(kind: MediaKind): Promise<AcquisitionSource | null> {
    const capable = this.capableOf(kind);
    // a provider that fetches is preferred over one that waits, whatever
    // the configured order says — waiting is always still there behind it
    for (const source of capable.filter((s) => s.automatic)) {
      if (await this.isUp(source)) return source;
    }
    for (const source of capable.filter((s) => !s.automatic)) {
      if (await this.isUp(source)) return source;
    }
    return null;
  }

  /**
   * Find a provider that will actually take this on. Providers are asked in
   * the usual order — ones that fetch before ones that wait — and one that
   * declines is not the end of it: the next is asked, down to the watched
   * folder, which never declines. So a film nothing can fetch still lands
   * on the list rather than being written off.
   *
   * `automaticOnly` asks only providers that fetch — for offering a request
   * that is already waiting on the folder to something better.
   */
  async claim(
    kind: MediaKind,
    request: MediaRequest,
    opts: { automaticOnly?: boolean; exclude?: string[] } = {},
  ): Promise<{
    source: AcquisitionSource | null;
    result: ProviderResult | null;
    declined: { name: string; detail: string }[];
  }> {
    const skip = new Set((opts.exclude ?? []).map((n) => n.toLowerCase()));
    const capable = this.capableOf(kind).filter(
      (s) => !skip.has(s.name.toLowerCase()),
    );
    const order = [
      ...capable.filter((s) => s.automatic),
      ...(opts.automaticOnly ? [] : capable.filter((s) => !s.automatic)),
    ];
    const declined: { name: string; detail: string }[] = [];
    for (const source of order) {
      if (!(await this.isUp(source))) continue;
      const result = await this.handOff(source, request);
      if (result.status === MediaStatus.UNAVAILABLE) {
        declined.push({
          name: source.name,
          detail: result.detail ?? result.note,
        });
        continue;
      }
      return { source, result, declined };
    }
    return { source: null, result: null, declined };
  }

  /** Could anything fetch this sort of thing by itself right now? The
   * answer the admin panel wants, and nothing the family needs to know. */
  async canFetch(kind: MediaKind): Promise<boolean> {
    for (const source of this.capableOf(kind).filter((s) => s.automatic)) {
      if (await this.isUp(source)) return true;
    }
    return false;
  }

  /** Kept for callers that only want to know whether anything works at all. */
  async pick(): Promise<AcquisitionSource | null> {
    for (const source of this.sources()) {
      if (await this.isUp(source)) return source;
    }
    return null;
  }

  /**
   * Hand a request over and come back with something the app can trust.
   * A provider that throws, hangs its promise on a rejection, or tries to
   * declare something ready to watch is corrected here rather than being
   * allowed to put the request into a state the rest of the app would
   * believe.
   */
  async handOff(
    source: AcquisitionSource,
    request: MediaRequest,
  ): Promise<ProviderResult> {
    let result: ProviderResult;
    try {
      result = await source.start(request);
    } catch (e) {
      this.log.warn(
        `${source.name} could not take ${request.label}: ${(e as Error).message}`,
      );
      return {
        status: MediaStatus.UNAVAILABLE,
        note: FAMILY_NOTE.failed,
        detail: `${source.name} threw: ${(e as Error).message}`,
      };
    }
    return this.vet(source, result);
  }

  /** Ask a provider how something it took on is getting along. */
  async pollFor(
    source: AcquisitionSource,
    request: MediaRequest,
  ): Promise<ProviderResult | null> {
    if (!source.poll) return null;
    try {
      const result = await source.poll(request);
      return result ? this.vet(source, result) : null;
    } catch (e) {
      this.log.warn(
        `${source.name} could not say how ${request.label} is doing: ${(e as Error).message}`,
      );
      return null;
    }
  }

  byName(name: string | null | undefined): AcquisitionSource | null {
    if (!name) return null;
    return (
      this.sources().find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
      null
    );
  }

  /** What each provider is and whether it is working — for the admin panel
   * only. None of this goes anywhere near the family. */
  async report(): Promise<ProviderHealth[]> {
    return Promise.all(
      this.sources().map(async (s) => {
        const kinds = ALL_KINDS.filter((k) => {
          try {
            return s.supports(k);
          } catch {
            return false;
          }
        });
        try {
          const detail = s.health ? await s.health() : null;
          const ok = detail ? detail.ok : await this.isUp(s);
          return {
            name: s.name,
            label: s.label,
            ok,
            kinds,
            ...(detail?.detail ? { detail: detail.detail } : {}),
          };
        } catch (e) {
          return {
            name: s.name,
            label: s.label,
            ok: false,
            kinds,
            detail: (e as Error).message,
          };
        }
      }),
    );
  }

  /** Which provider would take each sort of request right now. Answers the
   * only question an admin actually has about routing. */
  async routing(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const kind of ALL_KINDS) {
      const source = await this.pickFor(kind);
      out[kind] = source?.name ?? null;
    }
    return out;
  }

  /** Which kinds something could go and fetch by itself right now. */
  async automatic(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const kind of ALL_KINDS) out[kind] = await this.canFetch(kind);
    return out;
  }

  /** A provider that cannot answer is down, not broken. */
  private async isUp(source: AcquisitionSource): Promise<boolean> {
    try {
      return await source.available();
    } catch (e) {
      this.log.warn(`${source.name} is not answering: ${(e as Error).message}`);
      return false;
    }
  }

  /** The one rule nobody gets to break. */
  private vet(
    source: AcquisitionSource,
    result: ProviderResult,
  ): ProviderResult {
    if (!ALLOWED.includes(result.status)) {
      this.log.error(
        `${source.name} tried to set ${String(result.status)} — only Jellyfin ` +
          'decides what is ready to watch. Holding it at almost-ready.',
      );
      return {
        ...result,
        status: MediaStatus.IMPORTING,
        note: FAMILY_NOTE.almost,
      };
    }
    return result;
  }
}
