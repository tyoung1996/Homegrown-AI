/**
 * Recommendations: the rules on their own, then the service with a pretend
 * library (per person) and a pretend catalogue. All titles are invented.
 */
import type { LibraryEntry } from './jellyfin.service';
import type { CatalogPick } from './catalog.service';
import {
  about,
  familyFriendly,
  fits,
  genreWords,
  historyWeights,
  score,
} from './recommend-rules';
import { RecommendService, readAsk } from './recommend.service';

const e = (over: Partial<LibraryEntry> & { name: string }): LibraryEntry => ({
  id: over.name.toLowerCase().replace(/\W+/g, '-'),
  type: 'Movie',
  genres: [],
  directors: [],
  played: false,
  started: false,
  ...over,
});

const shelf = [
  e({
    name: 'Wizard School',
    genres: ['Fantasy', 'Adventure', 'Family'],
    certificate: 'PG',
    rating: 7.6,
    runtimeMinutes: 152,
    catalogId: 100,
  }),
  e({
    name: 'Wizard School 2',
    genres: ['Fantasy', 'Adventure', 'Family'],
    certificate: 'PG',
    rating: 7.2,
    runtimeMinutes: 161,
    catalogId: 101,
  }),
  e({
    name: 'The Grim Hollow',
    genres: ['Fantasy', 'Horror'],
    certificate: 'R',
    rating: 7.0,
    runtimeMinutes: 118,
    catalogId: 102,
  }),
  e({
    name: 'Pratfalls',
    genres: ['Comedy'],
    certificate: 'PG-13',
    rating: 6.9,
    runtimeMinutes: 92,
    catalogId: 103,
  }),
  e({
    name: 'Laugh Till Dawn',
    genres: ['Comedy', 'Horror'],
    certificate: 'R',
    rating: 6.5,
    runtimeMinutes: 88,
    catalogId: 104,
  }),
  e({
    name: 'Night Crawlers',
    genres: ['Horror'],
    rating: 7.9,
    runtimeMinutes: 96,
    catalogId: 105,
  }), // no certificate
  e({
    name: 'Star Freight',
    genres: ['Science Fiction', 'Action'],
    certificate: 'PG-13',
    rating: 8.1,
    runtimeMinutes: 169,
    catalogId: 106,
  }),
  e({
    name: 'Moon Base',
    genres: ['Science Fiction', 'Drama'],
    certificate: 'PG',
    rating: 7.4,
    runtimeMinutes: 95,
    catalogId: 107,
  }),
  e({
    name: 'Lighthouse Keepers',
    type: 'Series',
    genres: ['Sci-Fi & Fantasy', 'Drama'],
    certificate: 'TV-14',
    rating: 7.7,
    runtimeMinutes: 42,
    catalogId: 108,
  }),
  e({
    name: 'Little Otters',
    genres: ['Animation', 'Family'],
    certificate: 'G',
    rating: 7.0,
    runtimeMinutes: 81,
    catalogId: 109,
  }),
];

