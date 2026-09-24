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

// what jellyfin keeps about one person and one item
export interface JellyfinUserData {
  PlaybackPositionTicks?: number;
  PlayedPercentage?: number;
  PlayCount?: number;
  Played?: boolean;
  LastPlayedDate?: string;
}

// the slice of jellyfin's item shape this app uses
interface JellyfinItem {
  Id: string;
  Name?: string;
  Type?: string;
  ProductionYear?: number;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  RunTimeTicks?: number;
  SeriesName?: string;
  MediaSources?: { Container?: string }[];
  ProviderIds?: { Tmdb?: string };
  Path?: string;
  SeriesId?: string;
  UserData?: JellyfinUserData;
  Genres?: string[];
  OfficialRating?: string;
  CommunityRating?: number;
  Overview?: string;
  People?: { Name?: string; Type?: string }[];
}

/** An item as one particular person sees it: what it is, and how far they
 * are through it. */
export interface PersonalItem {
  id: string;
  name: string;
  type: string;
  year?: number;
  runtimeTicks?: number;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  container?: string;
  positionTicks: number;
  playedPercentage?: number;
  played: boolean;
  playCount: number;
  lastPlayed?: string;
}

/** A film or show on the shelf, with what a recommendation needs to know
 * about it — and, when asked for one person, whether they have seen it. */
export interface LibraryEntry {
  id: string;
  name: string;
  type: 'Movie' | 'Series';
  year?: number;
  genres: string[];
  /** the audience rating, 0-10, when Jellyfin has one */
  rating?: number;
  /** the certificate: "PG-13", "TV-Y7", "R" */
  certificate?: string;
  /** a film's length, or a show's usual episode length */
  runtimeMinutes?: number;
  catalogId?: number;
  directors: string[];
  overview?: string;
  /** this person has finished it */
  played: boolean;
  /** this person is part way through it */
  started: boolean;
  lastPlayed?: string;
}

/** Jellyfin's own rules for when a position is worth keeping and when an
 * item counts as watched. Read from the server, never assumed. */
export interface ResumeRules {
  minResumePct: number;
  maxResumePct: number;
  minResumeDurationSeconds: number;
}

export interface LibraryItem {
  id: string;
  name: string;
  year?: number;
  catalogId?: number; // tmdb id jellyfin stored with the item
  type: 'Movie' | 'Series';
}

export interface PlayableItem {
  id: string;
  name: string;
  year?: number;
  type: string;
  container?: string;
  runtimeMinutes?: number;
  posterUrl?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

// the slice of a live session this app reads
interface TmdbSessionRaw {
  Id?: string;
  DeviceName?: string;
  Client?: string;
  SupportsRemoteControl?: boolean;
  NowPlayingItem?: { Name?: string };
}

interface RawSession {
  Id?: string;
  DeviceName?: string;
  DeviceId?: string;
  Client?: string;
  UserId?: string;
  UserName?: string;
  AdditionalUsers?: { UserId: string }[];
  SupportsRemoteControl?: boolean;
  NowPlayingItem?: { Id?: string; Name?: string };
  PlayState?: { PositionTicks?: number; IsPaused?: boolean };
}

export interface LiveSession {
  id: string;
  deviceName: string;
  deviceId: string;
  client: string;
  userId?: string;
  userName?: string;
  additionalUserIds: string[];
  remoteControl: boolean;
  nowPlayingId?: string;
  positionTicks?: number;
  paused: boolean;
}

export interface JellyfinSession {
  id: string;
  deviceName: string;
  client: string;
  nowPlaying?: string;
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

