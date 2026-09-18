// reading a video file's name well enough to file it, and writing the names
// jellyfin expects back out. pure functions, no io — the importer leans on
// these and so do the tests

export const VIDEO_EXTENSIONS = [
  '.mkv',
  '.mp4',
  '.m4v',
  '.avi',
  '.mov',
  '.wmv',
  '.mpg',
  '.mpeg',
  '.ts',
  '.webm',
];

export interface ParsedName {
  kind: 'movie' | 'episode';
  title: string;
  year?: number;
  season?: number;
  episode?: number;
}

// the noise release tools leave behind; everything from the first one of
// these onwards is dropped from the title
const JUNK =
  /\b(1080p|2160p|720p|480p|4k|uhd|hdr10?|hdr|sdr|bluray|blu-ray|brrip|bdrip|dvdrip|webrip|web-dl|webdl|web|hdtv|remux|proper|repack|extended|unrated|directors?\.?cut|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac\d?(\.\d)?|ac3|dd5\.1|ddp?5\.1|dts(-hd)?|truehd|atmos|10bit|8bit|multi|dual|subbed|dubbed|yify|yts(\.\w+)?|rarbg|galaxyrg\d*|evo|fgt|sparks|ntb|tgx|amzn|nf|hmax|dsnp|atvp)\b/i;

function tidy(raw: string): string {
  let s = raw.replace(/[._]+/g, ' ');
  s = s.replace(/\s*[-–]\s*$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  // strip a trailing bracketed group, e.g. "Barbie (2023) [1080p] [YTS]"
  s = s.replace(/\s*[[(][^\])]*[\])]\s*$/, '').trim();
  return s;
}

function cleanTitle(raw: string): string {
  let s = tidy(raw);
  const junk = s.search(JUNK);
  if (junk > 0) s = s.slice(0, junk);
  return tidy(s);
}

/**
 * Work out what a file is from its name. Handles the shapes that actually
 * turn up: dots or spaces, a year in brackets or not, S01E02 / 1x02 / a
 * "Season 1" parent folder.
 */
export function parseMediaName(input: string): ParsedName | null {
  const base = input
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .slice(-3)
    .join('/');
  const parts = base.split('/');
  const file = parts[parts.length - 1] ?? '';
  const stem = file.replace(/\.[a-z0-9]{2,4}$/i, '');
  if (!stem.trim()) return null;

  // an episode: S03E07, s3e7, 3x07, or "Season 3" folder + "Episode 7"
  const se = stem.match(
    /\bs(?:eason\s*)?(\d{1,2})[\s._-]*e(?:pisode\s*)?(\d{1,3})\b/i,
  );
  const cross = stem.match(/\b(\d{1,2})x(\d{1,3})\b/);
  const hit = se ?? cross;
  if (hit) {
    const before = stem.slice(0, hit.index ?? 0);
    // the show name is in the file, or failing that in the folder above —
    // one level up, or two when that level is "Season 3"
    let source = before;
    if (!cleanTitle(before)) {
      const folder = parts.length > 1 ? parts[parts.length - 2] : '';
      source = /^season\b/i.test(tidy(folder))
        ? (parts[parts.length - 3] ?? '')
        : folder;
    }
    const title = cleanTitle(source);
    if (!title) return null;
    // "Fallout (2024)" as a folder tells us the year; cleanTitle drops it
    const year = source.match(/[([](19\d{2}|20\d{2})[)\]]/);
    return {
      kind: 'episode',
      title,
      season: Number(hit[1]),
      episode: Number(hit[2]),
      ...(year ? { year: Number(year[1]) } : {}),
    };
  }

  // a film: the title is whatever comes before the year. a year in brackets
  // is the reliable one ("Blade Runner 2049 (2017)"), so look for that first,
  // then fall back to a bare year token — which may sit at the very end of
  // the name ("Interstellar.2014.mkv")
  const bracketed = stem.match(/[([](19\d{2}|20\d{2})[)\]]/);
  const bare = stem.match(/[\s._-](19\d{2}|20\d{2})(?=[)\]\s._-]|$)/);
  const year = bracketed ?? bare;
  if (year) {
    const title = cleanTitle(stem.slice(0, year.index));
    if (title) return { kind: 'movie', title, year: Number(year[1]) };
  }
  const title = cleanTitle(stem);
  if (!title) return null;
  return { kind: 'movie', title };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// jellyfin finds things by folder and file name, so write the shapes its
// scanner documents: "Movies/Title (Year)/Title (Year).mkv" and
// "Shows/Title/Season 01/Title - S01E02.mkv"
export function movieTarget(
  title: string,
  year: number | undefined,
  ext: string,
  folder = 'Movies',
) {
  const name = year ? `${safe(title)} (${year})` : safe(title);
  return `${folder}/${name}/${name}${ext}`;
}

export function episodeTarget(
  title: string,
  season: number,
  episode: number,
  ext: string,
  folder = 'Shows',
) {
  const name = safe(title);
  return `${folder}/${name}/Season ${pad2(season)}/${name} - S${pad2(season)}E${pad2(episode)}${ext}`;
}

// keep file names portable: no slashes, colons or trailing dots
export function safe(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\.+$/, '')
      .trim() || 'Untitled'
  );
}

// loose title match, so "The Office" matches "the office" and "Office, The"
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function titlesMatch(a: string, b: string): boolean {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}
