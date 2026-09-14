'use client';

import { useCallback, useEffect, useState } from 'react';

type Stats = {
  gpu: {
    name: string;
    vramTotalMB: number;
    vramUsedMB: number;
    tempC: number;
    utilPercent: number;
  } | null;
  cpuLoad: number;
  cpuCores: number;
  ramTotalMB: number;
  ramFreeMB: number;
  diskTotalGB: number;
  diskFreeGB: number;
  uptimeSec: number;
};

type LibModel = {
  name: string;
  label: string;
  kind: 'chat' | 'vision';
  sizeGB: number;
  blurb: string;
  installed: boolean;
  active: boolean;
  fit: 'recommended' | 'tight' | 'too_big';
};

const FIT_BADGE: Record<string, [string, string]> = {
  recommended: ['Recommended', 'badge badge-adult'],
  tight: ['Will be slow', 'badge badge-admin'],
  too_big: ['Too big for this card', 'badge badge-child'],
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

function uptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((sec % 3600) / 60)}m`;
}

function Meter({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = Math.min(100, Math.round((used / total) * 100));
  return (
    <div className="rounded-md bg-paper p-3">
      <div className="flex justify-between text-xs text-ink-2">
        <span>{label}</span>
        <span>
          {used.toFixed(1)} / {total.toFixed(1)} {unit}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-red transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProgressBar({ pct, text }: { pct: number; text: string }) {
  return (
    <div className="mt-2">
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-red transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-ink-2">{text}</p>
    </div>
  );
}

// streams ollama's pull progress from the api
async function runInstall(
  token: string,
  name: string,
  onProgress: (pct: number, text: string) => void,
) {
  const res = await fetch(`${apiBase()}/models/install`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name }),
  });
  if (!res.ok || !res.body) throw new Error(`Request failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep).trim();
      buf = buf.slice(sep + 2);
      if (!raw.startsWith('data: ')) continue;
      const ev = JSON.parse(raw.slice(6));
      if (ev.type === 'progress') {
        onProgress(
          Math.round((ev.completed / ev.total) * 100),
          `Downloading — ${(ev.completed / 1e9).toFixed(1)} of ${(ev.total / 1e9).toFixed(1)} GB`,
        );
      } else if (ev.type === 'status') onProgress(-1, ev.status);
      else if (ev.type === 'error') throw new Error(ev.message);
    }
  }
}

