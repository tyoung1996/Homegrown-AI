/**
 * Following playbacks and crediting the right person. Everything real
 * except the edges: the database is an in-memory table, the TVs say
 * whatever each test tells them to, and Jellyfin is a list of what it was
 * told, in order.
 */
import { PlaybackTracker } from './playback-tracker.service';
import type { Screen, PlaybackState } from './screens.service';
import {
  GRACE_MS,
  POLL_MS,
  SETTLE_WINDOW_MS,
  STARTUP_WINDOW_MS,
} from './playback-lifecycle';

const FILM = 'film-night';
const OTHER = 'film-other';
const cast: Screen = {
  id: 'cast:10.0.0.11',
  name: 'Kids room',
  kind: 'cast',
  address: '10.0.0.11',
  ready: false,
};
const upnp: Screen = {
  id: 'dlna:10.0.0.15',
  name: 'Living room',
  kind: 'dlna',
  address: '10.0.0.15',
  control: '/upnp/control/AVTransport1',
  ready: false,
};
const roku: Screen = {
  id: 'roku:10.0.0.12',
  name: 'Den',
  kind: 'roku',
  address: '10.0.0.12',
  ready: false,
};

type Row = Record<string, any>;
interface Report {
  event: 'start' | 'progress' | 'stopped';
  playbackId: string;
  person: string;
  itemId: string;
  position: number;
  paused: boolean;
}

// ------------------------------------------------------ the pretend world

const cmp = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number;
function matches(row: Row, where: Row = {}): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond instanceof Date) {
      if (cmp(v) !== cond.getTime()) return false;
    } else if (typeof cond === 'object') {
      const c = cond as Row;
      if ('in' in c && !c.in.includes(v)) return false;
      if ('gt' in c && !(v != null && cmp(v) > cmp(c.gt))) return false;
      if ('lt' in c && !(v != null && cmp(v) < cmp(c.lt))) return false;
      if ('not' in c && (c.not === null ? v == null : v === c.not)) {
        return false;
      }
    } else if (v !== cond) return false;
  }
  return true;
}

class World {
  rows: Row[] = [];
  people = new Map<string, string | null>([
    ['ann', 'jf-ann'],
    ['ben', 'jf-ben'],
    ['kid', null], // no Jellyfin account linked
  ]);
  tvs = new Map<string, PlaybackState>();
  reports: Report[] = [];
  ended: string[] = [];
  jellyfinDown = false;
  /** lets a test slip something in straight after a database write */
  afterUpdate: ((data: Row) => void) | null = null;
  clock = new Date('2026-09-24T12:00:00Z').getTime();

