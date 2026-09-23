'use client';

import { useCallback, useEffect, useState } from 'react';

// what the assistant hands over when someone asks for a film or a show, and
// the tick-boxes the family taps to say which ones they meant

export type PickerItem = {
  catalogId: number;
  title: string;
  year?: number;
  overview?: string;
  posterUrl?: string;
  inLibrary: boolean;
  requested: boolean;
};

export type WatchItem = {
  itemId: string;
  title: string;
  year?: number;
  posterUrl?: string;
  runtimeMinutes?: number;
  seriesName?: string;
};

export type ScreenRow = {
  id: string;
  name: string;
  kind: string;
  ready: boolean;
  nowPlaying?: string;
};

export type AddItem = {
  catalogId: number;
  title: string;
  year?: number;
  posterUrl?: string;
  owned: boolean;
  requested: boolean;
};

export type SeasonRow = {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  ownedCount: number;
  state: 'complete' | 'partial' | 'missing';
  requested: boolean;
  episodes?: EpisodeRow[];
};

export type EpisodeRow = {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  owned: boolean;
  itemId?: string;
  requested: boolean;
};

export type ShowRow = {
  catalogId: number;
  title: string;
  year?: number;
  posterUrl?: string;
  itemId?: string;
  state: 'complete' | 'partial' | 'missing';
  missingCount: number;
  seasons: SeasonRow[];
};

export type Picker =
  | {
      mode: 'movies' | 'series';
      query: string;
      items: PickerItem[];
    }
  | {
      mode: 'play';
      query: string;
      items: WatchItem[];
      screens: ScreenRow[];
    }
  | { mode: 'add'; query: string; items: AddItem[] }
  | { mode: 'show'; query: string; series: ShowRow; screens: ScreenRow[] }
  | {
      mode: 'episode';
      query: string;
      catalogId: number;
      seriesTitle: string;
      episode: EpisodeRow;
      screens: ScreenRow[];
    };

export type RequestRow = {
  id: string;
  label: string;
  title: string;
  posterUrl: string | null;
  status: string;
  statusText: string;
  statusNote: string | null;
  requestedBy: string;
  mine: boolean;
};

type Outcome = { result: string; label: string };

type Season = {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  inLibrary: boolean;
  haveCount: number;
};

type Episode = {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview?: string;
  inLibrary: boolean;
};

// what to show someone when a call fails, whatever was thrown
function failure(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

async function api(
  path: string,
  opts: RequestInit = {},
  token?: string | null,
) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = Array.isArray(body.message) ? body.message[0] : body.message;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return res.json();
}

export function statusTone(status: string) {
  if (status === 'AVAILABLE') return 'border-sage/60 text-sage';
  if (status === 'UNAVAILABLE' || status === 'CANCELLED')
    return 'border-line-2 text-muted';
  return 'border-gold/60 text-gold';
}

// posters are either a catalogue link (an absolute url) or one of ours,
// which the api gives as a path for the /api proxy to resolve
export function posterSrc(url?: string | null) {
  if (!url) return null;
  return url.startsWith('/') ? `/api${url}` : url;
}

