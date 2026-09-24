import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Playback } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { JellyfinService } from './jellyfin.service';
import {
  Screen,
  ScreenKind,
  ScreensService,
  newPlaybackId,
} from './screens.service';
import {
  CloseReason,
  Observation,
  POLL_MS,
  RETENTION_MS,
  SETTLE_WINDOW_MS,
  judge,
} from './playback-lifecycle';

const OPEN: Playback['state'][] = ['STARTING', 'ACTIVE'];
const SWEEP_EVERY_MS = 60 * 60_000;

/**
 * The kinds of TV that have been seen, on real hardware, to say exactly
 * which playback they are showing and where they are in it. Nothing else is
 * tracked: a Roku or a Jellyfin app reports to Jellyfin under whatever
 * account it is signed in as, which is not the person.
 */
export function tracks(kind: ScreenKind): boolean {
  return kind === 'cast' || kind === 'dlna';
}

/**
 * Follows each playback this app starts on a Cast or UPnP TV, and passes
 * where it has got to on to the Jellyfin account of the person who started
 * it — and only theirs, and only while it is certainly the same playback.
 *
 * What is kept is only what is needed to be sure of that, across a restart:
 * which playback, whose, what, on which TV, how far, and whether it is
 * still going. Jellyfin keeps the watch history; this is not a second copy.
 *
 * Every Jellyfin write for one person and one film goes through a single
 * queue, and checks the database again inside it, so a playback that has
 * been closed or overtaken can never write after the one that overtook it.
 */
