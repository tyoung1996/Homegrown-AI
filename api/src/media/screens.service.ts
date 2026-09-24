import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import { randomBytes } from 'crypto';
import * as os from 'os';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import { JellyfinService } from './jellyfin.service';
import { streamToken } from './stream-token';

/**
 * The TVs in the house, and putting something on one of them.
 *
 * Three kinds of screen, in the order they are preferred:
 *  - a Jellyfin app that is already open somewhere (best: it resumes, has
 *    subtitles, and the server can transcode for it)
 *  - a Chromecast-style TV (Google TV, Chromecast): wakes from standby and
 *    plays the file straight from Jellyfin
 *  - a Roku: wakes, then hands the file to its built-in player
 *
 * Nothing has to be configured — the house is scanned for TVs and they are
 * listed by the name they already have on the network.
 */

const CAST_PORT = 8009;
const ROKU_PORT = 8060;
// where a TV that speaks UPnP keeps its renderer. Samsung sets advertise cast
// as well, but their cast is for their own apps and ignores anything else —
// this is the door that actually opens on them.
const DLNA_PORT = 9197;
const AV_TRANSPORT = 'urn:schemas-upnp-org:service:AVTransport:1';
const SCAN_CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 400;
const CAST_LAUNCH_TIMEOUT_MS = 15_000;
// "Play on Roku", the hidden channel the Roku phone app pushes a url to. It
// takes a url straight from a launch, but it is not in the channel store, so
// a TV either has it or never will. The Roku Media Player channel that IS in
// the store (id 2213) ignores a url handed to it this way.
const ROKU_URL_PLAYER = '15985';
// a Roku takes a moment to come out of standby before it will take a launch
const ROKU_WAKE_MS = 2500;

export type ScreenKind = 'session' | 'cast' | 'roku' | 'dlna';

/**
 * Can a TV of this kind start part way through? Only what has been proven
 * on real hardware is claimed:
 *   cast     yes — started at 600s and read back 600s on a Google TV, and
 *            an MKV episode picked up at its saved point. The picture of
 *            that episode was confirmed; its sound (5.1 AC3) has not been
 *            heard yet — the receiver reports no audio tracks for any file,
 *            so only a person in the room can confirm it
 *   dlna     no  — a Samsung refused every seek mode on our stream
 *   roku     no  — a deep link carries the item and nothing else
 *   session  unverified — Jellyfin delivers the start position to the app
 *            intact, but no real app has been seen to honour it yet
 */
export const STARTS_PART_WAY: Record<ScreenKind, 'yes' | 'no' | 'unverified'> =
  {
    cast: 'yes',
    dlna: 'no',
    roku: 'no',
    session: 'unverified',
  };

export interface Screen {
  id: string; // what the ui and the assistant pass back
  name: string; // what the family calls it: "Front room"
  deviceName?: string; // what the TV calls itself, when that differs
  kind: ScreenKind;
  address?: string; // ip, for the ones we wake ourselves
  control?: string; // upnp control path, for the dlna ones
  ready: boolean; // true when something is already open on it
  nowPlaying?: string;
}

/**
 * A TV names itself something like "55\" Roku TV", which tells the family
 * nothing about which room it is in. SCREEN_NAMES in the env maps the
 * device's own name onto the one the house uses:
 *
 *   SCREEN_NAMES=Bedroom 2=Nursery; 55 Roku TV=Front room
 *
 * Pairs separated by semicolons or newlines, or a JSON object if you prefer.
 * Names are matched loosely — punctuation and a trailing "TV" are ignored —
 * so you can leave the inch marks out, which saves fighting with the way
 * systemd rewrites quotes and backslashes in an EnvironmentFile.
 *
 * Renaming the TVs themselves works too, and shows up everywhere rather than
 * just here — this is for the ones you would rather not go and find the
 * remote for.
 */