  /** What is on the shelf that matches what someone asked for. Films and
   * episodes, newest names first — this is "what can we watch", not "what
   * exists in the world". */
  async searchPlayable(query: string, limit = 12): Promise<PlayableItem[]> {
    const params = new URLSearchParams({
      searchTerm: query,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      Fields: 'MediaSources,ProductionYear,RunTimeTicks,SeriesName',
      EnableImages: 'true',
      Limit: String(limit),
    });
    let data = await this.call<{ Items?: JellyfinItem[] }>(`/Items?${params}`);
    if (!data) {
      const uid = await this.anyUserId();
      if (uid) {
        data = await this.call<{ Items?: JellyfinItem[] }>(
          `/Items?${params}&UserId=${uid}`,
        );
      }
    }
    return (data?.Items ?? []).map((i) => ({
      id: String(i.Id),
      name: String(i.Name ?? ''),
      year: i.ProductionYear ? Number(i.ProductionYear) : undefined,
      type: String(i.Type ?? 'Movie'),
      container: i.MediaSources?.[0]?.Container,
      runtimeMinutes: i.RunTimeTicks
        ? Math.round(Number(i.RunTimeTicks) / 600_000_000)
        : undefined,
      posterUrl: `/media/poster/${String(i.Id)}`,
      seriesName: i.SeriesName ? String(i.SeriesName) : undefined,
      seasonNumber: i.ParentIndexNumber ?? undefined,
      episodeNumber: i.IndexNumber ?? undefined,
    }));
  }

  /** Look up specific items — used when something is about to be played. */
  async itemsById(ids: string[]): Promise<PlayableItem[]> {
    if (!ids.length) return [];
    const params = new URLSearchParams({
      Ids: ids.join(','),
      Fields: 'MediaSources,ProductionYear,SeriesName',
      Recursive: 'true',
    });
    let data = await this.call<{ Items?: JellyfinItem[] }>(`/Items?${params}`);
    if (!data) {
      const uid = await this.anyUserId();
      if (uid) {
        data = await this.call<{ Items?: JellyfinItem[] }>(
          `/Items?${params}&UserId=${uid}`,
        );
      }
    }
    return (data?.Items ?? []).map((i) => ({
      id: String(i.Id),
      name: String(i.Name ?? ''),
      year: i.ProductionYear ? Number(i.ProductionYear) : undefined,
      type: String(i.Type ?? 'Movie'),
      container: i.MediaSources?.[0]?.Container,
      seriesName: i.SeriesName ? String(i.SeriesName) : undefined,
      seasonNumber: i.ParentIndexNumber ?? undefined,
      episodeNumber: i.IndexNumber ?? undefined,
    }));
  }

  /** Jellyfin apps that are open right now and will take a play command. */
  async sessions(): Promise<JellyfinSession[]> {
    const data = await this.call<TmdbSessionRaw[]>('/Sessions');
    return (data ?? [])
      .filter((s) => s.SupportsRemoteControl && s.DeviceName)
      .map((s) => ({
        id: String(s.Id),
        deviceName: String(s.DeviceName),
        client: String(s.Client ?? ''),
        nowPlaying: s.NowPlayingItem?.Name
          ? String(s.NowPlayingItem.Name)
          : undefined,
      }));
  }

  /** Tell an open Jellyfin app to start something. */
  async playOnSession(
    sessionId: string,
    itemId: string,
    startTicks = 0,
  ): Promise<boolean> {
    const start = startTicks > 0 ? `&startPositionTicks=${startTicks}` : '';
    const res = await this.call(
      `/Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemId}${start}`,
      { method: 'POST' },
    );
    return res !== null;
  }

  /** Every session, with who is signed in, who has been added, and what is
   * playing and where — including apps that cannot be remote controlled. */
  async liveSessions(): Promise<LiveSession[]> {
    const data = await this.call<RawSession[]>('/Sessions');
    return (data ?? []).map((s) => ({
      id: String(s.Id),
      deviceName: String(s.DeviceName ?? ''),
      deviceId: String(s.DeviceId ?? ''),
      client: String(s.Client ?? ''),
      userId: s.UserId ? String(s.UserId) : undefined,
      userName: s.UserName ? String(s.UserName) : undefined,
      additionalUserIds: (s.AdditionalUsers ?? []).map((u) => String(u.UserId)),
      remoteControl: !!s.SupportsRemoteControl,
      nowPlayingId: s.NowPlayingItem?.Id
        ? String(s.NowPlayingItem.Id)
        : undefined,
      positionTicks: s.PlayState?.PositionTicks ?? undefined,
      paused: !!s.PlayState?.IsPaused,
    }));
  }

