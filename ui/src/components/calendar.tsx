'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Ev = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  location: string | null;
  who: string | null;
  notes: string | null;
};

function apiBase() {
  return '/api';
}

async function api(path: string, opts: RequestInit = {}, token?: string | null) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${res.status})`);
  }
  return res.json();
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function Calendar({ token }: { token: string }) {
  const today = useMemo(() => new Date(), []);
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selected, setSelected] = useState(ymd(today));
  const [events, setEvents] = useState<Ev[]>([]);
  const [adding, setAdding] = useState(false);
  const [subscribe, setSubscribe] = useState<{ https: string; webcal: string } | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ title: '', date: ymd(today), time: '10:00', allDay: false, location: '', who: '' });

  const monthStart = cursor;
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);

  const refresh = useCallback(() => {
    const from = ymd(new Date(monthStart.getFullYear(), monthStart.getMonth(), 1 - 7));
    const to = ymd(new Date(monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate() + 7));
    api(`/calendar?from=${from}&to=${to}`, {}, token)
      .then((r) => setEvents(r.events))
      .catch(() => {});
  }, [token, monthStart, monthEnd]);

  useEffect(refresh, [refresh]);

  const byDay = useMemo(() => {
    const m = new Map<string, Ev[]>();
    for (const e of events) {
      const k = ymd(new Date(e.startsAt));
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return m;
  }, [events]);

  // month grid: leading blanks so the 1st lands on the right weekday
  const cells: (Date | null)[] = [];
  for (let i = 0; i < monthStart.getDay(); i++) cells.push(null);
  for (let d = 1; d <= monthEnd.getDate(); d++) cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), d));

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await api(
        '/calendar',
        {
          method: 'POST',
          body: JSON.stringify({
            title: form.title,
            start: form.allDay ? form.date : `${form.date}T${form.time}`,
            allDay: form.allDay,
            location: form.location || undefined,
            who: form.who || undefined,
          }),
        },
        token,
      );
      setAdding(false);
      setForm({ ...form, title: '', location: '', who: '' });
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remove this from the family calendar?')) return;
    await api(`/calendar/${id}`, { method: 'DELETE' }, token).catch(() => {});
    refresh();
  }

  async function showSubscribe() {
    setSubscribe(await api('/calendar/subscribe', {}, token));
  }

  const dayEvents = byDay.get(selected) ?? [];
  const selectedDate = new Date(selected + 'T12:00:00');

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
          <div>
            <h1 className="display text-3xl font-semibold">Family calendar</h1>
            <p className="text-sm text-ink-2">Tell the assistant about a date and it lands here. Subscribe once and it shows up on your phone.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={showSubscribe} className="btn-ghost !py-1.5 text-xs">Add to my phone</button>
            <button onClick={() => { setForm((f) => ({ ...f, date: selected })); setAdding(true); }} className="btn !py-1.5 text-xs">+ Add event</button>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))} className="btn-ghost !px-3 !py-1">‹</button>
              <p className="display text-lg font-semibold">
                {cursor.toLocaleDateString([], { month: 'long', year: 'numeric' })}
              </p>
              <button onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))} className="btn-ghost !px-3 !py-1">›</button>
            </div>
            <div className="grid grid-cols-7 gap-1">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <div key={i} className="eyebrow py-1 text-center">{d}</div>
              ))}
              {cells.map((d, i) =>
                d ? (
                  <button
                    key={i}
                    onClick={() => setSelected(ymd(d))}
                    className={`flex aspect-square flex-col items-start rounded-md border p-1.5 text-left text-xs transition ${
                      ymd(d) === selected ? 'border-red bg-red-soft/40' : 'border-line bg-card hover:border-line-2'
                    } ${ymd(d) === ymd(today) ? 'font-bold' : ''}`}
                  >
                    <span className={ymd(d) === ymd(today) ? 'text-red' : 'text-ink-2'}>{d.getDate()}</span>
                    <span className="mt-auto flex flex-wrap gap-0.5">
                      {(byDay.get(ymd(d)) ?? []).slice(0, 4).map((e) => (
                        <span key={e.id} className="size-1.5 rounded-full bg-red" title={e.title} />
                      ))}
                    </span>
                  </button>
                ) : (
                  <div key={i} />
                ),
              )}
            </div>
          </div>

          <div>
            <p className="eyebrow mb-2">
              {selectedDate.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
            {dayEvents.length === 0 ? (
              <p className="text-sm text-muted">Nothing on this day.</p>
            ) : (
              <ul className="space-y-2">
                {dayEvents.map((e) => (
                  <li key={e.id} className="card group flex items-start gap-3 p-3">
                    <div className="w-16 shrink-0 text-xs text-ink-2">{e.allDay ? 'all day' : timeOf(e.startsAt)}</div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{e.title}</p>
                      <p className="text-xs text-ink-2">
                        {[e.who, e.location].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <button onClick={() => remove(e.id)} className="text-muted hover:text-red" title="Remove">✕</button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-xs text-muted">
              Or just tell the assistant: &ldquo;Levi has soccer Saturday at 10 at the park.&rdquo;
            </p>
          </div>
        </div>
      </div>

      {adding && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/30 p-4">
          <form onSubmit={add} className="card w-full max-w-sm space-y-3 p-6 shadow-xl shadow-ink/10">
            <h2 className="display text-xl font-semibold">Add to the calendar</h2>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="What" className="field" autoFocus />
            <div className="grid grid-cols-2 gap-2">
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="field text-sm" />
              <input type="time" value={form.time} disabled={form.allDay} onChange={(e) => setForm({ ...form, time: e.target.value })} className="field text-sm disabled:opacity-40" />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={form.allDay} onChange={(e) => setForm({ ...form, allDay: e.target.checked })} /> all day
            </label>
            <div className="grid grid-cols-2 gap-2">
              <input value={form.who} onChange={(e) => setForm({ ...form, who: e.target.value })} placeholder="Who (optional)" className="field text-sm" />
              <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Where (optional)" className="field text-sm" />
            </div>
            {error && <p className="text-sm text-red">{error}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setAdding(false)} className="btn-ghost flex-1">Cancel</button>
              <button disabled={!form.title.trim()} className="btn flex-1">Add</button>
            </div>
          </form>
        </div>
      )}

      {subscribe && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/30 p-4">
          <div className="card w-full max-w-md space-y-3 p-6 shadow-xl shadow-ink/10">
            <div className="flex items-center justify-between">
              <h2 className="display text-xl font-semibold">Add to your phone</h2>
              <button onClick={() => setSubscribe(null)} className="text-muted hover:text-ink">✕</button>
            </div>
            <p className="text-sm text-ink-2">
              Subscribe once and every event — including the ones the assistant adds — shows up in your phone&apos;s calendar app, with a reminder an hour before.
            </p>
            <div>
              <p className="eyebrow mb-1">iPhone / Mac</p>
              <a href={subscribe.webcal} className="btn w-full">Open in Apple Calendar</a>
              <p className="mt-1 text-xs text-muted">Tap, then choose Subscribe.</p>
            </div>
            <div>
              <p className="eyebrow mb-1">Google Calendar / Android</p>
              <p className="text-xs text-ink-2">Google Calendar → Other calendars → From URL → paste:</p>
              <input readOnly value={subscribe.https} onFocus={(e) => e.currentTarget.select()} className="field mt-1 text-xs" />
            </div>
            <p className="text-xs text-muted">This link is private to your family — anyone with it can see the calendar, so don&apos;t post it publicly.</p>
          </div>
        </div>
      )}
    </div>
  );
}