describe('the rules', () => {
  it('reads genre names the way people and both catalogues say them', () => {
    expect(genreWords('Sci-Fi & Fantasy')).toEqual([
      'science fiction',
      'fantasy',
    ]);
    expect(genreWords('sci-fi')).toEqual(['science fiction']);
    expect(genreWords('Horror')).toEqual(['horror']);
  });

  it('only a real family certificate counts as family-friendly', () => {
    expect(
      ['G', 'PG', 'TV-Y7', 'TV-PG', 'GB-U'].every((c) => familyFriendly(c)),
    ).toBe(true);
    expect(
      [undefined, '', 'PG-13', 'R', 'TV-14', 'NR'].some((c) =>
        familyFriendly(c),
      ),
    ).toBe(false);
  });

  it('"something funny" is comedies, and not a horror-comedy', () => {
    const names = shelf
      .filter((x) => fits(x, { mood: 'funny' }, true))
      .map((x) => x.name);
    expect(names).toEqual(['Pratfalls']);
  });

  it('"something scary" takes the horror-comedy too', () => {
    const names = shelf
      .filter((x) => fits(x, { mood: 'scary' }, true))
      .map((x) => x.name);
    expect(names).toEqual([
      'The Grim Hollow',
      'Laugh Till Dawn',
      'Night Crawlers',
    ]);
  });

  it('family viewing needs a family certificate', () => {
    const names = shelf
      .filter((x) => fits(x, { forFamily: true }, true))
      .map((x) => x.name);
    expect(names).toEqual([
      'Wizard School',
      'Wizard School 2',
      'Moon Base',
      'Little Otters',
    ]);
  });

  it('films or shows, sci-fi by any name', () => {
    expect(
      shelf
        .filter((x) => fits(x, { genres: ['sci-fi'], kind: 'movie' }, true))
        .map((x) => x.name),
    ).toEqual(['Star Freight', 'Moon Base']);
    expect(
      shelf
        .filter((x) => fits(x, { genres: ['sci-fi'], kind: 'show' }, true))
        .map((x) => x.name),
    ).toEqual(['Lighthouse Keepers']);
  });

  it('around 90 minutes means within twenty', () => {
    const names = shelf
      .filter((x) => fits(x, { aroundMinutes: 90, kind: 'movie' }, true))
      .map((x) => x.name);
    expect(names).toEqual([
      'Pratfalls',
      'Laugh Till Dawn',
      'Night Crawlers',
      'Moon Base',
      'Little Otters',
    ]);
  });

  it('leaves out what this person finished, unless asked what we have', () => {
    const seen = { ...shelf[3], played: true };
    expect(fits(seen, {}, true)).toBe(false);
    expect(fits(seen, { includeWatched: true }, true)).toBe(true);
    // with nobody known, nothing counts as seen
    expect(fits(seen, {}, false)).toBe(true);
  });

  it('with "like X", a mood leans the order instead of filtering', () => {
    const lean = {
      history: new Map(),
      similar: new Set<number>(),
      likeGenres: ['fantasy', 'adventure'],
    };
    const dark = (x: LibraryEntry) =>
      score(x, { like: 'Wizard School', mood: 'dark' }, lean).score;
    expect(fits(shelf[2], { like: 'Wizard School', mood: 'dark' }, true)).toBe(
      true,
    );
    expect(dark(shelf[2])).toBeGreaterThan(dark(shelf[1]));
  });

  it("a person's recent genres lean the order, newest counting most", () => {
    const history = historyWeights([
      { ...shelf[6], played: true, lastPlayed: '2026-09-20' },
      { ...shelf[7], started: true, lastPlayed: '2026-09-22' },
      { ...shelf[3], played: true, lastPlayed: '2026-01-01' },
    ]);
    expect(history.get('science fiction')).toBe(2);
    expect(history.get('comedy')!).toBeLessThan(1);
  });

  it('describes a film plainly', () => {
    expect(about(shelf[3])).toBe('comedy · 1h 32m · rated 6.9 · PG-13');
    expect(about(shelf[8])).toBe(
      'sci-fi & fantasy / drama · 42-minute episodes · rated 7.7 · TV-14',
    );
  });
});

// ------------------------------------------------------------ the service