  prisma = {
    playback: {
      create: async ({ data }: { data: Row }) => {
        const row = {
          state: 'STARTING',
          lastPosition: null,
          lastSeenAt: null,
          reportedAt: null,
          closedAt: null,
          closeReason: null,
          settledAt: null,
          control: null,
          ...data,
        };
        this.rows.push(row);
        return { ...row };
      },
      findUnique: async ({ where }: { where: Row }) => {
        const r = this.rows.find((x) => x.id === where.id);
        return r ? { ...r } : null;
      },
      findFirst: async ({ where }: { where: Row }) => {
        const r = this.rows.find((x) => matches(x, where));
        return r ? { ...r } : null;
      },
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row }) => {
        const out = this.rows
          .filter((x) => matches(x, where))
          .map((x) => ({ ...x }));
        if (orderBy?.startedAt) {
          const dir = orderBy.startedAt === 'desc' ? -1 : 1;
          out.sort((a, b) => dir * (cmp(a.startedAt) - cmp(b.startedAt)));
        }
        return out;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = this.rows.filter((x) => matches(x, where));
        for (const r of hit) Object.assign(r, data);
        this.afterUpdate?.(data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = this.rows.length;
        this.rows = this.rows.filter((x) => !matches(x, where));
        return { count: before - this.rows.length };
      },
    },
    user: {
      findUnique: async ({ where }: { where: Row }) =>
        this.people.has(String(where.id))
          ? { jellyfinUserId: this.people.get(String(where.id)) }
          : null,
    },
  };

  jellyfin = {
    reportPlayback: jest.fn(
      async (
        p: { playbackId: string; jellyfinUserId: string; itemId: string },
        event: Report['event'],
        position: number,
        paused = false,
      ) => {
        if (this.jellyfinDown) return false;
        this.reports.push({
          event,
          playbackId: p.playbackId,
          person: p.jellyfinUserId,
          itemId: p.itemId,
          position,
          paused,
        });
        return true;
      },
    ),
    endPlaybackSession: jest.fn(async (id: string) => {
      this.ended.push(id);
      return true;
    }),
  };

  screens = {
    nowPlaying: jest.fn(async (s: Screen): Promise<PlaybackState> => {
      return this.tvs.get(s.id) ?? { state: 'unknown' };
    }),
  };

  /** A tracker — a fresh one is what a restart looks like. */
  tracker(): PlaybackTracker {
    const t = new PlaybackTracker(
      this.prisma as never,
      this.jellyfin as never,
      this.screens as never,
    );
    t.now = () => new Date(this.clock);
    return t;
  }

  pass(ms = POLL_MS) {
    this.clock += ms;
  }

  /** What a TV shows once a playback has gone on it. */
  showing(
    screen: Screen,
    playbackId: string,
    itemId: string,
    positionSeconds: number,
    state: PlaybackState['state'] = 'playing',
  ) {
    this.tvs.set(screen.id, {
      state,
      itemId,
      playbackId,
      positionSeconds,
      durationSeconds: 5744,
    });
  }

  row(id: string) {
    return this.rows.find((r) => r.id === id)!;
  }

  reportsFor(playbackId: string) {
    return this.reports.filter((r) => r.playbackId === playbackId);
  }

  /** Where Jellyfin would have each person now: the last thing it heard. */
  jellyfinHas(person: string, itemId = FILM) {
    const last = [...this.reports]
      .reverse()
      .find((r) => r.person === person && r.itemId === itemId);
    return last?.position;
  }
}

/** Start something on a TV the way the app does, and have the TV show it. */
async function start(
  w: World,
  t: PlaybackTracker,
  userId: string,
  screen: Screen,
  itemId = FILM,
  at = 0,
) {
  const { result: pb, tracked } = await t.begin(
    { userId, screen, itemId },
    async (playbackId) => {
      w.showing(screen, playbackId, itemId, at);
      return playbackId;
    },
  );
  return { pb, tracked };
}

/** Let time pass, the TV move on, and the tracker look. */
async function watch(
  w: World,
  t: PlaybackTracker,
  screen: Screen,
  positionSeconds: number,
  state: PlaybackState['state'] = 'playing',
) {
  const now = w.tvs.get(screen.id)!;
  w.tvs.set(screen.id, { ...now, state, positionSeconds });
  w.pass();
  await t.tick();
}

// ------------------------------------------------------------------ tests

