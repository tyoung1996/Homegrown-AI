/**
 * Continue, start over, what was I watching, how far am I — through the
 * real watch rules, with Jellyfin and the TVs pretended.
 */
import { WatchingService } from './watching.service';
import { WatchStateService } from './watch-state.service';
import type { Screen } from './screens.service';
import type { PersonalItem } from './jellyfin.service';
import { roughly } from './watch-words';

const MIN = 60 * 10_000_000; // one minute in Jellyfin ticks
const castTv: Screen = {
  id: 'cast:1',
  name: 'Kids room',
  kind: 'cast',
  ready: false,
};
const upnpTv: Screen = {
  id: 'dlna:2',
  name: 'Living room',
  kind: 'dlna',
  ready: false,
};
const rokuTv: Screen = {
  id: 'roku:3',
  name: 'Den',
  kind: 'roku',
  ready: false,
};

function personal(over: Partial<PersonalItem> = {}): PersonalItem {
  return {
    id: 'night',
    name: 'Night of the Living Dead',
    type: 'Movie',
    year: 1968,
    runtimeTicks: 96 * MIN,
    positionTicks: 0,
    played: false,
    playCount: 0,
    ...over,
  };
}

function build(opts: {
  linked?: boolean;
  item?: PersonalItem;
  inProgress?: PersonalItem[];
  recent?: PersonalItem[];
  screen?: Screen;
}) {
  const item = opts.item ?? personal();
  const screen = opts.screen ?? castTv;
  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({
        jellyfinUserId: opts.linked === false ? null : 'jf-ann',
      })),
    },
  };
  const jellyfin = {
    itemsById: jest.fn(async () => [
      { id: item.id, name: item.name, type: item.type, container: 'mp4' },
    ]),
    forPerson: jest.fn(async () => [item]),
    resumeRules: jest.fn(async () => ({
      minResumePct: 5,
      maxResumePct: 90,
      minResumeDurationSeconds: 300,
    })),
    resumeFor: jest.fn(async () => opts.inProgress ?? []),
    recentFor: jest.fn(async () => opts.recent ?? []),
  };
  const screens = {
    find: jest.fn(async () => screen),
    list: jest.fn(async () => [screen]),
    play: jest.fn(
      async (...a: [Screen, { name: string }, number, string]) =>
        `Playing ${a[1].name} on ${a[0].name}`,
    ),
    stop: jest.fn(async (s: Screen) => `Stopped ${s.name}`),
  };
  const tracker = {
    begin: jest.fn(
      async (_a: unknown, start: (pb: string) => Promise<string>) => ({
        result: await start('0123456789abcdef'),
        tracked: true,
      }),
    ),
    stop: jest.fn(async (_s: Screen, stop: () => Promise<string>) => stop()),
  };
  const watchState = new WatchStateService(prisma as never, jellyfin as never);
  const service = new WatchingService(
    screens as never,
    jellyfin as never,
    watchState,
    tracker as never,
  );
  const startedAt = () => screens.play.mock.calls[0][2];
  return { service, screens, tracker, jellyfin, startedAt };
}

describe('continue', () => {
  it('on a Cast TV, picks up at the saved position and says so', async () => {
    const w = build({ item: personal({ positionTicks: 42 * MIN }) });
    const line = await w.service.play('ann', 'night', 'Kids room', 'resume');

    expect(w.startedAt()).toBe(42 * 60);
    expect(line).toBe(
      'Playing Night of the Living Dead on Kids room. Picking up where you ' +
        'left off, about 42 minutes in.',
    );
  });

  it('plain "play" on something part way through picks up too', async () => {
    const w = build({ item: personal({ positionTicks: 42 * MIN }) });
    await w.service.play('ann', 'night', 'Kids room');
    expect(w.startedAt()).toBe(42 * 60);
  });

  it('on the Samsung, starts from the beginning and does not pretend otherwise', async () => {
    const w = build({
      item: personal({ positionTicks: 42 * MIN }),
      screen: upnpTv,
    });
    const line = await w.service.play('ann', 'night', 'Living room', 'resume');

    expect(w.startedAt()).toBe(0);
    expect(line).toContain('That TV can only start from the beginning');
    expect(line).toContain('you were about 42 minutes in');
    expect(line).not.toMatch(/picking up/i);
  });

  it('on a Roku, starts from the beginning too', async () => {
    const w = build({
      item: personal({ positionTicks: 42 * MIN }),
      screen: rokuTv,
    });
    const line = await w.service.play('ann', 'night', 'Den', 'resume');
    expect(w.startedAt()).toBe(0);
    expect(line).toContain('can only start from the beginning');
  });

  it('with nothing saved, starts from the beginning and says why', async () => {
    const w = build({});
    const line = await w.service.play('ann', 'night', 'Kids room', 'resume');
    expect(w.startedAt()).toBe(0);
    expect(line).toContain('nowhere to pick up from');
  });

  it('for someone not linked, starts from the beginning and says why', async () => {
    const w = build({
      linked: false,
      item: personal({ positionTicks: 42 * MIN }),
    });
    const line = await w.service.play('kid', 'night', 'Kids room', 'resume');
    expect(w.startedAt()).toBe(0);
    expect(line).toContain("isn't linked to you yet");
    expect(w.jellyfin.forPerson).not.toHaveBeenCalled();
  });

  it('a show episode starts from the beginning, as before', async () => {
    const w = build({
      item: personal({ id: 'ep', type: 'Episode', positionTicks: 20 * MIN }),
    });
    const line = await w.service.play('ann', 'ep', 'Kids room', 'resume');
    expect(w.startedAt()).toBe(0);
    expect(line).toBe('Playing Night of the Living Dead on Kids room');
  });
});

