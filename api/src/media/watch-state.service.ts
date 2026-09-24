import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JellyfinService, PersonalItem } from './jellyfin.service';
import {
  From,
  StartPoint,
  episodeStart,
  resumable,
  seriesStart,
  startFor,
} from './watch-rules';

/**
 * Where each person is up to — read from Jellyfin, which is the only place
 * watch history lives. Nothing is recorded here.
 *
 * Every question is asked on behalf of the signed-in person, through the
 * Jellyfin account an admin has linked to them. Which TV is involved never
 * enters into it: a TV is a room, and rooms do not watch films. Someone with
 * no linked account gets no personal answers at all — never a room's
 * history standing in for theirs.
 */
@Injectable()
export class WatchStateService {
  constructor(
    private prisma: PrismaService,
    private jellyfin: JellyfinService,
  ) {}

  /** The Jellyfin account that is this person, or null if none is linked. */
  async personFor(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { jellyfinUserId: true },
    });
    return u?.jellyfinUserId ?? null;
  }

  /** How far this person is through one thing. */
  async position(userId: string, itemId: string): Promise<PersonalItem | null> {
    const person = await this.personFor(userId);
    if (!person) return null;
    const [item] = await this.jellyfin.forPerson(person, [itemId]);
    return item ?? null;
  }

  /** What they have started and not finished, newest first. */
  async inProgress(
    userId: string,
    type?: 'Movie' | 'Episode',
  ): Promise<PersonalItem[] | null> {
    const person = await this.personFor(userId);
    if (!person) return null;
    const rules = await this.jellyfin.resumeRules();
    const items = await this.jellyfin.resumeFor(person, { type });
    return items.filter((i) => resumable(i, rules));
  }

  /** What they watched or started most recently. */
  async recent(userId: string, limit = 10): Promise<PersonalItem[] | null> {
    const person = await this.personFor(userId);
    if (!person) return null;
    return this.jellyfin.recentFor(person, limit);
  }

  /** Where to start a film (or any single item) for this person. */
  async itemStart(
    userId: string,
    itemId: string,
    from: From,
  ): Promise<StartPoint | null> {
    const person = await this.personFor(userId);
    if (!person) return null;
    const [item] = await this.jellyfin.forPerson(person, [itemId]);
    if (!item) return null;
    return startFor(item, from, await this.jellyfin.resumeRules());
  }

  /** Which episode of a show to put on for this person, and from where. */
  async showStart(
    userId: string,
    seriesId: string,
    from: From,
  ): Promise<StartPoint | null> {
    const person = await this.personFor(userId);
    if (!person) return null;
    const [resuming, nextUp, episodes, rules] = await Promise.all([
      this.jellyfin.resumeFor(person, { parentId: seriesId, type: 'Episode' }),
      this.jellyfin.nextUpFor(person, seriesId),
      this.jellyfin.episodesFor(person, seriesId),
      this.jellyfin.resumeRules(),
    ]);
    return seriesStart({ resuming, nextUp, episodes }, from, rules);
  }

  /** One named episode — a special included, when it is the one named. */
  async namedEpisodeStart(
    userId: string,
    seriesId: string,
    season: number,
    episode: number,
    from: From,
  ): Promise<StartPoint | null> {
    const person = await this.personFor(userId);
    if (!person) return null;
    const [episodes, rules] = await Promise.all([
      this.jellyfin.episodesFor(person, seriesId),
      this.jellyfin.resumeRules(),
    ]);
    return episodeStart(episodes, season, episode, from, rules);
  }

  // --------------------------------------------------------------- admin

  /** Who is linked to which Jellyfin account, and what is on offer. */
  async people() {
    const [users, accounts] = await Promise.all([
      this.prisma.user.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, displayName: true, jellyfinUserId: true },
      }),
      this.jellyfin.accounts(),
    ]);
    return {
      people: users.map((u) => ({
        id: u.id,
        name: u.displayName,
        jellyfinAccount:
          accounts.find((a) => a.id === u.jellyfinUserId)?.name ?? null,
      })),
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    };
  }

  /** Link a person to the Jellyfin account that is them, or unlink them. */
  async link(userId: string, jellyfinUserId: string | null) {
    if (jellyfinUserId) {
      const accounts = await this.jellyfin.accounts();
      if (!accounts.some((a) => a.id === jellyfinUserId)) {
        throw new BadRequestException('No such Jellyfin account');
      }
      const taken = await this.prisma.user.findFirst({
        where: { jellyfinUserId, NOT: { id: userId } },
        select: { displayName: true },
      });
      if (taken) {
        throw new BadRequestException(
          `That Jellyfin account is already ${taken.displayName}'s`,
        );
      }
    }
    const exists = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!exists) throw new NotFoundException('No such person');
    await this.prisma.user.update({
      where: { id: userId },
      data: { jellyfinUserId },
    });
    return this.people();
  }
}