/**
 * Screens to leave off the list entirely. Some things answer on the cast port
 * without being any use as a TV — speakers, and TVs whose built-in cast is
 * there for their own apps and quietly ignores anything else. SCREEN_IGNORE
 * is a semicolon-separated list of their names.
 */
function loadIgnored(): Set<string> {
  const raw = process.env.SCREEN_IGNORE?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[;\n]/)
      .map((n) => normalize(n))
      .filter(Boolean),
  );
}

function loadNames(): Map<string, string> {
  const raw = process.env.SCREEN_NAMES?.trim();
  const map = new Map<string, string>();
  if (!raw) return map;

  const add = (from: string, to: string) => {
    if (from.trim() && to.trim()) map.set(normalize(from), to.trim());
  };

  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [from, to] of Object.entries(parsed)) {
        if (typeof to === 'string') add(from, to);
      }
      return map;
    } catch {
      // fall through: it is probably the plain form with the quotes eaten
    }
  }

  for (const pair of raw.split(/[;\n]/)) {
    const at = pair.indexOf('=');
    if (at > 0) add(pair.slice(0, at), pair.slice(at + 1));
  }
  if (!map.size) {
    // a broken map must never take the TVs away with it
    new Logger('Screens').warn(
      'SCREEN_NAMES could not be read — expected "Device name=Room name" ' +
        'pairs separated by semicolons. The TVs keep their own names.',
    );
  }
  return map;
}

@Injectable()
export class ScreensService {
  private log = new Logger('Screens');
  private scan: { at: number; found: Screen[] } = { at: 0, found: [] };
  // two people asking at once must not each start their own subnet sweep
  private scanning: Promise<Screen[]> | null = null;
  // what we last started on each screen. Jellyfin knows what its own apps are
  // playing; for a Chromecast or Roku we only know because we put it there.
  private started = new Map<string, { title: string; at: number }>();
  // one play at a time per screen, so two requests for the same TV queue
  private busy = new Map<string, Promise<void>>();
  // the playback this app last started on each screen, by its own id
  private playbacks = new Map<string, StartedPlayback>();
  private names = loadNames();
  private ignored = loadIgnored();

  constructor(private jellyfin: JellyfinService) {}

