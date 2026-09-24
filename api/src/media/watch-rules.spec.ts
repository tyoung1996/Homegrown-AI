import type { PersonalItem, ResumeRules } from './jellyfin.service';
import {
  episodeStart,
  inOrder,
  resumable,
  seriesStart,
  startFor,
  toSeconds,
} from './watch-rules';

// Jellyfin's defaults, as read from this server's configuration
const RULES: ResumeRules = {
  minResumePct: 5,
  maxResumePct: 90,
  minResumeDurationSeconds: 300,
};
const MIN = 60 * 10_000_000; // ticks in a minute

// a 96-minute film, as one person sees it
const film = (over: Partial<PersonalItem> = {}): PersonalItem => ({
  id: 'notld',
  name: 'Night of the Living Dead',
  type: 'Movie',
  runtimeTicks: 96 * MIN,
  positionTicks: 0,
  played: false,
  playCount: 0,
  ...over,
});

const ep = (
  season: number,
  episode: number,
  over: Partial<PersonalItem> = {},
): PersonalItem => ({
  id: `s${season}e${episode}`,
  name: `Episode ${episode}`,
  type: 'Episode',
  seriesId: 'office',
  seasonNumber: season,
  episodeNumber: episode,
  runtimeTicks: 22 * MIN,
  positionTicks: 0,
  played: false,
  playCount: 0,
  ...over,
});

describe('a film, for one person', () => {
  it('starts from the beginning when it has never been watched', () => {
    const s = startFor(film(), 'auto', RULES);
    expect(s.startSeconds).toBe(0);
    expect(s.why).toBe('from the beginning');
  });

  it('picks up where they left off when it is part watched', () => {
    const s = startFor(film({ positionTicks: 40 * MIN }), 'auto', RULES);
    expect(s.startSeconds).toBe(40 * 60);
    expect(s.why).toBe('resuming');
  });

  it('starts from the beginning once it has been watched through', () => {
    const s = startFor(film({ played: true, positionTicks: 0 }), 'auto', RULES);
    expect(s.startSeconds).toBe(0);
    expect(s.why).toBe('watched already, starting again');
  });

  it('starts over when asked, whatever is saved', () => {
    const s = startFor(film({ positionTicks: 40 * MIN }), 'start', RULES);
    expect(s.startSeconds).toBe(0);
    expect(s.why).toBe('asked to start over');
  });

  it('resumes when asked to continue', () => {
    expect(
      startFor(film({ positionTicks: 40 * MIN }), 'resume', RULES).startSeconds,
    ).toBe(40 * 60);
  });

  it('says there is nothing to continue rather than pretending', () => {
    const s = startFor(film(), 'resume', RULES);
    expect(s.startSeconds).toBe(0);
    expect(s.why).toBe('nothing to resume');
  });
});

describe("Jellyfin's thresholds, read not assumed", () => {
  it('ignores a position below the minimum', () => {
    // 4 minutes into 96 is about 4% — below 5%, not worth going back to
    expect(resumable(film({ positionTicks: 4 * MIN }), RULES)).toBe(false);
  });

  it('keeps one just above it', () => {
    expect(resumable(film({ positionTicks: 5 * MIN }), RULES)).toBe(true);
  });

  it('treats one past the maximum as finished', () => {
    // 88 minutes into 96 is about 92%
    expect(resumable(film({ positionTicks: 88 * MIN }), RULES)).toBe(false);
  });

  it('follows the server when its thresholds change', () => {
    const strict = { ...RULES, minResumePct: 20 };
    expect(resumable(film({ positionTicks: 10 * MIN }), RULES)).toBe(true);
    expect(resumable(film({ positionTicks: 10 * MIN }), strict)).toBe(false);
  });

  it('does not resume anything shorter than the minimum length', () => {
    const short = film({ runtimeTicks: 4 * MIN, positionTicks: 2 * MIN });
    expect(resumable(short, RULES)).toBe(false);
  });

  it('converts ticks to whole seconds', () => {
    expect(toSeconds(40 * MIN + 5_000_000)).toBe(2400);
  });
});

