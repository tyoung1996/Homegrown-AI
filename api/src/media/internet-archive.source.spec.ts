import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MediaKind, MediaRequest, MediaStatus } from '@prisma/client';

// paths.ts reads the environment as it loads, so point it somewhere
// disposable before anything imports it
let root: string;
let dropbox: string;
let work: string;
let Source: any;

const REAL_FETCH = global.fetch;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cb-ia-'));
  dropbox = path.join(root, '_incoming');
  work = path.join(root, '_work');
  await fs.mkdir(dropbox, { recursive: true });
  process.env.MEDIA_ROOT = root;
  process.env.MEDIA_DROPBOX = dropbox;
  process.env.IA_WORK_DIR = work;
  process.env.IA_ENABLED = 'true';
  process.env.IA_URL = 'https://archive.test';
  delete process.env.IA_ALLOWED_IDENTIFIERS;
  jest.resetModules();
  Source = (
    require('./internet-archive.source') as typeof import('./internet-archive.source')
  ).InternetArchiveSource;
});

afterEach(async () => {
  global.fetch = REAL_FETCH;
  await fs.rm(root, { recursive: true, force: true });
});

const request = (over: Partial<MediaRequest> = {}): MediaRequest =>
  ({
    id: 'r1',
    kind: MediaKind.MOVIE,
    title: 'Night of the Living Dead',
    label: 'Night of the Living Dead (1968)',
    year: 1968,
    sourceRef: null,
    ...over,
  }) as MediaRequest;

const PD = 'https://creativecommons.org/publicdomain/mark/1.0/';

/** archive.org, as far as these tests are concerned */
function archive(opts: {
  docs?: any[];
  files?: any[];
  body?: Buffer;
  downloadStatus?: number;
  searchStatus?: number;
  truncate?: boolean;
}) {
  const body = opts.body ?? Buffer.alloc(64, 7);
  global.fetch = jest.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/services/search/')) {
      return { ok: true, status: 200 } as any;
    }
    if (u.includes('advancedsearch')) {
      if (opts.searchStatus)
        return { ok: false, status: opts.searchStatus } as any;
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: { docs: opts.docs ?? [] } }),
      } as any;
    }
    if (u.includes('/metadata/')) {
      const id = decodeURIComponent(u.split('/metadata/')[1]);
      const doc = (opts.docs ?? []).find((d) => d.identifier === id);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          files: opts.files ?? [],
          ...(doc
            ? {
                metadata: {
                  identifier: doc.identifier,
                  title: doc.title,
                  year: doc.year,
                  date: doc.date,
                  licenseurl: doc.licenseurl,
                  rights: doc.rights,
                },
              }
            : {}),
        }),
      } as any;
    }
    // the download itself
    if (opts.downloadStatus) {
      return { ok: false, status: opts.downloadStatus, body: null } as any;
    }
    const sent = opts.truncate ? body.subarray(0, 8) : body;
    // chunked through a real web stream: a single push would never fill the
    // buffer, and it is the full buffer that used to deadlock
    const size = 8192;
    let at = 0;
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(body.byteLength) },
      body: new ReadableStream({
        pull(controller) {
          if (at >= sent.length) return controller.close();
          controller.enqueue(new Uint8Array(sent.subarray(at, at + size)));
          at += size;
        },
      }),
    } as any;
  }) as any;
}

const settle = () => new Promise((r) => setTimeout(r, 40));
const listDrop = () => fs.readdir(dropbox);

describe('what this provider will take on', () => {
  it('does films and nothing else yet', () => {
    const s = new Source();
    expect(s.supports(MediaKind.MOVIE)).toBe(true);
    expect(s.supports(MediaKind.SERIES)).toBe(false);
    expect(s.supports(MediaKind.SEASON)).toBe(false);
    expect(s.supports(MediaKind.EPISODE)).toBe(false);
  });

  it('is off unless it has been switched on', async () => {
    delete process.env.IA_ENABLED;
    archive({});
    expect(await new Source().available()).toBe(false);
  });

  it('is unavailable when archive.org is not answering', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    }) as any;
    expect(await new Source().available()).toBe(false);
  });
});

