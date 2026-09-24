import { ScreensService } from './screens.service';

// the house as the scanner found it, so no test touches the network
function build(
  opts: {
    tvs?: any[];
    sessions?: any[];
    playDelayMs?: number;
    playFails?: boolean;
  } = {},
) {
  const order: string[] = [];
  const jellyfin: any = {
    sessions: jest.fn(async () => opts.sessions ?? []),
    playOnSession: jest.fn(async (sessionId: string, itemId: string) => {
      order.push(`start ${itemId}`);
      await new Promise((r) => setTimeout(r, opts.playDelayMs ?? 5));
      order.push(`done ${itemId}`);
      return !opts.playFails;
    }),
    command: jest.fn(async () => true),
    streamUrl: (id: string) => `http://server/Videos/${id}/stream`,
  };
  const service = new ScreensService(jellyfin);
  // pretend the subnet sweep already ran
  (service as any).scan = { at: Date.now(), found: opts.tvs ?? [] };
  return { service, jellyfin, order };
}

const session = (id: string, name: string) => ({
  Id: id,
  id,
  deviceName: name,
});

describe('ScreensService listing', () => {
  it('lists open Jellyfin apps and TVs found on the network', async () => {
    const { service } = build({
      sessions: [session('s1', 'Living Room TV')],
      tvs: [
        {
          id: 'cast:10.0.0.11',
          name: 'Kids Room TV',
          kind: 'cast',
          ready: false,
        },
      ],
    });

    const list = await service.list();

    expect(list.map((s) => s.name)).toEqual(['Living Room TV', 'Kids Room TV']);
    expect(list[0].kind).toBe('session');
  });

  it('does not list the same TV twice when its app is open', async () => {
    const { service } = build({
      sessions: [session('s1', "Kids' room TV")],
      tvs: [
        {
          id: 'cast:10.0.0.11',
          name: "Kids' room TV new",
          kind: 'cast',
          ready: false,
        },
      ],
    });

    expect(await service.list()).toHaveLength(1);
  });

  it('finds a TV by the name someone said, not just its id', async () => {
    const { service } = build({
      tvs: [
        {
          id: 'roku:10.0.0.12',
          name: 'Den TV',
          kind: 'roku',
          ready: false,
        },
      ],
    });

    expect((await service.find('den tv'))?.id).toBe('roku:10.0.0.12');
    expect((await service.find('roku:10.0.0.12'))?.name).toBe('Den TV');
    expect(await service.find('kitchen')).toBeNull();
  });
});