describe('a show, for one person', () => {
  const season1 = [ep(1, 1), ep(1, 2), ep(1, 3)];

  it('starts the very first episode when they have never watched it', () => {
    const s = seriesStart(
      { resuming: [], nextUp: null, episodes: season1 },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e1');
    expect(s.why).toBe('first episode');
  });

  it('resumes an episode they are part way through', () => {
    const mid = ep(1, 2, { positionTicks: 10 * MIN });
    const s = seriesStart(
      {
        resuming: [mid],
        nextUp: null,
        episodes: [ep(1, 1, { played: true }), mid, ep(1, 3)],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e2');
    expect(s.startSeconds).toBe(10 * 60);
  });

  it('resumes a part-watched episode even when next-up points back at the first', () => {
    // seen on the real server: with nothing finished yet, Jellyfin's
    // next-up answers episode 1 while episode 3 is half watched
    const mid = ep(1, 3, { positionTicks: 9 * MIN });
    const s = seriesStart(
      {
        resuming: [mid],
        nextUp: ep(1, 1),
        episodes: [ep(1, 1), ep(1, 2), mid],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e3');
    expect(s.startSeconds).toBe(9 * 60);
    expect(s.why).toBe('resuming');
  });

  it("follows Jellyfin's next-up when nothing is part watched", () => {
    const s = seriesStart(
      {
        resuming: [],
        nextUp: ep(1, 3),
        episodes: [
          ep(1, 1, { played: true }),
          ep(1, 2, { played: true }),
          ep(1, 3),
        ],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e3');
    expect(s.why).toBe('next episode');
  });

  it('works out the next one itself when Jellyfin has no answer', () => {
    const s = seriesStart(
      {
        resuming: [],
        nextUp: null,
        episodes: [
          ep(1, 1, { played: true }),
          ep(1, 2, { played: true }),
          ep(1, 3),
        ],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e3');
  });

  it('goes forward from the last episode watched, not back for a skipped one', () => {
    // 1 and 3 watched, 2 skipped: like Jellyfin's own next-up, it carries on
    // from 3 rather than going back — a skipped episode is only played when
    // it is asked for by name
    const s = seriesStart(
      {
        resuming: [],
        nextUp: null,
        episodes: [
          ep(1, 1, { played: true }),
          ep(1, 2),
          ep(1, 3, { played: true }),
          ep(1, 4),
        ],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e4');
  });

  it('never picks a watched episode again', () => {
    const s = seriesStart(
      {
        resuming: [],
        nextUp: null,
        episodes: [
          ep(1, 1, { played: true }),
          ep(1, 2, { played: true }),
          ep(1, 3),
        ],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.played).toBe(false);
    expect(s.item.id).toBe('s1e3');
  });

  it('crosses into the next season', () => {
    const s = seriesStart(
      {
        resuming: [],
        nextUp: null,
        episodes: [
          ep(1, 1, { played: true }),
          ep(1, 2, { played: true }),
          ep(2, 1),
        ],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s2e1');
  });

  it('never picks a special on its own', () => {
    const s = seriesStart(
      {
        resuming: [],
        nextUp: null,
        episodes: [ep(0, 1), ep(1, 1, { played: true }), ep(0, 2), ep(1, 2)],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e2');
    expect(inOrder([ep(0, 1), ep(1, 1)]).map((e) => e.id)).toEqual(['s1e1']);
  });

  it('starts a never-watched show at 1x1, not at a special', () => {
    const s = seriesStart(
      { resuming: [], nextUp: null, episodes: [ep(0, 1), ep(1, 1), ep(1, 2)] },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e1');
  });

  it('trusts a special only when Jellyfin itself chose it as next', () => {
    const special = ep(0, 3);
    const s = seriesStart(
      {
        resuming: [],
        nextUp: special,
        episodes: [ep(1, 1, { played: true }), special],
      },
      'auto',
      RULES,
    )!;
    expect(s.item.id).toBe('s0e3');
  });

  it('says there is nothing left once every episode is watched', () => {
    expect(
      seriesStart(
        {
          resuming: [],
          nextUp: null,
          episodes: season1.map((e) => ({ ...e, played: true })),
        },
        'auto',
        RULES,
      ),
    ).toBeNull();
  });

  it('starts over from the first episode when asked', () => {
    const s = seriesStart(
      {
        resuming: [ep(1, 2, { positionTicks: 10 * MIN })],
        nextUp: null,
        episodes: [
          ep(1, 1, { played: true }),
          ep(1, 2, { positionTicks: 10 * MIN }),
        ],
      },
      'start',
      RULES,
    )!;
    expect(s.item.id).toBe('s1e1');
    expect(s.startSeconds).toBe(0);
  });
});

describe('a named episode', () => {
  const eps = [
    ep(0, 1),
    ep(3, 12, { positionTicks: 8 * MIN }),
    ep(3, 13, { played: true }),
  ];

  it('plays exactly the episode named, resuming it', () => {
    const s = episodeStart(eps, 3, 12, 'auto', RULES)!;
    expect(s.item.id).toBe('s3e12');
    expect(s.startSeconds).toBe(8 * 60);
  });

  it('plays a watched episode when it is named', () => {
    expect(episodeStart(eps, 3, 13, 'auto', RULES)!.item.id).toBe('s3e13');
  });

  it('plays a special when it is named', () => {
    expect(episodeStart(eps, 0, 1, 'auto', RULES)!.item.id).toBe('s0e1');
  });

  it('has nothing when the episode does not exist', () => {
    expect(episodeStart(eps, 9, 9, 'auto', RULES)).toBeNull();
  });
});
