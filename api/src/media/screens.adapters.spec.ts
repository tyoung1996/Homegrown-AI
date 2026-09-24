/**
 * The playback adapters and the readers that watch them. The question every
 * observation test answers is not "is the TV playing" but "is it playing
 * the thing this app started" — the same item, and the same start of it.
 */

// a pretend Cast receiver, standing in for the castv2 library. each test
// sets what the receiver is doing; loads record what it was asked to play
const mockCast = {
  reachable: true,
  sessions: [] as { appId: string; sessionId: string; transportId: string }[],
  status: null as null | Record<string, unknown>,
  loads: [] as {
    media: { contentId: string };
    opts: { currentTime?: number };
  }[],
};
jest.mock('castv2-client', () => {
  class DefaultMediaReceiver {
    load(media: any, opts: any, cb: (e: Error | null) => void) {
      mockCast.loads.push({ media, opts });
      cb(null);
    }
    getStatus(cb: (e: Error | null, s?: any) => void) {
      cb(null, mockCast.status ?? undefined);
    }
    stop(cb: () => void) {
      cb();
    }
  }
  class Client {
    private handlers: Record<string, (e: Error) => void> = {};
    on(ev: string, fn: (e: Error) => void) {
      this.handlers[ev] = fn;
    }
    connect(_host: string, cb: () => void) {
      if (!mockCast.reachable) {
        setTimeout(
          () => this.handlers.error?.(new Error('connect ECONNREFUSED')),
          0,
        );
        return;
      }
      cb();
    }
    launch(
      _app: unknown,
      cb: (e: Error | null, p: DefaultMediaReceiver) => void,
    ) {
      cb(null, new DefaultMediaReceiver());
    }
    getSessions(cb: (e: Error | null, s: any[]) => void) {
      cb(null, mockCast.sessions);
    }
    join(
      _s: unknown,
      _app: unknown,
      cb: (e: Error | null, p: DefaultMediaReceiver) => void,
    ) {
      cb(null, new DefaultMediaReceiver());
    }
    stop(_p: unknown, cb: () => void) {
      cb();
    }
    close() {
      /* nothing to close */
    }
  }
  return { Client, DefaultMediaReceiver };
});

import {
  ScreensService,
  isSamePlayback,
  itemIdFromUrl,
  playbackIdFromUrl,
  positionFor,
} from './screens.service';

const NOTLD = '94a4f867104ea527a3a6cb3ccc84873a';
const HP = '029ae794dc43397972195621b443eed9';
const film = { id: NOTLD, name: 'Night of the Living Dead', container: 'mp4' };
const other = { id: HP, name: 'Chamber of Secrets', container: 'mp4' };

const castTv = {
  id: 'cast:10.0.0.11',
  name: 'Kids room',
  kind: 'cast' as const,
  address: '10.0.0.11',
  ready: false,
};
const upnpTv = {
  id: 'dlna:10.0.0.15',
  name: 'Living room',
  kind: 'dlna' as const,
  address: '10.0.0.15',
  control: '/upnp/control/AVTransport1',
  ready: false,
};
const rokuTv = {
  id: 'roku:10.0.0.12',
  name: 'Den',
  kind: 'roku' as const,
  address: '10.0.0.12',
  ready: false,
};

function service(jellyfinOver: Record<string, unknown> = {}) {
  const jellyfin: any = {
    sessions: jest.fn(async () => []),
    liveSessions: jest.fn(async () => []),
    playOnSession: jest.fn(async () => true),
    ...jellyfinOver,
  };
  const s = new ScreensService(
    jellyfin as ConstructorParameters<typeof ScreensService>[0],
  );
  (s as any).scan = { at: Date.now(), found: [] };
  return { s, jellyfin };
}

// what a receiver playing a given link reports
const casting = (
  contentId: string,
  state = 'PLAYING',
  currentTime: number | undefined = 612,
) => {
  mockCast.sessions = [{ appId: 'CC1AD845', sessionId: 'x', transportId: 'y' }];
  mockCast.status = {
    playerState: state,
    currentTime,
    media: { contentId, duration: 5744 },
  };
};