describe('who gets the credit', () => {
  it('two people watching the same film on different TVs each get their own', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 600);
    const b = await start(w, t, 'ben', upnp, FILM, 0);

    await watch(w, t, cast, 630);
    await watch(w, t, upnp, 60);
    await watch(w, t, cast, 690);

    expect(w.reportsFor(a.pb).every((r) => r.person === 'jf-ann')).toBe(true);
    expect(w.reportsFor(b.pb).every((r) => r.person === 'jf-ben')).toBe(true);
    expect(w.jellyfinHas('jf-ann')).toBe(690);
    expect(w.jellyfinHas('jf-ben')).toBe(60);
  });

  it('two people one after the other on the same TV: the first is closed with their own last position', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 600);
    await watch(w, t, cast, 900);

    const b = await start(w, t, 'ben', cast, FILM, 0);
    await watch(w, t, cast, 30);

    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'replaced',
    });
    const annReports = w.reportsFor(a.pb);
    expect(annReports.at(-1)).toMatchObject({
      event: 'stopped',
      position: 900,
    });
    expect(annReports.every((r) => r.person === 'jf-ann')).toBe(true);
    expect(w.reportsFor(b.pb).every((r) => r.person === 'jf-ben')).toBe(true);
    expect(w.jellyfinHas('jf-ann')).toBe(900);
    expect(w.jellyfinHas('jf-ben')).toBe(30);
  });

  it('the same person restarting their own film: the old one is handed over before the new one says anything', async () => {
    const w = new World();
    const t = w.tracker();
    const first = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 1200);

    const second = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 40);
    await watch(w, t, cast, 70);

    const lastOfFirst = w.reports.findLastIndex(
      (r) => r.playbackId === first.pb,
    );
    const firstOfSecond = w.reports.findIndex(
      (r) => r.playbackId === second.pb,
    );
    expect(lastOfFirst).toBeLessThan(firstOfSecond);
    expect(w.jellyfinHas('jf-ann')).toBe(70);
  });

  it('a tracker holding an old look after a replacement writes nothing', async () => {
    const w = new World();
    const t = w.tracker();
    const first = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 1200);
    const staleLook = {
      state: 'playing' as const,
      itemId: FILM,
      playbackId: first.pb,
      positionSeconds: 1230,
      screenId: cast.id,
      at: new Date(w.clock + 1),
    };

    await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 30);
    const before = w.reports.length;
    await t.apply(first.pb, staleLook);

    expect(w.reports.length).toBe(before);
    expect(w.jellyfinHas('jf-ann')).toBe(30);
  });

  it('the same person on two TVs at once: the newer one wins, the older stops writing', async () => {
    const w = new World();
    const t = w.tracker();
    const older = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 500);
    w.pass(1000);
    const newer = await start(w, t, 'ann', upnp, FILM, 0);
    await watch(w, t, upnp, 20);
    await watch(w, t, cast, 560);

    expect(w.row(older.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'superseded',
    });
    const firstOfNewer = w.reports.findIndex((r) => r.playbackId === newer.pb);
    expect(
      w.reports.findLastIndex((r) => r.playbackId === older.pb),
    ).toBeLessThan(firstOfNewer);
    expect(w.jellyfinHas('jf-ann')).toBe(20);
  });

  it('a newer playback waits to report until the older one is handed over', async () => {
    const w = new World();
    const t = w.tracker();
    const older = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 800);
    w.jellyfinDown = true;
    const newer = await start(w, t, 'ann', upnp, FILM, 0);
    await watch(w, t, upnp, 30);
    expect(w.row(older.pb).settledAt).toBeNull();

    w.jellyfinDown = false;
    await watch(w, t, upnp, 60);

    const order = w.reports.map(
      (r) => `${r.playbackId === older.pb ? 'old' : 'new'}:${r.event}`,
    );
    expect(order.slice(-3)).toEqual([
      'old:stopped',
      'new:start',
      'new:progress',
    ]);
    expect(w.jellyfinHas('jf-ann')).toBe(60);
    expect(w.row(newer.pb).state).toBe('ACTIVE');
  });
});

describe('the same film, but not the same playback', () => {
  it('on its TV closes it: the TV is showing a different start', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', upnp, FILM, 0);
    await watch(w, t, upnp, 600);
    // the same film, under another playback id
    w.showing(upnp, 'ffffffffffffffff', FILM, 20);
    w.pass();
    await t.tick();

    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'different-playback',
    });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 600,
    });
    expect(w.reports.every((r) => r.playbackId === a.pb)).toBe(true);
  });

  it('a close that lands between a look and its write wins', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    const before = w.reports.length;
    // as the look is written down, something else closes the playback
    w.afterUpdate = (data) => {
      if (data.state === 'ACTIVE') {
        w.afterUpdate = null;
        Object.assign(w.row(a.pb), { state: 'CLOSED', closeReason: 'stopped' });
      }
    };
    await watch(w, t, cast, 330);

    expect(w.reports.slice(before).some((r) => r.event === 'progress')).toBe(
      false,
    );
  });
});

describe('a person with no Jellyfin account', () => {
  it('can watch, but nothing is written down or reported', async () => {
    const w = new World();
    const t = w.tracker();
    const { tracked } = await start(w, t, 'kid', cast, FILM, 0);
    await watch(w, t, cast, 400);

    expect(tracked).toBe(false);
    expect(w.rows).toHaveLength(0);
    expect(w.reports).toHaveLength(0);
  });

  it('losing the link part way through stops the writing, with no final write', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 400);
    w.people.set('ann', null);
    await watch(w, t, cast, 460);

    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'unlinked',
    });
    expect(w.reportsFor(a.pb).map((r) => r.event)).toEqual([
      'start',
      'progress',
    ]);
  });

  it('a TV that cannot be followed is never tracked', async () => {
    const w = new World();
    const t = w.tracker();
    const { tracked } = await start(w, t, 'ann', roku, FILM, 0);
    expect(tracked).toBe(false);
    expect(w.rows).toHaveLength(0);
  });
});