function build(
  opts: {
    people?: Record<string, string | null>;
    seen?: Record<string, Record<string, Partial<LibraryEntry>>>;
    similar?: Record<number, CatalogPick[]>;
    discover?: CatalogPick[];
    requested?: number[];
    catalogueDown?: boolean;
  } = {},
) {
  const people = opts.people ?? { ann: 'jf-ann', ben: 'jf-ben', kid: null };
  const jellyfin = {
    libraryFor: jest.fn(async (person: string | null) =>
      shelf.map((x) => ({
        ...x,
        ...(person ? opts.seen?.[person]?.[x.id] : {}),
      })),
    ),
  };
  const down = () => {
    if (opts.catalogueDown) throw new Error('catalogue not answering');
  };
  const catalog = {
    searchMovies: jest.fn(async () => (down(), [])),
    searchSeries: jest.fn(async () => (down(), [])),
    genresOf: jest.fn(async () => (down(), [])),
    recommendedWith: jest.fn(
      async (_k: string, id: number) => (down(), opts.similar?.[id] ?? []),
    ),
    genreId: jest.fn(
      async (_k: string, name: string) => (
        down(),
        ({ horror: 27, comedy: 35 } as Record<string, number>)[name] ?? null
      ),
    ),
    discover: jest.fn(async () => (down(), opts.discover ?? [])),
  };
  const watchState = {
    personFor: jest.fn(async (u: string) => people[u] ?? null),
  };
  const prisma = {
    mediaRequest: {
      findMany: jest.fn(
        async ({ where }: { where: { catalogId: { in: number[] } } }) =>
          (opts.requested ?? [])
            .filter((id) => where.catalogId.in.includes(id))
            .map((catalogId) => ({ catalogId })),
      ),
      create: jest.fn(),
    },
  };
  const svc = new RecommendService(
    jellyfin as never,
    catalog as never,
    watchState as never,
    prisma as never,
  );
  return { svc, jellyfin, catalog, prisma };
}

const pick = (
  catalogId: number,
  title: string,
  genres: string[],
  rating = 7,
): CatalogPick => ({
  catalogId,
  title,
  genres,
  rating,
  kind: 'movie',
});