describe('ScreensService with more than one person asking', () => {
  it('queues two requests for the same TV instead of overlapping them', async () => {
    const { service, order } = build({
      sessions: [session('s1', 'Living Room TV')],
      playDelayMs: 20,
    });
    const tv = (await service.list())[0];

    await Promise.all([
      service.play(tv, { id: 'movie-a', name: 'Encanto' }),
      service.play(tv, { id: 'movie-b', name: 'Moana' }),
    ]);

    // whichever went first finished before the other started
    expect(order).toEqual([
      'start movie-a',
      'done movie-a',
      'start movie-b',
      'done movie-b',
    ]);
  });

  it('plays on two different TVs at the same time', async () => {
    const { service } = build({
      sessions: [
        session('s1', 'Living Room TV'),
        session('s2', 'Kids Room TV'),
      ],
      playDelayMs: 20,
    });
    const [living, kids] = await service.list();

    const started = Date.now();
    await Promise.all([
      service.play(living, { id: 'movie-a', name: 'Encanto' }),
      service.play(kids, { id: 'movie-b', name: 'Moana' }),
    ]);

    // side by side, not one after the other
    expect(Date.now() - started).toBeLessThan(40);
  });

  it('tells the next person what a TV is already playing', async () => {
    const { service } = build({
      tvs: [
        {
          id: 'roku:10.0.0.13',
          name: 'Den TV',
          kind: 'roku',
          ready: false,
        },
      ],
    });
    // pretend something was started there a moment ago
    (service as any).started.set('roku:10.0.0.13', {
      title: 'Encanto',
      at: Date.now(),
    });

    const tv = await service.find('Den TV');

    expect(tv?.nowPlaying).toBe('Encanto');
    expect(tv?.ready).toBe(true);
  });

  it('forgets what was playing once it is stale', async () => {
    const { service } = build({
      tvs: [
        {
          id: 'roku:10.0.0.13',
          name: 'Den TV',
          kind: 'roku',
          ready: false,
        },
      ],
    });
    (service as any).started.set('roku:10.0.0.13', {
      title: 'Encanto',
      at: Date.now() - 5 * 60 * 60_000,
    });

    expect((await service.find('Den TV'))?.nowPlaying).toBeUndefined();
  });

  it('says what it interrupted', async () => {
    const { service } = build({
      sessions: [{ ...session('s1', 'Living Room TV'), nowPlaying: 'Encanto' }],
    });
    (service as any).jellyfin.sessions = jest.fn(async () => [
      {
        id: 's1',
        deviceName: 'Living Room TV',
        client: 'x',
        nowPlaying: 'Encanto',
      },
    ]);
    const tv = (await service.list())[0];

    const line = await service.play(tv, { id: 'movie-b', name: 'Moana' });

    expect(line).toContain('Playing Moana on Living Room TV');
    expect(line).toContain('it was playing Encanto');
  });

  it('does not leave a TV stuck after a failed play', async () => {
    const { service } = build({
      sessions: [session('s1', 'Living Room TV')],
      playFails: true,
    });
    const tv = (await service.list())[0];

    await expect(
      service.play(tv, { id: 'movie-a', name: 'Encanto' }),
    ).rejects.toThrow(/did not take the request/);
    // the next person is not blocked by the failure
    expect((service as any).busy.size).toBe(0);
  });

  it('only sweeps the network once when several people ask at once', async () => {
    const { service } = build({});
    (service as any).scan = { at: 0, found: [] };
    const sweep = jest
      .spyOn(service as any, 'sweep')
      .mockImplementation(
        () => new Promise((r) => setTimeout(() => r([]), 10)),
      );

    await Promise.all([
      (service as any).discover(),
      (service as any).discover(),
      (service as any).discover(),
    ]);

    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

describe('ScreensService naming the TVs after the rooms', () => {
  const ORIGINAL = process.env.SCREEN_NAMES;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SCREEN_NAMES;
    else process.env.SCREEN_NAMES = ORIGINAL;
  });

  const house = [
    { id: 'roku:10.0.0.12', name: 'Den TV', kind: 'roku', ready: false },
    {
      id: 'roku:10.0.0.14',
      name: 'Garage tv',
      kind: 'roku',
      ready: false,
    },
    {
      id: 'roku:10.0.0.13',
      name: '55" Roku TV',
      kind: 'roku',
      ready: false,
    },
    {
      id: 'cast:10.0.0.15',
      name: '65" Smart UHD',
      kind: 'cast',
      ready: false,
    },
  ];

  it('shows the room name instead of whatever the TV calls itself', async () => {
    process.env.SCREEN_NAMES = JSON.stringify({
      'Den TV': 'Front room',
      'Garage tv': 'Nursery',
      '55" Roku TV': 'Back bedroom',
      '65" Smart UHD': 'Living room',
    });
    const { service } = build({ tvs: house });

    expect((await service.list()).map((s) => s.name)).toEqual([
      'Front room',
      'Nursery',
      'Back bedroom',
      'Living room',
    ]);
  });

  it('still finds a TV by the name printed on it', async () => {
    process.env.SCREEN_NAMES = JSON.stringify({ 'Den TV': 'Front room' });
    const { service } = build({ tvs: house });

    expect((await service.find('front room'))?.id).toBe('roku:10.0.0.12');
    expect((await service.find('den tv'))?.id).toBe('roku:10.0.0.12');
  });

  it('renames a Jellyfin app on that TV to the same room', async () => {
    process.env.SCREEN_NAMES = JSON.stringify({ 'Den TV': 'Front room' });
    const { service } = build({
      tvs: house,
      sessions: [{ id: 's1', deviceName: 'Den TV' }],
    });

    const list = await service.list();
    const front = list.filter((s) => s.name === 'Front room');
    // one entry, not the session and the TV listed as two different rooms
    expect(front).toHaveLength(1);
    expect(front[0].kind).toBe('session');
  });

  it('reads the plain pairs form, which systemd cannot mangle', async () => {
    process.env.SCREEN_NAMES =
      'Den TV=Front room; Garage tv=Nursery; 55 Roku TV=Back bedroom';
    const { service } = build({ tvs: house });

    expect((await service.list()).map((s) => s.name)).toEqual([
      'Front room',
      'Nursery',
      'Back bedroom',
      '65" Smart UHD',
    ]);
  });

  it('matches a TV whose name has punctuation the setting leaves out', async () => {
    // the TV calls itself '55" Roku TV'; nobody wants to escape that quote
    process.env.SCREEN_NAMES = '55 Roku TV=Back bedroom';
    const { service } = build({ tvs: house });

    expect((await service.find('back bedroom'))?.id).toBe('roku:10.0.0.13');
  });

  it('falls back to pairs when systemd has eaten the JSON quotes', async () => {
    // what an EnvironmentFile does to {"55\" Roku TV":"Back bedroom"}
    process.env.SCREEN_NAMES = '{"55" Roku TV":"Back bedroom"}';
    const { service } = build({ tvs: house });

    // the mangled line is not usable, but the TVs are all still listed
    expect(await service.list()).toHaveLength(4);
  });

  it('leaves the TVs alone when the map is nonsense', async () => {
    process.env.SCREEN_NAMES = 'complete nonsense, no pairs at all';
    const { service } = build({ tvs: house });

    expect((await service.list()).map((s) => s.name)).toEqual([
      'Den TV',
      'Garage tv',
      '55" Roku TV',
      '65" Smart UHD',
    ]);
  });

  it('says the room name when it starts something there', async () => {
    process.env.SCREEN_NAMES = JSON.stringify({ 'Den TV': 'Front room' });
    const { service } = build({
      tvs: house,
      sessions: [{ id: 's1', deviceName: 'Den TV' }],
    });
    const tv = await service.find('Front room');

    expect(await service.play(tv!, { id: 'm1', name: 'Encanto' })).toBe(
      'Playing Encanto on Front room',
    );
  });
});

describe('ScreensService playing on a Roku', () => {
  const roku = {
    id: 'roku:10.0.0.12',
    name: "Bray's room",
    deviceName: 'Workout tv',
    kind: 'roku' as const,
    address: '10.0.0.12',
    ready: false,
  };

  const apps = (...rows: [string, string][]) =>
    `<apps>${rows.map(([id, n]) => `<app id="${id}">${n}</app>`).join('')}</apps>`;

  const REAL_FETCH = global.fetch;
  afterEach(() => {
    global.fetch = REAL_FETCH;
  });

  function roku_(opts: { apps?: string; postStatus?: number }) {
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path.startsWith('/query/apps')) {
        return {
          ok: true,
          status: 200,
          text: async () => opts.apps ?? apps(),
        } as any;
      }
      return {
        ok: (opts.postStatus ?? 200) < 400,
        status: opts.postStatus ?? 200,
        text: async () => '',
      } as any;
    }) as any;
    return calls;
  }

  it('opens the Jellyfin app with the film on the end of the launch', async () => {
    const { service } = build({});
    const calls = roku_({
      apps: apps(['592369', 'Jellyfin'], ['12', 'Netflix']),
    });

    await service.play(roku, { id: 'm1', name: 'Encanto' });

    expect(calls).toContain('POST /keypress/PowerOn');
    expect(calls).toContain('POST /launch/592369?contentId=m1&mediaType=movie');
  });

  it('deep links an episode as an episode', async () => {
    const { service } = build({});
    const calls = roku_({ apps: apps(['592369', 'Jellyfin']) });

    await service.play(roku, { id: 'e9', name: 'Pilot', type: 'Episode' });

    expect(calls).toContain(
      'POST /launch/592369?contentId=e9&mediaType=episode',
    );
  });

  it('says to install Jellyfin when the TV has no way to play', async () => {
    const { service } = build({});
    roku_({ apps: apps(['12', 'Netflix'], ['2213', 'Roku Media Player']) });

    await expect(
      service.play(roku, { id: 'm1', name: 'Encanto' }),
    ).rejects.toThrow(/Jellyfin channel/);
  });

  it('falls back to the push-a-url channel on a TV that has it', async () => {
    const { service } = build({});
    const calls = roku_({ apps: apps(['15985', 'Play on Roku']) });

    await service.play(roku, { id: 'm1', name: 'Encanto' });

    expect(calls.some((c) => c.startsWith('POST /launch/15985?'))).toBe(true);
  });

  it('explains the setting rather than reporting a bare failure', async () => {
    const { service } = build({});
    roku_({ apps: apps(['592369', 'Jellyfin']), postStatus: 403 });

    await expect(
      service.play(roku, { id: 'm1', name: 'Encanto' }),
    ).rejects.toThrow(/Control by mobile apps/);
  });
});

