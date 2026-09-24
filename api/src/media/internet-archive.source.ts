import { Injectable, Logger } from '@nestjs/common';
import { createWriteStream, promises as fs } from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import { MediaKind, MediaRequest, MediaStatus } from '@prisma/client';
import { AcquisitionSource, ProviderResult } from './acquisition';
import { DROPBOX_DIR, MEDIA_ROOT } from './paths';
import { safe } from './filename';
import { libraryWritable } from './storage';
import {
  IaCandidate,
  IaFile,
  IaRef,
  allowedIdentifiers,
  decodeRef,
  encodeRef,
  narrow,
  pickFile,
  rightsOf,
} from './internet-archive';

const IA = process.env.IA_URL ?? 'https://archive.org';
const SEARCH_TIMEOUT_MS = 15_000;

/** Something that went wrong in a way the family can be told about. */
class NotEligible extends Error {
  constructor(
    readonly note: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

interface IaSearchRow {
  identifier?: string;
  title?: string | string[];
  year?: string | number;
  date?: string;
  licenseurl?: string;
  rights?: string;
}

/**
 * Films from the Internet Archive.
 *
 * This is the first provider that actually goes and fetches something, and
 * it is deliberately timid about it. The Archive hosts a great deal that is
 * free to copy and a great deal that is not, and the difference is not
 * something to guess at: an item is only ever taken when it is named in the
 * allowlist, or carries a licence or rights statement that plainly says so.
 * Two plausible matches is a reason to stop, not to pick one.
 *
 * Downloads run in the background. Nothing half-downloaded is ever put where
 * the importer can see it — the file is built in a work folder and moved in
 * one step once it is whole.
 */
@Injectable()
export class InternetArchiveSource implements AcquisitionSource {
  readonly name = 'internet-archive';
  readonly label = 'Internet Archive';
  readonly automatic = true;
  private log = new Logger('InternetArchive');

  /** progress for the admin panel only; the truth about what is finished
   * lives on disk, so losing this map costs nothing but a progress bar */
  private jobs = new Map<
    string,
    { received: number; total: number; failed?: string }
  >();
  private running = new Set<string>();
  private reachable: { at: number; ok: boolean } = { at: 0, ok: false };

  supports(kind: MediaKind): boolean {
    // films only until shows have been tried properly
    return kind === MediaKind.MOVIE;
  }

  async available(): Promise<boolean> {
    if (process.env.IA_ENABLED !== 'true') return false;
    // the work folder is on the library drive; without it, nothing
    if (!libraryWritable().ok) return false;
    try {
      await fs.mkdir(this.workDir(), { recursive: true });
    } catch {
      return false;
    }
    if (Date.now() - this.reachable.at < 60_000) return this.reachable.ok;
    let ok = false;
    try {
      const res = await fetch(
        `${IA}/services/search/v1/scrape?q=identifier:a&count=1`,
        {
          signal: AbortSignal.timeout(6000),
        },
      );
      ok = res.ok || res.status === 400; // answering at all is the question
    } catch {
      ok = false;
    }
    this.reachable = { at: Date.now(), ok };
    return ok;
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    if (process.env.IA_ENABLED !== 'true') {
      return { ok: false, detail: 'Not switched on (IA_ENABLED)' };
    }
    const disk = libraryWritable();
    if (!disk.ok) return { ok: false, detail: disk.why };
    return (await this.available())
      ? { ok: true }
      : { ok: false, detail: 'archive.org is not answering' };
  }

  // ------------------------------------------------------------ taking it on

  async start(request: MediaRequest): Promise<ProviderResult> {
    try {
      const { item, file, verdict } = await this.resolve(request);
      const ref: IaRef = {
        id: item.identifier,
        file: file.name,
        size: Number(file.size ?? 0),
      };
      // everything an admin would want, and nothing the family would
      this.log.log(
        `${request.label}: ${item.identifier} "${item.title}" ` +
          `(${item.year ?? 'no year'}) — rights ${verdict.why}: ` +
          `${verdict.detail} — taking ${file.name} (${ref.size} bytes)`,
      );
      void this.download(ref);
      return {
        status: MediaStatus.ACQUIRING,
        note: 'Adding it to the library',
        ref: encodeRef(ref),
      };
    } catch (e) {
      if (e instanceof NotEligible) {
        this.log.warn(`${request.label}: ${e.detail}`);
        return {
          status: MediaStatus.UNAVAILABLE,
          note: e.note,
          detail: e.detail,
        };
      }
      this.log.error(`${request.label}: ${(e as Error).message}`);
      return {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it — the search didn't work just now.",
        detail: `search failed: ${(e as Error).message}`,
      };
    }
  }

  /** The one item we are allowed to take, or a reason we are not taking any. */
  private async resolve(request: MediaRequest): Promise<{
    item: IaCandidate;
    file: IaFile;
    verdict: { why: string; detail: string };
  }> {
    const approvedIds = [...allowedIdentifiers()];
    // an approval names an item. looking it up is how you find a named
    // thing; searching is how you find an unnamed one. the Archive's search
    // does not return the same rows twice running and does not expose every
    // field for every item, so letting it decide whether an approval counts
    // means an approval that sometimes does not
    const found = approvedIds.length
      ? await this.lookUp(approvedIds)
      : await this.search(request.title);
    const candidates = narrow(found, {
      title: request.title,
      year: request.year ?? undefined,
    });
    if (!candidates.length) {
      throw new NotEligible(
        approvedIds.length
          ? "Couldn't add it — there's no approved copy of that one."
          : "Couldn't add it — there's no free copy of that one.",
        approvedIds.length
          ? `none of the ${approvedIds.length} approved item(s) is ` +
              `"${request.title}" (${request.year ?? '—'})`
          : `no candidate matched "${request.title}" (${request.year ?? '—'})`,
      );
    }

    let eligible = candidates.filter((c) => rightsOf(c).ok);
    if (!eligible.length) {
      throw new NotEligible(
        "Couldn't add it — there's no free copy of that one.",
        `${candidates.length} match(es) but none with clear rights: ` +
          candidates
            .map((c) => `${c.identifier}=${rightsOf(c).detail}`)
            .join(', '),
      );
    }

    // an allowlist is a list of what someone has actually looked at and
    // approved. once there is one, it is the whole answer: taking a
    // different item because its licence happened to read well would be
    // swapping in something nobody agreed to. the Archive does not return
    // the same results twice running, so this is not hypothetical.
    const approved = allowedIdentifiers();
    if (approved.size) {
      const named = eligible.filter((c) =>
        approved.has(c.identifier.toLowerCase()),
      );
      if (!named.length) {
        throw new NotEligible(
          "Couldn't add it — there's no approved copy of that one.",
          `an allowlist is set and none of ${eligible.length} eligible ` +
            `match(es) is on it: ${eligible.map((c) => c.identifier).join(', ')}`,
        );
      }
      eligible = named;
    }

    if (eligible.length > 1) {
      throw new NotEligible(
        "Couldn't add it — there's more than one copy and I'm not sure which is right.",
        `ambiguous: ${eligible.map((c) => c.identifier).join(', ')}`,
      );
    }

    const item = eligible[0];
    const files = await this.files(item.identifier);
    const file = pickFile(files);
    if (!file) {
      throw new NotEligible(
        "Couldn't add it — there's no usable video in that copy.",
        `${item.identifier} has no file the importer could use`,
      );
    }
    // a download is only ever trusted when it matches the size the Archive
    // said it would be. without that number there is nothing to check a
    // finished file against, so it is not started at all
    if (!(Number(file.size) > 0)) {
      throw new NotEligible(
        "Couldn't add it — there's no usable video in that copy.",
        `${item.identifier}/${file.name} has no listed size; a download ` +
          'could not be verified',
      );
    }
    return { item, file, verdict: rightsOf(item) };
  }

  /** The approved items themselves, read one by one. Anything the Archive
   * will not tell us about is left out rather than guessed at. */
  private async lookUp(identifiers: string[]): Promise<IaCandidate[]> {
    const out: IaCandidate[] = [];
    for (const id of identifiers.slice(0, 50)) {
      try {
        const meta = await this.metadata(id);
        if (!meta) continue;
        out.push(meta);
      } catch (e) {
        this.log.warn(`${id} could not be read: ${(e as Error).message}`);
      }
    }
    return out;
  }

  private async metadata(identifier: string): Promise<IaCandidate | null> {
    const res = await fetch(`${IA}/metadata/${identifier}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      metadata?: {
        identifier?: string;
        title?: string | string[];
        year?: string;
        date?: string;
        licenseurl?: string;
        rights?: string;
      };
    };
    const m = body.metadata;
    if (!m?.identifier) return null;
    return {
      identifier: String(m.identifier),
      title: String(Array.isArray(m.title) ? m.title[0] : (m.title ?? '')),
      year: this.yearOf({ year: m.year, date: m.date }),
      licenseUrl: m.licenseurl ? String(m.licenseurl) : undefined,
      rights: m.rights ? String(m.rights) : undefined,
    };
  }

  private async search(title: string): Promise<IaCandidate[]> {
    const url = new URL(`${IA}/advancedsearch.php`);
    url.searchParams.set(
      'q',
      `title:("${title.replace(/"/g, '')}") AND mediatype:(movies)`,
    );
    for (const f of [
      'identifier',
      'title',
      'year',
      'date',
      'licenseurl',
      'rights',
    ]) {
      url.searchParams.append('fl[]', f);
    }
    url.searchParams.set('rows', '25');
    url.searchParams.set('output', 'json');
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`search -> ${res.status}`);
    const body = (await res.json()) as {
      response?: { docs?: IaSearchRow[] };
    };
    return (body.response?.docs ?? [])
      .filter((d) => d.identifier)
      .map((d) => ({
        identifier: String(d.identifier),
        title: String(Array.isArray(d.title) ? d.title[0] : (d.title ?? '')),
        year: this.yearOf(d),
        licenseUrl: d.licenseurl ? String(d.licenseurl) : undefined,
        rights: d.rights ? String(d.rights) : undefined,
      }));
  }

