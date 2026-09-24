/**
 * Films and shows for one person: continue, next episode, start over, a
 * named episode, what was I watching, how far am I. Through the real watch
 * rules and watch-state service; Jellyfin is a pretend library that keeps
 * each person's history separately, and the TVs only record what they were
 * asked to play.
 */
import { WatchingService } from './watching.service';
import { WatchStateService } from './watch-state.service';
import type { Screen } from './screens.service';
import type { PersonalItem } from './jellyfin.service';
import { roughly } from './watch-words';

const MIN = 60 * 10_000_000; // one minute in Jellyfin ticks

const tvs: Record<string, Screen> = {
  'Kids room': { id: 'cast:1', name: 'Kids room', kind: 'cast', ready: false },
  'Living room': {
    id: 'dlna:2',
    name: 'Living room',
    kind: 'dlna',
    ready: false,
  },
  Den: { id: 'roku:3', name: 'Den', kind: 'roku', ready: false },
};

// ------------------------------------------------------ the pretend library

interface Base {
  id: string;
  name: string;
  type: 'Movie' | 'Episode';
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  runtimeTicks: number;
}
interface Seen {
  pos?: number; // minutes
  played?: boolean;
  last: string;
}

const film = (id: string, name: string): Base => ({
  id,
  name,
  type: 'Movie',
  runtimeTicks: 96 * MIN,
});
const episode = (show: string, name: string, s: number, e: number): Base => ({
  id: `${show}-s${s}e${e}`,
  name: `Episode ${e}`,
  type: 'Episode',
  seriesId: show,
  seriesName: name,
  seasonNumber: s,
  episodeNumber: e,
  runtimeTicks: 42 * MIN,
});

// The Lighthouse: a special, a season of three, a season of two
const LH = 'The Lighthouse';
const lighthouse = [
  episode('lh', LH, 0, 1),
  episode('lh', LH, 1, 1),
  episode('lh', LH, 1, 2),
  episode('lh', LH, 1, 3),
  episode('lh', LH, 2, 1),
  episode('lh', LH, 2, 2),
];
const NS = 'Night Shift';
const nightShift = [episode('ns', NS, 1, 1), episode('ns', NS, 1, 2)];
const everything = [
  film('harbour', 'Harbour Lights'),
  ...lighthouse,
  ...nightShift,
];

const byRecent = (a: PersonalItem, b: PersonalItem) =>
  (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? '');

class Library {
  seen = new Map<string, Map<string, Seen>>();
  private clock = 0;
  shows: { id: string; name: string; type: 'Series' }[] = [
    { id: 'lh', name: LH, type: 'Series' },
    { id: 'ns', name: NS, type: 'Series' },
  ];

  /** someone watched something, just now */
  watch(person: string, id: string, what: { pos?: number; played?: boolean }) {
    if (!this.seen.has(person)) this.seen.set(person, new Map());
    this.clock += 1;
    const last = `2026-09-24T12:${String(this.clock).padStart(2, '0')}:00Z`;
    this.seen.get(person)!.set(id, { ...what, last });
  }

  personal(person: string | null, b: Base): PersonalItem {
    const d = person ? this.seen.get(person)?.get(b.id) : undefined;
    return {
      ...b,
      container: 'mkv',
      positionTicks: d?.played ? 0 : (d?.pos ?? 0) * MIN,
      played: !!d?.played,
      playCount: d ? 1 : 0,
      lastPlayed: d?.last,
    };
  }

  of(person: string | null, list: Base[]) {
    return list.map((b) => this.personal(person, b));
  }