describe('what the TV does', () => {
  it('reports a start once, then progress', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 600);
    await watch(w, t, cast, 630);
    await watch(w, t, cast, 660);

    expect(w.reportsFor(a.pb).map((r) => `${r.event}:${r.position}`)).toEqual([
      'start:630',
      'progress:630',
      'progress:660',
    ]);
  });

  it('pause: the position holds and is reported as paused', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 700);
    await watch(w, t, cast, 712, 'paused');
    await watch(w, t, cast, 712, 'paused');

    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      position: 712,
      paused: true,
    });
    expect(w.row(a.pb).state).toBe('ACTIVE');
  });

  it('stop: closed with the last confirmed position, and never reopened', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', upnp, FILM, 0);
    await watch(w, t, upnp, 1500);
    // the Samsung keeps the old link and a position after stopping
    await watch(w, t, upnp, 1512, 'stopped');

    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'stopped',
    });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 1500,
    });
    expect(w.ended).toContain(a.pb);

    // someone presses play on the TV's own remote: the old link plays again
    const count = w.reports.length;
    await watch(w, t, upnp, 1520, 'playing');
    await watch(w, t, upnp, 1550, 'playing');
    expect(w.reports.length).toBe(count);
    expect(w.row(a.pb).state).toBe('CLOSED');
  });

  it('stopped from Circuit Barn: one last look, then closed for good', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    w.tvs.set(cast.id, { ...w.tvs.get(cast.id)!, positionSeconds: 320 });
    w.pass(5000);

    const line = await t.stop(cast, async () => {
      w.tvs.set(cast.id, { state: 'idle' });
      return 'Stopped Kids room';
    });

    expect(line).toBe('Stopped Kids room');
    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'stopped-by-app',
    });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 320,
    });
  });

  it('something else put on the TV closes it', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    w.tvs.set(cast.id, { state: 'playing', positionSeconds: 5 });
    w.pass();
    await t.tick();

    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'different-media',
    });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 300,
    });
  });

  it('seek forward and seek backward are both believed', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 600);
    await watch(w, t, cast, 630);
    await watch(w, t, cast, 3000); // skipped ahead
    await watch(w, t, cast, 400); // went back to see something again

    expect(w.reportsFor(a.pb).map((r) => r.position)).toEqual([
      630, 630, 3000, 400,
    ]);
    expect(w.jellyfinHas('jf-ann')).toBe(400);
  });

  it('a look older than the last one is ignored', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 900);
    const count = w.reports.length;
    await t.apply(a.pb, {
      state: 'playing',
      itemId: FILM,
      playbackId: a.pb,
      positionSeconds: 100,
      screenId: cast.id,
      at: new Date(w.clock - 10_000),
    });
    expect(w.reports.length).toBe(count);
    expect(w.row(a.pb).lastPosition).toBe(900);
  });

  it.each([
    ['not a number', NaN],
    ['negative', -5],
    ['far past the end', 99_999],
    ['missing', undefined],
  ])(
    'a position that is %s is not written, and does not close it',
    async (_l, bad) => {
      const w = new World();
      const t = w.tracker();
      const a = await start(w, t, 'ann', cast, FILM, 0);
      await watch(w, t, cast, 500);
      const count = w.reports.length;
      await watch(w, t, cast, bad as number);

      expect(w.reports.length).toBe(count);
      expect(w.row(a.pb)).toMatchObject({ state: 'ACTIVE', lastPosition: 500 });
    },
  );
});