describe('ScreensService leaving a screen off the list', () => {
  const ORIGINAL = process.env.SCREEN_IGNORE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SCREEN_IGNORE;
    else process.env.SCREEN_IGNORE = ORIGINAL;
  });

  const tvs = [
    { id: 'cast:10.0.0.15', name: '65" Smart UHD', kind: 'cast', ready: false },
    { id: 'roku:10.0.0.12', name: 'Den TV', kind: 'roku', ready: false },
  ];

  it('hides a screen that answers but cannot actually play', async () => {
    process.env.SCREEN_IGNORE = '65 Smart UHD';
    const { service } = build({ tvs });

    expect((await service.list()).map((s) => s.name)).toEqual(['Den TV']);
  });

  it('will not find one that has been hidden', async () => {
    process.env.SCREEN_IGNORE = '65 Smart UHD';
    const { service } = build({ tvs });

    expect(await service.find('65" Smart UHD')).toBeNull();
  });

  it('lists everything when nothing is hidden', async () => {
    delete process.env.SCREEN_IGNORE;
    const { service } = build({ tvs });

    expect(await service.list()).toHaveLength(2);
  });
});

describe('ScreensService playing on a TV that speaks UPnP', () => {
  const tv = {
    id: 'dlna:10.0.0.15',
    name: 'Living room',
    kind: 'dlna' as const,
    address: '10.0.0.15',
    control: '/upnp/control/AVTransport1',
    ready: false,
  };
  const REAL_FETCH = global.fetch;
  afterEach(() => {
    global.fetch = REAL_FETCH;
  });

  function upnp(status = 200) {
    const sent: { action: string; body: string }[] = [];
    global.fetch = jest.fn(async (url: any, init: any) => {
      sent.push({
        action: String(init?.headers?.soapaction ?? '').split('#')[1] ?? '',
        body: String(init?.body ?? ''),
      });
      return { ok: status < 400, status, text: async () => '' } as any;
    }) as any;
    return sent;
  }

  it('hands over the film and then says play', async () => {
    const { service } = build({});
    const sent = upnp();

    await service.play(tv, { id: 'm1', name: 'Encanto', container: 'mp4' });

    // stop first: a Samsung that is already playing refuses the Play after
    // a new link — found on the real set during the live tests
    expect(sent.map((s) => s.action)).toEqual([
      'Stop"',
      'SetAVTransportURI"',
      'Play"',
    ]);
    const set = sent.find((s) => s.action === 'SetAVTransportURI"')!;
    expect(set.body).toContain('CurrentURI');
    expect(set.body).toContain('Encanto');
  });

  it('escapes the title rather than breaking the xml', async () => {
    const { service } = build({});
    const sent = upnp();

    await service.play(tv, { id: 'm1', name: 'Tom & Jerry' });

    // the description is xml inside an xml value, so it is escaped twice —
    // once as the title, and again when it is carried in the soap body
    expect(sent.find((s) => s.action === 'SetAVTransportURI"')!.body).toContain(
      '&lt;DIDL-Lite',
    );
    expect(sent.find((s) => s.action === 'SetAVTransportURI"')!.body).toContain(
      'Tom &amp;amp; Jerry',
    );
    // nothing raw is left to end the element early
    expect(
      sent.find((s) => s.action === 'SetAVTransportURI"')!.body,
    ).not.toContain('Tom & Jerry');
  });

  it('suggests the TV may be in standby when it refuses', async () => {
    const { service } = build({});
    upnp(500);

    await expect(
      service.play(tv, { id: 'm1', name: 'Encanto' }),
    ).rejects.toThrow(/standby/);
  });

  it('stops it', async () => {
    const { service } = build({});
    const sent = upnp();

    expect(await service.stop(tv)).toBe('Stopped Living room');
    expect(sent[0].action).toBe('Stop"');
  });
});

