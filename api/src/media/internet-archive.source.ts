import { Injectable, Logger } from '@nestjs/common';
import { createWriteStream, promises as fs } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import { MediaKind, MediaRequest, MediaStatus } from '@prisma/client';
import { AcquisitionSource, ProviderResult } from './acquisition';
import { DROPBOX_DIR, MEDIA_ROOT } from './paths';
import { safe } from './filename';
import {
  IaCandidate,
  IaFile,
  IaRef,
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
        return { status: MediaStatus.UNAVAILABLE, note: e.note };
      }
      this.log.error(`${request.label}: ${(e as Error).message}`);
      return {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it — the search didn't work just now.",
      };
    }
  }

  /** The one item we are allowed to take, or a reason we are not taking any. */
  private async resolve(request: MediaRequest): Promise<{
    item: IaCandidate;
    file: IaFile;
    verdict: { why: string; detail: string };
  }> {
    const found = await this.search(request.title);
    const candidates = narrow(found, {
      title: request.title,
      year: request.year ?? undefined,
    });
    if (!candidates.length) {
      throw new NotEligible(
        "Couldn't add it — there's no free copy of that one.",
        `no candidate matched "${request.title}" (${request.year ?? '—'})`,
      );
    }

    const eligible = candidates.filter((c) => rightsOf(c).ok);
    if (!eligible.length) {
      throw new NotEligible(
        "Couldn't add it — there's no free copy of that one.",
        `${candidates.length} match(es) but none with clear rights: ` +
          candidates
            .map((c) => `${c.identifier}=${rightsOf(c).detail}`)
            .join(', '),
      );
    }
    if (eligible.length > 1) {
      // an allowlisted item settles it; otherwise we stop rather than guess
      const named = eligible.filter((c) => rightsOf(c).why === 'allowlisted');
      if (named.length !== 1) {
        throw new NotEligible(
          "Couldn't add it — there's more than one copy and I'm not sure which is right.",
          `ambiguous: ${eligible.map((c) => c.identifier).join(', ')}`,
        );
      }
      eligible.splice(0, eligible.length, named[0]);
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
    return { item, file, verdict: rightsOf(item) };
  }

  private async search(title: string): Promise<IaCandidate[]> {
    const url = new URL(`${IA}/advancedsearch.php`);
    url.searchParams.set(
      'q',
      `title:("${title.replace(/"/g, '')}") AND mediatype:(movies)`,
    );
    for (const f of ['identifier', 'title', 'year', 'licenseurl', 'rights']) {
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

  /** The half-finished file. It lives well away from the drop folder, so
   * the importer can never catch sight of it. */
  private partPath(ref: IaRef): string {
    const stem = safe(`${ref.id}__${ref.file}`).replace(/[^\w.-]+/g, '_');
    return path.join(this.workDir(), `${stem}.part`);
  }

  private async download(ref: IaRef): Promise<void> {
    const key = encodeRef(ref);
    if (this.running.has(key)) return;
    this.running.add(key);
    const part = this.partPath(ref);
    try {
      await fs.mkdir(this.workDir(), { recursive: true });
      const url = `${IA}/download/${ref.id}/${encodeURIComponent(ref.file)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(0) });
      if (!res.ok || !res.body) throw new Error(`download -> ${res.status}`);
      const total =
        Number(res.headers.get('content-length') ?? 0) || ref.size || 0;
      this.jobs.set(key, { received: 0, total });

      let received = 0;
      const counted = new Readable({
        read() {
          /* pushed below */
        },
      });
      const reader = (
        res.body as unknown as ReadableStream<Uint8Array>
      ).getReader();
      const pump = async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          this.jobs.set(key, { received, total });
          if (!counted.push(Buffer.from(value))) {
            await new Promise((r) => counted.once('drain', r));
          }
        }
        counted.push(null);
      };
      await Promise.all([pump(), pipeline(counted, createWriteStream(part))]);

      // a truncated file is worse than none: if we were told a size, hold
      // the download to it
      const written = (await fs.stat(part)).size;
      if (total && written !== total) {
        throw new Error(`incomplete: ${written} of ${total} bytes`);
      }
      this.jobs.set(key, { received: written, total: written });
      this.log.log(`${ref.id}/${ref.file} downloaded (${written} bytes)`);
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
    if (!ref) return null;
    const key = encodeRef(ref);
    const job = this.jobs.get(key);

    if (job?.failed) {
      this.jobs.delete(key);
      return {
        status: MediaStatus.UNAVAILABLE,
        note: "Couldn't add it — the download didn't finish.",
      };
    }

    const part = this.partPath(ref);
    const done = await fs.stat(part).catch(() => null);
    const finished =
      done && (!job || job.total === 0 || job.received >= job.total);

    if (finished && !this.running.has(key)) {
      try {
        const landed = await this.handOver(request, ref, part);
        this.jobs.delete(key);
        this.log.log(`${ref.id} handed to the importer as ${landed}`);
        return { status: MediaStatus.IMPORTING, note: 'Almost ready' };
      } catch (e) {
        this.log.warn(`could not file ${ref.id}: ${(e as Error).message}`);
        await fs.unlink(part).catch(() => undefined);
        return {
          status: MediaStatus.UNAVAILABLE,
          note: "Couldn't add it — there was a problem saving it.",
        };
      }
    }

    // nothing running and nothing on disk means the server restarted
    // mid-download; the reference is all that was needed to pick it up again
    if (!this.running.has(key) && !done) {
      this.log.log(`picking ${ref.id} back up after a restart`);
      void this.download(ref);
    }
    return null;
  }

  /**
   * Into the drop folder in one step, named the way the importer reads
   * names, so the rest of the pipeline treats it exactly like a file put
   * there by hand.
   */
  private async handOver(
    request: MediaRequest,
    ref: IaRef,
    part: string,
  ): Promise<string> {
    const ext = path.extname(ref.file).toLowerCase() || '.mp4';
    const stem = request.year
      ? `${safe(request.title)} (${request.year})`
      : safe(request.title);
    const dest = path.join(DROPBOX_DIR, `${stem}${ext}`);
    await fs.mkdir(DROPBOX_DIR, { recursive: true });
    try {
      await fs.rename(part, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await fs.copyFile(part, dest);
      await fs.unlink(part);
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