describe('recommending', () => {
  it('"what should I watch?" offers only what we have, and never what they finished', async () => {
    const w = build({
      seen: {
        'jf-ann': {
          'star-freight': { played: true, lastPlayed: '2026-09-20' },
        },
      },
    });
    const got = await w.svc.recommend('ann', {});
    expect(got.notInLibrary).toEqual([]);
    expect(got.availableNow.map((x) => x.title)).not.toContain('Star Freight');
    expect(got.availableNow.length).toBe(5);
    expect(w.catalog.discover).not.toHaveBeenCalled();
  });

  it("uses only the asking person's own viewing", async () => {
    const w = build({
      seen: {
        'jf-ann': { 'moon-base': { played: true, lastPlayed: '2026-09-22' } },
        'jf-ben': { pratfalls: { played: true, lastPlayed: '2026-09-23' } },
      },
    });
    const ann = await w.svc.recommend('ann', { mood: 'funny' });
    expect(w.jellyfin.libraryFor).toHaveBeenCalledWith('jf-ann');
    expect(w.jellyfin.libraryFor).not.toHaveBeenCalledWith('jf-ben');
    // Ben finished it; Ann did not, so she is still offered it
    expect(ann.availableNow.map((x) => x.title)).toEqual(['Pratfalls']);
    const ben = await w.svc.recommend('ben', { mood: 'funny' });
    expect(ben.availableNow).toEqual([]);
    const annSciFi = await w.svc.recommend('ann', {
      genres: ['sci-fi'],
      kind: 'movie',
    });
    expect(annSciFi.availableNow.map((x) => x.title)).toEqual(['Star Freight']);
  });

  it("someone not linked gets suggestions from nobody's history", async () => {
    const w = build();
    const got = await w.svc.recommend('kid', {});
    expect(got.linked).toBe(false);
    expect(w.jellyfin.libraryFor).toHaveBeenCalledWith(null);
  });

  it('"something like Wizard School" puts what the catalogue pairs with it first, and not the film itself', async () => {
    const w = build({
      similar: {
        100: [
          pick(101, 'Wizard School 2', ['Fantasy']),
          pick(900, 'Dragon Tutor', ['Fantasy'], 7.8),
        ],
      },
    });
    const got = await w.svc.recommend('ann', { like: 'Wizard School' });
    expect(got.availableNow[0]).toMatchObject({
      title: 'Wizard School 2',
      why: 'recommended for people who liked Wizard School',
    });
    expect(got.availableNow.map((x) => x.title)).not.toContain('Wizard School');
  });

  it('"...but darker" moves the darker ones up', async () => {
    const w = build({ similar: { 100: [] } });
    const got = await w.svc.recommend('ann', {
      like: 'Wizard School',
      mood: 'dark',
    });
    const order = got.availableNow.map((x) => x.title);
    expect(order.indexOf('The Grim Hollow')).toBeLessThan(
      order.indexOf('Wizard School 2'),
    );
  });

  it('something new is only suggested, clearly apart, and never requested', async () => {
    const w = build({
      discover: [
        pick(103, 'Pratfalls', ['Comedy']),
        pick(901, 'Banana Peel', ['Comedy'], 8),
        pick(902, 'Sitcom Nights', ['Comedy'], 7.5),
      ],
      requested: [902],
    });
    const got = await w.svc.recommend('ann', { mood: 'funny', wantNew: true });
    expect(got.availableNow.map((x) => x.title)).toEqual(['Pratfalls']);
    expect(got.notInLibrary).toEqual([
      expect.objectContaining({
        title: 'Banana Peel',
        alreadyRequested: false,
      }),
      expect.objectContaining({
        title: 'Sitcom Nights',
        alreadyRequested: true,
      }),
    ]);
    expect(w.prisma.mediaRequest.create).not.toHaveBeenCalled();
  });

  it('a family search for something new asks the catalogue for family certificates only', async () => {
    const w = build({ discover: [pick(903, 'Puppy Parade', ['Family'])] });
    await w.svc.recommend('ann', { forFamily: true, wantNew: true });
    expect(w.catalog.discover).toHaveBeenCalledWith(
      'movie',
      expect.objectContaining({ family: true }),
    );
  });

  it('"what sci-fi do we have?" lists what we have, watched or not', async () => {
    const w = build({
      seen: { 'jf-ann': { 'star-freight': { played: true } } },
    });
    const got = await w.svc.recommend('ann', {
      genres: ['sci-fi'],
      kind: 'movie',
      includeWatched: true,
    });
    expect(got.availableNow.map((x) => x.title).sort()).toEqual([
      'Moon Base',
      'Star Freight',
    ]);
    expect(got.notInLibrary).toEqual([]);
  });

  it('"based on what I\'ve been watching" pairs from their own recent viewing', async () => {
    const w = build({
      seen: {
        'jf-ann': { 'moon-base': { played: true, lastPlayed: '2026-09-22' } },
      },
      similar: { 107: [pick(106, 'Star Freight', ['Science Fiction'])] },
    });
    const got = await w.svc.recommend('ann', { basedOnHistory: true });
    expect(w.catalog.recommendedWith).toHaveBeenCalledWith('movie', 107);
    expect(got.availableNow[0]).toMatchObject({
      title: 'Star Freight',
      why: expect.stringContaining("goes with what you've been watching"),
    });
  });

  it('carries on from the library alone when the catalogue is down', async () => {
    const w = build({ catalogueDown: true });
    const got = await w.svc.recommend('ann', {
      like: 'Wizard School',
      wantNew: true,
    });
    expect(got.availableNow.length).toBeGreaterThan(0);
    expect(got.notInLibrary).toEqual([]);
  });
});

describe('reading what the model asked for', () => {
  it('keeps what makes sense and drops what it made up', () => {
    expect(
      readAsk({
        kind: 'movie',
        mood: 'Funny',
        genres: ['sci-fi', 7],
        like: '  Wizard School ',
        forFamily: 'true',
        maxMinutes: '100',
        aroundMinutes: 5000,
        wantNew: false,
        colour: 'blue',
      }),
    ).toEqual({
      kind: 'movie',
      mood: 'funny',
      genres: ['sci-fi'],
      like: 'Wizard School',
      forFamily: true,
      maxMinutes: 100,
    });
    expect(readAsk({ mood: 'gloomy', kind: 'podcast' })).toEqual({});
  });
});
