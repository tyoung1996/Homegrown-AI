import {
  IaCandidate,
  decodeRef,
  encodeRef,
  narrow,
  pickFile,
  rightsOf,
  sameTitle,
} from './internet-archive';

const ORIGINAL = {
  ids: process.env.IA_ALLOWED_IDENTIFIERS,
  licences: process.env.IA_ALLOWED_LICENCES,
};
afterEach(() => {
  for (const [k, v] of [
    ['IA_ALLOWED_IDENTIFIERS', ORIGINAL.ids],
    ['IA_ALLOWED_LICENCES', ORIGINAL.licences],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const item = (over: Partial<IaCandidate> = {}): IaCandidate => ({
  identifier: 'night_of_the_living_dead',
  title: 'Night of the Living Dead',
  year: 1968,
  ...over,
});

describe('whether we may take a copy', () => {
  it('says yes to a licence that plainly says so', () => {
    const v = rightsOf(
      item({
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      }),
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.why).toBe('licence');
  });

  it('says yes to a rights field that plainly says so', () => {
    const v = rightsOf(item({ rights: 'Public Domain' }));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.why).toBe('rights');
  });

  it('says no when nothing is stated at all', () => {
    expect(rightsOf(item()).ok).toBe(false);
  });

  it('says no to wording it does not recognise', () => {
    for (const rights of [
      'All rights reserved',
      'Used with permission',
      'Copyright 1968 the estate',
      'Probably public domain',
      'Unknown',
    ]) {
      expect(rightsOf(item({ rights })).ok).toBe(false);
    }
  });

  it('says no to a licence link it cannot read', () => {
    expect(
      rightsOf(item({ licenseUrl: 'https://example.com/our-terms' })).ok,
    ).toBe(false);
  });

  it('does not take age or a collection as permission', () => {
    // 1928, on the Archive, and still not ours to take without a statement
    expect(rightsOf(item({ year: 1928 })).ok).toBe(false);
  });

  it('says yes to anything named in the allowlist', () => {
    process.env.IA_ALLOWED_IDENTIFIERS = 'some_item, night_of_the_living_dead';
    const v = rightsOf(item());
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.why).toBe('allowlisted');
  });

  it('only allowlists the exact identifier, not something like it', () => {
    process.env.IA_ALLOWED_IDENTIFIERS = 'night_of_the_living';
    expect(rightsOf(item()).ok).toBe(false);
  });
});

describe('matching a title', () => {
  it('matches the same title written differently', () => {
    expect(sameTitle('The Kid', 'Kid')).toBe(true);
    expect(sameTitle('Tom & Jerry', 'Tom and Jerry')).toBe(true);
    expect(sameTitle('Metropolis', 'metropolis  ')).toBe(true);
  });

  it('does not match a title that merely contains it', () => {
    expect(sameTitle('The Kid', 'The Kid Brother')).toBe(false);
    expect(sameTitle('Metropolis', 'Metropolis Restored Edition')).toBe(false);
    expect(sameTitle('Nosferatu', 'Nosferatu the Vampyre')).toBe(false);
  });

  it('keeps only candidates of the same name', () => {
    const out = narrow(
      [
        item({ identifier: 'a', title: 'Metropolis', year: 1927 }),
        item({ identifier: 'b', title: 'Metropolis Trailer', year: 1927 }),
      ],
      { title: 'Metropolis' },
    );
    expect(out.map((c) => c.identifier)).toEqual(['a']);
  });

  it('prefers the year we asked for when one is known', () => {
    const out = narrow(
      [
        item({ identifier: 'right', title: 'Metropolis', year: 1927 }),
        item({ identifier: 'wrong', title: 'Metropolis', year: 2001 }),
      ],
      { title: 'Metropolis', year: 1927 },
    );
    expect(out.map((c) => c.identifier)).toEqual(['right']);
  });

  it('falls back to candidates with no year rather than a wrong one', () => {
    const out = narrow(
      [
        item({ identifier: 'undated', title: 'Metropolis', year: undefined }),
        item({ identifier: 'wrong', title: 'Metropolis', year: 2001 }),
      ],
      { title: 'Metropolis', year: 1927 },
    );
    expect(out.map((c) => c.identifier)).toEqual(['undated']);
  });
});

describe('choosing which file to download', () => {
  it('takes the video and leaves everything else alone', () => {
    const file = pickFile([
      { name: 'film_meta.xml', size: '900' },
      { name: 'film.thumbs/frame1.jpg', size: '4000' },
      { name: 'film_archive.torrent', size: '300' },
      { name: 'film.mp4', size: '700000000' },
      { name: 'film.srt', size: '2000' },
    ]);
    expect(file?.name).toBe('film.mp4');
  });

  it('prefers the format the importer is happiest with', () => {
    const file = pickFile([
      { name: 'film.ogv', size: '900000000' },
      { name: 'film.mp4', size: '100000000' },
    ]);
    expect(file?.name).toBe('film.mp4');
  });

  it('takes the better copy when the format is the same', () => {
    const file = pickFile([
      { name: 'film_512kb.mp4', size: '100000' },
      { name: 'film_hd.mp4', size: '900000' },
    ]);
    expect(file?.name).toBe('film_hd.mp4');
  });

  it('has nothing to offer when there is no video at all', () => {
    expect(pickFile([{ name: 'scan.pdf' }, { name: 'notes.txt' }])).toBeNull();
  });
});

describe('remembering a job across a restart', () => {
  it('survives a round trip', () => {
    const ref = { id: 'abc', file: 'film.mp4', size: 42 };
    expect(decodeRef(encodeRef(ref))).toEqual(ref);
  });

  it('shrugs off anything it cannot read', () => {
    expect(decodeRef(null)).toBeNull();
    expect(decodeRef('')).toBeNull();
    expect(decodeRef('not json')).toBeNull();
    expect(decodeRef('{"file":"only"}')).toBeNull();
  });
});