export function SetupScreen({
  token,
  isAdmin,
  onReady,
}: {
  token: string;
  isAdmin: boolean;
  onReady: () => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [models, setModels] = useState<LibModel[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/system/stats', {}, token).then(setStats).catch(() => {});
    api('/models/library', {}, token)
      .then((r) => setModels(r.models.filter((m: LibModel) => m.kind === 'chat')))
      .catch(() => {});
    const t = setInterval(() => {
      api('/setup/status', {}, token)
        .then((s) => s.modelInstalled && onReady())
        .catch(() => {});
    }, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function install(name: string) {
    setInstalling(name);
    setProgress(0);
    setError('');
    setStatusLine('Starting download…');
    try {
      await runInstall(token, name, (pct, text) => {
        if (pct >= 0) setProgress(pct);
        setStatusLine(text);
      });
      onReady();
    } catch (e: any) {
      setError(e.message);
      setInstalling(null);
    }
  }

  if (!isAdmin) {
    return (
      <div className="circuit-bg grid min-h-dvh place-items-center px-4 text-ink">
        <div className="max-w-sm text-center">
          <h1 className="display text-2xl font-semibold">Almost ready…</h1>
          <p className="mt-2 text-sm text-ink-2">
            This server doesn&apos;t have an AI model installed yet. Ask your
            admin to finish setup — this page will update on its own.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="circuit-bg min-h-dvh px-4 py-10 text-ink">
      <div className="mx-auto max-w-xl">
        <h1 className="display text-3xl font-semibold">Give your server a brain</h1>
        <p className="mt-1 text-sm text-ink-2">
          Last step: pick an AI model. We checked your hardware and ranked what will actually run well on it.
        </p>

        {stats?.gpu && (
          <div className="card mt-5 p-4">
            <p className="eyebrow">Your hardware</p>
            <p className="mt-1 font-semibold">{stats.gpu.name}</p>
            <p className="text-sm text-ink-2">
              {(stats.gpu.vramTotalMB / 1024).toFixed(0)} GB of video memory · {stats.cpuCores} CPU cores ·{' '}
              {(stats.ramTotalMB / 1000).toFixed(0)} GB RAM
            </p>
          </div>
        )}

        <div className="mt-5 space-y-2">
          {models.map((m) => {
            const [fitLabel, fitCls] = FIT_BADGE[m.fit];
            return (
              <div key={m.name} className="card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{m.label}</span>
                  <span className="text-xs text-muted">{m.sizeGB} GB</span>
                  <span className={fitCls}>{fitLabel}</span>
                  {m.fit !== 'too_big' && (
                    <button
                      onClick={() => install(m.name)}
                      disabled={installing !== null}
                      className="btn ml-auto !py-1.5"
                    >
                      {installing === m.name ? 'Installing…' : 'Install'}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-ink-2">{m.blurb}</p>
                {installing === m.name && <ProgressBar pct={progress} text={statusLine} />}
              </div>
            );
          })}
        </div>
        {error && <p className="mt-3 text-sm text-red">{error}</p>}
      </div>
    </div>
  );
}

export function ModelsPanel({
  token,
  isAdmin,
  onClose,
}: {
  token: string;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [models, setModels] = useState<LibModel[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    api('/models/library', {}, token)
      .then((r) => setModels(r.models))
      .catch(() => {});
    api('/system/stats', {}, token).then(setStats).catch(() => {});
  }, [token]);

  useEffect(() => {
    refresh();
    const t = setInterval(() => {
      api('/system/stats', {}, token).then(setStats).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, [refresh, token]);

  async function install(name: string) {
    setInstalling(name);
    setProgress(0);
    setError('');
    setStatusLine('Starting download…');
    try {
      await runInstall(token, name, (pct, text) => {
        if (pct >= 0) setProgress(pct);
        setStatusLine(text);
      });
      setStatusLine('');
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setInstalling(null);
    }
  }

  async function activate(name: string) {
    setError('');
    try {
      await api('/models/active', { method: 'POST', body: JSON.stringify({ name }) }, token);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  const chat = models.filter((m) => m.kind === 'chat');
  const ext = models.filter((m) => m.kind === 'vision');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4">
      <div className="card max-h-[90dvh] w-full max-w-2xl overflow-y-auto p-6 shadow-xl shadow-ink/10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-xl font-semibold">Models &amp; server</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>

        {stats && (
          <div className="mb-5">
            {stats.gpu && (
              <p className="mb-2 text-sm">
                <span className="font-semibold">{stats.gpu.name}</span>
                <span className="text-ink-2">
                  {' '}· {stats.gpu.tempC}°C · {stats.gpu.utilPercent}% busy · up {uptime(stats.uptimeSec)}
                </span>
              </p>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {stats.gpu && (
                <Meter label="VRAM" used={stats.gpu.vramUsedMB / 1024} total={stats.gpu.vramTotalMB / 1024} unit="GB" />
              )}
              <Meter label="RAM" used={(stats.ramTotalMB - stats.ramFreeMB) / 1000} total={stats.ramTotalMB / 1000} unit="GB" />
              <Meter label="Disk" used={stats.diskTotalGB - stats.diskFreeGB} total={stats.diskTotalGB} unit="GB" />
            </div>
          </div>
        )}

        <p className="eyebrow mb-2">Model library</p>
        <div className="space-y-2">
          {chat.map((m) => {
            const [fitLabel, fitCls] = FIT_BADGE[m.fit];
            return (
              <div key={m.name} className={`rounded-md border p-3 ${m.active ? 'border-red bg-red-soft/40' : 'border-line bg-paper'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{m.label}</span>
                  <span className="text-xs text-muted">{m.sizeGB} GB</span>
                  <span className={fitCls}>{fitLabel}</span>
                  {m.active && <span className="badge bg-ink text-paper">ACTIVE</span>}
                  <span className="ml-auto flex gap-2">
                    {isAdmin && m.installed && !m.active && (
                      <button onClick={() => activate(m.name)} className="btn !py-1 text-xs">
                        Use
                      </button>
                    )}
                    {isAdmin && !m.installed && m.fit !== 'too_big' && (
                      <button
                        onClick={() => install(m.name)}
                        disabled={installing !== null}
                        className="btn-ghost !py-1 text-xs"
                      >
                        Install
                      </button>
                    )}
                    {!isAdmin && m.installed && !m.active && (
                      <span className="text-[10px] text-muted">installed</span>
                    )}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-2">{m.blurb}</p>
                {installing === m.name && <ProgressBar pct={progress} text={statusLine} />}
              </div>
            );
          })}
        </div>

        <p className="eyebrow mb-2 mt-5">Extensions</p>
        <div className="space-y-2">
          {ext.map((m) => (
            <div key={m.name} className="rounded-md border border-line bg-paper p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{m.label}</span>
                <span className="text-xs text-muted">{m.sizeGB} GB</span>
                {m.installed ? (
                  <span className="badge badge-adult">INSTALLED</span>
                ) : (
                  isAdmin && (
                    <button
                      onClick={() => install(m.name)}
                      disabled={installing !== null}
                      className="btn-ghost ml-auto !py-1 text-xs"
                    >
                      Install
                    </button>
                  )
                )}
              </div>
              <p className="mt-1 text-xs text-ink-2">{m.blurb}</p>
              {installing === m.name && <ProgressBar pct={progress} text={statusLine} />}
            </div>
          ))}
        </div>
        {error && <p className="mt-3 text-sm text-red">{error}</p>}
        {!isAdmin && (
          <p className="mt-3 text-xs text-muted">Only admins can install or switch models.</p>
        )}
      </div>
    </div>
  );
}
