'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BarnMark } from '@/components/logo';
import { ModelsPanel, SetupScreen } from '@/components/models-panel';
import { Studio } from '@/components/studio';
import { MemoryPanel } from '@/components/memory-panel';
import { Calendar } from '@/components/calendar';

type User = { id: string; username: string; displayName: string; role: string };
type Convo = { id: string; title: string; updatedAt: string };
type Msg = {
  id?: string;
  role: string;
  content: string;
  image?: string;
  sources?: string[];
  status?: string;
};
type AdminUser = User & { createdAt: string };

// same origin — next.js proxies /api to the nest api (see next.config.ts)
const apiBase = () => '/api';

function dropSession() {
  try {
    localStorage.removeItem('cb_token');
    localStorage.removeItem('cb_user');
  } catch {}
  window.location.reload();
}

async function api(path: string, opts: RequestInit = {}, token?: string | null) {
  const res = await fetch(`${apiBase()}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401 && token) {
    dropSession();
    throw new Error('Signed out');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = Array.isArray(body.message) ? body.message[0] : body.message;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

const ROLE_BADGE: Record<string, string> = {
  ADMIN: 'badge badge-admin',
  ADULT: 'badge badge-adult',
  CHILD: 'badge badge-child',
};

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [bootstrap, setBootstrap] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const [convos, setConvos] = useState<Convo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showStudio, setShowStudio] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [server, setServer] = useState<{
    modelInstalled: boolean;
    visionAvailable: boolean;
  } | null>(null);
  const [attached, setAttached] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let t: string | null = null;
    let u: string | null = null;
    try {
      t = localStorage.getItem('cb_token');
      u = localStorage.getItem('cb_user');
    } catch {}
    if (t && u) {
      setToken(t);
      setUser(JSON.parse(u));
    }
    api('/auth/bootstrap-needed')
      .then((r) => setBootstrap(r.needed))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const refreshConvos = useCallback((tk: string) => {
    api('/conversations', {}, tk).then(setConvos).catch(() => {});
  }, []);

  const refreshServer = useCallback((tk: string) => {
    api('/setup/status', {}, tk).then(setServer).catch(() => {});
  }, []);

  useEffect(() => {
    if (token) {
      refreshConvos(token);
      refreshServer(token);
    }
  }, [token, refreshConvos, refreshServer]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function signedIn(r: { token: string; user: User }) {
    setToken(r.token);
    setUser(r.user);
    setBootstrap(false);
    try {
      localStorage.setItem('cb_token', r.token);
      localStorage.setItem('cb_user', JSON.stringify(r.user));
    } catch {}
  }

  function signOut() {
    setToken(null);
    setUser(null);
    setConvos([]);
    setMessages([]);
    setActiveId(null);
    try {
      localStorage.removeItem('cb_token');
      localStorage.removeItem('cb_user');
    } catch {}
  }

  async function openConvo(id: string) {
    setShowStudio(false);
    setShowCalendar(false);
    setActiveId(id);
    setSidebarOpen(false);
    const raw = await api(`/conversations/${id}/messages`, {}, token);
    setMessages(
      raw.map((m: any) => ({
        ...m,
        image: m.imagePath ? `${apiBase()}/images/${m.imagePath}` : undefined,
      })),
    );
  }

  function pickImage(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setAttached(String(reader.result));
    reader.readAsDataURL(file);
  }

  async function deleteConvo(id: string) {
    await api(`/conversations/${id}`, { method: 'DELETE' }, token);
    if (id === activeId) {
      setActiveId(null);
      setMessages([]);
    }
    if (token) refreshConvos(token);
  }

  function newChat() {
    setShowStudio(false);
    setShowCalendar(false);
    setActiveId(null);
    setMessages([]);
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  async function send() {
    const text = input.trim();
    if ((!text && !attached) || busy || !token) return;
    const imageData = attached ?? undefined;
    setError('');
    setInput('');
    setAttached(null);
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: 'user', content: text, image: imageData },
      { role: 'assistant', content: '', status: 'Thinking…' },
    ]);

    const patchLast = (fn: (m: Msg) => Msg) =>
      setMessages((ms) => [...ms.slice(0, -1), fn(ms[ms.length - 1])]);

    try {
      const res = await fetch(`${apiBase()}/chat/stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: text || 'What do you see in this image?',
          conversationId: activeId ?? undefined,
          imageData,
        }),
      });
      if (res.status === 401) {
        dropSession();
        return;
      }
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
          if (ev.type === 'meta') setActiveId(ev.conversationId);
          else if (ev.type === 'status')
            patchLast((m) => ({ ...m, status: ev.text }));
          else if (ev.type === 'token')
            patchLast((m) => ({
              ...m,
              status: undefined,
              content: m.content + ev.text,
            }));
          else if (ev.type === 'image')
            patchLast((m) => ({
              ...m,
              status: undefined,
              image: `${apiBase()}${ev.url}`,
            }));
          else if (ev.type === 'sources')
            patchLast((m) => ({ ...m, sources: ev.urls }));
          else if (ev.type === 'error') throw new Error(ev.message);
        }
      }
      patchLast((m) => ({ ...m, status: undefined }));
      refreshConvos(token);
    } catch (e: any) {
      setError(e.message);
      setMessages((ms) =>
        ms[ms.length - 1]?.role === 'assistant' && !ms[ms.length - 1].content
          ? ms.slice(0, -1)
          : ms,
      );
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;
  if (!token || !user) return <AuthScreen bootstrap={bootstrap} onDone={signedIn} />;
  if (server && !server.modelInstalled) {
    return (
      <SetupScreen
        token={token}
        isAdmin={user.role === 'ADMIN'}
        onReady={() => refreshServer(token)}
      />
    );
  }

  const sidebar = (
    <div className="flex h-full w-64 flex-col border-r border-line bg-paper-2">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
        <BarnMark size={34} />
        <div>
          <h1 className="display text-[17px] font-semibold leading-tight">Circuit Barn</h1>
          <p className="eyebrow">Homegrown AI</p>
        </div>
      </div>

      <div className="mx-3 mb-3 flex flex-col gap-1.5">
        <button onClick={newChat} className="btn">
          New chat
        </button>
        <button
          onClick={() => {
            setShowStudio(true);
            setShowCalendar(false);
            setSidebarOpen(false);
          }}
          className={`btn-ghost ${showStudio ? 'bg-card border-ink' : ''}`}
        >
          <PaletteIcon />
          Studio
        </button>
        <button
          onClick={() => {
            setShowCalendar(true);
            setShowStudio(false);
            setSidebarOpen(false);
          }}
          className={`btn-ghost ${showCalendar ? 'bg-card border-ink' : ''}`}
        >
          <CalendarIcon />
          Calendar
        </button>
      </div>

      <div className="mx-4 mb-1 border-t border-line" />
      <nav className="flex-1 space-y-px overflow-y-auto px-2 py-2">
        {convos.map((c) => (
          <div
            key={c.id}
            className={`group flex items-center rounded-md text-sm ${
              c.id === activeId && !showStudio ? 'bg-card text-ink' : 'text-ink-2 hover:bg-card/60'
            }`}
          >
            <button
              onClick={() => openConvo(c.id)}
              className="min-w-0 flex-1 truncate px-3 py-2 text-left"
            >
              {c.title}
            </button>
            <button
              onClick={() => deleteConvo(c.id)}
              title="Delete chat"
              className="hidden pr-2 text-muted hover:text-red group-hover:block"
            >
              ✕
            </button>
          </div>
        ))}
        {convos.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted">No chats yet</p>
        )}
      </nav>

      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-full bg-ink text-sm font-semibold text-paper">
            {user.displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.displayName}</p>
            <span className={ROLE_BADGE[user.role] ?? 'badge'}>{user.role}</span>
          </div>
        </div>
        <div className="mt-2 flex gap-3 text-xs text-ink-2">
          <button onClick={() => setShowMemory(true)} className="hover:text-red">
            Memory
          </button>
          <button onClick={() => setShowModels(true)} className="hover:text-red">
            Models
          </button>
          {user.role === 'ADMIN' && (
            <button onClick={() => setShowAdmin(true)} className="hover:text-red">
              Family
            </button>
          )}
          <button onClick={signOut} className="hover:text-red">
            Sign out
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="circuit-bg flex h-dvh text-ink">
      <aside className="max-md:hidden">{sidebar}</aside>
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setSidebarOpen(false)} />
          <div className="absolute inset-y-0 left-0 z-50">{sidebar}</div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-paper-2 px-4 py-3 md:hidden">
          <button onClick={() => setSidebarOpen(true)} className="text-xl">☰</button>
          <BarnMark size={24} />
          <span className="display font-semibold">Circuit Barn</span>
        </header>

        {showStudio ? (
          <Studio token={token} meId={user.id} isAdmin={user.role === 'ADMIN'} />
        ) : showCalendar ? (
          <Calendar token={token} />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
                {messages.length === 0 && (
                  <div className="mt-[16vh] text-center">
                    <div className="mx-auto mb-4 w-fit">
                      <BarnMark size={56} />
                    </div>
                    <h2 className="display text-3xl font-semibold">Hey {user.displayName}.</h2>
                    <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ink-2">
                      Ask me anything — I can check the weather and search the
                      web too. Everything stays on your own server.
                    </p>
                  </div>
                )}
                {messages.map((m, i) => (
                  <MessageBubble
                    key={m.id ?? i}
                    msg={m}
                    streaming={busy && i === messages.length - 1}
                  />
                ))}
                <div ref={bottomRef} />
              </div>
            </div>

            {error && (
              <p className="mx-auto w-full max-w-3xl px-4 pb-1 text-sm text-red">{error}</p>
            )}
            <div className="border-t border-line bg-paper-2/80">
              {attached && (
                <div className="mx-auto max-w-3xl px-4 pt-3">
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={attached}
                      alt="attached"
                      className="h-20 rounded-md border border-line-2 object-cover"
                    />
                    <button
                      onClick={() => setAttached(null)}
                      className="absolute -right-2 -top-2 grid size-6 place-items-center rounded-full border border-line-2 bg-card text-xs text-ink-2 hover:text-red"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              )}
              <div className="mx-auto flex max-w-3xl items-end gap-2 px-4 py-3">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    pickImage(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
                {server?.visionAvailable && (
                  <button
                    onClick={() => fileRef.current?.click()}
                    title="Attach a photo"
                    className="btn-ghost size-11 shrink-0 !p-0 text-lg"
                  >
                    +
                  </button>
                )}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  rows={1}
                  placeholder="Ask anything…"
                  className="field max-h-40 flex-1 resize-none"
                />
                <button
                  onClick={send}
                  disabled={busy || (!input.trim() && !attached)}
                  className="btn size-11 shrink-0 !p-0"
                  title="Send"
                >
                  <SendIcon />
                </button>
              </div>
            </div>
          </>
        )}
      </main>

      {showAdmin && token && (
        <AdminPanel token={token} me={user} onClose={() => setShowAdmin(false)} />
      )}
      {showMemory && token && (
        <MemoryPanel
          token={token}
          isAdmin={user.role === 'ADMIN'}
          displayName={user.displayName}
          onClose={() => setShowMemory(false)}
        />
      )}
      {showModels && token && (
        <ModelsPanel
          token={token}
          isAdmin={user.role === 'ADMIN'}
          onClose={() => {
            setShowModels(false);
            refreshServer(token);
          }}
        />
      )}
    </div>
  );
}

function PaletteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.9 2-2 0-.6-.3-1-.6-1.4-.3-.4-.4-.8-.4-1.2 0-1 .9-1.9 2-1.9h1.5A4.5 4.5 0 0 0 21 10c0-3.9-4-7-9-7z" />
      <circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" />
      <circle cx="15.5" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function MessageBubble({ msg, streaming }: { msg: Msg; streaming?: boolean }) {
  if (msg.role === 'user') {
    return (
      <div className="msg-in ml-auto w-fit max-w-[85%]">
        {msg.image && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={msg.image}
            alt="sent"
            className="mb-1.5 ml-auto max-h-64 rounded-md border border-line-2 object-cover"
          />
        )}
        {msg.content && (
          <div className="whitespace-pre-wrap rounded-lg rounded-br-sm bg-ink px-4 py-2.5 leading-relaxed text-paper">
            {msg.content}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="msg-in flex max-w-full gap-3">
      <div className="mt-1 shrink-0">
        <BarnMark size={28} />
      </div>
      <div className="min-w-0 flex-1">
        {msg.status && (
          <p className="flex items-center gap-2 py-2 text-sm text-ink-2">
            <span className="inline-flex gap-1">
              <span className="size-1.5 animate-bounce rounded-full bg-red [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-red [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-red [animation-delay:300ms]" />
            </span>
            {msg.status}
          </p>
        )}
        {msg.image && (
          <a href={msg.image} target="_blank" rel="noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={msg.image}
              alt="generated"
              className="mb-1.5 max-h-96 rounded-md border border-line-2"
            />
          </a>
        )}
        {msg.content && (
          <div className={`md-body card rounded-tl-sm px-4 py-3 ${streaming ? 'stream-cursor' : ''}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        )}
        {msg.sources && msg.sources.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {msg.sources.map((u) => {
              let host = u;
              try {
                host = new URL(u).hostname.replace(/^www\./, '');
              } catch {}
              return (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="chip !py-1 text-[11px]">
                  {host}
                </a>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function AdminPanel({
  token,
  me,
  onClose,
}: {
  token: string;
  me: User;
  onClose: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('CHILD');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [persona, setPersona] = useState('');
  const [personaSaved, setPersonaSaved] = useState('');

  const refresh = useCallback(() => {
    api('/users', {}, token).then(setUsers).catch(() => {});
    api('/settings', {}, token)
      .then((s) => {
        setPersona(s.persona ?? '');
        setPersonaSaved(s.persona ?? '');
      })
      .catch(() => {});
  }, [token]);

  useEffect(refresh, [refresh]);

  async function savePersona() {
    setError('');
    try {
      const s = await api('/settings', { method: 'POST', body: JSON.stringify({ persona }) }, token);
      setPersonaSaved(s.persona ?? '');
      setOk('Personality saved — applies to the next message');
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setOk('');
    try {
      await api(
        '/auth/register',
        {
          method: 'POST',
          body: JSON.stringify({
            username,
            displayName: displayName || username,
            password,
            role,
          }),
        },
        token,
      );
      setOk(`Account "${username}" created`);
      setUsername('');
      setDisplayName('');
      setPassword('');
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function removeUser(id: string, name: string) {
    if (!confirm(`Delete ${name}'s account and all their chats?`)) return;
    try {
      await api(`/users/${id}`, { method: 'DELETE' }, token);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/30 p-4">
      <div className="card w-full max-w-lg p-6 shadow-xl shadow-ink/10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-xl font-semibold">The family</h2>
          <button onClick={onClose} className="text-muted hover:text-ink">✕</button>
        </div>

        <div className="max-h-52 space-y-1 overflow-y-auto">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-3 rounded-md bg-paper px-3 py-2">
              <div className="grid size-8 place-items-center rounded-full bg-ink text-sm font-semibold text-paper">
                {u.displayName.charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {u.displayName} <span className="text-muted">@{u.username}</span>
                </p>
              </div>
              <span className={ROLE_BADGE[u.role] ?? 'badge'}>{u.role}</span>
              {u.id !== me.id && (
                <button
                  onClick={() => removeUser(u.id, u.displayName)}
                  className="text-muted hover:text-red"
                  title="Delete account"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>

        <form onSubmit={createUser} className="mt-5 space-y-3 border-t border-line pt-4">
          <p className="eyebrow">Add a family member</p>
          <div className="grid grid-cols-2 gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
              autoCapitalize="none"
              className="field text-sm"
            />
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name"
              className="field text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (6+ chars)"
              className="field text-sm"
            />
            <select value={role} onChange={(e) => setRole(e.target.value)} className="field text-sm">
              <option value="CHILD">Child</option>
              <option value="ADULT">Adult</option>
              <option value="ADMIN">Admin</option>
            </select>
          </div>
          {error && <p className="text-sm text-red">{error}</p>}
          {ok && <p className="text-sm text-sage">{ok}</p>}
          <button className="btn w-full">Create account</button>
        </form>

        <div className="mt-5 space-y-2 border-t border-line pt-4">
          <p className="eyebrow">Personality</p>
          <p className="text-xs text-ink-2">
            House rules for the assistant — its name, tone, things it should always or never do. Applies to everyone.
          </p>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={3}
            placeholder="e.g. Your name is Sparky. Keep answers short. Be extra patient with the kids' homework."
            className="field resize-none text-sm"
          />
          <button onClick={savePersona} disabled={persona === personaSaved} className="btn-ghost w-full">
            Save personality
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthScreen({
  bootstrap,
  onDone,
}: {
  bootstrap: boolean;
  onDone: (r: { token: string; user: User }) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = bootstrap
        ? await api('/auth/register', {
            method: 'POST',
            body: JSON.stringify({
              username,
              displayName: displayName || username,
              password,
              role: 'ADMIN',
            }),
          })
        : await api('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
          });
      onDone(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="circuit-bg grid min-h-dvh place-items-center px-4 text-ink">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-8 shadow-xl shadow-ink/5">
        <div className="text-center">
          <div className="mx-auto mb-3 w-fit">
            <BarnMark size={52} />
          </div>
          <h1 className="display text-3xl font-semibold">Circuit Barn</h1>
          <p className="mt-1 text-sm text-ink-2">
            {bootstrap ? 'First run — set up the admin account' : 'Your family’s private AI'}
          </p>
        </div>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          autoCapitalize="none"
          className="field"
        />
        {bootstrap && (
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name"
            className="field"
          />
        )}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="field"
        />
        {error && <p className="text-sm text-red">{error}</p>}
        <button disabled={busy} className="btn w-full">
          {busy ? '…' : bootstrap ? 'Create admin account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
