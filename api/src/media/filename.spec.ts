import {
  episodeTarget,
  movieTarget,
  normalizeTitle,
  parseMediaName,
  safe,
  titlesMatch,
} from './filename';

describe('parseMediaName', () => {
  it('reads a dotted release name', () => {
    expect(
      parseMediaName(
        'Harry.Potter.and.the.Sorcerers.Stone.2001.1080p.BluRay.x264.mkv',
      ),
    ).toEqual({
      kind: 'movie',
      title: 'Harry Potter and the Sorcerers Stone',
      year: 2001,
    });
  });

  it('reads a bracketed year and drops the trailing tags', () => {
    expect(
      parseMediaName('Barbie (2023) [1080p] [WEBRip] [5.1] [YTS.MX].mp4'),
    ).toEqual({
      kind: 'movie',
      title: 'Barbie',
      year: 2023,
    });
  });

  it('reads a plain title with no year', () => {
    expect(parseMediaName('Bad Santa.mkv')).toEqual({
      kind: 'movie',
      title: 'Bad Santa',
    });
  });

  it('reads S00E00 episodes', () => {
    expect(parseMediaName('The.Office.S03E07.1080p.WEB.mkv')).toEqual({
      kind: 'episode',
      title: 'The Office',
      season: 3,
      episode: 7,
    });
  });

  it('reads 0x00 episodes', () => {
    expect(parseMediaName('The Office - 3x07 - Branch Closing.mkv')).toEqual({
      kind: 'episode',
      title: 'The Office',
      season: 3,
      episode: 7,
    });
  });

  it('takes the show name from the folder when the file has only the numbering', () => {
    expect(parseMediaName('The Office/Season 3/S03E07.mkv')).toEqual({
      kind: 'episode',
      title: 'The Office',
      season: 3,
      episode: 7,
    });
  });

  it('keeps a year out of a series title', () => {
    expect(
      parseMediaName('Fallout (2024)/Season 1/Fallout S01E02.mkv'),
    ).toEqual({
      kind: 'episode',
      title: 'Fallout',
      season: 1,
      episode: 2,
    });
  });

  it('takes the year off the show folder when the file is only numbering', () => {
    expect(parseMediaName('Fallout (2024)/Season 1/S01E02.mkv')).toEqual({
      kind: 'episode',
      title: 'Fallout',
      season: 1,
      episode: 2,
      year: 2024,
    });
  });

  it('prefers a bracketed year over a number in the title', () => {
    expect(parseMediaName('Blade Runner 2049 (2017) 1080p.mkv')).toEqual({
      kind: 'movie',
      title: 'Blade Runner 2049',
      year: 2017,
    });
  });

  it('gives up on a name with nothing in it', () => {
    expect(parseMediaName('.mkv')).toBeNull();
  });
});

describe('library paths', () => {
  it('writes the movie layout jellyfin scans for', () => {
    expect(movieTarget('Interstellar', 2014, '.mkv')).toBe(
      'Movies/Interstellar (2014)/Interstellar (2014).mkv',
    );
  });

  it('writes a movie with no year', () => {
    expect(movieTarget('Bad Santa', undefined, '.mp4')).toBe(
      'Movies/Bad Santa/Bad Santa.mp4',
    );
  });

  it('writes the episode layout with padded numbers', () => {
    expect(episodeTarget('The Office', 3, 7, '.mkv')).toBe(
      'Shows/The Office/Season 03/The Office - S03E07.mkv',
    );
  });

  it('files into an existing library\u2019s folder names when told to', () => {
    expect(movieTarget('Interstellar', 2014, '.mkv', 'movies')).toBe(
      'movies/Interstellar (2014)/Interstellar (2014).mkv',
    );
    expect(episodeTarget('The Office', 3, 7, '.mkv', 'shows')).toBe(
      'shows/The Office/Season 03/The Office - S03E07.mkv',
    );
  });

  it('strips characters that break file names', () => {
    expect(safe('Face/Off: The Movie?')).toBe('Face Off The Movie');
  });
});

describe('title matching', () => {
  it('ignores case, articles and punctuation', () => {
    expect(normalizeTitle('The Office')).toBe('office');
    expect(titlesMatch('the office', 'The Office!')).toBe(true);
    expect(
      titlesMatch(
        'Harry Potter & the Goblet of Fire',
        'harry potter and the goblet of fire',
      ),
    ).toBe(true);
  });

  it('does not match different shows', () => {
    expect(titlesMatch('The Office', 'The Bear')).toBe(false);
  });

  it('is empty-safe', () => {
    expect(titlesMatch('', 'The Office')).toBe(false);
  });
});
