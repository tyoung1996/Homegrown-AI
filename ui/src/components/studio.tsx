'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BarnMark } from '@/components/logo';

type Photo = { id: string; imagePath: string };
type Person = {
  id: string;
  name: string;
  description: string | null;
  imagePath: string;
  createdBy: string;
  photos: Photo[];
};
type GalleryItem = { id: string; prompt: string; url: string; createdAt: string };

const STYLES = [
  { key: 'photo', label: 'Photo', swatch: '#8f8578', hint: 'looks like a real photograph' },
  { key: 'fantasy', label: 'Fantasy', swatch: '#b8912f', hint: 'epic, cinematic, painterly' },
  { key: 'ghibli', label: 'Ghibli', swatch: '#6f7f63', hint: 'hand-painted anime' },
  { key: 'pixar', label: 'Pixar', swatch: '#4f7fa8', hint: '3D animated movie' },
  { key: 'watercolor', label: 'Watercolor', swatch: '#8a6fa8', hint: 'soft washes of color' },
  { key: 'comic', label: 'Comic', swatch: '#b3402f', hint: 'bold inks and halftones' },
];

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

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function Studio({
  token,
  meId,
  isAdmin,
}: {
  token: string;
  meId: string;
  isAdmin: boolean;
}) {
  const [people, setPeople] = useState<Person[]>([]);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [personId, setPersonId] = useState<string | null>(null);
  const [style, setStyle] = useState('photo');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{ prompt: string; personId: string | null; style: string; quality: string } | null>(null);
  const [error, setError] = useState('');
  const [addingPerson, setAddingPerson] = useState(false);
  const [managing, setManaging] = useState<Person | null>(null);
  const [newName, setNewName] = useState('');
  const [newPhoto, setNewPhoto] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    api('/studio/people', {}, token)
      .then((ps: Person[]) => {
        setPeople(ps);
        setManaging((m) => (m ? ps.find((p) => p.id === m.id) ?? null : null));
      })
      .catch(() => {});
    api('/studio/gallery', {}, token).then(setGallery).catch(() => {});
  }, [token]);

  useEffect(refresh, [refresh]);

  const selected = people.find((p) => p.id === personId) ?? null;
  const styleInfo = STYLES.find((s) => s.key === style) ?? STYLES[0];

  async function savePerson(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim() || !newPhoto) return;
    setError('');
    setSaving(true);
    try {
      const p = await api(
        '/studio/people',
        { method: 'POST', body: JSON.stringify({ name: newName.trim(), imageData: newPhoto }) },
        token,
      );
      setAddingPerson(false);
      setNewName('');
      setNewPhoto(null);
      setPersonId(p.id);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function addPhotos(person: Person, files: FileList | null) {
    if (!files) return;
    setError('');
    try {
      for (const f of Array.from(files).slice(0, 5)) {
        if (!f.type.startsWith('image/')) continue;
        await api(
          `/studio/people/${person.id}/photos`,
          { method: 'POST', body: JSON.stringify({ imageData: await readFile(f) }) },
          token,
        );
      }
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function removePhoto(photo: Photo) {
    try {
      await api(`/studio/photos/${photo.id}`, { method: 'DELETE' }, token);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function removePerson(p: Person) {
    if (!confirm(`Remove ${p.name} from the Studio?`)) return;
    try {
      await api(`/studio/people/${p.id}`, { method: 'DELETE' }, token);
      if (personId === p.id) setPersonId(null);
      setManaging(null);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function generate(quality: 'fast' | 'best', overrides?: { prompt: string; personId: string | null; style: string }) {
    const p = (overrides?.prompt ?? prompt).trim();
    const who = overrides ? overrides.personId : personId;
    const st = overrides?.style ?? style;
    if (!p || busy) return;
    setBusy(true);
    setError('');
    setStage(quality === 'best' ? 'Starting the high-quality pass' : 'Starting');
    try {
      const res = await fetch(`${apiBase()}/studio/generate/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: p, personId: who ?? undefined, style: st, quality }),
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
          if (ev.type === 'stage') setStage(ev.text);
          else if (ev.type === 'image') {
            setResult(`${apiBase()}${ev.url}`);
            setLastRun({ prompt: p, personId: who, style: st, quality });
          } else if (ev.type === 'error') throw new Error(ev.message);
        }
      }
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      setStage('');
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <div className="mb-6 border-b border-line pb-4">
          <h1 className="display text-3xl font-semibold">Studio</h1>
          <p className="text-sm text-ink-2">Put anyone, anywhere. Rendered right here at home.</p>
        </div>

        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <div className="space-y-6">
            <section>
              <p className="eyebrow mb-2">Who</p>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => setPersonId(null)}
                  className={`flex w-16 flex-col items-center gap-1.5 ${personId === null ? '' : 'opacity-50 hover:opacity-90'}`}
                >
                  <span
                    className={`grid size-14 place-items-center rounded-full border-2 border-dashed text-[10px] font-bold uppercase tracking-wider ${
                      personId === null ? 'border-red bg-red-soft text-red' : 'border-line-2 text-muted'
                    }`}
                  >
                    scene
                  </span>
                  <span className="text-[11px] text-ink-2">Just a scene</span>
                </button>
                {people.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => (personId === p.id ? setManaging(p) : setPersonId(p.id))}
                    title={personId === p.id ? 'Manage photos' : `Use ${p.name}`}
                    className={`flex w-16 flex-col items-center gap-1.5 ${personId === p.id ? '' : 'opacity-50 hover:opacity-90'}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${apiBase()}/images/${p.imagePath}`}
                      alt={p.name}
                      className={`size-14 rounded-full border-2 object-cover ${personId === p.id ? 'border-red' : 'border-line-2'}`}
                    />
                    <span className="max-w-16 truncate text-[11px] text-ink">{p.name}</span>
                    {personId === p.id && (
                      <span className="text-[10px] text-muted">
                        {p.photos.length} photo{p.photos.length === 1 ? '' : 's'} · edit
                      </span>
                    )}
                  </button>
                ))}
                <button
                  onClick={() => setAddingPerson(true)}
                  className="flex w-16 flex-col items-center gap-1.5 opacity-60 hover:opacity-100"
                >
                  <span className="grid size-14 place-items-center rounded-full border-2 border-dashed border-line-2 text-xl text-muted">
                    +
                  </span>
                  <span className="text-[11px] text-muted">Add someone</span>
                </button>
              </div>
            </section>

            <section>
              <p className="eyebrow mb-2">Style</p>
              <div className="flex flex-wrap gap-2">
                {STYLES.map((s) => (
                  <button key={s.key} onClick={() => setStyle(s.key)} className={`chip ${style === s.key ? 'on' : ''}`}>
                    <span className="size-2.5 rounded-full" style={{ background: s.swatch }} />
                    {s.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted">{styleInfo.hint}</p>
            </section>

            <section>
              <p className="eyebrow mb-2">What&apos;s happening</p>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    generate('fast');
                  }
                }}
                rows={3}
                placeholder={selected ? 'riding a dragon over a castle at sunset…' : 'a cozy cabin in a snowy forest at night…'}
                className="field resize-none"
              />
              <button onClick={() => generate('fast')} disabled={busy || !prompt.trim()} className="btn mt-2 w-full">
                {busy ? 'Working…' : 'Create'}
              </button>
              <p className="mt-1.5 text-xs text-muted">
                A quick draft in about a minute. Hit Enhance on the result for the full-quality version.
              </p>
              {error && <p className="mt-2 text-sm text-red">{error}</p>}
            </section>
          </div>

          <div>
            <div className="card relative aspect-square w-full overflow-hidden">
              {result && !busy && (
                <a href={result} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={result} alt="result" className="msg-in size-full object-cover" />
                </a>
              )}
              {busy && (
                <div className="absolute inset-0 grid place-items-center bg-paper">
                  <div className="flex flex-col items-center gap-3">
                    <div className="animate-pulse">
                      <BarnMark size={56} />
                    </div>
                    <p className="text-sm text-ink">{stage}…</p>
                    <div className="h-1 w-40 overflow-hidden rounded-full bg-line">
                      <div className="h-full w-1/3 animate-[shimmer_1.4s_ease-in-out_infinite] rounded-full bg-red" />
                    </div>
                  </div>
                </div>
              )}
              {!result && !busy && (
                <div className="absolute inset-0 grid place-items-center">
                  <div className="text-center opacity-50">
                    <BarnMark size={48} />
                    <p className="mt-3 text-sm text-ink-2">Your picture shows up here</p>
                  </div>
                </div>
              )}
            </div>
            {result && !busy && lastRun && (
              <div className="mt-3 flex items-center gap-2">
                {lastRun.quality === 'fast' ? (
                  <button onClick={() => generate('best', lastRun)} className="btn">
                    Enhance
                  </button>
                ) : (
                  <span className="badge badge-adult">HIGH QUALITY</span>
                )}
                <button onClick={() => generate('fast', lastRun)} className="btn-ghost">
                  Another take
                </button>
                <span className="text-xs text-muted">
                  {lastRun.quality === 'fast' ? 'Enhance takes about 2 minutes' : ''}
                </span>
              </div>
            )}
          </div>
        </div>

        {gallery.length > 0 && (
          <section className="mt-10">
            <p className="eyebrow mb-3">Recent creations</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {gallery.map((g) => (
                <a
                  key={g.id}
                  href={`${apiBase()}${g.url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="group relative aspect-square overflow-hidden rounded-md border border-line"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${apiBase()}${g.url}`}
                    alt={g.prompt}
                    className="size-full object-cover transition duration-300 group-hover:scale-105"
                  />
                  <div className="absolute inset-x-0 bottom-0 translate-y-full bg-ink/85 p-2.5 text-[11px] leading-snug text-paper transition group-hover:translate-y-0">
                    {g.prompt.split(',')[0]}
                  </div>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>

      {addingPerson && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/30 p-4">
          <form onSubmit={savePerson} className="card w-full max-w-sm space-y-3 p-6 shadow-xl shadow-ink/10">
            <h2 className="display text-xl font-semibold">Add someone</h2>
            <p className="text-xs text-ink-2">
              Start with one clear, front-facing photo. You can add more angles after — more photos, better likeness.
            </p>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className="field"
            />
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f && f.type.startsWith('image/')) setNewPhoto(await readFile(f));
                e.target.value = '';
              }}
            />
            <button type="button" onClick={() => fileRef.current?.click()} className="btn-ghost w-full border-dashed">
              {newPhoto ? 'Change photo' : 'Choose a photo'}
            </button>
            {newPhoto && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={newPhoto} alt="preview" className="mx-auto size-24 rounded-full border-2 border-red object-cover" />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setAddingPerson(false);
                  setNewPhoto(null);
                  setNewName('');
                }}
                className="btn-ghost flex-1"
              >
                Cancel
              </button>
              <button disabled={saving || !newName.trim() || !newPhoto} className="btn flex-1">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}

      {managing && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-ink/30 p-4">
          <div className="card w-full max-w-md space-y-4 p-6 shadow-xl shadow-ink/10">
            <div className="flex items-center justify-between">
              <h2 className="display text-xl font-semibold">{managing.name}</h2>
              <button onClick={() => setManaging(null)} className="text-muted hover:text-ink">✕</button>
            </div>
            {managing.description && (
              <p className="text-xs text-ink-2">
                How the AI sees them: <span className="italic">{managing.description}</span>
              </p>
            )}
            <div>
              <p className="eyebrow mb-2">Reference photos ({managing.photos.length}/5)</p>
              <div className="flex flex-wrap gap-2">
                {managing.photos.map((ph) => (
                  <div key={ph.id} className="group relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${apiBase()}/images/${ph.imagePath}`}
                      alt=""
                      className="size-20 rounded-md border border-line-2 object-cover"
                    />
                    {(managing.createdBy === meId || isAdmin) && managing.photos.length > 1 && (
                      <button
                        onClick={() => removePhoto(ph)}
                        className="absolute -right-1 -top-1 hidden size-5 place-items-center rounded-full border border-line-2 bg-card text-[10px] text-ink-2 hover:text-red group-hover:grid"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {(managing.createdBy === meId || isAdmin) && managing.photos.length < 5 && (
                  <>
                    <input
                      ref={moreRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        addPhotos(managing, e.target.files);
                        e.target.value = '';
                      }}
                    />
                    <button
                      onClick={() => moreRef.current?.click()}
                      className="grid size-20 place-items-center rounded-md border-2 border-dashed border-line-2 text-xl text-muted hover:border-red hover:text-red"
                    >
                      +
                    </button>
                  </>
                )}
              </div>
              <p className="mt-2 text-xs text-muted">
                Best set: straight-on, a smile, three-quarter left and right, different lighting.
              </p>
            </div>
            {(managing.createdBy === meId || isAdmin) && (
              <button onClick={() => removePerson(managing)} className="text-xs text-muted hover:text-red">
                Remove {managing.name} from the Studio
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