const REAL_FETCH = global.fetch;
beforeEach(() => {
  mockCast.reachable = true;
  mockCast.sessions = [];
  mockCast.status = null;
  mockCast.loads = [];
});
afterEach(() => {
  global.fetch = REAL_FETCH;
});

/** a pretend UPnP TV that plays back whatever link it was last given */
function upnp(opts: { transport?: string; rel?: string; down?: boolean } = {}) {
  const actions: { action: string; body: string }[] = [];
  let uri = '';
  global.fetch = jest.fn(async (_url: any, init: any) => {
    if (opts.down) throw new Error('connect EHOSTUNREACH');
    const action =
      String(init?.headers?.soapaction ?? '')
        .split('#')[1]
        ?.replace('"', '') ?? '';
    const body = String(init?.body ?? '');
    actions.push({ action, body });
    if (action === 'SetAVTransportURI') {
      uri = /<CurrentURI>([^<]*)<\/CurrentURI>/.exec(body)?.[1] ?? '';
    }
    let reply = '';
    if (action === 'GetTransportInfo') {
      reply = `<CurrentTransportState>${opts.transport ?? 'PLAYING'}</CurrentTransportState>`;
    }
    if (action === 'GetPositionInfo') {
      reply =
        `<TrackURI>${uri}</TrackURI><RelTime>${opts.rel ?? '0:10:12'}</RelTime>` +
        '<TrackDuration>1:35:44</TrackDuration>';
    }
    return {
      ok: true,
      status: 200,
      text: async () => `<s:Envelope><s:Body>${reply}</s:Body></s:Envelope>`,
    } as any;
  }) as any;
  return {
    actions,
    // someone else puts a link on the TV, as another app or remote would
    setUri: (u: string) => {
      uri = u.replace(/&/g, '&amp;');
    },
  };
}

// ------------------------------------------------------------------ Cast

describe('Cast: starting', () => {
  it('starts from the beginning when asked for 0', async () => {
    const { s } = service();
    await s.play(castTv, film, 0);
    expect(mockCast.loads[0].opts.currentTime).toBe(0);
  });

  it('starts at the saved point when given one', async () => {
    const { s } = service();
    await s.play(castTv, film, 600);
    expect(mockCast.loads[0].opts.currentTime).toBe(600);
  });

  it('gives every start its own playback id, in the link itself', async () => {
    const { s } = service();
    await s.play(castTv, film, 0);
    const first = s.startedOn(castTv)!;
    await s.play(castTv, film, 0);
    const second = s.startedOn(castTv)!;

    expect(first.playbackId).toMatch(/^[a-f0-9]{16}$/);
    expect(second.playbackId).not.toBe(first.playbackId);
    expect(mockCast.loads[1].media.contentId).toContain(
      `pb=${second.playbackId}`,
    );
  });
});