function Poster({
  url,
  title,
  wide,
}: {
  url?: string | null;
  title: string;
  wide?: boolean;
}) {
  const src = posterSrc(url);
  if (!src) {
    return (
      <div
        className={`grid shrink-0 place-items-center rounded-md border border-line-2 bg-paper text-center text-[10px] leading-tight text-muted ${
          wide ? 'h-24 w-16' : 'h-20 w-14'
        }`}
      >
        {title.slice(0, 18)}
      </div>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={title}
      loading="lazy"
      className={`shrink-0 rounded-md border border-line-2 object-cover ${
        wide ? 'h-24 w-16' : 'h-20 w-14'
      }`}
    />
  );
}

/**
 * The picker itself. Films are a straight multi-select. Shows go one level
 * deeper: pick the show, then the whole thing, some seasons, or single
 * episodes.
 */
export function MediaPicker({
  picker,
  token,
  onAdded,
}: {
  picker: Picker;
  token: string;
  onAdded?: () => void;
}) {
  // "put it on the TV" is its own little flow — nothing to tick, two taps
  if (picker.mode === 'play') {
    return <WatchPicker picker={picker} token={token} />;
  }
  if (picker.mode === 'add') {
    return <AddPicker picker={picker} token={token} onAdded={onAdded} />;
  }
  if (picker.mode === 'show') {
    return <ShowPicker picker={picker} token={token} onAdded={onAdded} />;
  }
  if (picker.mode === 'episode') {
    return <EpisodePicker picker={picker} token={token} onAdded={onAdded} />;
  }
  return <RequestPicker picker={picker} token={token} onAdded={onAdded} />;
}

function RequestPicker({
  picker,
  token,
  onAdded,
}: {
  picker: Extract<Picker, { mode: 'movies' | 'series' }>;
  token: string;
  onAdded?: () => void;
}) {
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [series, setSeries] = useState<PickerItem | null>(null);
  const [seasons, setSeasons] = useState<Season[] | null>(null);
  const [wholeSeries, setWholeSeries] = useState(false);
  const [pickedSeasons, setPickedSeasons] = useState<Set<number>>(new Set());
  const [openSeason, setOpenSeason] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<Record<number, Episode[]>>({});
  const [pickedEpisodes, setPickedEpisodes] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Outcome[] | null>(null);

  const openable = picker.items.filter((i) => !i.inLibrary);

  const chooseSeries = useCallback(
    async (item: PickerItem) => {
      setSeries(item);
      setSeasons(null);
      setError('');
      try {
        const data = await api(
          `/media/series/${item.catalogId}/seasons`,
          {},
          token,
        );
        setSeasons(data.seasons);
      } catch (e) {
        setError(failure(e));
      }
    },
    [token],
  );

  async function toggleSeason(n: number) {
    if (openSeason === n) {
      setOpenSeason(null);
      return;
    }
    setOpenSeason(n);
    if (episodes[n] || !series) return;
    try {
      const data = await api(
        `/media/series/${series.catalogId}/seasons/${n}/episodes`,
        {},
        token,
      );
      setEpisodes((e) => ({ ...e, [n]: data.episodes }));
    } catch (e) {
      setError(failure(e));
    }
  }

  const count = series
    ? wholeSeries
      ? 1
      : pickedSeasons.size + pickedEpisodes.size
    : chosen.size;

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {};
      if (series) {
        body.seriesId = series.catalogId;
        if (!wholeSeries) {
          if (pickedSeasons.size) body.seasons = [...pickedSeasons];
          if (pickedEpisodes.size) {
            body.episodes = [...pickedEpisodes].map((k) => {
              const [season, episode] = k.split('x').map(Number);
              return { season, episode };
            });
          }
        }
      } else {
        body.movies = [...chosen];
      }
      const r = await api(
        '/media/requests',
        { method: 'POST', body: JSON.stringify(body) },
        token,
      );
      setDone(r.results as Outcome[]);
      onAdded?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card mt-2 p-3">
        <p className="eyebrow mb-2">Added to the library list</p>
        <ul className="space-y-1 text-sm">
          {done.map((o, i) => (
            <li key={i} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">{o.label}</span>
              <span
                className={`chip shrink-0 !py-0.5 text-[11px] ${statusTone(
                  o.result === 'already-available' ? 'AVAILABLE' : 'REQUESTED',
                )}`}
              >
                {o.result === 'already-available'
                  ? 'Already in your library'
                  : o.result === 'already-requested'
                    ? 'Already on the list'
                    : 'On the list'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // ----------------------------------------------------------- shows
  if (series) {
    return (
      <div className="card mt-2 p-3">
        <div className="mb-3 flex items-center gap-3">
          <Poster url={series.posterUrl} title={series.title} />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {series.title}{' '}
              {series.year && (
                <span className="text-muted">({series.year})</span>
              )}
            </p>
            <p className="text-xs text-ink-2">Pick what you want</p>
          </div>
          <button
            onClick={() => {
              setSeries(null);
              setSeasons(null);
              setWholeSeries(false);
              setPickedSeasons(new Set());
              setPickedEpisodes(new Set());
            }}
            className="text-xs text-muted hover:text-red"
          >
            back
          </button>
        </div>

        <label className="mb-2 flex items-center gap-2 rounded-md bg-paper px-3 py-2 text-sm">
          <input
            type="checkbox"
            checked={wholeSeries}
            onChange={(e) => {
              setWholeSeries(e.target.checked);
              if (e.target.checked) {
                setPickedSeasons(new Set());
                setPickedEpisodes(new Set());
              }
            }}
          />
          <span className="font-medium">The whole show</span>
        </label>

        {!seasons && (
          <p className="py-3 text-sm text-muted">Loading seasons…</p>
        )}

        {seasons && !wholeSeries && (
          <ul className="space-y-1">
            {seasons.map((s) => (
              <li key={s.seasonNumber} className="rounded-md bg-paper">
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={s.inLibrary}
                    checked={pickedSeasons.has(s.seasonNumber)}
                    onChange={(e) => {
                      const next = new Set(pickedSeasons);
                      if (e.target.checked) next.add(s.seasonNumber);
                      else next.delete(s.seasonNumber);
                      setPickedSeasons(next);
                      // ticking the season covers its episodes
                      if (e.target.checked) {
                        setPickedEpisodes(
                          new Set(
                            [...pickedEpisodes].filter(
                              (k) => Number(k.split('x')[0]) !== s.seasonNumber,
                            ),
                          ),
                        );
                      }
                    }}
                  />
                  <button
                    onClick={() => toggleSeason(s.seasonNumber)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="font-medium">{s.name}</span>{' '}
                    <span className="text-xs text-muted">
                      {s.episodeCount} episode{s.episodeCount === 1 ? '' : 's'}
                      {s.haveCount > 0 &&
                        !s.inLibrary &&
                        ` · ${s.haveCount} here`}
                    </span>
                  </button>
                  {s.inLibrary ? (
                    <span className="chip !py-0.5 text-[11px] border-sage/60 text-sage">
                      In your library
                    </span>
                  ) : (
                    <button
                      onClick={() => toggleSeason(s.seasonNumber)}
                      className="text-xs text-muted hover:text-ink"
                    >
                      {openSeason === s.seasonNumber ? 'hide' : 'episodes'}
                    </button>
                  )}
                </div>

                {openSeason === s.seasonNumber && (
                  <ul className="border-t border-line px-3 py-1.5">
                    {!episodes[s.seasonNumber] && (
                      <li className="py-1 text-xs text-muted">Loading…</li>
                    )}
                    {(episodes[s.seasonNumber] ?? []).map((ep) => {
                      const key = `${ep.seasonNumber}x${ep.episodeNumber}`;
                      const covered =
                        pickedSeasons.has(ep.seasonNumber) || wholeSeries;
                      return (
                        <li
                          key={key}
                          className="flex items-center gap-2 py-1 text-sm"
                        >
                          <input
                            type="checkbox"
                            disabled={ep.inLibrary || covered}
                            checked={pickedEpisodes.has(key) || covered}
                            onChange={(e) => {
                              const next = new Set(pickedEpisodes);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              setPickedEpisodes(next);
                            }}
                          />
                          <span className="w-10 shrink-0 text-xs text-muted">
                            E{ep.episodeNumber}
                          </span>
                          <span className="min-w-0 flex-1 truncate">
                            {ep.name}
                          </span>
                          {ep.inLibrary && (
                            <span className="shrink-0 text-[11px] text-sage">
                              have it
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="mt-2 text-sm text-red">{error}</p>}
        <button
          onClick={submit}
          disabled={busy || count === 0}
          className="btn mt-3 w-full"
        >
          {busy
            ? 'Adding…'
            : count === 0
              ? 'Pick something first'
              : `Add ${count} to library`}
        </button>
      </div>
    );
  }

  // ----------------------------------------------------------- films
  return (
    <div className="card mt-2 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="eyebrow">
          {picker.mode === 'series' ? 'Shows' : 'Films'} matching “
          {picker.query}”
        </p>
        {picker.mode === 'movies' && openable.length > 1 && (
          <button
            onClick={() =>
              setChosen(
                chosen.size === openable.length
                  ? new Set()
                  : new Set(openable.map((i) => i.catalogId)),
              )
            }
            className="text-xs text-muted hover:text-ink"
          >
            {chosen.size === openable.length ? 'Clear' : 'Select all'}
          </button>
        )}
      </div>

      <ul className="space-y-1.5">
        {picker.items.map((item) => (
          <li key={item.catalogId}>
            {picker.mode === 'series' ? (
              <button
                onClick={() => chooseSeries(item)}
                className="flex w-full items-start gap-3 rounded-md bg-paper p-2 text-left hover:bg-card"
              >
                <Poster url={item.posterUrl} title={item.title} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {item.title}{' '}
                    {item.year && (
                      <span className="text-muted">({item.year})</span>
                    )}
                  </span>
                  {item.overview && (
                    <span className="mt-0.5 block line-clamp-2 text-xs text-ink-2">
                      {item.overview}
                    </span>
                  )}
                </span>
                <span className="shrink-0 self-center text-muted">›</span>
              </button>
            ) : (
              <label
                className={`flex items-start gap-3 rounded-md p-2 ${
                  item.inLibrary ? 'opacity-60' : 'bg-paper hover:bg-card'
                }`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={item.inLibrary}
                  checked={chosen.has(item.catalogId)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(item.catalogId);
                    else next.delete(item.catalogId);
                    setChosen(next);
                  }}
                />
                <Poster url={item.posterUrl} title={item.title} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">
                    {item.title}{' '}
                    {item.year && (
                      <span className="text-muted">({item.year})</span>
                    )}
                  </span>
                  {item.overview && (
                    <span className="mt-0.5 block line-clamp-2 text-xs text-ink-2">
                      {item.overview}
                    </span>
                  )}
                  {item.inLibrary && (
                    <span className="mt-1 inline-block text-[11px] text-sage">
                      Already in your library
                    </span>
                  )}
                  {!item.inLibrary && item.requested && (
                    <span className="mt-1 inline-block text-[11px] text-gold">
                      Already on the list
                    </span>
                  )}
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>

      {error && <p className="mt-2 text-sm text-red">{error}</p>}
      {picker.mode === 'movies' && (
        <button
          onClick={submit}
          disabled={busy || chosen.size === 0}
          className="btn mt-3 w-full"
        >
          {busy
            ? 'Adding…'
            : chosen.size === 0
              ? 'Tick the ones you want'
              : `Add ${chosen.size} to library`}
        </button>
      )}
    </div>
  );
}

/** The compact list a reply shows after it has put things on the list. */
export function RequestList({ requests }: { requests: RequestRow[] }) {
  if (!requests.length) return null;
  return (
    <div className="card mt-2 p-3">
      <p className="eyebrow mb-2">On the library list</p>
      <ul className="space-y-1.5">
        {requests.map((r) => (
          <li key={r.id} className="flex items-center gap-3">
            <Poster url={r.posterUrl} title={r.title} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {r.label}
              </span>
              {r.statusNote && (
                <span className="block truncate text-xs text-ink-2">
                  {r.statusNote}
                </span>
              )}
            </span>
            <span
              className={`chip shrink-0 !py-0.5 text-[11px] ${statusTone(r.status)}`}
            >
              {r.statusText}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Small hook the library page uses to keep statuses fresh. */
export function useRequests(token: string) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const refresh = useCallback(() => {
    api('/media/requests', {}, token)
      .then(setRows)
      .catch(() => {});
  }, [token]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);
  return { rows, refresh };
}

/**
 * "I want to watch Harry Potter" — pick which one, then pick the TV, and it
 * starts. The TV list is refreshed when the card opens, because a TV that was
 * asleep when the question was asked may be awake by the time they tap.
 */
function WatchPicker({
  picker,
  token,
}: {
  picker: Extract<Picker, { mode: 'play' }>;
  token: string;
}) {
  const [item, setItem] = useState<WatchItem | null>(
    picker.items.length === 1 ? picker.items[0] : null,
  );
  const [screens, setScreens] = useState<ScreenRow[]>(picker.screens);
  const [playing, setPlaying] = useState<string | null>(null);

  // someone else may have turned a TV on (or started something) since the
  // assistant answered
  useEffect(() => {
    let live = true;
    api('/media/screens', {}, token)
      .then((rows: ScreenRow[]) => {
        if (live && rows?.length) setScreens(rows);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token]);

  if (playing) {
    return (
      <div className="card mt-2 p-3">
        <p className="eyebrow mb-1">On the TV</p>
        <p className="text-sm">{playing}</p>
      </div>
    );
  }

  // step one: which one did they mean?
  if (!item) {
    return (
      <div className="card mt-2 p-3">
        <p className="eyebrow mb-2">Which one?</p>
        <ul className="space-y-1">
          {picker.items.map((i) => (
            <li key={i.itemId}>
              <button
                onClick={() => setItem(i)}
                className="flex w-full items-center gap-3 rounded-md bg-paper px-3 py-2 text-left hover:bg-line-2/40"
              >
                <Poster url={i.posterUrl} title={i.title} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {i.seriesName ? `${i.seriesName} — ${i.title}` : i.title}
                  </span>
                  <span className="block text-xs text-muted">
                    {[
                      i.year,
                      i.runtimeMinutes ? `${i.runtimeMinutes} min` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // step two: which TV?
  return (
    <div className="card mt-2 p-3">
      <div className="mb-3 flex items-center gap-3">
        <Poster url={item.posterUrl} title={item.title} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{item.title}</p>
          <p className="text-xs text-ink-2">Which TV?</p>
        </div>
        {picker.items.length > 1 && (
          <button
            onClick={() => setItem(null)}
            className="text-xs text-muted hover:text-red"
          >
            back
          </button>
        )}
      </div>

      <ScreenList
        screens={screens}
        itemId={item.itemId}
        token={token}
        onPlaying={setPlaying}
      />
    </div>
  );
}

// shared by the cards that can both play something and ask for what is
// missing: the film is chosen, now pick a room
function ScreenList({
  screens,
  itemId,
  token,
  onPlaying,
}: {
  screens: ScreenRow[];
  itemId: string;
  token: string;
  onPlaying: (line: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function play(screen: ScreenRow) {
    setBusy(screen.id);
    setError('');
    try {
      const res = await api(
        '/media/play',
        { method: 'POST', body: JSON.stringify({ itemId, screen: screen.id }) },
        token,
      );
      onPlaying(res.message ?? `Playing on ${screen.name}`);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  }

  if (!screens.length) {
    return (
      <p className="py-2 text-sm text-muted">
        No TVs are awake right now. Turn one on and ask again.
      </p>
    );
  }

  return (
    <>
      <ul className="space-y-1">
        {screens.map((s) => (
          <li key={s.id}>
            <button
              disabled={!!busy}
              onClick={() => play(s)}
              className="flex w-full items-center justify-between gap-3 rounded-md bg-paper px-3 py-2 text-left text-sm hover:bg-line-2/40 disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{s.name}</span>
                {s.nowPlaying && (
                  <span className="block truncate text-xs text-muted">
                    playing {s.nowPlaying}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {busy === s.id ? 'starting…' : 'play here'}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
    </>
  );
}

/** We don't have it. Say so plainly, and offer to put it on the list —
 * nothing is asked for until they tap. */
function AddPicker({
  picker,
  token,
  onAdded,
}: {
  picker: Extract<Picker, { mode: 'add' }>;
  token: string;
  onAdded?: () => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');

  async function add(item: AddItem) {
    setBusy(item.catalogId);
    setError('');
    try {
      await api(
        '/media/requests',
        { method: 'POST', body: JSON.stringify({ movies: [item.catalogId] }) },
        token,
      );
      setAdded((s) => new Set(s).add(item.catalogId));
      onAdded?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card mt-2 p-3">
      <p className="eyebrow mb-2">Not in your library</p>
      <ul className="space-y-1">
        {picker.items.map((i) => {
          const done = added.has(i.catalogId) || i.requested;
          return (
            <li
              key={i.catalogId}
              className="flex items-center gap-3 rounded-md bg-paper px-3 py-2"
            >
              <Poster url={i.posterUrl} title={i.title} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {i.title}
                </span>
                <span className="block text-xs text-muted">{i.year}</span>
              </span>
              {done ? (
                <span className="chip shrink-0 !py-0.5 text-[11px] border-gold/60 text-gold">
                  On the list
                </span>
              ) : (
                <button
                  disabled={busy === i.catalogId}
                  onClick={() => add(i)}
                  className="btn shrink-0 text-xs disabled:opacity-50"
                >
                  {busy === i.catalogId ? 'adding…' : 'Add to library'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
    </div>
  );
}

const SEASON_MARK: Record<string, string> = {
  complete: '✓',
  partial: '·',
  missing: '✗',
};

/** A show, season by season: watch what is here, ask for what is not. */
function ShowPicker({
  picker,
  token,
  onAdded,
}: {
  picker: Extract<Picker, { mode: 'show' }>;
  token: string;
  onAdded?: () => void;
}) {
  const show = picker.series;
  const [playing, setPlaying] = useState<string | null>(null);
  const [chosen, setChosen] = useState<EpisodeRow | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState('');

  async function addMissing() {
    setBusy(true);
    setError('');
    try {
      await api(
        '/media/requests',
        {
          method: 'POST',
          body: JSON.stringify({ seriesId: show.catalogId, missingOnly: true }),
        },
        token,
      );
      setAsked(true);
      onAdded?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  if (playing) {
    return (
      <div className="card mt-2 p-3">
        <p className="eyebrow mb-1">On the TV</p>
        <p className="text-sm">{playing}</p>
      </div>
    );
  }

  if (chosen?.itemId) {
    return (
      <div className="card mt-2 p-3">
        <div className="mb-3 flex items-center gap-3">
          <Poster url={show.posterUrl} title={show.title} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">
              {show.title} — S{chosen.seasonNumber}E{chosen.episodeNumber}
            </p>
            <p className="text-xs text-ink-2">Which TV?</p>
          </div>
          <button
            onClick={() => setChosen(null)}
            className="text-xs text-muted hover:text-red"
          >
            back
          </button>
        </div>
        <ScreenList
          screens={picker.screens}
          itemId={chosen.itemId}
          token={token}
          onPlaying={setPlaying}
        />
      </div>
    );
  }

  return (
    <div className="card mt-2 p-3">
      <div className="mb-3 flex items-center gap-3">
        <Poster url={show.posterUrl} title={show.title} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{show.title}</p>
          <p className="text-xs text-ink-2">
            {show.state === 'complete'
              ? 'You have all of it'
              : show.state === 'missing'
                ? 'None of it is in your library'
                : `${show.missingCount} episode${show.missingCount === 1 ? '' : 's'} missing`}
          </p>
        </div>
      </div>

      <ul className="space-y-1">
        {show.seasons.map((s) => (
          <li key={s.seasonNumber} className="rounded-md bg-paper">
            <button
              onClick={() =>
                setOpen(open === s.seasonNumber ? null : s.seasonNumber)
              }
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
            >
              <span
                className={
                  s.state === 'complete'
                    ? 'text-sage'
                    : s.state === 'missing'
                      ? 'text-muted'
                      : 'text-gold'
                }
              >
                {SEASON_MARK[s.state]}
              </span>
              <span className="flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-xs text-muted">
                {s.state === 'complete'
                  ? 'Ready'
                  : s.state === 'missing'
                    ? 'Not in library'
                    : `${s.episodeCount - s.ownedCount} missing`}
              </span>
            </button>

            {open === s.seasonNumber && s.episodes && (
              <ul className="border-t border-line-2 px-3 py-1">
                {s.episodes.map((e) => (
                  <li
                    key={e.episodeNumber}
                    className="flex items-center gap-2 py-1 text-sm"
                  >
                    <span className="w-10 shrink-0 text-xs text-muted">
                      E{e.episodeNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{e.name}</span>
                    {e.owned ? (
                      <button
                        onClick={() => setChosen(e)}
                        className="shrink-0 text-xs text-sage hover:underline"
                      >
                        watch
                      </button>
                    ) : (
                      <span className="shrink-0 text-xs text-muted">
                        {e.requested ? 'on the list' : 'not in library'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {show.missingCount > 0 && (
        <button
          disabled={busy || asked}
          onClick={addMissing}
          className="btn mt-3 w-full text-sm disabled:opacity-50"
        >
          {asked
            ? 'Added to the library list'
            : busy
              ? 'adding…'
              : `Add the ${show.missingCount} missing episode${show.missingCount === 1 ? '' : 's'}`}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
    </div>
  );
}

/** One episode, asked for by name. Play it, or add just that one — never
 * the whole show. */
function EpisodePicker({
  picker,
  token,
  onAdded,
}: {
  picker: Extract<Picker, { mode: 'episode' }>;
  token: string;
  onAdded?: () => void;
}) {
  const { episode, seriesTitle } = picker;
  const [playing, setPlaying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState('');
  const label = `${seriesTitle} — S${episode.seasonNumber}E${episode.episodeNumber}`;

  async function addThisOne() {
    setBusy(true);
    setError('');
    try {
      await api(
        '/media/requests',
        {
          method: 'POST',
          body: JSON.stringify({
            seriesId: picker.catalogId,
            episodes: [
              {
                season: episode.seasonNumber,
                episode: episode.episodeNumber,
              },
            ],
          }),
        },
        token,
      );
      setAsked(true);
      onAdded?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  if (playing) {
    return (
      <div className="card mt-2 p-3">
        <p className="eyebrow mb-1">On the TV</p>
        <p className="text-sm">{playing}</p>
      </div>
    );
  }

  return (
    <div className="card mt-2 p-3">
      <p className="eyebrow mb-1">
        {episode.owned ? 'Which TV?' : 'Not in your library'}
      </p>
      <p className="mb-3 text-sm font-medium">
        {label}
        <span className="ml-2 font-normal text-muted">{episode.name}</span>
      </p>

      {episode.owned && episode.itemId ? (
        <ScreenList
          screens={picker.screens}
          itemId={episode.itemId}
          token={token}
          onPlaying={setPlaying}
        />
      ) : episode.requested || asked ? (
        <p className="text-sm text-gold">
          That episode is already on the list.
        </p>
      ) : (
        <button
          disabled={busy}
          onClick={addThisOne}
          className="btn w-full text-sm disabled:opacity-50"
        >
          {busy ? 'adding…' : 'Add this episode'}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
    </div>
  );
}