  /**
   * The address a TV can reach this app on — never 127.0.0.1, since the
   * request comes from the TV. A tunnel address is no good to a TV in the
   * living room either, so anything that is not a private LAN address is
   * passed over.
   */
  serverAddress(): string {
    const configured = process.env.PUBLIC_API_URL;
    if (configured) return configured.replace(/\/+$/, '');
    const port = process.env.PORT ?? '3001';
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net_ of list ?? []) {
        if (net_.family === 'IPv4' && !net_.internal && isLan(net_.address)) {
          return `http://${net_.address}:${port}`;
        }
      }
    }
    return `http://127.0.0.1:${port}`;
  }

  /** The link a TV is given for a film: our own address, signed, so the
   * Jellyfin key stays on the server. */
  private filmUrl(itemId: string, playbackId: string): string {
    return (
      `${this.serverAddress()}/api/media/stream/${itemId}` +
      `?t=${streamToken(itemId)}&pb=${playbackId}`
    );
  }

  /** The playback this app last started on a screen: which item, and the
   * id that was put in its link. A tracker compares what the TV reports
   * against this, and only against this. */
  startedOn(screen: Screen): StartedPlayback | undefined {
    return this.playbacks.get(screen.id);
  }

  private open(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  private async name(url: string, pick: (body: string) => string | null) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (!res.ok) return null;
      return pick(await res.text());
    } catch {
      return null;
    }
  }

  /** Look around the local network for TVs. Cached — the house does not
   * change between one question and the next. */
  private async discover(force = false): Promise<Screen[]> {
    if (!force && Date.now() - this.scan.at < SCAN_CACHE_MS) {
      return this.scan.found;
    }
    if (this.scanning) return this.scanning;
    this.scanning = this.sweep();
    try {
      return await this.scanning;
    } finally {
      this.scanning = null;
    }
  }

  private async sweep(): Promise<Screen[]> {
    const base = this.subnet();
    if (!base) return [];
    const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    const found: Screen[] = [];

    await Promise.all(
      hosts.map(async (ip) => {
        const [isCast, isRoku, isDlna] = await Promise.all([
          this.open(ip, CAST_PORT),
          this.open(ip, ROKU_PORT),
          this.open(ip, DLNA_PORT),
        ]);
        if (isRoku) {
          const name = await this.name(
            `http://${ip}:${ROKU_PORT}/query/device-info`,
            (b) => {
              const tv = /<is-tv>true<\/is-tv>/.test(b);
              const m =
                /<friendly-device-name>(.*?)<\/friendly-device-name>/.exec(b);
              return tv || m ? (m?.[1] ?? 'Roku') : null;
            },
          );
          if (name)
            found.push({
              id: `roku:${ip}`,
              name,
              kind: 'roku',
              address: ip,
              ready: false,
            });
        } else if (isDlna) {
          // preferred over cast on a set that offers both: a TV advertising
          // a renderer will take a film, where its own cast may not
          const found_ = await this.dlnaRenderer(ip);
          if (found_) found.push(found_);
        } else if (isCast) {
          const name = await this.name(
            `http://${ip}:8008/setup/eureka_info?params=name`,
            (b) => {
              try {
                return (JSON.parse(b) as { name?: string }).name ?? null;
              } catch {
                return null;
              }
            },
          );
          if (name)
            found.push({
              id: `cast:${ip}`,
              name,
              kind: 'cast',
              address: ip,
              ready: false,
            });
        }
      }),
    );

    found.sort((a, b) => a.name.localeCompare(b.name));
    this.scan = { at: Date.now(), found };
    this.log.log(
      `found ${found.length} tv(s): ${found.map((f) => f.name).join(', ')}`,
    );
    return found;
  }

  /** Read a UPnP renderer's description: what it calls itself, and where to
   * send it a film. */
  private async dlnaRenderer(ip: string): Promise<Screen | null> {
    try {
      const res = await fetch(`http://${ip}:${DLNA_PORT}/dmr`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const body = await res.text();
      const name = /<friendlyName>(.*?)<\/friendlyName>/.exec(body)?.[1];
      // the control path sits after the AVTransport service it belongs to
      const after = body.slice(body.indexOf(AV_TRANSPORT));
      const control = /<controlURL>(.*?)<\/controlURL>/.exec(after)?.[1];
      if (!name || !control) return null;
      return {
        id: `dlna:${ip}`,
        name: decodeXml(name),
        kind: 'dlna',
        address: ip,
        control,
        ready: false,
      };
    } catch {
      return null;
    }
  }

  private subnet(): string | null {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list ?? []) {
        if (n.family === 'IPv4' && !n.internal) {
          return n.address.split('.').slice(0, 3).join('.');
        }
      }
    }
    return null;
  }

  /** Everything something could be played on right now. A TV with the
   * Jellyfin app open is listed once, as that session. */
  async list(force = false): Promise<Screen[]> {
    const [sessions, tvs] = await Promise.all([
      this.jellyfin.sessions(),
      this.discover(force),
    ]);
    const live: Screen[] = sessions.map((s) => ({
      id: `session:${s.id}`,
      name: s.deviceName,
      kind: 'session' as const,
      ready: true,
      nowPlaying: s.nowPlaying,
    }));
    const seen = new Set(live.map((s) => normalize(s.name)));
    const rest = tvs
      .filter((t) => !seen.has(normalize(t.name)))
      .map((t) => {
        const mine = this.started.get(t.id);
        // a stale note is worse than none — assume nothing runs past 4 hours
        if (!mine || Date.now() - mine.at > 4 * 60 * 60_000) return t;
        return { ...t, ready: true, nowPlaying: mine.title };
      });
    return [...live, ...rest]
      .filter((s) => !this.ignored.has(normalize(s.name)))
      .map((s) => this.rename(s));
  }

  /** Give a screen the name the house uses for it, keeping the device's own
   * name so the name printed on the TV still finds it. */
  private rename(screen: Screen): Screen {
    const friendly = this.names.get(normalize(screen.name));
    if (!friendly || friendly === screen.name) return screen;
    return { ...screen, name: friendly, deviceName: screen.name };
  }

  async find(id: string): Promise<Screen | null> {
    const all = await this.list();
    const want = normalize(id);
    return (
      all.find((s) => s.id === id) ??
      all.find((s) => normalize(s.name) === want) ??
      // someone may still call it by the name on the TV itself
      all.find((s) => s.deviceName && normalize(s.deviceName) === want) ??
      null
    );
  }

  /** Put something on a screen. Returns the line to tell the family. */
  async play(
    screen: Screen,
    item: { id: string; name: string; container?: string; type?: string },
    startSeconds = 0,
    playbackId?: string,
  ): Promise<string> {
    // one TV can only show one thing: if two people ask for the same screen
    // at once, make them queue rather than half-starting both
    const ahead = this.busy.get(screen.id);
    if (ahead) await ahead.catch(() => undefined);
    const run = this.start(
      screen,
      item,
      Math.max(0, Math.floor(startSeconds)),
      playbackId,
    );
    const slot = run.then(
      () => undefined,
      () => undefined,
    );
    this.busy.set(screen.id, slot);
    try {
      const line = await run;
      this.started.set(screen.id, { title: item.name, at: Date.now() });
      return line;
    } finally {
      // leave it alone if someone has already queued behind us
      if (this.busy.get(screen.id) === slot) this.busy.delete(screen.id);
    }
  }

  private async start(
    screen: Screen,
    item: { id: string; name: string; container?: string; type?: string },
    startSeconds: number,
    given?: string,
  ): Promise<string> {
    // what it interrupts, so the reply can say so
    const before =
      screen.nowPlaying && normalize(screen.nowPlaying) !== normalize(item.name)
        ? ` (it was playing ${screen.nowPlaying})`
        : '';

    if (screen.kind === 'session') {
      const sessionId = screen.id.slice('session:'.length);
      const ok = await this.jellyfin.playOnSession(
        sessionId,
        item.id,
        startSeconds * 10_000_000,
      );
      if (!ok) throw new Error(`${screen.name} did not take the request`);
      return `Playing ${item.name} on ${screen.name}${before}`;
    }

    // every start gets its own id, carried in the link the TV plays, so
    // the TV reports back not just which film but which playback — the same
    // film started twice is two different playbacks
    // the caller may have chosen it already, so it could be written down
    // before the TV was told anything
    const playbackId =
      given && /^[a-f0-9]{16}$/.test(given) ? given : newPlaybackId();
    const url = this.filmUrl(item.id, playbackId);
    if (screen.kind === 'roku') {
      // a deep link carries the item and nothing else; where it starts is
      // up to the Jellyfin app on the Roku
      await this.playOnRoku(screen, item, url);
    } else if (screen.kind === 'dlna') {
      await this.playOnDlna(screen, item, url, startSeconds);
    } else {
      await this.playOnCast(
        screen,
        url,
        item.name,
        item.container,
        startSeconds,
      );
    }
    // a Roku plays Jellyfin's own copy under its own sign-in, and reports
    // nothing back to us, so there is no playback of ours to watch there
    if (screen.kind === 'roku') this.playbacks.delete(screen.id);
    else {
      this.playbacks.set(screen.id, {
        playbackId,
        itemId: item.id,
        startedAt: Date.now(),
        startSeconds,
      });
    }
    return `Playing ${item.name} on ${screen.name}${before}`;
  }

  // roku: wake it, then hand the file to the player its own remote app uses
  /**
   * A Roku will not be told to play: the Jellyfin app there reports no remote
   * control at all, and the channel that takes a url handed to it is hidden
   * and not in the store. What does work is deep linking — launch the
   * Jellyfin app with the item on the end of it, and it opens playing.
   */
  private async playOnRoku(
    screen: Screen,
    item: { id: string; name: string; type?: string },
    url: string,
  ) {
    const base = `http://${screen.address}:${ROKU_PORT}`;
    const post = async (path: string) => {
      const res = await fetch(base + path, {
        method: 'POST',
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 403) {
        throw new Error(
          `${screen.name} is refusing commands. On that TV: Settings > ` +
            'System > Advanced system settings > Control by mobile apps > ' +
            'Network access needs to be Enabled (older remotes say Default) — ' +
            'Limited is not enough.',
        );
      }
      return res.ok;
    };

    const channels = await this.rokuChannels(base);
    const jellyfin = channels.find((c) => /jellyfin/i.test(c.name));
    await post('/keypress/PowerOn').catch(() => false);
    await new Promise((r) => setTimeout(r, ROKU_WAKE_MS));

    if (jellyfin) {
      const q = new URLSearchParams({
        contentId: item.id,
        mediaType: item.type === 'Episode' ? 'episode' : 'movie',
      });
      const ok = await post(`/launch/${jellyfin.id}?${q.toString()}`);
      if (!ok) throw new Error(`${screen.name} would not open Jellyfin`);
      return;
    }

    // a TV that shipped with the hidden url channel can still use it
    if (channels.some((c) => c.id === ROKU_URL_PLAYER)) {
      const params = new URLSearchParams({
        t: 'v',
        u: url,
        videoName: item.name,
        videoFormat: 'mp4',
      });
      const ok = await post(`/launch/${ROKU_URL_PLAYER}?${params.toString()}`);
      if (!ok) throw new Error(`${screen.name} would not start the player`);
      return;
    }

    throw new Error(
      `${screen.name} needs the free Jellyfin channel before it can play ` +
        'anything. Add it once from the Roku channel store on that TV, and ' +
        'sign it in.',
    );
  }

  /**
   * A TV that speaks UPnP is handed the film in two steps: here is the file,
   * now play it. No app to install and nothing to sign in, which is what
   * makes it the way in to a set whose own casting will not cooperate.
   */
  private async playOnDlna(
    screen: Screen,
    item: { id: string; name: string; container?: string },
    url: string,
    startSeconds = 0,
  ) {
    const didl =
      '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
      `<item id="1" parentID="0" restricted="1"><dc:title>${xml(item.name)}</dc:title>` +
      '<upnp:class>object.item.videoItem</upnp:class>' +
      `<res protocolInfo="http-get:*:video/${item.container === 'mp4' ? 'mp4' : 'x-matroska'}:*">${xml(url)}</res>` +
      '</item></DIDL-Lite>';

    // a set that is already playing starts a new link by itself the moment
    // it is given one, and then refuses the Play that follows — so stop it
    // first, and the switch is the same as starting from nothing. a TV with
    // nothing on may refuse the Stop; that is fine
    await this.soap(screen, 'Stop', '').catch(() => undefined);
    await this.soap(
      screen,
      'SetAVTransportURI',
      `<CurrentURI>${xml(url)}</CurrentURI>` +
        `<CurrentURIMetaData>${xml(didl)}</CurrentURIMetaData>`,
    );
    await this.soap(screen, 'Play', '<Speed>1</Speed>');
    // no seek: tested on a real Samsung, it refused every seek mode on this
    // stream, so a UPnP TV always starts from the beginning for now.
    // startSeconds is accepted and deliberately not used
    void startSeconds;
  }

  private async soap(screen: Screen, action: string, inner: string) {
    const body =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
      `<u:${action} xmlns:u="${AV_TRANSPORT}"><InstanceID>0</InstanceID>` +
      `${inner}</u:${action}></s:Body></s:Envelope>`;
    const res = await fetch(
      `http://${screen.address}:${DLNA_PORT}${screen.control ?? ''}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: `"${AV_TRANSPORT}#${action}"`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      throw new Error(
        `${screen.name} would not take the film (${action} came back ${res.status}). ` +
          'It may need to be switched on rather than in standby.',
      );
    }
    return res.text();
  }

  /** What is installed on a Roku. An empty list means it would not say. */
  private async rokuChannels(
    base: string,
  ): Promise<{ id: string; name: string }[]> {
    try {
      const res = await fetch(`${base}/query/apps`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const body = await res.text();
      const out: { id: string; name: string }[] = [];
      const re = /<app id="([^"]+)"[^>]*>([^<]*)<\/app>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) out.push({ id: m[1], name: m[2] });
      return out;
    } catch {
      return [];
    }
  }

  // chromecast-style: launching the receiver is what wakes the tv
  private playOnCast(
    screen: Screen,
    url: string,
    title: string,
    container?: string,
    startSeconds = 0,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const fail = (e: Error) => {
        try {
          client.close();
        } catch {
          /* already gone */
        }
        reject(e);
      };
      // a TV in standby answers in under ten seconds; one that does not
      // answer at all is usually switched off at the wall, and the family
      // should not be left watching a spinner while we find that out
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `${screen.name} is not answering — it may be switched off at the wall.`,
            ),
          ),
        CAST_LAUNCH_TIMEOUT_MS,
      );
      client.on('error', (e) => {
        clearTimeout(timer);
        fail(e);
      });
      client.connect(screen.address as string, () => {
        client.launch(DefaultMediaReceiver, (err, player) => {
          if (err) {
            clearTimeout(timer);
            return fail(err);
          }
          player.load(
            {
              contentId: url,
              contentType:
                container === 'mp4' ? 'video/mp4' : 'video/x-matroska',
              streamType: 'BUFFERED',
              metadata: { type: 0, metadataType: 0, title },
            },
            { autoplay: true, currentTime: startSeconds },
            (loadErr) => {
              clearTimeout(timer);
              if (loadErr) return fail(loadErr);
              client.close();
              resolve();
            },
          );
        });
      });
    });
  }

  /**
   * What a TV is actually doing, read from the TV itself — or, for an app
   * that reports to Jellyfin, from Jellyfin. The item is identified from the
   * link it is playing, so something else started on the same TV is seen as
   * something else, not mistaken for the film that was there before.
   */
  async nowPlaying(screen: Screen): Promise<PlaybackState> {
    try {
      if (screen.kind === 'dlna') return await this.dlnaState(screen);
      if (screen.kind === 'cast') return await this.castState(screen);
      if (screen.kind === 'session') {
        const id = screen.id.slice('session:'.length);
        const s = (await this.jellyfin.liveSessions()).find((x) => x.id === id);
        if (!s) return { state: 'unknown', detail: 'session gone' };
        return s.nowPlayingId
          ? {
              state: s.paused ? 'paused' : 'playing',
              itemId: s.nowPlayingId,
              positionSeconds: Math.floor((s.positionTicks ?? 0) / 10_000_000),
            }
          : { state: 'idle' };
      }
      return { state: 'unknown', detail: 'read through its Jellyfin session' };
    } catch (e) {
      return { state: 'unknown', detail: (e as Error).message };
    }
  }

  private async dlnaState(screen: Screen): Promise<PlaybackState> {
    const [info, pos] = [
      await this.soap(screen, 'GetTransportInfo', ''),
      await this.soap(screen, 'GetPositionInfo', ''),
    ];
    const tag = (x: string, t: string) =>
      new RegExp(`<${t}>([^<]*)</${t}>`).exec(x)?.[1];
    const transport = tag(info, 'CurrentTransportState') ?? '';
    const state: PlaybackState['state'] =
      transport === 'PLAYING'
        ? 'playing'
        : transport === 'PAUSED_PLAYBACK'
          ? 'paused'
          : transport === 'TRANSITIONING'
            ? 'buffering'
            : transport === 'STOPPED' || transport === 'NO_MEDIA_PRESENT'
              ? 'stopped'
              : 'unknown';
    const uri = decodeXml(tag(pos, 'TrackURI') ?? '');
    return {
      state,
      itemId: itemIdFromUrl(uri),
      playbackId: playbackIdFromUrl(uri),
      positionSeconds: seconds(tag(pos, 'RelTime')),
      durationSeconds: seconds(tag(pos, 'TrackDuration')),
      detail: transport,
    };
  }

  /** Attach to the receiver that is already running and ask it — never
   * launch one, which would stop whatever is playing. */
  private castState(screen: Screen): Promise<PlaybackState> {
    return new Promise((resolve) => {
      const client = new Client();
      const done = (s: PlaybackState) => {
        clearTimeout(timer);
        try {
          client.close();
        } catch {
          /* already gone */
        }
        resolve(s);
      };
      const timer = setTimeout(
        () => done({ state: 'unknown', detail: 'no answer' }),
        8000,
      );
      client.on('error', (e) => done({ state: 'unknown', detail: e.message }));
      client.connect(screen.address as string, () => {
        client.getSessions((err, sessions) => {
          const ours = (sessions ?? []).find((x) => x.appId === 'CC1AD845');
          if (err || !ours) return done({ state: 'idle' });
          client.join(ours, DefaultMediaReceiver, (jerr, player) => {
            if (jerr || !player) return done({ state: 'idle' });
            player.getStatus((serr, st) => {
              if (serr || !st) return done({ state: 'idle' });
              const map: Record<string, PlaybackState['state']> = {
                PLAYING: 'playing',
                PAUSED: 'paused',
                BUFFERING: 'buffering',
                IDLE: 'stopped',
              };
              done({
                state: map[st.playerState ?? ''] ?? 'unknown',
                itemId: itemIdFromUrl(st.media?.contentId ?? ''),
                playbackId: playbackIdFromUrl(st.media?.contentId ?? ''),
                // a receiver that says nothing about where it is has not
                // said "the start": leave it unknown
                positionSeconds:
                  typeof st.currentTime === 'number'
                    ? Math.floor(st.currentTime)
                    : undefined,
                durationSeconds: st.media?.duration
                  ? Math.floor(st.media.duration)
                  : undefined,
                detail: st.idleReason,
              });
            });
          });
        });
      });
    });
  }

  /** Stop whatever is on a screen. */
  async stop(screen: Screen): Promise<string> {
    this.started.delete(screen.id);
    if (screen.kind === 'dlna') {
      await this.soap(screen, 'Stop', '').catch(() => undefined);
      return `Stopped ${screen.name}`;
    }
    if (screen.kind === 'session') {
      await this.jellyfin.command(screen.id.slice('session:'.length), 'Stop');
      return `Stopped ${screen.name}`;
    }
    if (screen.kind === 'roku') {
      await fetch(`http://${screen.address}:${ROKU_PORT}/keypress/Home`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      return `Stopped ${screen.name}`;
    }
    return new Promise((resolve) => {
      const client = new Client();
      const finish = (line: string) => {
        try {
          client.close();
        } catch {
          /* already gone */
        }
        resolve(line);
      };
      const timer = setTimeout(
        () => finish(`Could not reach ${screen.name}`),
        CAST_LAUNCH_TIMEOUT_MS,
      );
      client.on('error', () => {
        clearTimeout(timer);
        finish(`Could not reach ${screen.name}`);
      });
      client.connect(screen.address as string, () => {
        // launch joins the receiver if it is already up
        client.launch(DefaultMediaReceiver, (err, player) => {
          clearTimeout(timer);
          if (err || !player) {
            return finish(`Nothing was playing on ${screen.name}`);
          }
          // quitting the app stops the film and puts the TV back on its own
          // home screen — asking the player to stop only works once it has
          // been told which media session it is in
          client.stop(player, () => finish(`Stopped ${screen.name}`));
        });
      });
    });
  }
}