  private yearOf(row: IaSearchRow): number | undefined {
    const raw = String(row.year ?? row.date ?? '').slice(0, 4);
    const n = Number(raw);
    return Number.isFinite(n) && n > 1870 ? n : undefined;
  }

  private async files(identifier: string): Promise<IaFile[]> {
    const res = await fetch(`${IA}/metadata/${identifier}`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`metadata -> ${res.status}`);
    const body = (await res.json()) as { files?: IaFile[] };
    return body.files ?? [];
  }

  // --------------------------------------------------------------- fetching

  private workDir(): string {
    return process.env.IA_WORK_DIR ?? path.join(MEDIA_ROOT, '_work');
  }

  /**
   * Three files in the work folder track a download, and between them they
   * are the whole truth about it — nothing is taken on trust from memory,
   * which a restart wipes:
   *
   *   .part     being written, or left behind by a crash. never trusted.
   *   .done     written in full and checked byte for byte against the size
   *             the Archive listed. only this can go to the drop folder.
   *   .handoff  written just before the move, so a crash straight after it
   *             is recognised as "already handed over" rather than as
   *             "nothing here yet, start again".
   *
   * The work folder sits well away from the drop folder, so the importer
   * never catches sight of any of them.
   */
  private stemPath(ref: IaRef): string {
    const stem = safe(`${ref.id}__${ref.file}`).replace(/[^\w.-]+/g, '_');
    return path.join(this.workDir(), stem);
  }