@Injectable()
export class PlaybackTracker implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Playback');
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private lastSweep = 0;
  /** the clock; tests replace it */
  now: () => Date = () => new Date();

  constructor(
    private prisma: PrismaService,
    private jellyfin: JellyfinService,
    private screens: ScreensService,
  ) {}

  onModuleInit() {
    if (process.env.PLAYBACK_TRACKING === 'off') return;
    // straight away, so anything left open by a restart is picked back up
    setTimeout(() => void this.tick(), 5_000).unref();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------ starting

  /**
   * Put something new on a TV. Whatever this app had playing there is
   * closed first — whoever it was for — then, if this person has a Jellyfin
   * account and the TV is one that can be followed, the new playback is
   * written down before the TV is told anything.
   */
  async begin<T>(
    a: { userId: string; screen: Screen; itemId: string },
    start: (playbackId: string) => Promise<T>,
  ): Promise<{ result: T; tracked: boolean }> {
    return this.withLock(`tv:${a.screen.id}`, async () => {
      await this.closeScreen(a.screen.id, 'replaced');
      const playbackId = newPlaybackId();
      const person = await this.personFor(a.userId);
      const tracked = tracks(a.screen.kind) && !!person;
      if (tracked && person) {
        await this.prisma.playback.create({
          data: {
            id: playbackId,
            userId: a.userId,
            jellyfinUserId: person,
            itemId: a.itemId,
            screenId: a.screen.id,
            protocol: a.screen.kind,
            control:
              a.screen.kind === 'dlna' ? (a.screen.control ?? null) : null,
            startedAt: this.now(),
          },
        });
      }
      try {
        return { result: await start(playbackId), tracked };
      } catch (e) {
        if (tracked) await this.close(playbackId, 'failed-to-start');
        throw e;
      }
    });
  }

  /** Stop a TV from Circuit Barn: one last look for the final position,
   * then the playback is closed and the TV told to stop. */
  async stop(screen: Screen, stop: () => Promise<string>): Promise<string> {
    return this.withLock(`tv:${screen.id}`, async () => {
      await this.closeScreen(screen.id, 'stopped-by-app');
      return stop();
    });
  }

  // ------------------------------------------------------------- looking

  /** Look at every TV with an open playback, and hand over any final
   * positions still owed. Runs every half minute, and once at start-up. */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick() {
    const open = await this.prisma.playback.findMany({
      where: { state: { in: OPEN } },
      select: { screenId: true },
    });
    for (const screenId of new Set(open.map((r) => r.screenId))) {
      await this.withLock(`tv:${screenId}`, () => this.lookAt(screenId)).catch(
        (e: unknown) => this.log.warn(`look failed: ${(e as Error).message}`),
      );
    }

    const owed = await this.prisma.playback.findMany({
      where: { state: 'CLOSED', settledAt: null },
      orderBy: { startedAt: 'asc' },
    });
    for (const r of owed) {
      await this.settle(r).catch((e: unknown) =>
        this.log.warn(`settle failed: ${(e as Error).message}`),
      );
    }

    const now = this.now().getTime();
    if (now - this.lastSweep > SWEEP_EVERY_MS) {
      this.lastSweep = now;
      await this.prisma.playback.deleteMany({
        where: {
          state: 'CLOSED',
          settledAt: { not: null },
          closedAt: { lt: new Date(now - RETENTION_MS) },
        },
      });
    }
  }

  /** The newest open playback on a TV is looked at; anything older still
   * open there has been replaced. */
  private async lookAt(screenId: string) {
    const open = await this.prisma.playback.findMany({
      where: { screenId, state: { in: OPEN } },
      orderBy: { startedAt: 'desc' },
    });
    if (!open.length) return;
    const [newest, ...older] = open;
    for (const r of older) await this.close(r.id, 'replaced');
    await this.apply(newest.id, await this.observe(newest));
  }

  /** Close everything open on a TV, after one last look at the newest. */
  private async closeScreen(screenId: string, reason: CloseReason) {
    const open = await this.prisma.playback.findMany({
      where: { screenId, state: { in: OPEN } },
      orderBy: { startedAt: 'desc' },
    });
    if (!open.length) return;
    await this.apply(open[0].id, await this.observe(open[0]));
    for (const r of open) await this.close(r.id, reason);
  }

  private async observe(rec: Playback): Promise<Observation> {
    const seen = await this.screens
      .nowPlaying(screenFor(rec))
      .catch(() => ({ state: 'unknown' as const }));
    return { ...seen, screenId: rec.screenId, at: this.now() };
  }

  /** What one look means for one playback, and acting on it. */
  async apply(id: string, obs: Observation): Promise<void> {
    const rec = await this.prisma.playback.findUnique({ where: { id } });
    if (!rec || rec.state === 'CLOSED') return;
    if ((await this.personFor(rec.userId)) !== rec.jellyfinUserId) {
      await this.close(id, 'unlinked');
      return;
    }
    const verdict = judge(rec, obs, this.now());
    if (verdict.act === 'wait') return;
    if (verdict.act === 'close') {
      await this.close(id, verdict.reason);
      return;
    }

    // something newer went on this TV after it
    const newer = await this.prisma.playback.findFirst({
      where: { screenId: rec.screenId, startedAt: { gt: rec.startedAt } },
      select: { id: true },
    });
    if (newer) {
      await this.close(id, 'replaced');
      return;
    }

    const moved = await this.prisma.playback.updateMany({
      where: {
        id,
        state: { in: OPEN },
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: obs.at } }],
      },
      data: {
        state: 'ACTIVE',
        lastPosition: verdict.position,
        lastSeenAt: obs.at,
      },
    });
    if (!moved.count) return;
    await this.report(id, verdict.position, verdict.paused);
  }

  // ------------------------------------------------------------- writing

  /** Tell Jellyfin where this person has got to. */
  private async report(id: string, position: number, paused: boolean) {
    const first = await this.prisma.playback.findUnique({ where: { id } });
    if (!first) return;
    await this.withLock(jfKey(first), async () => {
      // checked again inside the queue: it may have been closed meanwhile
      const rec = await this.prisma.playback.findUnique({ where: { id } });
      if (!rec || rec.state === 'CLOSED') return;
      if (rec.lastPosition !== position) return; // a newer look got here first
      if (await this.newerReported(rec)) {
        await this.markClosed(id, 'superseded');
        await this.settleHeld(id);
        return;
      }
      const who = {
        playbackId: rec.id,
        jellyfinUserId: rec.jellyfinUserId,
        itemId: rec.itemId,
      };

      if (!rec.reportedAt) {
        // whatever this person had going on this film before now is handed
        // over first, so it can never land after this one
        if (!(await this.clearOlder(rec))) return;
        if (
          !(await this.jellyfin.reportPlayback(who, 'start', position, paused))
        ) {
          this.log.warn(
            'Jellyfin would not take a playback start; trying again',
          );
          return;
        }
        await this.prisma.playback.updateMany({
          where: { id, reportedAt: null },
          data: { reportedAt: this.now() },
        });
      }
      if (
        !(await this.jellyfin.reportPlayback(who, 'progress', position, paused))
      ) {
        this.log.warn('Jellyfin would not take progress; trying again');
      }
    });
  }

  /** Earlier playbacks of this film by this person are closed and their
   * final positions handed over. False while any is still owed. */
  private async clearOlder(rec: Playback): Promise<boolean> {
    const older = await this.prisma.playback.findMany({
      where: {
        jellyfinUserId: rec.jellyfinUserId,
        itemId: rec.itemId,
        startedAt: { lt: rec.startedAt },
        OR: [{ state: { in: OPEN } }, { settledAt: null }],
      },
      orderBy: { startedAt: 'asc' },
    });
    let clear = true;
    for (const o of older) {
      await this.markClosed(o.id, 'superseded');
      if (!(await this.settleHeld(o.id))) clear = false;
    }
    return clear;
  }

  private async newerReported(rec: Playback): Promise<boolean> {
    const newer = await this.prisma.playback.findFirst({
      where: {
        jellyfinUserId: rec.jellyfinUserId,
        itemId: rec.itemId,
        startedAt: { gt: rec.startedAt },
        reportedAt: { not: null },
      },
      select: { id: true },
    });
    return !!newer;
  }

  // ------------------------------------------------------------- closing

  /** Close a playback for good, then hand over its final position. */
  private async close(id: string, reason: CloseReason) {
    if (!(await this.markClosed(id, reason))) return;
    const rec = await this.prisma.playback.findUnique({ where: { id } });
    if (rec) await this.settle(rec);
  }

  /** Only an open playback can be closed, and only once. */
  private async markClosed(id: string, reason: CloseReason): Promise<boolean> {
    const done = await this.prisma.playback.updateMany({
      where: { id, state: { in: OPEN } },
      data: { state: 'CLOSED', closedAt: this.now(), closeReason: reason },
    });
    if (done.count) this.log.log(`playback closed: ${reason}`);
    return done.count > 0;
  }

  private settle(rec: Playback): Promise<boolean> {
    return this.withLock(jfKey(rec), () => this.settleHeld(rec.id));
  }

  /**
   * Hand a closed playback's last confirmed position to Jellyfin as where
   * it stopped, then remove its sign-in. Nothing is written when Jellyfin
   * was never told it started, when the person's account is no longer the
   * one it began with, or when a newer playback of the same film by the
   * same person has already been reported. A failed write is tried again
   * for a while, then given up. Caller holds the write queue.
   */
  private async settleHeld(id: string): Promise<boolean> {
    const rec = await this.prisma.playback.findUnique({ where: { id } });
    if (!rec || rec.state !== 'CLOSED' || rec.settledAt) return true;

    let done: boolean;
    if (!rec.reportedAt || rec.lastPosition === null) done = true;
    else if ((await this.personFor(rec.userId)) !== rec.jellyfinUserId) {
      done = true;
    } else if (await this.newerReported(rec)) done = true;
    else {
      done = await this.jellyfin.reportPlayback(
        {
          playbackId: rec.id,
          jellyfinUserId: rec.jellyfinUserId,
          itemId: rec.itemId,
        },
        'stopped',
        rec.lastPosition,
      );
      if (!done) this.log.warn('Jellyfin would not take a final position');
    }

    const closedAt = (rec.closedAt ?? rec.startedAt).getTime();
    if (!done && this.now().getTime() - closedAt > SETTLE_WINDOW_MS) {
      this.log.warn('gave up handing over a final position');
      done = true;
    }
    if (!done) return false;

    await this.prisma.playback.updateMany({
      where: { id, settledAt: null },
      data: { settledAt: this.now() },
    });
    if (rec.reportedAt) await this.jellyfin.endPlaybackSession(rec.id);
    return true;
  }

  // ------------------------------------------------------------- helpers

  private async personFor(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { jellyfinUserId: true },
    });
    return u?.jellyfinUserId ?? null;
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const ahead = this.locks.get(key) ?? Promise.resolve();
    const run = ahead.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}

// one queue per person and film for everything written to Jellyfin
function jfKey(rec: { jellyfinUserId: string; itemId: string }): string {
  return `jf:${rec.jellyfinUserId}:${rec.itemId}`;
}

/** Enough of a TV to look at it again, from what was written down. */
function screenFor(rec: Playback): Screen {
  return {
    id: rec.screenId,
    name: '',
    kind: rec.protocol as ScreenKind,
    address: rec.screenId.slice(rec.screenId.indexOf(':') + 1),
    control: rec.control ?? undefined,
    ready: false,
  };
}
