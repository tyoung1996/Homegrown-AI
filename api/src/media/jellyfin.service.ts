import { Injectable, Logger } from '@nestjs/common';
import { normalizeTitle } from './filename';

// talks to the jellyfin server that actually holds the library and drives the
// tvs. the api key stays here; the browser never sees it.
const URL_BASE = (process.env.JELLYFIN_URL ?? 'http://127.0.0.1:8096').replace(
  /\/+$/,
  '',
);
const KEY = process.env.JELLYFIN_API_KEY ?? '';
// newer jellyfin builds only accept the key in this header; the old
// X-Emby-Token one is refused outright
const AUTH =
  `MediaBrowser Token="${KEY}", Client="Circuit Barn", ` +
  'Device="server", DeviceId="circuit-barn", Version="1.0"';

// the slice of jellyfin's item shape this app uses
interface JellyfinItem {
  Id: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProviderIds?: { Tmdb?: string };
}

export interface LibraryItem {
  id: string;
  name: string;
  year?: number;
  catalogId?: number; // tmdb id jellyfin stored with the item
  type: 'Movie' | 'Series';
}

export interface LibraryEpisode {
  id: string;
  seriesId: string;
  seasonNumber?: number;
  episodeNumber?: number;
  name: string;
}

@Injectable()
export class JellyfinService {
  private log = new Logger('Jellyfin');
  private userId: string | null = null;
  private cache: { at: number; items: LibraryItem[] } = { at: 0, items: [] };

  configured(): boolean {
    return KEY.trim().length > 0;
  }

  private async call<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T | null> {
    if (!this.configured()) return null;
    try {
      const res = await fetch(URL_BASE + path, {
        ...init,
        headers: {
          Authorization: AUTH,
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        this.log.warn(`${path} -> ${res.status}`);
        return null;
      }
      if (res.status === 204) return {} as T;
      const text = await res.text();
      return text ? (JSON.parse(text) as T) : ({} as T);
    } catch (e) {
      this.log.warn(`${path} failed: ${(e as Error).message}`);
      return null;
    }
  }

  async health() {
    if (!this.configured()) {
      return { configured: false, ok: false, detail: 'No Jellyfin key set' };
    }
    const info = await this.call<{ ServerName?: string; Version?: string }>(
      '/System/Info',
    );
    return info
      ? {
          configured: true,
          ok: true,
          name: info.ServerName,
          version: info.Version,
        }
      : { configured: true, ok: false, detail: 'Jellyfin is not answering' };
  }

  // some deployments want a user id on /Items; look one up once and reuse it
  private async anyUserId(): Promise<string | null> {
    if (this.userId) return this.userId;
    const users = await this.call<{ Id?: string }[]>('/Users');
    this.userId = users?.[0]?.Id ?? null;
    return this.userId;
  }

  /** Everything on the shelves, cached briefly — the list is small and the
   * same request usually checks several titles in a row. */
  async items(force = false): Promise<LibraryItem[]> {
    if (!force && Date.now() - this.cache.at < 60_000) return this.cache.items;
    const query =
      '?Recursive=true&IncludeItemTypes=Movie,Series&Fields=ProviderIds,ProductionYear&EnableImages=false&Limit=5000';
    let data = await this.call<{ Items?: JellyfinItem[] }>('/Items' + query);
    if (!data) {
      const uid = await this.anyUserId();
      if (uid) {
        data = await this.call<{ Items?: JellyfinItem[] }>(
          `/Items${query}&UserId=${uid}`,
        );
      }
    }
    if (!data) return this.cache.items;
    const items: LibraryItem[] = (data.Items ?? []).map((i) => ({
      id: String(i.Id),
      name: String(i.Name ?? ''),
      year: i.ProductionYear ? Number(i.ProductionYear) : undefined,
      catalogId: i.ProviderIds?.Tmdb ? Number(i.ProviderIds.Tmdb) : undefined,
      type: i.Type === 'Series' ? 'Series' : 'Movie',
    }));
    this.cache = { at: Date.now(), items };
    return items;
  }

  /** Is this film or show already on the shelf? Matches on the catalogue id
   * first, then falls back to title (and year, for films). */
  async find(
    type: 'Movie' | 'Series',
    catalogId: number,
    title: string,
    year?: number,
  ): Promise<LibraryItem | null> {
    const items = await this.items();
    const mine = items.filter((i) => i.type === type);
    const byId = mine.find((i) => i.catalogId && i.catalogId === catalogId);
    if (byId) return byId;
    const want = normalizeTitle(title);
    return (
      mine.find(
        (i) =>
          normalizeTitle(i.name) === want &&
          (type === 'Series' || !year || !i.year || i.year === year),
      ) ?? null
    );
  }

  async episodes(seriesItemId: string): Promise<LibraryEpisode[]> {
    const data = await this.call<{ Items?: JellyfinItem[] }>(
      `/Shows/${seriesItemId}/Episodes?Fields=ProviderIds&EnableImages=false`,
    );
    return (data?.Items ?? []).map((e) => ({
      id: String(e.Id),
      seriesId: seriesItemId,
      seasonNumber: e.ParentIndexNumber ?? undefined,
      episodeNumber: e.IndexNumber ?? undefined,
      name: String(e.Name ?? ''),
    }));
  }

  /** Ask Jellyfin to rescan, so something just imported shows up. */
  async refreshLibrary(): Promise<void> {
    this.cache = { at: 0, items: [] };
    await this.call('/Library/Refresh', { method: 'POST' });
  }
}