  /** Add a person to a session, so what is watched there counts for them
   * too. Jellyfin's own mechanism for more than one person watching. */
  async addUserToSession(sessionId: string, userId: string): Promise<boolean> {
    const res = await this.call(`/Sessions/${sessionId}/User/${userId}`, {
      method: 'POST',
    });
    return res !== null;
  }

  async removeUserFromSession(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const res = await this.call(`/Sessions/${sessionId}/User/${userId}`, {
      method: 'DELETE',
    });
    return res !== null;
  }

  /** Pause / Unpause / Stop on an open app. */
  async command(sessionId: string, command: string): Promise<boolean> {
    const res = await this.call(`/Sessions/${sessionId}/Playing/${command}`, {
      method: 'POST',
    });
    return res !== null;
  }

  /**
   * Where the file actually is. The library is a folder on this server, so
   * the app can hand a TV the bytes itself rather than asking Jellyfin to
   * do it — one less service in the path, and nothing that breaks when
   * Jellyfin changes which of its urls it will answer.
   */
  async filePath(itemId: string): Promise<string | null> {
    const data = await this.call<{ Items?: JellyfinItem[] }>(
      `/Items?Ids=${itemId}&Fields=Path&Recursive=true`,
    );
    const path = data?.Items?.[0]?.Path;
    return path ? String(path) : null;
  }

  /**
   * Kept for anything that would rather Jellyfin served the file. Note that
   * a key in the query string is refused by current versions, and media
   * endpoints want a user context an API key does not carry.
   */
  async stream(
    itemId: string,
    range?: string,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: ReadableStream<Uint8Array> | null;
  } | null> {
    if (!this.configured()) return null;
    try {
      const res = await fetch(
        `${URL_BASE}/Videos/${itemId}/stream?static=true`,
        {
          headers: {
            Authorization: AUTH,
            ...(range ? { range } : {}),
          },
        },
      );
      if (!res.ok && res.status !== 206) {
        this.log.warn(`stream ${itemId} -> ${res.status}`);
        return null;
      }
      const pass: Record<string, string> = {};
      for (const h of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
      ]) {
        const v = res.headers.get(h);
        if (v) pass[h] = v;
      }
      if (!pass['accept-ranges']) pass['accept-ranges'] = 'bytes';
      return {
        status: res.status,
        headers: pass,
        body: res.body as ReadableStream<Uint8Array> | null,
      };
    } catch (e) {
      this.log.warn(`stream ${itemId} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Every episode of a series the house owns, by TMDB id. Returns null
   * when Jellyfin has no such series at all — which is different from having
   * the series with none of its episodes. */
  async ownedEpisodes(
    catalogId: number,
    title: string,
  ): Promise<{ itemId: string; episodes: LibraryEpisode[] } | null> {
    const series = await this.find('Series', catalogId, title);
    if (!series) return null;
    return { itemId: series.id, episodes: await this.episodes(series.id) };
  }

  /** The cover art for an item, fetched here so the key never leaves the
   * server and the browser never has to reach Jellyfin itself. */
  async image(
    itemId: string,
    maxHeight = 340,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!this.configured()) return null;
    try {
      const res = await fetch(
        `${URL_BASE}/Items/${itemId}/Images/Primary?maxHeight=${maxHeight}`,
        { headers: { Authorization: AUTH }, signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) return null;
      return {
        body: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') ?? 'image/jpeg',
      };
    } catch (e) {
      this.log.warn(`poster ${itemId} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Every film and show, with genres, certificate, rating and length —
   * and, given a person, whether they have seen each one. Never anyone
   * else's viewing: with no person, nothing is marked seen. */
  async libraryFor(userId: string | null): Promise<LibraryEntry[]> {
    const q = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
      Fields:
        'Genres,OfficialRating,CommunityRating,RunTimeTicks,ProductionYear,ProviderIds,Overview,People',
      EnableImages: 'false',
      Limit: '5000',
      ...(userId ? { userId, enableUserData: 'true' } : {}),
    });
    const data = await this.call<{ Items?: JellyfinItem[] }>(`/Items?${q}`);
    return (data?.Items ?? []).map((i) => {
      const d = userId ? (i.UserData ?? {}) : {};
      return {
        id: String(i.Id),
        name: String(i.Name ?? ''),
        type: i.Type === 'Series' ? ('Series' as const) : ('Movie' as const),
        year: i.ProductionYear ? Number(i.ProductionYear) : undefined,
        genres: (i.Genres ?? []).map(String),
        rating:
          typeof i.CommunityRating === 'number' ? i.CommunityRating : undefined,
        certificate: i.OfficialRating ? String(i.OfficialRating) : undefined,
        runtimeMinutes: i.RunTimeTicks
          ? Math.round(Number(i.RunTimeTicks) / 600_000_000)
          : undefined,
        catalogId: i.ProviderIds?.Tmdb ? Number(i.ProviderIds.Tmdb) : undefined,
        directors: (i.People ?? [])
          .filter((p) => p.Type === 'Director' && p.Name)
          .map((p) => String(p.Name))
          .slice(0, 3),
        overview: i.Overview ? String(i.Overview) : undefined,
        played: !!d.Played,
        started: !d.Played && Number(d.PlaybackPositionTicks ?? 0) > 0,
        lastPlayed: d.LastPlayedDate ? String(d.LastPlayedDate) : undefined,
      };
    });
  }