describe('when the TV goes quiet', () => {
  it('briefly: nothing is closed or written, and it carries on after', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 500);
    w.tvs.set(cast.id, { state: 'unknown', detail: 'EHOSTUNREACH' });
    w.pass();
    await t.tick();
    w.pass();
    await t.tick();
    const count = w.reports.length;
    expect(w.row(a.pb).state).toBe('ACTIVE');

    w.showing(cast, a.pb, FILM, 590);
    w.pass();
    await t.tick();
    expect(w.reports.length).toBe(count + 1);
    expect(w.jellyfinHas('jf-ann')).toBe(590);
  });

  it('for longer than the grace period: closed with the last confirmed position', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 500);
    w.tvs.set(cast.id, { state: 'unknown' });
    for (let i = 0; i * POLL_MS <= GRACE_MS; i++) {
      w.pass();
      await t.tick();
    }

    expect(w.row(a.pb)).toMatchObject({ state: 'CLOSED', closeReason: 'lost' });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 500,
    });
  });

  it('a playback the TV never shows is given up with nothing written', async () => {
    const w = new World();
    const t = w.tracker();
    const { result: pb } = await t.begin(
      { userId: 'ann', screen: cast, itemId: FILM },
      async (id) => id, // the TV never switches over
    );
    w.tvs.set(cast.id, { state: 'idle' });
    w.pass();
    await t.tick();
    expect(w.row(pb).state).toBe('STARTING');

    w.pass(STARTUP_WINDOW_MS);
    await t.tick();
    expect(w.row(pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'never-started',
    });
    expect(w.reports).toHaveLength(0);
  });

  it('a TV that refuses to start closes it at once', async () => {
    const w = new World();
    const t = w.tracker();
    await expect(
      t.begin({ userId: 'ann', screen: cast, itemId: FILM }, async () => {
        throw new Error('no');
      }),
    ).rejects.toThrow('no');
    expect(w.rows[0]).toMatchObject({
      state: 'CLOSED',
      closeReason: 'failed-to-start',
    });
    expect(w.reports).toHaveLength(0);
  });
});

describe('after a restart', () => {
  it('while playing: picked back up, without counting a second start', async () => {
    const w = new World();
    const a = await start(w, w.tracker(), 'ann', cast, FILM, 600);
    await watch(w, w.tracker(), cast, 630);

    const restarted = w.tracker();
    await watch(w, restarted, cast, 660);

    expect(w.reportsFor(a.pb).filter((r) => r.event === 'start')).toHaveLength(
      1,
    );
    expect(w.jellyfinHas('jf-ann')).toBe(660);
  });

  it('while paused: picked back up as paused', async () => {
    const w = new World();
    const a = await start(w, w.tracker(), 'ann', cast, FILM, 0);
    await watch(w, w.tracker(), cast, 800, 'paused');

    await watch(w, w.tracker(), cast, 800, 'paused');
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      position: 800,
      paused: true,
    });
    expect(w.row(a.pb).state).toBe('ACTIVE');
  });

  it('while the TV is briefly unreachable: left open', async () => {
    const w = new World();
    const a = await start(w, w.tracker(), 'ann', cast, FILM, 0);
    await watch(w, w.tracker(), cast, 800);
    w.tvs.set(cast.id, { state: 'unknown' });
    w.pass();
    await w.tracker().tick();
    expect(w.row(a.pb).state).toBe('ACTIVE');
  });

  it('after it was replaced by something else: closed, never claimed', async () => {
    const w = new World();
    const a = await start(w, w.tracker(), 'ann', cast, FILM, 0);
    await watch(w, w.tracker(), cast, 800);
    // while the app was down, someone cast something of their own
    w.tvs.set(cast.id, {
      state: 'playing',
      itemId: OTHER,
      playbackId: 'ffffffffffffffff',
      positionSeconds: 10,
    });
    w.pass();
    await w.tracker().tick();

    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'different-media',
    });
    expect(w.reports.every((r) => r.playbackId === a.pb)).toBe(true);
    expect(w.rows).toHaveLength(1);
  });

  it('after it was stopped: closed, with the last confirmed position handed over', async () => {
    const w = new World();
    const a = await start(w, w.tracker(), 'ann', cast, FILM, 0);
    await watch(w, w.tracker(), cast, 1500);
    w.tvs.set(cast.id, { state: 'idle' });
    w.pass();
    await w.tracker().tick();

    expect(w.row(a.pb)).toMatchObject({ state: 'CLOSED', closeReason: 'idle' });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 1500,
    });
  });
});