  jellyfin = {
    items: jest.fn(async () => [
      { id: 'harbour', name: 'Harbour Lights', type: 'Movie' as const },
      ...this.shows,
    ]),
    itemsById: jest.fn(async (ids: string[]) =>
      everything
        .filter((b) => ids.includes(b.id))
        .map((b) => ({ ...b, container: 'mkv' })),
    ),
    forPerson: jest.fn(async (person: string, ids: string[]) =>
      this.of(
        person,
        everything.filter((b) => ids.includes(b.id)),
      ),
    ),
    episodesFor: jest.fn(async (person: string | null, seriesId: string) =>
      this.of(
        person,
        everything.filter((b) => b.seriesId === seriesId),
      ),
    ),
    resumeFor: jest.fn(
      async (person: string, o: { parentId?: string; type?: string } = {}) =>
        this.of(person, everything)
          .filter((i) => i.positionTicks > 0 && !i.played)
          .filter((i) => !o.type || i.type === o.type)
          .filter((i) => !o.parentId || i.seriesId === o.parentId)
          .sort(byRecent),
    ),
    // as the real server answered: on from the last episode finished; the
    // first episode when nothing is finished, even with a later one part
    // watched; nothing at the end
    nextUpFor: jest.fn(async (person: string, seriesId: string) => {
      const eps = this.of(
        person,
        everything.filter((b) => b.seriesId === seriesId),
      )
        .filter((e) => e.seasonNumber !== 0)
        .sort(
          (a, b) =>
            a.seasonNumber! - b.seasonNumber! ||
            a.episodeNumber! - b.episodeNumber!,
        );
      const done = eps.filter((e) => e.played).sort(byRecent);
      if (!done.length) return eps[0] ?? null;
      return eps.slice(eps.indexOf(done[0]) + 1).find((e) => !e.played) ?? null;
    }),
    recentFor: jest.fn(async (person: string, limit?: number) =>
      this.of(person, everything)
        .filter((i) => i.lastPlayed && (i.played || i.positionTicks > 0))
        .sort(byRecent)
        .slice(0, limit ?? 10),
    ),
    resumeRules: jest.fn(async () => ({
      minResumePct: 5,
      maxResumePct: 90,
      minResumeDurationSeconds: 300,
    })),
  };
}

function build() {
  const lib = new Library();
  const people: Record<string, string | null> = {
    ann: 'jf-ann',
    ben: 'jf-ben',
    kid: null,
  };
  const prisma = {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        jellyfinUserId: people[where.id] ?? null,
      })),
    },
  };
  const played: { tv: string; itemId: string; name: string; at: number }[] = [];
  const screens = {
    find: jest.fn(async (ref: string) => tvs[ref] ?? null),
    list: jest.fn(async () => Object.values(tvs)),
    play: jest.fn(
      async (...a: [Screen, { id: string; name: string }, number, string]) => {
        played.push({
          tv: a[0].name,
          itemId: a[1].id,
          name: a[1].name,
          at: a[2],
        });
        return `Playing ${a[1].name} on ${a[0].name}`;
      },
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
  const watchState = new WatchStateService(
    prisma as never,
    lib.jellyfin as never,
  );
  const service = new WatchingService(
    screens as never,
    lib.jellyfin as never,
    watchState,
    tracker as never,
  );
  const last = () => played.at(-1);
  return { lib, service, played, last, tracker };
}

// ------------------------------------------------------------------ shows

describe('continue a show', () => {
  it('picks up a part-watched episode where they left off, on Cast', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e1', { played: true });
    w.lib.watch('jf-ann', 'lh-s1e2', { pos: 18 });

    const out = await w.service.playShow(
      'ann',
      { show: 'the lighthouse', action: 'continue' },
      'Kids room',
    );

    expect(w.last()).toMatchObject({ itemId: 'lh-s1e2', at: 18 * 60 });
    expect(out).toEqual({
      kind: 'playing',
      message:
        'Playing The Lighthouse, Season 1 Episode 2 on Kids room. Picking ' +
        'up where you left off, about 18 minutes in.',
    });
  });

  it('after a finished episode, plays the next one from the beginning', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e1', { played: true });
    w.lib.watch('jf-ann', 'lh-s1e2', { played: true });
    await w.service.playShow(
      'ann',
      { show: 'Lighthouse', action: 'continue' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e3', at: 0 });
  });

  it('never watched: the first regular episode, not the special', async () => {
    const w = build();
    await w.service.playShow(
      'ann',
      { show: LH, action: 'continue' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e1', at: 0 });
  });

  it('on the Samsung, picks the right episode but starts it from the beginning, and says so', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e3', { pos: 18 });
    const out = await w.service.playShow(
      'ann',
      { show: LH, action: 'continue' },
      'Living room',
    );

    expect(w.last()).toMatchObject({ itemId: 'lh-s1e3', at: 0 });
    expect(out.message).toContain('Season 1 Episode 3');
    expect(out.message).toContain(
      "That TV can't pick up part way yet, so it's starting the episode " +
        'from the beginning — you were about 18 minutes in.',
    );
    expect(out.message).not.toMatch(/picking up/i);
  });

  it('with every episode watched, says so rather than wrapping round', async () => {
    const w = build();
    for (const e of lighthouse) w.lib.watch('jf-ann', e.id, { played: true });
    const out = await w.service.playShow(
      'ann',
      { show: LH, action: 'continue' },
      'Kids room',
    );
    expect(out).toEqual({
      kind: 'nothing',
      message: "You've watched every episode of The Lighthouse that's here.",
    });
    expect(w.played).toHaveLength(0);
  });
});

describe('play the next episode', () => {
  it('moves on from a part-watched episode instead of resuming it', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e1', { played: true });
    w.lib.watch('jf-ann', 'lh-s1e2', { pos: 18 });
    await w.service.playShow('ann', { show: LH, action: 'next' }, 'Kids room');
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e3', at: 0 });
  });

  it('crosses into the next season', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e3', { played: true });
    await w.service.playShow('ann', { show: LH, action: 'next' }, 'Kids room');
    expect(w.last()).toMatchObject({ itemId: 'lh-s2e1', at: 0 });
  });

  it('at the end of what is in the library, says so', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s2e2', { pos: 10 });
    const out = await w.service.playShow(
      'ann',
      { show: LH, action: 'next' },
      'Kids room',
    );
    expect(out.kind).toBe('nothing');
    expect(out.message).toContain("You've reached the end of The Lighthouse");
    expect(w.played).toHaveLength(0);
  });

  it('never steps onto or off a special', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e1', { played: true });
    w.lib.watch('jf-ann', 'lh-s0e1', { played: true }); // most recent
    await w.service.playShow('ann', { show: LH, action: 'next' }, 'Kids room');
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e2' });
  });

  it('with no show named, goes on with the show they watched last', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'ns-s1e1', { played: true });
    w.lib.watch('jf-ann', 'lh-s1e1', { played: true });
    await w.service.playShow('ann', { action: 'next' }, 'Kids room');
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e2' });
  });
});

