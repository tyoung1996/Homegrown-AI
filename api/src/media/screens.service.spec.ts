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
          id: 'cast:192.168.0.52',
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
      sessions: [session('s1', "Emmy and Ty's room TV")],
      tvs: [
        {
          id: 'cast:192.168.0.52',
          name: "Emmy and Ty's room TV new",
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
          id: 'roku:192.168.0.100',
          name: 'Hangout',
          kind: 'roku',
          ready: false,
        },
      ],
    });

    expect((await service.find('hangout'))?.id).toBe('roku:192.168.0.100');
    expect((await service.find('roku:192.168.0.100'))?.name).toBe('Hangout');
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
          id: 'roku:192.168.0.106',
          name: 'Hangout',
          kind: 'roku',
          ready: false,
        },
      ],
    });
    // pretend something was started there a moment ago
    (service as any).started.set('roku:192.168.0.106', {
      title: 'Encanto',
      at: Date.now(),
    });

    const tv = await service.find('Hangout');

    expect(tv?.nowPlaying).toBe('Encanto');
    expect(tv?.ready).toBe(true);
  });

  it('forgets what was playing once it is stale', async () => {
    const { service } = build({
      tvs: [
        {
          id: 'roku:192.168.0.106',
          name: 'Hangout',
          kind: 'roku',
          ready: false,
        },
      ],
    });
    (service as any).started.set('roku:192.168.0.106', {
      title: 'Encanto',
      at: Date.now() - 5 * 60 * 60_000,
    });

    expect((await service.find('Hangout'))?.nowPlaying).toBeUndefined();
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