describe('start over', () => {
  it('on a Cast TV, starts at the beginning even with a saved position', async () => {
    const w = build({ item: personal({ positionTicks: 42 * MIN }) });
    const line = await w.service.play('ann', 'night', 'Kids room', 'start');
    expect(w.startedAt()).toBe(0);
    expect(line).toContain('Starting from the beginning, as asked.');
  });
});

describe('a film already finished', () => {
  it('plays from the beginning', async () => {
    const w = build({ item: personal({ played: true, playCount: 1 }) });
    const line = await w.service.play('ann', 'night', 'Kids room');
    expect(w.startedAt()).toBe(0);
    expect(line).toBe('Playing Night of the Living Dead on Kids room');
  });

  it('asked to continue, says it was finished', async () => {
    const w = build({ item: personal({ played: true, playCount: 1 }) });
    const line = await w.service.play('ann', 'night', 'Kids room', 'resume');
    expect(w.startedAt()).toBe(0);
    expect(line).toContain('You finished it last time');
  });
});

describe('stopping', () => {
  it('goes through the tracker, so the last position is kept', async () => {
    const w = build({});
    expect(await w.service.stop('Kids room')).toBe('Stopped Kids room');
    expect(w.tracker.stop).toHaveBeenCalled();
  });
});

describe('what was I watching', () => {
  it('lists films part way through, in words', async () => {
    const w = build({
      inProgress: [personal({ positionTicks: 42 * MIN })],
      recent: [
        personal({ positionTicks: 42 * MIN, lastPlayed: '2026-09-24' }),
        personal({ id: 'ep', type: 'Episode', lastPlayed: '2026-09-23' }),
      ],
    });
    const got = await w.service.watching('ann');

    expect(got?.partWay).toEqual([
      {
        itemId: 'night',
        title: 'Night of the Living Dead',
        year: 1968,
        state: 'part way',
        watched: 'about 42 minutes in',
        left: 'about 54 minutes left',
      },
    ]);
    expect(got?.lastWatched.map((i) => i.itemId)).toEqual(['night']);
    expect(JSON.stringify(got)).not.toMatch(/tick|Ticks|jf-ann/);
  });

  it('is unavailable to someone not linked', async () => {
    const w = build({ linked: false });
    expect(await w.service.watching('kid')).toBeNull();
    expect(w.jellyfin.resumeFor).not.toHaveBeenCalled();
  });
});

describe('how far am I', () => {
  it('part way', async () => {
    const w = build({ item: personal({ positionTicks: 75 * MIN }) });
    expect(await w.service.howFar('ann', 'night')).toEqual({
      title: 'Night of the Living Dead',
      state: 'part way',
      watched: 'about 1 hour 15 minutes in',
      left: 'about 21 minutes left',
    });
  });

  it('finished, and not started', async () => {
    const done = build({ item: personal({ played: true }) });
    expect(await done.service.howFar('ann', 'night')).toMatchObject({
      state: 'finished',
    });
    const fresh = build({});
    expect(await fresh.service.howFar('ann', 'night')).toMatchObject({
      state: 'not started',
    });
  });

  it('only for films, for now', async () => {
    const w = build({ item: personal({ type: 'Episode' }) });
    expect(await w.service.howFar('ann', 'night')).toBe('not a film');
  });

  it('is unavailable to someone not linked', async () => {
    const w = build({ linked: false });
    expect(await w.service.howFar('kid', 'night')).toBeNull();
  });
});

describe('saying how long', () => {
  it.each([
    [20, 'less than a minute'],
    [60, 'about 1 minute'],
    [42 * 60, 'about 42 minutes'],
    [60 * 60, 'about 1 hour'],
    [65 * 60, 'about 1 hour 5 minutes'],
    [121 * 60, 'about 2 hours 1 minute'],
  ])('%i seconds is %s', (s, words) => {
    expect(roughly(s)).toBe(words);
  });
});
