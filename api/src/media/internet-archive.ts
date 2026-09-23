// Deciding whether an Internet Archive item is one we may take a copy of,
// and which file to take. Pure functions — no network, no disk — so the
// judgement calls can be tested exhaustively.

export interface IaCandidate {
  identifier: string;
  title: string;
  year?: number;
  licenseUrl?: string;
  rights?: string;
}

export interface IaFile {
  name: string;
  format?: string;
  size?: string;
}

/**
 * Licences that say, in a form a machine can actually read, that anyone may
 * take a copy. Nothing is inferred from a collection name, an upload date or
 * an age: plenty of what the Archive hosts is there by arrangement, or by
 * nobody's arrangement at all, and neither is ours to take.
 */
const OPEN_LICENCES = [
  'creativecommons.org/publicdomain/mark',
  'creativecommons.org/publicdomain/zero',
  'creativecommons.org/licenses/by/',
  'creativecommons.org/licenses/by-sa/',
  'creativecommons.org/licenses/by-nd/',
  'creativecommons.org/licenses/by-nc/',
  'creativecommons.org/licenses/by-nc-sa/',
  'creativecommons.org/licenses/by-nc-nd/',
];

/** Phrases in a rights field that are unambiguous on their own. */
const OPEN_RIGHTS = /^(public domain|no known copyright|cc0)\b/i;

export function allowedIdentifiers(): Set<string> {
  return new Set(
    (process.env.IA_ALLOWED_IDENTIFIERS ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function openLicences(): string[] {
  const extra = (process.env.IA_ALLOWED_LICENCES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...OPEN_LICENCES, ...extra];
}

export type RightsVerdict =
  | { ok: true; why: 'allowlisted' | 'licence' | 'rights'; detail: string }
  | { ok: false; why: 'unclear'; detail: string };

/**
 * May we take a copy of this? Yes only when it is named in the allowlist, or
 * carries a licence or rights statement that says so plainly. Anything else
 * — a blank field, a wording we do not recognise, a link we cannot read — is
 * a no. Ambiguity is not permission.
 */
export function rightsOf(item: IaCandidate): RightsVerdict {
  if (allowedIdentifiers().has(item.identifier.toLowerCase())) {
    return {
      ok: true,
      why: 'allowlisted',
      detail: 'approved by identifier in configuration',
    };
  }
  const licence = (item.licenseUrl ?? '').toLowerCase();
  const match = openLicences().find((l) => licence.includes(l));
  if (match) return { ok: true, why: 'licence', detail: item.licenseUrl! };
  const rights = (item.rights ?? '').trim();
  if (rights && OPEN_RIGHTS.test(rights)) {
    return { ok: true, why: 'rights', detail: rights };
  }
  return {
    ok: false,
    why: 'unclear',
    detail: licence || rights || 'no licence or rights stated',
  };
}

/** Titles match only when they are the same title. No prefixes, no
 * "contains" — the wrong film downloaded quietly is worse than none. */
export function sameTitle(a: string, b: string): boolean {
  const tidy = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(the|a|an)\b/g, ' ')
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const x = tidy(a);
  return !!x && x === tidy(b);
}

/**
 * The candidates that are actually this film. A year we know about must
 * agree; a candidate with no year at all is kept, since the Archive often
 * omits it, but it can never outrank one that matches.
 */
export function narrow(
  candidates: IaCandidate[],
  want: { title: string; year?: number },
): IaCandidate[] {
  const named = candidates.filter((c) => sameTitle(c.title, want.title));
  if (!want.year) return named;
  const exact = named.filter((c) => c.year === want.year);
  if (exact.length) return exact;
  return named.filter((c) => c.year == null);
}

// what the importer and Jellyfin get on with, best first
const EXTENSIONS = ['.mp4', '.m4v', '.mkv', '.avi', '.mpeg', '.mpg', '.ogv'];
// derivatives, artwork and bookkeeping that are not the film
const NOT_THE_FILM =
  /(_meta\.|_files\.|_reviews\.|\.torrent$|\.xml$|\.sqlite$|\.txt$|\.jpg$|\.jpeg$|\.png$|\.gif$|\.srt$|\.vtt$|\.pdf$|\.json$|thumbs?\/)/i;

/** The one file worth downloading: the best format the importer handles,
 * and among equals the biggest, which is the better copy. */
export function pickFile(files: IaFile[]): IaFile | null {
  const usable = files
    .filter((f) => f.name && !NOT_THE_FILM.test(f.name))
    .map((f) => ({
      file: f,
      rank: EXTENSIONS.findIndex((e) => f.name.toLowerCase().endsWith(e)),
      size: Number(f.size ?? 0),
    }))
    .filter((f) => f.rank !== -1);
  if (!usable.length) return null;
  usable.sort((a, b) => a.rank - b.rank || b.size - a.size);
  return usable[0].file;
}

/** What goes on the request so poll() can pick the job up again after a
 * restart — everything it needs, and nothing it would have to remember. */
export interface IaRef {
  id: string;
  file: string;
  size: number;
}

export function encodeRef(ref: IaRef): string {
  return JSON.stringify(ref);
}

export function decodeRef(raw: string | null | undefined): IaRef | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<IaRef>;
    if (!parsed.id || !parsed.file) return null;
    return {
      id: String(parsed.id),
      file: String(parsed.file),
      size: Number(parsed.size ?? 0),
    };
  } catch {
    return null;
  }
}
