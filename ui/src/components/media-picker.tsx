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

export type Picker = {
  mode: 'movies' | 'series';
  query: string;
  items: PickerItem[];
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

function Poster({
  url,
  title,
  wide,
}: {
  url?: string | null;
  title: string;
  wide?: boolean;
}) {
  if (!url) {
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
      src={url}
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
      } catch (e: any) {
        setError(e.message);
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
    } catch (e: any) {
      setError(e.message);
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
    } catch (e: any) {
      setError(e.message);
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
