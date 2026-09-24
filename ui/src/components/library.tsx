"use client";

import { useEffect, useState } from "react";
import {
  MediaPicker,
  Picker,
  RequestRow,
  statusTone,
  useRequests,
  posterSrc,
} from "./media-picker";

async function api(
  path: string,
  opts: RequestInit = {},
  token?: string | null,
) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
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

// what the family's health check returns. admins get a great deal more from
// the same endpoint, but nothing on this page needs it
type Health = {
  catalog: { configured: boolean; ok: boolean };
  jellyfin: { configured: boolean; ok: boolean; name?: string };
  ready: boolean;
};

const OPEN = ["REQUESTED", "SEARCHING", "ACQUIRING", "IMPORTING"];

export function Library({
  token,
  isAdmin,
}: {
  token: string;
  isAdmin: boolean;
}) {
  const [kind, setKind] = useState<"movies" | "series">("movies");
  const [query, setQuery] = useState("");
  const [picker, setPicker] = useState<Picker | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const { rows, refresh } = useRequests(token);
  // what this person asked for that has just become ready to watch
  const [justReady, setJustReady] = useState<RequestRow[]>([]);

  useEffect(() => {
    api("/media/requests/ready", {}, token)
      .then(setJustReady)
      .catch(() => {});
  }, [token]);

  async function gotIt() {
    const ids = justReady.map((r) => r.id);
    setJustReady([]);
    await api(
      "/media/requests/ready/seen",
      { method: "POST", body: JSON.stringify({ ids }) },
      token,
    ).catch(() => {});
  }

  useEffect(() => {
    api("/media/health", {}, token)
      .then(setHealth)
      .catch(() => {});
  }, [token]);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError("");
    setPicker(null);
    try {
      const items = await api(
        `/media/search?q=${encodeURIComponent(q)}&type=${kind === "series" ? "series" : "movie"}`,
        {},
        token,
      );
      setPicker({ mode: kind, query: q, items });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }

  async function cancel(r: RequestRow) {
    if (!confirm(`Take “${r.label}” off the list?`)) return;
    try {
      await api(`/media/requests/${r.id}`, { method: "DELETE" }, token);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function scan() {
    setError("");
    try {
      const r = await api("/media/scan", { method: "POST" }, token);
      setError(
        r.imported?.length
          ? `Added ${r.imported.length} file${r.imported.length === 1 ? "" : "s"} to the library`
          : "Nothing new in the drop folder",
      );
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const waiting = rows.filter((r) => OPEN.includes(r.status));
  const ready = rows.filter((r) => r.status === "AVAILABLE");
  const closed = rows.filter(
    (r) => r.status === "UNAVAILABLE" || r.status === "CANCELLED",
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
          <div>
            <h1 className="display text-3xl font-semibold">Movie night</h1>
            <p className="text-sm text-ink-2">
              Ask for a film or a show and it goes on the family list. Or just
              tell the assistant: “add Harry Potter”.
            </p>
          </div>
          {isAdmin && (
            <button onClick={scan} className="btn-ghost !py-1.5 text-xs">
              Check the drop folder
            </button>
          )}
        </div>

        {health && !health.catalog.configured && (
          <div className="card mb-5 border-gold/50 p-3 text-sm">
            <p className="font-medium text-gold">
              Film lookup isn’t set up yet
            </p>
            <p className="text-ink-2">
              An admin needs to add a catalogue key to the server’s
              <code className="mx-1 text-xs">api/.env</code> file (TMDB_API_KEY)
              and restart it. Everything else works without it.
            </p>
          </div>
        )}

        <form onSubmit={search} className="mb-6 flex flex-wrap gap-2">
          <div className="flex overflow-hidden rounded-md border border-line">
            {(["movies", "series"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`px-3 py-2 text-sm ${
                  kind === k
                    ? "bg-card text-ink"
                    : "text-ink-2 hover:bg-card/60"
                }`}
              >
                {k === "movies" ? "Films" : "Shows"}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              kind === "movies" ? "Search for a film…" : "Search for a show…"
            }
            className="field min-w-0 flex-1"
          />
          <button
            disabled={searching || query.trim().length < 2}
            className="btn shrink-0"
          >
            {searching ? "Looking…" : "Search"}
          </button>
        </form>

        {justReady.length > 0 && (
          <div className="card mb-5 flex items-center gap-3 border-sage/50 p-3 text-sm">
            <div className="min-w-0 flex-1">
              {justReady.slice(0, 5).map((r) => (
                <p key={r.id} className="font-medium text-sage">
                  {r.line ?? `${r.label} is ready to watch.`}
                </p>
              ))}
            </div>
            <button onClick={gotIt} className="btn-ghost !py-1 text-xs">
              Got it
            </button>
          </div>
        )}

        {error && <p className="mb-4 text-sm text-red">{error}</p>}

        {picker && (
          <div className="mb-8">
            <MediaPicker picker={picker} token={token} onAdded={refresh} />
          </div>
        )}

        <div className="grid gap-6 md:grid-cols-2">
          <section>
            <p className="eyebrow mb-2">On the list ({waiting.length})</p>
            {waiting.length === 0 ? (
              <p className="text-sm text-muted">Nothing waiting.</p>
            ) : (
              <ul className="space-y-2">
                {waiting.map((r) => (
                  <Row key={r.id} row={r} onCancel={() => cancel(r)} />
                ))}
              </ul>
            )}
          </section>

          <section>
            <p className="eyebrow mb-2">Ready to watch ({ready.length})</p>
            {ready.length === 0 ? (
              <p className="text-sm text-muted">Nothing new yet.</p>
            ) : (
              <ul className="space-y-2">
                {ready.slice(0, 20).map((r) => (
                  <Row key={r.id} row={r} />
                ))}
              </ul>
            )}
          </section>
        </div>

        {closed.length > 0 && (
          <section className="mt-6">
            <p className="eyebrow mb-2">Closed</p>
            <ul className="space-y-2 opacity-70">
              {closed.slice(0, 10).map((r) => (
                <Row key={r.id} row={r} />
              ))}
            </ul>
          </section>
        )}

        {health?.jellyfin.ok && health.jellyfin.name && (
          <p className="mt-8 text-xs text-muted">
            Everything here plays from {health.jellyfin.name}.
          </p>
        )}
      </div>
    </div>
  );
}

function Row({ row, onCancel }: { row: RequestRow; onCancel?: () => void }) {
  return (
    <li className="card flex items-center gap-3 p-3">
      {row.posterUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={posterSrc(row.posterUrl)!}
          alt={row.title}
          loading="lazy"
          className="h-16 w-11 shrink-0 rounded border border-line-2 object-cover"
        />
      ) : (
        <div className="h-16 w-11 shrink-0 rounded border border-line-2 bg-paper" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.label}</p>
        <p className="truncate text-xs text-ink-2">
          {row.line ?? row.statusNote ?? `Asked for by ${row.requestedBy}`}
        </p>
        {typeof row.progress === "number" && (
          <div
            className="mt-1.5 h-1 overflow-hidden rounded bg-line"
            role="progressbar"
            aria-valuenow={row.progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-sage"
              style={{ width: `${Math.max(2, Math.min(100, row.progress))}%` }}
            />
          </div>
        )}
      </div>
      <span
        className={`chip shrink-0 !py-0.5 text-[11px] ${statusTone(row.status)}`}
      >
        {row.statusText}
      </span>
      {onCancel && (
        <button
          onClick={onCancel}
          className="text-muted hover:text-red"
          title="Remove"
        >
          ✕
        </button>
      )}
    </li>
  );
}