  // --------------------------------------------------------- per person

  private personal(i: JellyfinItem): PersonalItem {
    const d = i.UserData ?? {};
    return {
      id: String(i.Id),
      name: String(i.Name ?? ''),
      type: String(i.Type ?? ''),
      year: i.ProductionYear ? Number(i.ProductionYear) : undefined,
      runtimeTicks: i.RunTimeTicks ? Number(i.RunTimeTicks) : undefined,
      seriesId: i.SeriesId ? String(i.SeriesId) : undefined,
      seriesName: i.SeriesName ? String(i.SeriesName) : undefined,
      seasonNumber: i.ParentIndexNumber ?? undefined,
      episodeNumber: i.IndexNumber ?? undefined,
      container: i.MediaSources?.[0]?.Container,
      positionTicks: Number(d.PlaybackPositionTicks ?? 0),
      playedPercentage:
        d.PlayedPercentage != null ? Number(d.PlayedPercentage) : undefined,
      played: !!d.Played,
      playCount: Number(d.PlayCount ?? 0),
      lastPlayed: d.LastPlayedDate ? String(d.LastPlayedDate) : undefined,
    };
  }

  private static FIELDS =
    'UserData,RunTimeTicks,ProductionYear,SeriesName,MediaSources';

  /** Items as one person sees them. */
  async forPerson(userId: string, ids: string[]): Promise<PersonalItem[]> {
    if (!ids.length) return [];
    const q = new URLSearchParams({
      userId,
      Ids: ids.join(','),
      Recursive: 'true',
      Fields: JellyfinService.FIELDS,
    });
    const data = await this.call<{ Items?: JellyfinItem[] }>(`/Items?${q}`);
    return (data?.Items ?? []).map((i) => this.personal(i));
  }

  /** What this person has started and not finished, most recent first —
   * Jellyfin's own Continue Watching. */
  async resumeFor(
    userId: string,
    opts: {
      parentId?: string;
      type?: 'Movie' | 'Episode';
      limit?: number;
    } = {},
  ): Promise<PersonalItem[]> {
    const q = new URLSearchParams({
      userId,
      Fields: JellyfinService.FIELDS,
      enableUserData: 'true',
      limit: String(opts.limit ?? 20),
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.type ? { includeItemTypes: opts.type } : {}),
    });
    const data = await this.call<{ Items?: JellyfinItem[] }>(
      `/UserItems/Resume?${q}`,
    );
    return (data?.Items ?? []).map((i) => this.personal(i));
  }

  /** What Jellyfin says this person should watch next in a show. Null when
   * Jellyfin has no answer — which includes a show they have never begun. */
  async nextUpFor(
    userId: string,
    seriesId: string,
  ): Promise<PersonalItem | null> {
    const q = new URLSearchParams({
      userId,
      seriesId,
      Fields: JellyfinService.FIELDS,
      enableUserData: 'true',
      limit: '1',
    });
    const data = await this.call<{ Items?: JellyfinItem[] }>(
      `/Shows/NextUp?${q}`,
    );
    const first = data?.Items?.[0];
    return first ? this.personal(first) : null;
  }

