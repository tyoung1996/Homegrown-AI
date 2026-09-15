'use client';

import { useCallback, useEffect, useState } from 'react';

type Memory = { id: string; content: string; userId: string | null; createdAt: string };

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

// what the assistant knows — every person sees their own list, can delete
// anything, and can teach it directly. admins also manage family-wide facts.
export function MemoryPanel({
  token,
  isAdmin,
  displayName,
  onClose,
}: {
  token: string;
  isAdmin: boolean;
  displayName: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [family, setFamily] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api('/memories', {}, token).then(setItems).catch(() => {});
  }, [token]);

  useEffect(refresh, [refresh]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setError('');
    try {
      await api('/memories', { method: 'POST', body: JSON.stringify({ content: draft, family }) }, token);
      setDraft('');
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function forget(id: string) {
    setError('');
    try {
      await api(`/memories/${id}`, { method: 'DELETE' }, token);
      setItems((xs) => xs.filter((x) => x.id !== id));
    } catch (e: any) {
      setError(e.message);
    }
  }

  const mine = items.filter((m) => m.userId !== null);
  const shared = items.filter((m) => m.userId === null);

  const List = ({ list, canDelete }: { list: Memory[]; canDelete: boolean }) =>
    list.length === 0 ? (
      <p className="px-1 py-2 text-xs text-muted">Nothing yet — it learns as you chat.</p>
    ) : (
      <ul className="space-y-1">
        {list.map((m) => (
          <li key={m.id} className="group flex items-start gap-2 rounded-md bg-paper px-3 py-2 text-sm">
            <span className="flex-1">{m.content}</span>
            {canDelete && (
              <button onClick={() => forget(m.id)} title="Forget this" className="text-muted hover:text-red">
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
    );

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4">
      <div className="card max-h-[90dvh] w-full max-w-lg overflow-y-auto p-6 shadow-xl shadow-ink/10">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="display text-xl font-semibold">Memory</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>
        <p className="mb-4 text-xs text-ink-2">
          Everything the assistant remembers about you. It adds to this on its own as you talk;
          delete anything you&apos;d rather it forget, or teach it something below.
        </p>

        <p className="eyebrow mb-2">About {displayName}</p>
        <List list={mine} canDelete />

        <p className="eyebrow mb-2 mt-5">About the whole family</p>
        <List list={shared} canDelete={isAdmin} />

        <form onSubmit={add} className="mt-5 space-y-2 border-t border-line pt-4">
          <p className="eyebrow">Teach it something</p>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. I'm allergic to peanuts · my sister's name is Kate"
            maxLength={200}
            className="field text-sm"
          />
          <div className="flex items-center gap-3">
            {isAdmin && (
              <label className="flex items-center gap-1.5 text-xs text-ink-2">
                <input type="checkbox" checked={family} onChange={(e) => setFamily(e.target.checked)} />
                whole family
              </label>
            )}
            <button disabled={!draft.trim()} className="btn ml-auto !py-1.5 text-xs">
              Remember
            </button>
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
        </form>
      </div>
    </div>
  );
}