describe('start a show over', () => {
  it('plays the very first episode from the beginning', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e1', { pos: 20 });
    w.lib.watch('jf-ann', 'lh-s2e1', { pos: 10 });
    const out = await w.service.playShow(
      'ann',
      { show: LH, action: 'start-over' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e1', at: 0 });
    expect(out.message).toContain('Starting from the beginning, as asked.');
  });

  it('works on a finished show too', async () => {
    const w = build();
    for (const e of lighthouse) w.lib.watch('jf-ann', e.id, { played: true });
    await w.service.playShow(
      'ann',
      { show: LH, action: 'start-over' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e1', at: 0 });
  });
});

describe('a named episode', () => {
  it('resumes it when it is part watched', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s2e1', { pos: 10 });
    await w.service.playShow(
      'ann',
      { show: LH, action: 'episode', season: 2, episode: 1 },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s2e1', at: 10 * 60 });
  });

  it('starts it over when asked', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s2e1', { pos: 10 });
    const out = await w.service.playShow(
      'ann',
      { show: LH, action: 'episode', season: 2, episode: 1, from: 'start' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s2e1', at: 0 });
    expect(out.message).toContain('Starting from the beginning, as asked.');
  });

  it('plays a special when it is the one named', async () => {
    const w = build();
    await w.service.playShow(
      'ann',
      { show: LH, action: 'episode', season: 0, episode: 1 },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s0e1' });
  });

  it('says when that episode is not in the library', async () => {
    const w = build();
    const out = await w.service.playShow(
      'ann',
      { show: LH, action: 'episode', season: 9, episode: 1 },
      'Kids room',
    );
    expect(out).toEqual({
      kind: 'nothing',
      message: "The Lighthouse Season 9 Episode 1 isn't in the library.",
    });
  });

  it('played by id, as the picker does, resumes the same way', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e3', { pos: 18 });
    const line = await w.service.play('ann', 'lh-s1e3', 'Kids room');
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e3', at: 18 * 60 });
    expect(line).toContain('The Lighthouse, Season 1 Episode 3');
  });
});

describe('continue my show', () => {
  it('with one show on the go, continues it', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'ns-s1e1', { pos: 7 });
    await w.service.playShow('ann', { action: 'continue' }, 'Kids room');
    expect(w.last()).toMatchObject({ itemId: 'ns-s1e1', at: 7 * 60 });
  });

  it('with more than one on the go, asks which', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'ns-s1e1', { pos: 7 });
    w.lib.watch('jf-ann', 'lh-s1e2', { pos: 18 });
    const out = await w.service.playShow(
      'ann',
      { action: 'continue' },
      'Kids room',
    );
    expect(out).toEqual({
      kind: 'choose',
      shows: [LH, NS],
      message:
        "You've got more than one show going: The Lighthouse and Night " +
        'Shift. Which one?',
    });
    expect(w.played).toHaveLength(0);
  });

  it('with nothing on the go, says so', async () => {
    const w = build();
    const out = await w.service.playShow(
      'ann',
      { action: 'continue' },
      'Kids room',
    );
    expect(out.kind).toBe('nothing');
  });
});