describe('Cast: watching what is on', () => {
  async function started() {
    const { s } = service();
    await s.play(castTv, film, 600);
    return {
      s,
      link: mockCast.loads[0].media.contentId,
      run: s.startedOn(castTv)!,
    };
  }

  it('recognises the playback it started, still playing', async () => {
    const { s, link, run } = await started();
    casting(link);

    const now = await s.nowPlaying(castTv);

    expect(now).toMatchObject({
      state: 'playing',
      itemId: NOTLD,
      playbackId: run.playbackId,
    });
    expect(positionFor(run, now)).toBe(612);
  });

  it('does not mistake a different film for it', async () => {
    const { s, run } = await started();
    await s.play(castTv, other, 0);
    casting(mockCast.loads[1].media.contentId);

    const now = await s.nowPlaying(castTv);

    expect(now.itemId).toBe(HP);
    expect(positionFor(run, now)).toBeNull();
  });

  it('does not mistake the same film started again for it', async () => {
    // two people, one film, one TV: the second start is a different playback
    const { s, run } = await started();
    await s.play(castTv, film, 0);
    casting(mockCast.loads[1].media.contentId);

    const now = await s.nowPlaying(castTv);

    expect(now.itemId).toBe(NOTLD);
    expect(now.playbackId).not.toBe(run.playbackId);
    expect(positionFor(run, now)).toBeNull();
  });

  it('gives no position once it has stopped, even with the link still showing', async () => {
    const { s, link, run } = await started();
    casting(link, 'IDLE');

    const now = await s.nowPlaying(castTv);

    expect(now.state).toBe('stopped');
    expect(isSamePlayback(run, now)).toBe(true);
    expect(positionFor(run, now)).toBeNull();
  });

  it('reads a receiver that has been closed as idle', async () => {
    const { s, run } = await started();
    mockCast.sessions = [];

    const now = await s.nowPlaying(castTv);

    expect(now.state).toBe('idle');
    expect(positionFor(run, now)).toBeNull();
  });

  it('reads a TV it cannot reach as unknown, never as the film', async () => {
    const { s, run } = await started();
    mockCast.reachable = false;

    const now = await s.nowPlaying(castTv);

    expect(now.state).toBe('unknown');
    expect(positionFor(run, now)).toBeNull();
  });

  it('gives no position when the receiver will not say where it is', async () => {
    const { s, link, run } = await started();
    casting(link);
    mockCast.status = { ...mockCast.status, currentTime: undefined };

    const now = await s.nowPlaying(castTv);

    expect(now.positionSeconds).toBeUndefined();
    expect(positionFor(run, now)).toBeNull();
  });

  it('does not claim a playback for a link that is not ours', async () => {
    const { s, run } = await started();
    casting('https://example.com/some/video.mp4');

    const now = await s.nowPlaying(castTv);

    expect(now.itemId).toBeUndefined();
    expect(now.playbackId).toBeUndefined();
    expect(positionFor(run, now)).toBeNull();
  });
});

// ------------------------------------------------------------------ UPnP

describe('UPnP: starting', () => {
  it('starts from the beginning without any seek', async () => {
    const { s } = service();
    const tv = upnp();
    await s.play(upnpTv, film, 0);
    expect(tv.actions.map((a) => a.action)).toEqual([
      'Stop',
      'SetAVTransportURI',
      'Play',
    ]);
  });

  it('asked for a saved point, still starts from the beginning and never seeks', async () => {
    // proven on the real Samsung: every seek mode was refused on our stream
    const { s } = service();
    const tv = upnp();
    await s.play(upnpTv, film, 600);
    expect(tv.actions.map((a) => a.action)).not.toContain('Seek');
  });

  it('puts the playback id in the link the TV is given', async () => {
    const { s } = service();
    const tv = upnp();
    await s.play(upnpTv, film, 0);
    const set = tv.actions.find((a) => a.action === 'SetAVTransportURI')!;
    expect(set.body).toContain(`pb=${s.startedOn(upnpTv)!.playbackId}`);
  });
});

