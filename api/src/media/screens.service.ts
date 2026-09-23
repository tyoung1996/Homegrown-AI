import { Injectable, Logger } from '@nestjs/common';
import * as net from 'net';
import * as os from 'os';
import { Client, DefaultMediaReceiver } from 'castv2-client';
import { JellyfinService } from './jellyfin.service';

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
const SCAN_CACHE_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 400;
const CAST_LAUNCH_TIMEOUT_MS = 15_000;
// "Play on Roku", the hidden channel the Roku phone app pushes a url to. It
// takes a url straight from a launch, but it is not in the channel store, so
// a TV either has it or never will. The Roku Media Player channel that IS in
// the store (id 2213) ignores a url handed to it this way.
const ROKU_URL_PLAYER = '15985';
// how long to give the Jellyfin app on a Roku to start up and check in. A
// cold TV can take twenty seconds; ROKU_APP_WAIT_MS moves it for a slow set.
const ROKU_APP_WAIT_DEFAULT_MS = 30_000;

export type ScreenKind = 'session' | 'cast' | 'roku';

export interface Screen {
  id: string; // what the ui and the assistant pass back
  name: string; // what the family calls it: "Front room"
  deviceName?: string; // what the TV calls itself, when that differs
  kind: ScreenKind;
  address?: string; // ip, for the ones we wake ourselves
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
  private names = loadNames();

  constructor(private jellyfin: JellyfinService) {}

  /** The address a TV can reach this server on — never 127.0.0.1, since the
   * request comes from the TV, not from here. */
  serverAddress(): string {
    const configured = process.env.JELLYFIN_PUBLIC_URL;
    if (configured) return configured.replace(/\/+$/, '');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net_ of list ?? []) {
        if (net_.family === 'IPv4' && !net_.internal) {
          return `http://${net_.address}:8096`;
        }
      }
    }
    return 'http://127.0.0.1:8096';
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
        const [isCast, isRoku] = await Promise.all([
          this.open(ip, CAST_PORT),
          this.open(ip, ROKU_PORT),
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
    return [...live, ...rest].map((s) => this.rename(s));
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
    item: { id: string; name: string; container?: string },
  ): Promise<string> {
    // one TV can only show one thing: if two people ask for the same screen
    // at once, make them queue rather than half-starting both
    const ahead = this.busy.get(screen.id);
    if (ahead) await ahead.catch(() => undefined);
    const run = this.start(screen, item);
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
    item: { id: string; name: string; container?: string },
  ): Promise<string> {
    // what it interrupts, so the reply can say so
    const before =
      screen.nowPlaying && normalize(screen.nowPlaying) !== normalize(item.name)
        ? ` (it was playing ${screen.nowPlaying})`
        : '';

    if (screen.kind === 'session') {
      const sessionId = screen.id.slice('session:'.length);
      const ok = await this.jellyfin.playOnSession(sessionId, item.id);
      if (!ok) throw new Error(`${screen.name} did not take the request`);
      return `Playing ${item.name} on ${screen.name}${before}`;
    }

    const url = this.jellyfin.streamUrl(item.id, this.serverAddress());
    if (screen.kind === 'roku') {
      await this.playOnRoku(screen, item, url);
    } else {
      await this.playOnCast(screen, url, item.name, item.container);
    }
    return `Playing ${item.name} on ${screen.name}${before}`;
  }

  // roku: wake it, then hand the file to the player its own remote app uses
  private async playOnRoku(
    screen: Screen,
    item: { id: string; name: string },
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

    // the Jellyfin app is the good way: once it is up it checks in as a
    // session, and then it plays like any other Jellyfin app in the house —
    // right file, right subtitles, and it remembers where you got to
    if (jellyfin) {
      await post(`/launch/${jellyfin.id}`);
      const session = await this.waitForSession(screen);
      if (!session) {
        throw new Error(
          `${screen.name} opened Jellyfin but it never checked in — it may ` +
            'need signing in on that TV once.',
        );
      }
      const ok = await this.jellyfin.playOnSession(session.id, item.id);
      if (!ok) throw new Error(`${screen.name} did not take the request`);
      return;
    }

    // failing that, a TV with the old push-a-url channel can still be used
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
        'anything. Add it once from the Roku channel store on that TV.',
    );
  }

  /** Wait for a Jellyfin app on this TV to finish starting and check in. */
  private async waitForSession(screen: Screen) {
    const want = normalize(screen.deviceName ?? screen.name);
    const limit =
      Number(process.env.ROKU_APP_WAIT_MS) || ROKU_APP_WAIT_DEFAULT_MS;
    const until = Date.now() + limit;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, Math.min(2000, limit / 4)));
      const sessions = await this.jellyfin.sessions();
      const match = sessions.find((s) => normalize(s.deviceName) === want);
      if (match) return match;
    }
    return null;
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
            { autoplay: true },
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

  /** Stop whatever is on a screen. */
  async stop(screen: Screen): Promise<string> {
    this.started.delete(screen.id);
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