// the same TV rarely gives the same name twice: the Jellyfin app may report
// "Kids' room TV" while the network scan finds "Kids' room TV new". Drop the
// punctuation and the words that say nothing about which room it is in, so
// both land on "kids room".
const NOISE = /^(tv|television|new|old|4k|uhd|hdr|display|screen|the)$/;

/** What this app started on a screen. */
export interface StartedPlayback {
  playbackId: string;
  itemId: string;
  startedAt: number;
  startSeconds: number;
}

/** What a TV is doing right now, as far as it will say. */
export interface PlaybackState {
  state: 'playing' | 'paused' | 'buffering' | 'stopped' | 'idle' | 'unknown';
  /** the Jellyfin item, read from the link being played */
  itemId?: string;
  /** which playback of it — the id this app put in the link when it
   * started it. absent for anything this app did not start */
  playbackId?: string;
  positionSeconds?: number;
  durationSeconds?: number;
  detail?: string;
}

/** The item a link of ours points at, or undefined for anything else. */
/** A fresh id for one playback: 16 hex characters, random. */
export function newPlaybackId(): string {
  return randomBytes(8).toString('hex');
}

export function itemIdFromUrl(url: string): string | undefined {
  return /\/api\/media\/stream\/([a-f0-9-]{8,64})(?:[?#]|$)/i.exec(url)?.[1];
}

/** The playback id in a link of ours, or undefined if it has none. Only
 * read from links that are ours, so another server's "pb" means nothing. */
export function playbackIdFromUrl(url: string): string | undefined {
  if (!itemIdFromUrl(url)) return undefined;
  return /[?&]pb=([a-f0-9]{16})(?:&|#|$)/i.exec(url)?.[1];
}

/**
 * The one gate a progress tracker goes through: a position is only ever
 * handed back when the TV names the playback that was started — same item,
 * same playback id — is actually playing or paused, and says where it is.
 * A stopped TV still reporting its last link, a TV that cannot be reached,
 * one with no position to give, or anything started since, all give null.
 */
export function positionFor(
  started: StartedPlayback | undefined,
  now: PlaybackState,
): number | null {
  if (!isSamePlayback(started, now)) return null;
  if (now.state !== 'playing' && now.state !== 'paused') return null;
  return typeof now.positionSeconds === 'number' ? now.positionSeconds : null;
}

/**
 * Is this report about exactly the playback that was started? Only when the
 * TV names the same item and the same playback id. A TV that cannot say —
 * unreachable, idle, playing something that is not ours — is not a match,
 * and neither is the same film started again, which gets a new id.
 */
export function isSamePlayback(
  started: StartedPlayback | undefined,
  now: PlaybackState,
): boolean {
  return (
    !!started &&
    !!now.playbackId &&
    now.itemId === started.itemId &&
    now.playbackId === started.playbackId
  );
}

/** hh:mm:ss, the form UPnP wants a time in */
export function clock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Seconds from UPnP's h:mm:ss(.fff), or undefined for NOT_IMPLEMENTED */
export function seconds(value?: string): number | undefined {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})/.exec(value ?? '');
  if (!m) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// xml bodies carry a url with an api key on it and a title that may have an
// ampersand in it, so everything that goes in gets escaped
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The address ranges a TV in this house could actually reach. A tailscale
 * or other tunnel address is reachable from the server and from nowhere the
 * family's TVs are sitting. */
function isLan(address: string): boolean {
  return (
    /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

function normalize(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  // only trailing noise goes — "TV Room" is a room, "Room TV" is a TV
  while (words.length > 1 && NOISE.test(words[words.length - 1])) words.pop();
  while (words.length > 1 && NOISE.test(words[0])) words.shift();
  return words.join(' ');
}