  private partPath(ref: IaRef): string {
    return `${this.stemPath(ref)}.part`;
  }

  private donePath(ref: IaRef): string {
    return `${this.stemPath(ref)}.done`;
  }

  private handoffPath(ref: IaRef): string {
    return `${this.stemPath(ref)}.handoff`;
  }

  /**
   * Fetch the file from the start. A crash mid-download is recovered by
   * starting over rather than resuming: the Archive serves byte ranges, but
   * a resumed file stitched from two connections is one more thing to go
   * wrong, and a film at this speed takes about a minute.
   */
  private async download(ref: IaRef): Promise<void> {
    const key = encodeRef(ref);
    if (this.running.has(key)) return;
    this.running.add(key);
    const part = this.partPath(ref);
    const expected = ref.size;
    try {
      if (!(expected > 0)) throw new Error('expected size unknown');
      const disk = libraryWritable();
      if (!disk.ok) throw new Error(`library not writable: ${disk.why}`);
      await fs.mkdir(this.workDir(), { recursive: true });
      // whatever a previous run left behind is not to be trusted
      await fs.unlink(part).catch(() => undefined);

      const url = `${IA}/download/${ref.id}/${encodeURIComponent(ref.file)}`;
      // no overall deadline: a film is hundreds of megabytes and any number
      // we picked would be wrong for someone's connection. a socket that
      // dies still ends the read loop below.
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`download -> ${res.status}`);
      const announced = Number(res.headers.get('content-length') ?? 0);
      if (announced && announced !== expected) {
        throw new Error(
          `the server is sending ${announced} bytes; the item lists ${expected}`,
        );
      }
      this.jobs.set(key, { received: 0, total: expected });

      // counting the bytes as they go past, and letting the pipeline do the
      // pushing back. anything past the expected size is a different file
      // from the one that was approved, so it stops there
      let received = 0;
      const counter = new Transform({
        transform: (chunk: Buffer, _enc, done) => {
          received += chunk.length;
          if (received > expected) {
            done(new Error(`more than the expected ${expected} bytes arrived`));
            return;
          }
          this.jobs.set(key, { received, total: expected });
          done(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
        counter,
        createWriteStream(part, { flags: 'w' }),
      );

      const written = (await fs.stat(part)).size;
      if (written !== expected) {
        throw new Error(`incomplete: ${written} of ${expected} bytes`);
      }
      // verified, and only now marked as finished — in one step, so there
      // is no moment where a finished-looking file is not a whole one
      await fs.rename(part, this.donePath(ref));
      this.jobs.set(key, { received: written, total: expected });
      this.log.log(
        `${ref.id}/${ref.file} downloaded and verified (${written} bytes)`,
      );
    } catch (e) {
      const why = (e as Error).message;
      this.log.warn(`${ref.id}/${ref.file} failed: ${why}`);
      this.jobs.set(key, { received: 0, total: 0, failed: why });
      await fs.unlink(part).catch(() => undefined);
    } finally {
      this.running.delete(key);
    }
  }

  // ------------------------------------------------------------- how it goes

  async poll(request: MediaRequest): Promise<ProviderResult | null> {
    const ref = decodeRef(request.sourceRef);
    // a reference that cannot be read cannot be checked, so nothing it
    // points at can ever be trusted into the library
    if (!ref) {
      return {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it — the download didn't finish.",
        detail: 'the stored download reference is unreadable',
      };
    }
    if (!(ref.size > 0)) {
      return {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it — the download didn't finish.",
        detail: `no expected size for ${ref.id}/${ref.file}; cannot verify it`,
      };
    }
    const key = encodeRef(ref);

    // the drive went away mid-job: nothing is moved, nothing restarted, and
    // nothing given up on — it waits, and carries on when the drive is back
    if (!libraryWritable().ok) return null;

    const job = this.jobs.get(key);

    if (job?.failed) {
      this.jobs.delete(key);
      return {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it — the download didn't finish.",
        detail: `${ref.id}/${ref.file}: ${job.failed}`,
      };
    }

    // finished and verified: check it once more, then hand it over
    const done = await fs.stat(this.donePath(ref)).catch(() => null);
    if (done) {
      if (done.size !== ref.size) {
        await fs.unlink(this.donePath(ref)).catch(() => undefined);
        return {
          status: MediaStatus.UNAVAILABLE,
          note: "Couldn't add it — the download didn't finish.",
          detail:
            `${ref.id}/${ref.file}: finished file is ${done.size} bytes, ` +
            `expected ${ref.size}; discarded rather than imported`,
        };
      }
      try {
        const landed = await this.handOver(request, ref);
        this.jobs.delete(key);
        this.log.log(`${ref.id} handed to the importer as ${landed}`);
        return { status: MediaStatus.IMPORTING, note: 'Almost ready' };
      } catch (e) {
        this.log.warn(`could not file ${ref.id}: ${(e as Error).message}`);
        return {
          status: MediaStatus.UNAVAILABLE,
          note: "Couldn't add it — there was a problem saving it.",
          detail: `handover failed: ${(e as Error).message}`,
        };
      }
    }

    // handed over before a crash that happened before anyone was told
    if (await fs.stat(this.handoffPath(ref)).catch(() => null)) {
      return { status: MediaStatus.IMPORTING, note: 'Almost ready' };
    }

    if (this.running.has(key)) return null;

    // nothing running: either never started or the process restarted.
    // a .part from before is not trusted; the download starts again
    this.log.log(`picking ${ref.id} back up after a restart`);
    void this.download(ref);
    return null;
  }

  /**
   * Into the drop folder in one step, named the way the importer reads
   * names. Across filesystems the copy goes to a hidden name first — the
   * importer ignores those — and is renamed once whole, so the importer can
   * never pick up a file that is still arriving.
   */
  private async handOver(request: MediaRequest, ref: IaRef): Promise<string> {
    const ext = path.extname(ref.file).toLowerCase() || '.mp4';
    const stem = request.year
      ? `${safe(request.title)} (${request.year})`
      : safe(request.title);
    const dest = path.join(DROPBOX_DIR, `${stem}${ext}`);
    const done = this.donePath(ref);
    const disk = libraryWritable();
    if (!disk.ok) throw new Error(`library not writable: ${disk.why}`);
    await fs.mkdir(DROPBOX_DIR, { recursive: true });
    await fs.writeFile(this.handoffPath(ref), JSON.stringify({ dest }));
    try {
      await fs.rename(done, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      const hidden = path.join(DROPBOX_DIR, `.${path.basename(dest)}.incoming`);
      await fs.copyFile(done, hidden);
      if ((await fs.stat(hidden)).size !== ref.size) {
        await fs.unlink(hidden).catch(() => undefined);
        throw new Error('copy into the drop folder came out the wrong size');
      }
      await fs.rename(hidden, dest);
      await fs.unlink(done);
    }
    return path.basename(dest);
  }

  /** For the admin panel: how far along everything is. */
  progress(): {
    ref: string;
    received: number;
    total: number;
    failed?: string;
  }[] {
    return [...this.jobs.entries()].map(([ref, j]) => ({ ref, ...j }));
  }
}