describe('deciding what to fetch', () => {
  it('takes on a clearly licensed match and says it is working', async () => {
    archive({
      docs: [
        {
          identifier: 'notld',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'notld.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.ACQUIRING);
    expect(out.note).toBe('Adding it to the library');
    expect(JSON.parse(String(out.ref))).toMatchObject({
      id: 'notld',
      file: 'notld.mp4',
    });
  });

  it('refuses when the rights are not clear', async () => {
    archive({
      docs: [
        {
          identifier: 'notld',
          title: 'Night of the Living Dead',
          year: '1968',
        },
      ],
      files: [{ name: 'notld.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.ref).toBeUndefined();
    expect(await listDrop()).toEqual([]);
  });

  it('stops rather than guessing between two copies', async () => {
    archive({
      docs: [
        {
          identifier: 'a',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
        {
          identifier: 'b',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.note).toMatch(/more than one copy/i);
  });

  it('lets an allowlisted identifier settle which of two it is', async () => {
    process.env.IA_ALLOWED_IDENTIFIERS = 'b';
    archive({
      docs: [
        {
          identifier: 'a',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
        { identifier: 'b', title: 'Night of the Living Dead', year: '1968' },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.ACQUIRING);
    expect(JSON.parse(String(out.ref)).id).toBe('b');
  });

  it('refuses a different item when an allowlist says which one', async () => {
    // the live bug: one item eligible on its licence, but not the one that
    // was approved. taking it would be a swap nobody agreed to
    process.env.IA_ALLOWED_IDENTIFIERS = 'the_one_i_checked';
    archive({
      docs: [
        {
          identifier: 'some_other_copy',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.note).toMatch(/no approved copy/i);
    expect(out.ref).toBeUndefined();
    expect(await listDrop()).toEqual([]);
  });

  it('takes the approved one when it is there', async () => {
    process.env.IA_ALLOWED_IDENTIFIERS = 'the_one_i_checked';
    archive({
      docs: [
        {
          identifier: 'some_other_copy',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
        {
          identifier: 'the_one_i_checked',
          title: 'Night of the Living Dead',
          year: '1968',
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.ACQUIRING);
    expect(JSON.parse(String(out.ref)).id).toBe('the_one_i_checked');
  });

  it('finds an approved item the search does not return at all', async () => {
    // the live failure: the item exists and is approved, but the search
    // ranking did not surface it that minute
    process.env.IA_ALLOWED_IDENTIFIERS = 'the_one_i_checked';
    archive({
      docs: [
        {
          identifier: 'the_one_i_checked',
          title: 'Night of the Living Dead',
          date: '1968-10-01',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
      searchStatus: 503, // search is no help; the lookup must not need it
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.ACQUIRING);
    expect(JSON.parse(String(out.ref)).id).toBe('the_one_i_checked');
  });

  it('reads the year from a date when no year is stated', async () => {
    process.env.IA_ALLOWED_IDENTIFIERS = 'dated';
    archive({
      docs: [
        {
          identifier: 'dated',
          title: 'Night of the Living Dead',
          date: '1968-10-01',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    expect((await new Source().start(request())).status).toBe(
      MediaStatus.ACQUIRING,
    );
  });

  it('will not use an approved item for a different film', async () => {
    process.env.IA_ALLOWED_IDENTIFIERS = 'some_other_film';
    archive({
      docs: [
        {
          identifier: 'some_other_film',
          title: 'Plan 9 from Outer Space',
          year: '1957',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.ref).toBeUndefined();
  });

  it('still goes on licence alone when no allowlist is set', async () => {
    delete process.env.IA_ALLOWED_IDENTIFIERS;
    archive({
      docs: [
        {
          identifier: 'notld',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'f.mp4', size: '64' }],
    });

    expect((await new Source().start(request())).status).toBe(
      MediaStatus.ACQUIRING,
    );
  });

  it('says so when nothing matches', async () => {
    archive({ docs: [] });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.note).toMatch(/no free copy/i);
  });

  it('says so when the copy has no usable video', async () => {
    archive({
      docs: [
        {
          identifier: 'notld',
          title: 'Night of the Living Dead',
          year: '1968',
          licenseurl: PD,
        },
      ],
      files: [{ name: 'notld.pdf', size: '64' }],
    });

    expect((await new Source().start(request())).note).toMatch(
      /no usable video/i,
    );
  });

  it('survives the search being down', async () => {
    archive({ searchStatus: 503 });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.note).not.toMatch(/503|error|stack/i);
  });
});

describe('fetching it', () => {
  const ok = {
    docs: [
      {
        identifier: 'notld',
        title: 'Night of the Living Dead',
        year: '1968',
        licenseurl: PD,
      },
    ],
    files: [{ name: 'notld.mp4', size: '64' }],
  };

  it('keeps a half-finished file out of the drop folder', async () => {
    archive(ok);
    const source = new Source();
    const started = await source.start(request());

    // looked at before anything has finished
    expect(await listDrop()).toEqual([]);
    expect(await source.poll(request({ sourceRef: started.ref }))).toBeNull();
    expect(await listDrop()).toEqual([]);
  });

  it('moves the finished file in, named the way the importer reads names', async () => {
    archive(ok);
    const source = new Source();
    const started = await source.start(request());
    await settle();

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).toBe(MediaStatus.IMPORTING);
    expect(out?.note).toBe('Almost ready');
    expect(await listDrop()).toEqual(['Night of the Living Dead (1968).mp4']);
    // nothing left in the work folder but the note that says it was handed
    // over, which is what stops a crash from starting the download again
    const left = await fs.readdir(work);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/\.handoff$/);
  });

  it('never says something is ready to watch', async () => {
    archive(ok);
    const source = new Source();
    const started = await source.start(request());
    await settle();

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).not.toBe(MediaStatus.AVAILABLE);
  });

  it('throws away a download that was cut off, and says so', async () => {
    archive({ ...ok, truncate: true });
    const source = new Source();
    const started = await source.start(request());
    await settle();

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out?.note).toMatch(/didn't finish/i);
    expect(await listDrop()).toEqual([]);
    expect(await fs.readdir(work)).toEqual([]);
  });

  it('cleans up when the file cannot be fetched at all', async () => {
    archive({ ...ok, downloadStatus: 404 });
    const source = new Source();
    const started = await source.start(request());
    await settle();

    expect(
      (await source.poll(request({ sourceRef: started.ref })))?.status,
    ).toBe(MediaStatus.UNAVAILABLE);
    expect(await fs.readdir(work)).toEqual([]);
  });

  it('picks the job back up after a restart, from the reference alone', async () => {
    archive(ok);
    // the reference is all a fresh process has
    const ref = JSON.stringify({ id: 'notld', file: 'notld.mp4', size: 64 });
    const restarted = new Source();

    // nothing in memory, nothing on disk: it starts the fetch again
    expect(await restarted.poll(request({ sourceRef: ref }))).toBeNull();
    await settle();
    const out = await restarted.poll(request({ sourceRef: ref }));

    expect(out?.status).toBe(MediaStatus.IMPORTING);
    expect(await listDrop()).toEqual(['Night of the Living Dead (1968).mp4']);
  });

  it('fails safe on a reference it cannot read, rather than ignoring it', async () => {
    archive(ok);
    for (const sourceRef of [null, 'rubbish', '{"file":"only"}']) {
      const out = await new Source().poll(request({ sourceRef }));
      expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
      expect(out?.detail).toMatch(/unreadable/);
    }
    expect(await listDrop()).toEqual([]);
  });

  it('gets a whole film through, not just the first few hundred kilobytes', async () => {
    // one that is comfortably bigger than any stream buffer, so the
    // pushing back is real rather than theoretical
    const big = Buffer.alloc(3 * 1024 * 1024, 9);
    archive({
      ...ok,
      files: [{ name: 'notld.mp4', size: String(big.length) }],
      body: big,
    });
    const source = new Source();
    const started = await source.start(request());
    await new Promise((r) => setTimeout(r, 300));

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).toBe(MediaStatus.IMPORTING);
    const landed = path.join(dropbox, 'Night of the Living Dead (1968).mp4');
    expect((await fs.stat(landed)).size).toBe(big.length);
  });

  it('does not put a deadline on the download itself', async () => {
    // a film is hundreds of megabytes; an abort signal of zero milliseconds
    // ends it before a byte arrives
    archive(ok);
    const source = new Source();
    await source.start(request());
    await settle();

    const download = (global.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes('/download/'),
    );
    const signal = download?.[1]?.signal;
    expect(signal?.aborted).not.toBe(true);
  });

  it('can say how far along it is, for the admin panel', async () => {
    archive(ok);
    const source = new Source();
    await source.start(request());
    await settle();

    const [job] = source.progress();

    expect(job.total).toBe(64);
    expect(job.received).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// the invariant: nothing reaches the drop folder unless it has been verified

describe('nothing reaches the drop folder unverified', () => {
  const SIZE = 64;
  const ok = {
    docs: [
      {
        identifier: 'notld',
        title: 'Night of the Living Dead',
        year: '1968',
        licenseurl: PD,
      },
    ],
    files: [{ name: 'notld.mp4', size: String(SIZE) }],
  };
  const ref = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ id: 'notld', file: 'notld.mp4', size: SIZE, ...over });
  const stem = () => path.join(work, 'notld__notld.mp4');
  const put = async (suffix: string, bytes: number) => {
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(`${stem()}${suffix}`, Buffer.alloc(bytes, 3));
  };
  const downloads = () =>
    (global.fetch as jest.Mock).mock.calls.filter((c) =>
      String(c[0]).includes('/download/'),
    ).length;

  it('restarts from nothing after a restart at 0 bytes', async () => {
    archive(ok);
    await put('.part', 0);
    const fresh = new Source();

    expect(await fresh.poll(request({ sourceRef: ref() }))).toBeNull();
    expect(await listDrop()).toEqual([]);
    await settle();
    expect(downloads()).toBe(1);
  });

  it('never imports a partial file left by a restart, and starts over', async () => {
    archive(ok);
    await put('.part', SIZE / 2);
    const fresh = new Source();

    // the old in-memory job is gone; the half file must not be taken as done
    expect(await fresh.poll(request({ sourceRef: ref() }))).toBeNull();
    expect(await listDrop()).toEqual([]);

    await settle();
    const out = await fresh.poll(request({ sourceRef: ref() }));
    expect(out?.status).toBe(MediaStatus.IMPORTING);
    const [landed] = await listDrop();
    expect((await fs.stat(path.join(dropbox, landed))).size).toBe(SIZE);
  });

  it('does not trust a .part even when it happens to be the right size', async () => {
    // the right number of bytes in a .part is a coincidence, not a
    // verification — only .done means the download finished and was checked
    archive(ok);
    await put('.part', SIZE);
    const fresh = new Source();

    expect(await fresh.poll(request({ sourceRef: ref() }))).toBeNull();
    expect(await listDrop()).toEqual([]);
  });

  it('hands over a verified file found after a restart', async () => {
    archive(ok);
    await put('.done', SIZE);

    const out = await new Source().poll(request({ sourceRef: ref() }));

    expect(out?.status).toBe(MediaStatus.IMPORTING);
    expect(await listDrop()).toEqual(['Night of the Living Dead (1968).mp4']);
    expect(downloads()).toBe(0);
  });

  it('refuses a download that arrives short', async () => {
    archive({ ...ok, truncate: true });
    const source = new Source();
    const started = await source.start(request());
    await settle();

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out?.detail).toMatch(/incomplete/);
    expect(await listDrop()).toEqual([]);
  });

  it('refuses a download that keeps coming past the expected size', async () => {
    // the item says 64 bytes; the server sends 200 and claims nothing
    archive({ ...ok, body: Buffer.alloc(200, 1) });
    (global.fetch as jest.Mock).mockImplementation(
      ((orig) => async (url: any, init: any) => {
        const res = await orig(url, init);
        if (String(url).includes('/download/'))
          res.headers = { get: () => null };
        return res;
      })((global.fetch as jest.Mock).getMockImplementation()!),
    );
    const source = new Source();
    const started = await source.start(request());
    await settle();

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out?.detail).toMatch(/more than the expected/);
    expect(await listDrop()).toEqual([]);
  });

  it('refuses when the server announces a different size from the item', async () => {
    archive({ ...ok, body: Buffer.alloc(100, 1) });
    const source = new Source();
    const started = await source.start(request());
    await settle();

    const out = await source.poll(request({ sourceRef: started.ref }));

    expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out?.detail).toMatch(/sending 100 bytes/);
    expect(await listDrop()).toEqual([]);
  });

  it('discards a finished file that is not the size it should be', async () => {
    archive(ok);
    await put('.done', SIZE + 10);

    const out = await new Source().poll(request({ sourceRef: ref() }));

    expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out?.detail).toMatch(/expected 64/);
    expect(await listDrop()).toEqual([]);
    expect(await fs.readdir(work)).toEqual([]);
  });

  it('will not start a download it could not verify', async () => {
    archive({ ...ok, files: [{ name: 'notld.mp4' }] });

    const out = await new Source().start(request());

    expect(out.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out.detail).toMatch(/no listed size/);
    expect(downloads()).toBe(0);
  });

  it('fails safe on a reference with no size in it', async () => {
    archive(ok);
    const out = await new Source().poll(
      request({ sourceRef: ref({ size: 0 }) }),
    );

    expect(out?.status).toBe(MediaStatus.UNAVAILABLE);
    expect(out?.detail).toMatch(/no expected size/);
    expect(downloads()).toBe(0);
  });

  it('finishes the job after a crash just before the move', async () => {
    // verified and marked for handover, then the process died
    archive(ok);
    await put('.done', SIZE);
    await fs.writeFile(`${stem()}.handoff`, '{}');

    const out = await new Source().poll(request({ sourceRef: ref() }));

    expect(out?.status).toBe(MediaStatus.IMPORTING);
    expect(await listDrop()).toEqual(['Night of the Living Dead (1968).mp4']);
    expect(downloads()).toBe(0);
  });

  it('does not download again after a crash just after the move', async () => {
    // moved into the drop folder, but nobody was told before the crash
    archive(ok);
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(`${stem()}.handoff`, '{}');
    await fs.writeFile(
      path.join(dropbox, 'Night of the Living Dead (1968).mp4'),
      Buffer.alloc(SIZE, 3),
    );

    const out = await new Source().poll(request({ sourceRef: ref() }));
    await settle();

    expect(out?.status).toBe(MediaStatus.IMPORTING);
    expect(downloads()).toBe(0);
    expect(await listDrop()).toEqual(['Night of the Living Dead (1968).mp4']);
  });

  it('never says ready to watch, whatever state it finds', async () => {
    for (const setup of [
      () => put('.done', SIZE),
      () => put('.part', SIZE / 2),
      () => fs.writeFile(`${stem()}.handoff`, '{}'),
    ]) {
      await fs.rm(work, { recursive: true, force: true });
      await fs.mkdir(work, { recursive: true });
      archive(ok);
      await setup();
      const out = await new Source().poll(request({ sourceRef: ref() }));
      expect(out?.status).not.toBe(MediaStatus.AVAILABLE);
      // a restarted download runs on in the background; let it finish
      // before the next case clears the folder out from under it
      await settle();
    }
  });
});

describe('the archive provider with its drive missing', () => {
  afterEach(() => {
    delete process.env.MEDIA_MOUNT;
    delete process.env.MEDIA_MOUNTS_FILE;
  });

  it('pauses a finished job rather than moving it or giving up on it', async () => {
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(
      path.join(work, 'notld__notld.mp4.done'),
      Buffer.alloc(64, 3),
    );
    const mounts = path.join(root, 'mounts');
    await fs.writeFile(mounts, '/dev/sdb2 / ext4 rw 0 0\n');
    process.env.MEDIA_MOUNT = root;
    process.env.MEDIA_MOUNTS_FILE = mounts;
    jest.resetModules();
    const Fresh = require('./internet-archive.source').InternetArchiveSource;
    archive({});

    const out = await new Fresh().poll(
      request({
        sourceRef: JSON.stringify({ id: 'notld', file: 'notld.mp4', size: 64 }),
      }),
    );

    expect(out).toBeNull();
    expect(await listDrop()).toEqual([]);
    expect(await fs.readdir(work)).toEqual(['notld__notld.mp4.done']);
    expect(await new Fresh().available()).toBe(false);
  });
});