describe('two people, one show', () => {
  it('each continues from their own place', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e2', { pos: 18 });
    w.lib.watch('jf-ben', 'lh-s1e3', { played: true });

    await w.service.playShow(
      'ann',
      { show: LH, action: 'continue' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e2', at: 18 * 60 });
    await w.service.playShow(
      'ben',
      { show: LH, action: 'continue' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s2e1', at: 0 });

    expect(await w.service.howFar('ann', { show: LH })).toBe(
      "You're about 18 minutes into The Lighthouse, Season 1 Episode 2.",
    );
    expect(await w.service.howFar('ben', { show: LH })).toBe(
      "You've watched The Lighthouse, Season 1 Episode 3. Next up is Season 2 Episode 1.",
    );
    const bens = await w.service.watching('ben');
    expect(bens?.map((a) => a.line)).toEqual([
      'You finished The Lighthouse — S1E3.',
    ]);
  });
});

describe('someone with no linked account', () => {
  it('cannot continue, and is told why', async () => {
    const w = build();
    const out = await w.service.playShow(
      'kid',
      { show: LH, action: 'continue' },
      'Kids room',
    );
    expect(out.kind).toBe('nothing');
    expect(out.message).toContain("isn't linked to you yet");
    expect(w.played).toHaveLength(0);
  });

  it('can still have a named episode or the first one, from the beginning', async () => {
    const w = build();
    await w.service.playShow(
      'kid',
      { show: LH, action: 'episode', season: 1, episode: 2 },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e2', at: 0 });
    await w.service.playShow(
      'kid',
      { show: LH, action: 'start-over' },
      'Kids room',
    );
    expect(w.last()).toMatchObject({ itemId: 'lh-s1e1', at: 0 });
    // and nobody's history was read for it
    for (const call of w.lib.jellyfin.episodesFor.mock.calls) {
      expect(call[0]).toBeNull();
    }
  });

  it('gets no watching history or progress at all', async () => {
    const w = build();
    expect(await w.service.watching('kid')).toBeNull();
    expect(await w.service.howFar('kid', { show: LH })).toBeNull();
  });
});

describe('which show they meant', () => {
  it('says when there is no such show', async () => {
    const w = build();
    const out = await w.service.playShow(
      'ann',
      { show: 'Dragon Riders', action: 'continue' },
      'Kids room',
    );
    expect(out).toEqual({
      kind: 'nothing',
      message: "I can't find Dragon Riders in the library.",
    });
  });

  it('asks when the name fits more than one', async () => {
    const w = build();
    w.lib.shows.push({
      id: 'lk',
      name: 'The Lighthouse Keepers',
      type: 'Series',
    });
    const out = await w.service.playShow(
      'ann',
      { show: 'Lighth', action: 'continue' },
      'Kids room',
    );
    expect(out.kind).toBe('choose');
  });
});

// -------------------------------------------------------- how far, recent

describe('how far am I', () => {
  it('in a show part way through an episode', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s1e3', { pos: 18 });
    expect(await w.service.howFar('ann', { show: LH })).toBe(
      "You're about 18 minutes into The Lighthouse, Season 1 Episode 3.",
    );
  });

  it('in a show at its last episode, finished', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'lh-s2e2', { played: true });
    expect(await w.service.howFar('ann', { show: LH })).toBe(
      "You've watched The Lighthouse, Season 2 Episode 2 — that's the last episode here.",
    );
  });

  it('in a show never started', async () => {
    const w = build();
    expect(await w.service.howFar('ann', { show: NS })).toBe(
      "You haven't started Night Shift yet.",
    );
  });

  it('in a film, finished or part way', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'harbour', { pos: 42 });
    expect(await w.service.howFar('ann', { itemId: 'harbour' })).toBe(
      "You're about 42 minutes into Harbour Lights.",
    );
    w.lib.watch('jf-ann', 'harbour', { played: true });
    expect(await w.service.howFar('ann', { itemId: 'harbour' })).toBe(
      "You've watched Harbour Lights.",
    );
  });
});