  /** Every episode of a show, in order, as this person sees them — or,
   * with no person, with nobody's history at all. */
  async episodesFor(
    userId: string | null,
    seriesId: string,
  ): Promise<PersonalItem[]> {
    const q = new URLSearchParams({
      ...(userId ? { userId, enableUserData: 'true' } : {}),
      Fields: JellyfinService.FIELDS,
    });
    const data = await this.call<{ Items?: JellyfinItem[] }>(
      `/Shows/${seriesId}/Episodes?${q}`,
    );
    return (data?.Items ?? []).map((i) => this.personal(i));
  }

  /** What this person watched or started most recently, newest first. */
  async recentFor(userId: string, limit = 10): Promise<PersonalItem[]> {
    const q = new URLSearchParams({
      userId,
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Filters: 'IsPlayed',
      Fields: JellyfinService.FIELDS,
      Limit: String(limit),
    });
    const played = await this.call<{ Items?: JellyfinItem[] }>(`/Items?${q}`);
    const started = await this.resumeFor(userId, { limit });
    const all = [
      ...(played?.Items ?? []).map((i) => this.personal(i)),
      ...started,
    ];
    const seen = new Set<string>();
    return all
      .filter((i) => i.lastPlayed && !seen.has(i.id) && seen.add(i.id))
      .sort((a, b) => (b.lastPlayed ?? '').localeCompare(a.lastPlayed ?? ''))
      .slice(0, limit);
  }

  private rules: { at: number; value: ResumeRules } | null = null;

  /** Jellyfin's resume rules, cached for a few minutes. Falls back to
   * Jellyfin's own defaults only if the server cannot be asked. */
  async resumeRules(): Promise<ResumeRules> {
    if (this.rules && Date.now() - this.rules.at < 5 * 60_000) {
      return this.rules.value;
    }
    const c = await this.call<{
      MinResumePct?: number;
      MaxResumePct?: number;
      MinResumeDurationSeconds?: number;
    }>('/System/Configuration');
    const value: ResumeRules = {
      minResumePct: Number(c?.MinResumePct ?? 5),
      maxResumePct: Number(c?.MaxResumePct ?? 90),
      minResumeDurationSeconds: Number(c?.MinResumeDurationSeconds ?? 300),
    };
    if (c) this.rules = { at: Date.now(), value };
    return value;
  }

  /** Every Jellyfin account — for an admin choosing who is who. */
  async accounts(): Promise<{ id: string; name: string; admin: boolean }[]> {
    const users =
      await this.call<
        { Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }[]
      >('/Users');
    return (users ?? []).map((u) => ({
      id: String(u.Id),
      name: String(u.Name),
      admin: !!u.Policy?.IsAdministrator,
    }));
  }

  // ------------------------------------------- reporting, as the person

  /**
   * Tell Jellyfin how one person's playback is going, the way its own apps
   * do — so Jellyfin applies its own rules: a start counts a play, a
   * position under its resume threshold is dropped, one past the watched
   * threshold marks it watched.
   *
   * Jellyfin only credits the account a session is signed in as, so each
   * playback gets its own short sign-in as that person, approved by the
   * server through Quick Connect. The sign-in is held in memory only, never
   * stored or shown, and removed with endPlaybackSession. After a restart a
   * fresh one is made for the same device, which replaces the old.
   */
  async reportPlayback(
    p: { playbackId: string; jellyfinUserId: string; itemId: string },
    event: 'start' | 'progress' | 'stopped',
    positionSeconds: number,
    paused = false,
  ): Promise<boolean> {
    const path =
      event === 'start'
        ? '/Sessions/Playing'
        : event === 'progress'
          ? '/Sessions/Playing/Progress'
          : '/Sessions/Playing/Stopped';
    const body = JSON.stringify({
      ItemId: p.itemId,
      PositionTicks: Math.round(positionSeconds * 10_000_000),
      PlaySessionId: p.playbackId,
      IsPaused: paused,
      CanSeek: true,
      PlayMethod: 'DirectPlay',
    });
    // a sign-in that has gone stale is made again, once
    for (let attempt = 0; attempt < 2; attempt++) {
      const token =
        this.signIns.get(p.playbackId) ??
        (await this.signInAs(p.playbackId, p.jellyfinUserId));
      if (!token) return false;
      const res = await this.asDevice(p.playbackId, token, path, {
        method: 'POST',
        body,
      });
      if (res === 401) {
        this.signIns.delete(p.playbackId);
        continue;
      }
      return res !== null && res < 300;
    }
    return false;
  }

