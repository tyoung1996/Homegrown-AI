import { asksForMissing, parseEpisodeRef, titleOf } from './query';

describe('reading a season and episode out of a request', () => {
  it.each([
    ['The Office S03E12', 'The Office', 3, 12],
    ['the office s3e12', 'the office', 3, 12],
    ['play The Office s03 e12', 'The Office', 3, 12],
    ['The Office 3x12', 'The Office', 3, 12],
    ['The Office season 3 episode 12', 'The Office', 3, 12],
    ['watch the office Season 3 Episode 12 please', 'the office', 3, 12],
  ])('reads %s', (input, title, season, episode) => {
    const ref = parseEpisodeRef(input)!;
    expect(ref.title).toBe(title);
    expect(ref.season).toBe(season);
    expect(ref.episode).toBe(episode);
  });

  it('reads a whole season with no episode', () => {
    const ref = parseEpisodeRef('add season 3 of Breaking Bad')!;
    expect(ref.season).toBe(3);
    expect(ref.episode).toBeUndefined();
    expect(ref.title.toLowerCase()).toContain('breaking bad');
  });

  it('says nothing when no season was mentioned', () => {
    expect(parseEpisodeRef('I want to watch The Office')).toBeNull();
    expect(parseEpisodeRef('play Interstellar')).toBeNull();
  });

  it('does not read a year as a season', () => {
    expect(parseEpisodeRef('watch Dune 2021')).toBeNull();
    expect(parseEpisodeRef('Blade Runner 2049')).toBeNull();
  });
});

describe('tidying a spoken request into a title', () => {
  it.each([
    ['I want to watch Interstellar', 'Interstellar'],
    ['play Interstellar please', 'Interstellar'],
    ['can we watch Encanto tonight', 'Encanto'],
    ['put on Harry Potter', 'Harry Potter'],
  ])('%s -> %s', (input, expected) => {
    expect(titleOf(input)).toBe(expected);
  });

  it('leaves a bare title alone', () => {
    expect(titleOf('The Office')).toBe('The Office');
  });
});

describe('asking for the rest of something', () => {
  it.each([
    'get the rest of The Office',
    'add the missing Harry Potter films',
    "what's missing from Breaking Bad",
    'complete my Office collection',
  ])('spots "%s"', (q) => {
    expect(asksForMissing(q)).toBe(true);
  });

  it('does not mistake a plain request for it', () => {
    expect(asksForMissing('add The Office')).toBe(false);
    expect(asksForMissing('watch Interstellar')).toBe(false);
  });
});