describe('what was I watching', () => {
  it('mixes films and shows, most recent first, one line each', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'ns-s1e1', { played: true });
    w.lib.watch('jf-ann', 'harbour', { pos: 12 });
    w.lib.watch('jf-ann', 'lh-s1e2', { played: true });
    w.lib.watch('jf-ann', 'lh-s1e3', { pos: 18 });

    const got = await w.service.watching('ann');

    expect(got?.map((a) => a.line)).toEqual([
      "You were watching The Lighthouse — S1E3. You're about 18 minutes in.",
      "You were watching Harbour Lights. You're about 12 minutes in.",
      'You finished Night Shift — S1E1.',
    ]);
    expect(got?.[0]).toMatchObject({
      kind: 'episode',
      title: LH,
      episode: 'S1E3',
      state: 'part way',
    });
    expect(JSON.stringify(got)).not.toMatch(/tick|jf-ann|cast|dlna/i);
  });

  it('keeps it short', async () => {
    const w = build();
    for (const e of [...lighthouse, ...nightShift]) {
      w.lib.watch('jf-ann', e.id, { played: true });
    }
    w.lib.watch('jf-ann', 'harbour', { played: true });
    expect((await w.service.watching('ann'))!.length).toBeLessThanOrEqual(4);
  });
});

// ------------------------------------------------------------------ films

describe('films', () => {
  it('continue on Cast picks up at the saved position', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'harbour', { pos: 42 });
    const line = await w.service.play('ann', 'harbour', 'Kids room', 'resume');
    expect(w.last()).toMatchObject({ at: 42 * 60 });
    expect(line).toBe(
      'Playing Harbour Lights on Kids room. Picking up where you left off, ' +
        'about 42 minutes in.',
    );
  });

  it('continue on the Samsung or a Roku starts from the beginning and says so', async () => {
    for (const tv of ['Living room', 'Den']) {
      const w = build();
      w.lib.watch('jf-ann', 'harbour', { pos: 42 });
      const line = await w.service.play('ann', 'harbour', tv, 'resume');
      expect(w.last()).toMatchObject({ at: 0 });
      expect(line).toContain(
        "That TV can't pick up part way yet, so it's starting the film " +
          'from the beginning — you were about 42 minutes in.',
      );
    }
  });

  it('start over on Cast starts at the beginning', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'harbour', { pos: 42 });
    const line = await w.service.play('ann', 'harbour', 'Kids room', 'start');
    expect(w.last()).toMatchObject({ at: 0 });
    expect(line).toContain('Starting from the beginning, as asked.');
  });

  it('a finished film plays from the beginning', async () => {
    const w = build();
    w.lib.watch('jf-ann', 'harbour', { played: true });
    expect(await w.service.play('ann', 'harbour', 'Kids room')).toBe(
      'Playing Harbour Lights on Kids room',
    );
    expect(
      await w.service.play('ann', 'harbour', 'Kids room', 'resume'),
    ).toContain('You finished it last time');
  });

  it('nothing saved: starts from the beginning and says why', async () => {
    const w = build();
    const line = await w.service.play('ann', 'harbour', 'Kids room', 'resume');
    expect(line).toContain('nowhere to pick up from');
  });

  it('someone not linked: starts from the beginning and says why', async () => {
    const w = build();
    const line = await w.service.play('kid', 'harbour', 'Kids room', 'resume');
    expect(w.last()).toMatchObject({ at: 0 });
    expect(line).toContain("isn't linked to you yet");
  });
});

describe('stopping', () => {
  it('goes through the tracker, so the last position is kept', async () => {
    const w = build();
    expect(await w.service.stop('Kids room')).toBe('Stopped Kids room');
    expect(w.tracker.stop).toHaveBeenCalled();
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