  /** Remove a playback's sign-in from Jellyfin, and so its session. */
  async endPlaybackSession(playbackId: string): Promise<boolean> {
    this.signIns.delete(playbackId);
    const res = await this.call(
      `/Devices?id=${encodeURIComponent(deviceFor(playbackId))}`,
      { method: 'DELETE' },
    );
    return res !== null;
  }

  private signIns = new Map<string, string>();

  private async signInAs(
    playbackId: string,
    jellyfinUserId: string,
  ): Promise<string | null> {
    if (!this.configured()) return null;
    const started = await this.asDeviceJson<{ Code?: string; Secret?: string }>(
      playbackId,
      null,
      '/QuickConnect/Initiate',
      { method: 'POST' },
    );
    if (!started?.Code || !started.Secret) {
      this.log.warn('Quick Connect would not start; is it turned on?');
      return null;
    }
    const approved = await this.call(
      `/QuickConnect/Authorize?code=${encodeURIComponent(started.Code)}` +
        `&userId=${encodeURIComponent(jellyfinUserId)}`,
      { method: 'POST' },
    );
    if (approved === null) return null;
    const login = await this.asDeviceJson<{
      AccessToken?: string;
      User?: { Id?: string };
    }>(playbackId, null, '/Users/AuthenticateWithQuickConnect', {
      method: 'POST',
      body: JSON.stringify({ Secret: started.Secret }),
    });
    // it must be the person asked for and nobody else
    if (!login?.AccessToken || !sameId(login.User?.Id, jellyfinUserId)) {
      await this.endPlaybackSession(playbackId);
      return null;
    }
    this.signIns.set(playbackId, login.AccessToken);
    return login.AccessToken;
  }

  /** A call as one playback's own device. Returns the status, or null if
   * Jellyfin could not be reached. */
  private async asDevice(
    playbackId: string,
    token: string | null,
    path: string,
    init: RequestInit,
  ): Promise<number | null> {
    try {
      const res = await fetch(URL_BASE + path, {
        ...init,
        headers: {
          Authorization: deviceAuth(playbackId, token),
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(12000),
      });
      await res.text().catch(() => '');
      return res.status;
    } catch (e) {
      this.log.warn(`${path} failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async asDeviceJson<T>(
    playbackId: string,
    token: string | null,
    path: string,
    init: RequestInit,
  ): Promise<T | null> {
    try {
      const res = await fetch(URL_BASE + path, {
        ...init,
        headers: {
          Authorization: deviceAuth(playbackId, token),
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        this.log.warn(`${path} -> ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      this.log.warn(`${path} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Ask Jellyfin to rescan, so something just imported shows up. */
  async refreshLibrary(): Promise<void> {
    this.cache = { at: 0, items: [] };
    await this.call('/Library/Refresh', { method: 'POST' });
  }
}

// each playback is its own device in Jellyfin, so its sign-in and session
// can be told apart from every other and removed on their own
function deviceFor(playbackId: string): string {
  return `circuit-barn-${playbackId}`;
}

function deviceAuth(playbackId: string, token: string | null): string {
  return (
    'MediaBrowser ' +
    (token ? `Token="${token}", ` : '') +
    `Client="Circuit Barn", Device="Circuit Barn", ` +
    `DeviceId="${deviceFor(playbackId)}", Version="1.0"`
  );
}

// jellyfin writes ids with and without dashes depending on where they came from
function sameId(a: string | undefined, b: string): boolean {
  const norm = (x: string) => x.replace(/-/g, '').toLowerCase();
  return !!a && norm(a) === norm(b);
}