describe('UPnP: watching what is on', () => {
  it('recognises the playback it started, still playing', async () => {
    const { s } = service();
    upnp();
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;

    const now = await s.nowPlaying(upnpTv);

    expect(now).toMatchObject({
      state: 'playing',
      itemId: NOTLD,
      playbackId: run.playbackId,
    });
    expect(positionFor(run, now)).toBe(612);
  });

  it('does not mistake a different film for it', async () => {
    const { s } = service();
    upnp();
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;
    await s.play(upnpTv, other, 0);

    const now = await s.nowPlaying(upnpTv);

    expect(now.itemId).toBe(HP);
    expect(positionFor(run, now)).toBeNull();
  });

  it('does not mistake the same film started again for it', async () => {
    const { s } = service();
    upnp();
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;
    await s.play(upnpTv, film, 0);

    const now = await s.nowPlaying(upnpTv);

    expect(now.itemId).toBe(NOTLD);
    expect(positionFor(run, now)).toBeNull();
  });

  it('gives no position once stopped, though the TV still shows the old link', async () => {
    // seen on the real Samsung: after Stop, TrackURI is still the last film
    const { s } = service();
    upnp({ transport: 'STOPPED' });
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;

    const now = await s.nowPlaying(upnpTv);

    expect(now.state).toBe('stopped');
    expect(isSamePlayback(run, now)).toBe(true);
    expect(positionFor(run, now)).toBeNull();
  });

  it('reads a TV it cannot reach as unknown', async () => {
    const { s } = service();
    upnp();
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;
    upnp({ down: true });

    const now = await s.nowPlaying(upnpTv);

    expect(now.state).toBe('unknown');
    expect(positionFor(run, now)).toBeNull();
  });

  it('gives no position when the TV cannot say where it is', async () => {
    const { s } = service();
    upnp({ rel: 'NOT_IMPLEMENTED' });
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;

    const now = await s.nowPlaying(upnpTv);

    expect(now.positionSeconds).toBeUndefined();
    expect(positionFor(run, now)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ["someone else's video", 'http://youtube.example/watch?v=x'],
    [
      'our path on another server, not under /api',
      'http://x/media/stream/94a4f867104ea527?pb=0123456789abcdef',
    ],
    [
      'a malformed item id',
      'http://x/api/media/stream/not-hex!!?pb=0123456789abcdef',
    ],
    [
      'our film with no playback id',
      `http://x/api/media/stream/${NOTLD}?t=sig`,
    ],
    [
      'our film with a malformed playback id',
      `http://x/api/media/stream/${NOTLD}?t=sig&pb=zz`,
    ],
  ])('never claims a playback from %s', async (_label, link) => {
    const { s } = service();
    const tv = upnp();
    await s.play(upnpTv, film, 0);
    const run = s.startedOn(upnpTv)!;
    tv.setUri(link);

    const now = await s.nowPlaying(upnpTv);

    expect(positionFor(run, now)).toBeNull();
  });
});

// ------------------------------------------------------------ the others

describe('a Jellyfin app session', () => {
  const tv = {
    id: 'session:s1',
    name: 'Den app',
    kind: 'session' as const,
    ready: true,
  };

  it('is told the exact start point in ticks', async () => {
    const { s, jellyfin } = service();
    await s.play(tv, film, 600);
    expect(jellyfin.playOnSession).toHaveBeenCalledWith(
      's1',
      NOTLD,
      6_000_000_000,
    );
  });

  it('is told nothing about a start point when starting from the beginning', async () => {
    const { s, jellyfin } = service();
    await s.play(tv, film, 0);
    expect(jellyfin.playOnSession).toHaveBeenCalledWith('s1', NOTLD, 0);
  });
});

describe('a Roku, unchanged for now', () => {
  function rokuWorld() {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      return {
        ok: true,
        status: 200,
        text: async () =>
          path.startsWith('/query/apps')
            ? '<apps><app id="592369">Jellyfin</app></apps>'
            : '',
      } as any;
    }) as any;
    return calls;
  }

  it('launches exactly the same way whatever start point it is given', async () => {
    const { s } = service();
    const calls = rokuWorld();
    await s.play(rokuTv, { ...film, type: 'Movie' }, 0);
    const at0 = calls.filter((c) => c.startsWith('POST /launch'));
    calls.length = 0;
    await s.play(rokuTv, { ...film, type: 'Movie' }, 600);
    const at600 = calls.filter((c) => c.startsWith('POST /launch'));

    expect(at600).toEqual(at0);
    expect(at0[0]).toBe(
      `POST /launch/592369?contentId=${NOTLD}&mediaType=movie`,
    );
  }, 15_000);

  it('is not recorded as a playback this app can watch', async () => {
    const { s } = service();
    rokuWorld();
    await s.play(rokuTv, { ...film, type: 'Movie' }, 0);
    expect(s.startedOn(rokuTv)).toBeUndefined();
  }, 10_000);
});

describe('reading links', () => {
  it('finds the item and playback only in links of ours', () => {
    const ours = `http://10.0.0.2:3001/api/media/stream/${NOTLD}?t=sig&pb=0123456789abcdef`;
    expect(itemIdFromUrl(ours)).toBe(NOTLD);
    expect(playbackIdFromUrl(ours)).toBe('0123456789abcdef');
    expect(
      playbackIdFromUrl('http://other/x?pb=0123456789abcdef'),
    ).toBeUndefined();
  });
});