describe('when Jellyfin will not take it', () => {
  it('progress is tried again on the next look', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    w.jellyfinDown = true;
    await watch(w, t, cast, 300);
    expect(w.row(a.pb).reportedAt).toBeNull();

    w.jellyfinDown = false;
    await watch(w, t, cast, 330);
    expect(w.reportsFor(a.pb).map((r) => r.event)).toEqual([
      'start',
      'progress',
    ]);
    expect(w.jellyfinHas('jf-ann')).toBe(330);
  });

  it('the final position is tried again until it goes', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 900);
    w.jellyfinDown = true;
    await watch(w, t, cast, 910, 'stopped');
    expect(w.row(a.pb)).toMatchObject({ state: 'CLOSED', settledAt: null });

    w.jellyfinDown = false;
    w.pass();
    await t.tick();
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 900,
    });
    expect(w.row(a.pb).settledAt).not.toBeNull();
  });

  it('and is given up after a while, so nothing waits on it for ever', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 900);
    w.jellyfinDown = true;
    await watch(w, t, cast, 910, 'stopped');
    w.pass(SETTLE_WINDOW_MS + 1);
    await t.tick();
    expect(w.row(a.pb).settledAt).not.toBeNull();
  });
});

describe('keeping the table small', () => {
  it('removes closed, settled playbacks after the retention period', async () => {
    const w = new World();
    const t = w.tracker();
    await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 900);
    await watch(w, t, cast, 900, 'stopped');
    expect(w.rows).toHaveLength(1);

    w.pass(31 * 24 * 60 * 60_000);
    await t.tick();
    expect(w.rows).toHaveLength(0);
  });
});

describe('a confirmed stop', () => {
  const idle = (w: World) => w.tvs.set(cast.id, { state: 'idle' });

  it('takes one last look, stops, and only then closes with that position', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    w.tvs.set(cast.id, { ...w.tvs.get(cast.id)!, positionSeconds: 342 });
    w.pass(5000);

    const got = await t.stopConfirmed(
      cast,
      async () => idle(w),
      async () => 'stopped',
    );

    expect(got).toBe('stopped');
    expect(w.row(a.pb)).toMatchObject({
      state: 'CLOSED',
      closeReason: 'stopped-by-app',
    });
    expect(w.reportsFor(a.pb).at(-1)).toMatchObject({
      event: 'stopped',
      position: 342,
    });
    expect(w.row(a.pb).settledAt).not.toBeNull();
  });

  it('a TV still playing afterwards stays open and keeps being followed', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);

    const got = await t.stopConfirmed(
      cast,
      async () => undefined,
      async () => 'playing',
    );
    expect(got).toBe('still-playing');
    expect(w.row(a.pb).state).toBe('ACTIVE');

    await watch(w, t, cast, 360);
    expect(w.jellyfinHas('jf-ann')).toBe(360);
  });

  it('a TV that will not say stays open', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    expect(
      await t.stopConfirmed(
        cast,
        async () => undefined,
        async () => 'unknown',
      ),
    ).toBe('unconfirmed');
    expect(w.row(a.pb).state).toBe('ACTIVE');
  });

  it('a stop that throws closes nothing', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    await expect(
      t.stopConfirmed(
        cast,
        async () => {
          throw new Error('no route');
        },
        async () => 'stopped',
      ),
    ).rejects.toThrow('no route');
    expect(w.row(a.pb).state).toBe('ACTIVE');
  });

  it('once closed, the same playback showing again is never picked back up', async () => {
    const w = new World();
    const t = w.tracker();
    const a = await start(w, t, 'ann', cast, FILM, 0);
    await watch(w, t, cast, 300);
    await t.stopConfirmed(
      cast,
      async () => idle(w),
      async () => 'stopped',
    );
    const count = w.reports.length;

    w.showing(cast, a.pb, FILM, 305);
    w.pass();
    await t.tick();
    await t.refresh(cast.id);

    expect(w.reports.length).toBe(count);
    expect(w.row(a.pb).state).toBe('CLOSED');
  });

  it("touches nobody else's playback", async () => {
    const w = new World();
    const t = w.tracker();
    await start(w, t, 'ann', cast, FILM, 0);
    const b = await start(w, t, 'ben', upnp, FILM, 0);
    await watch(w, t, cast, 300);
    await watch(w, t, upnp, 100);
    const bens = w.reportsFor(b.pb).length;

    await t.stopConfirmed(
      cast,
      async () => idle(w),
      async () => 'stopped',
    );

    expect(w.row(b.pb).state).toBe('ACTIVE');
    expect(w.reportsFor(b.pb).length).toBe(bens);
    expect(
      w.reports
        .filter((r) => r.event === 'stopped')
        .every((r) => r.person === 'jf-ann'),
    ).toBe(true);
  });
});