describe('starting part way through, and reading back what is on', () => {
  const REAL = global.fetch;
  afterEach(() => {
    global.fetch = REAL;
  });
  const tv = {
    id: 'dlna:10.0.0.15',
    name: 'Living room',
    kind: 'dlna' as const,
    address: '10.0.0.15',
    control: '/upnp/control/AVTransport1',
    ready: false,
  };
  const envelope = (inner: string) =>
    `<?xml version="1.0"?><s:Envelope><s:Body>${inner}</s:Body></s:Envelope>`;

  /** a pretend UPnP TV: it answers each action, and says it is playing
   * only after a moment, as a real set does */
  function renderer(
    opts: {
      playingAfter?: number;
      uri?: string;
      rel?: string;
      transport?: string;
    } = {},
  ) {
    const actions: { action: string; body: string }[] = [];
    let polls = 0;
    global.fetch = jest.fn(async (_url: any, init: any) => {
      const action =
        String(init?.headers?.soapaction ?? '')
          .split('#')[1]
          ?.replace('"', '') ?? '';
      actions.push({ action, body: String(init?.body ?? '') });
      let reply = '';
      if (action === 'GetTransportInfo') {
        polls++;
        const state =
          opts.transport ??
          (polls > (opts.playingAfter ?? 0) ? 'PLAYING' : 'TRANSITIONING');
        reply = `<CurrentTransportState>${state}</CurrentTransportState>`;
      }
      if (action === 'GetPositionInfo') {
        reply =
          `<TrackURI>${(opts.uri ?? '').replace(/&/g, '&amp;')}</TrackURI>` +
          `<RelTime>${opts.rel ?? '0:40:00'}</RelTime><TrackDuration>1:36:03</TrackDuration>`;
      }
      return {
        ok: true,
        status: 200,
        text: async () => envelope(reply),
      } as any;
    }) as any;
    return actions;
  }

  it('starts from the beginning without seeking at all', async () => {
    const { service } = build({});
    const actions = renderer();

    await service.play(tv, { id: 'm1', name: 'Encanto' });

    expect(actions.map((a) => a.action)).toEqual([
      'Stop',
      'SetAVTransportURI',
      'Play',
    ]);
  });

  it('never seeks a UPnP TV, even when asked to start part way', async () => {
    // a real Samsung refused every seek mode on our stream; until one is
    // shown to work, a UPnP TV starts from the beginning and says so
    const { service } = build({});
    const actions = renderer({ playingAfter: 0 });

    await service.play(tv, { id: 'm1', name: 'Encanto' }, 2400);

    expect(actions.map((a) => a.action)).toEqual([
      'Stop',
      'SetAVTransportURI',
      'Play',
    ]);
    const { STARTS_PART_WAY } = require('./screens.service');
    expect(STARTS_PART_WAY.dlna).toBe('no');
  });

  it('only claims starting part way where it has been proven', () => {
    const { STARTS_PART_WAY } = require('./screens.service');
    expect(STARTS_PART_WAY).toEqual({
      cast: 'yes',
      dlna: 'no',
      roku: 'no',
      session: 'unverified',
    });
  });

  it('knows which film is on from the link it is playing', async () => {
    const { service } = build({});
    renderer({
      uri: 'http://10.0.0.2:3001/api/media/stream/abc123def456?t=sig',
      rel: '0:40:00',
    });

    const now = await service.nowPlaying(tv);

    expect(now).toMatchObject({
      state: 'playing',
      itemId: 'abc123def456',
      positionSeconds: 2400,
      durationSeconds: 5763,
    });
  });

  it('sees a different film as a different film', async () => {
    const { service } = build({});
    renderer({
      uri: 'http://10.0.0.2:3001/api/media/stream/ffff0000ffff?t=sig',
    });

    const now = await service.nowPlaying(tv);

    // someone put something else on: this must not read as the first film
    expect(now.itemId).toBe('ffff0000ffff');
    expect(now.itemId).not.toBe('abc123def456');
  });

  it('does not claim to know the film when the TV is playing something that is not ours', async () => {
    const { service } = build({});
    renderer({ uri: 'http://youtube.example/watch?v=x' });

    expect((await service.nowPlaying(tv)).itemId).toBeUndefined();
  });

  it('reads a stopped TV as stopped', async () => {
    const { service } = build({});
    renderer({ transport: 'STOPPED', uri: '' });

    expect((await service.nowPlaying(tv)).state).toBe('stopped');
  });

  it('asks a Jellyfin app to start at the saved point', async () => {
    const { service, jellyfin } = build({
      sessions: [session('s1', 'Den TV')],
    });
    jellyfin.playOnSession = jest.fn(async () => true);
    const den = (await service.list())[0];

    await service.play(den, { id: 'm1', name: 'Encanto' }, 90);

    expect(jellyfin.playOnSession).toHaveBeenCalledWith(
      's1',
      'm1',
      900_000_000,
    );
  });
});

describe('the small conversions', () => {
  const { clock, seconds, itemIdFromUrl } = require('./screens.service');

  it('writes a time the way UPnP wants it', () => {
    expect(clock(0)).toBe('00:00:00');
    expect(clock(2400)).toBe('00:40:00');
    expect(clock(5763)).toBe('01:36:03');
  });

  it('reads UPnP times, and gives up on ones it cannot read', () => {
    expect(seconds('0:40:00')).toBe(2400);
    expect(seconds('1:36:03.000')).toBe(5763);
    expect(seconds('NOT_IMPLEMENTED')).toBeUndefined();
    expect(seconds(undefined)).toBeUndefined();
  });

  it('finds the item only in links that are ours', () => {
    expect(
      itemIdFromUrl('http://x/api/media/stream/94a4f867104ea527?t=abc'),
    ).toBe('94a4f867104ea527');
    expect(
      itemIdFromUrl('http://x/Videos/94a4f867104ea527/stream'),
    ).toBeUndefined();
  });
});
