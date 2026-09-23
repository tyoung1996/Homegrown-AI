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

  it('opens the Jellyfin app and plays through it once it checks in', async () => {
    // the app is not running yet; it checks in on the second look
    let looks = 0;
    const { service, jellyfin } = build({});
    jellyfin.sessions = jest.fn(async () =>
      ++looks < 2 ? [] : [{ id: 'sess-1', deviceName: 'Workout tv' }],
    );
    const calls = roku_({
      apps: apps(['592369', 'Jellyfin'], ['12', 'Netflix']),
    });

    await service.play(roku, { id: 'm1', name: 'Encanto' });

    expect(calls).toContain('POST /keypress/PowerOn');
    expect(calls).toContain('POST /launch/592369');
    expect(jellyfin.playOnSession).toHaveBeenCalledWith('sess-1', 'm1');
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

  it('gives up cleanly when the app never checks in', async () => {
    process.env.ROKU_APP_WAIT_MS = '600';
    const { service, jellyfin } = build({});
    jellyfin.sessions = jest.fn(async () => []);
    roku_({ apps: apps(['592369', 'Jellyfin']) });

    await expect(
      service.play(roku, { id: 'm1', name: 'Encanto' }),
    ).rejects.toThrow(/never checked in/);
    delete process.env.ROKU_APP_WAIT_MS;
  });
});
