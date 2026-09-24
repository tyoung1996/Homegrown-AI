import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JellyfinService } from './jellyfin.service';
import { STARTS_PART_WAY, ScreensService } from './screens.service';
import { PlaybackTracker } from './playback-tracker.service';
import { WatchStateService } from './watch-state.service';
import { From } from './watch-rules';
import { HowFar, howFar, startNote } from './watch-words';

/** A film someone is part way through, as the assistant is told it. */
export interface PartWay extends HowFar {
  itemId: string;
  title: string;
  year?: number;
}

/**
 * Putting something on a TV for one person, and what they have been
 * watching. Where to start comes from that person's own Jellyfin history;
 * a TV that cannot start part way starts from the beginning and says so.
 *
 * Only films pick up where someone left off for now. Shows start from the
 * beginning of the episode, as they always have, until how shows should
 * behave has been worked out.
 */
@Injectable()
export class WatchingService {
  private log = new Logger('Watching');

  constructor(
    private screens: ScreensService,
    private jellyfin: JellyfinService,
    private watchState: WatchStateService,
    private tracker: PlaybackTracker,
  ) {}

  /** Put something on a TV for this person. Returns the line to tell them. */
  async play(
    userId: string,
    itemId: string,
    screenRef: string,
    from: From = 'auto',
  ): Promise<string> {
    const screen = await this.screens.find(screenRef);
    if (!screen) {
      const names = (await this.screens.list()).map((s) => s.name).join(', ');
      throw new BadRequestException(
        names
          ? `I could not find that TV. Right now I can see: ${names}.`
          : 'I cannot see any TVs on the network right now.',
      );
    }
    const [item] = await this.jellyfin.itemsById([itemId]);
    if (!item) throw new NotFoundException('That is not in the library');

    const film = item.type === 'Movie';
    const linked = !!(await this.watchState.personFor(userId));
    const start =
      linked && film
        ? await this.watchState.itemStart(userId, item.id, from)
        : null;
    const canResume = STARTS_PART_WAY[screen.kind] === 'yes';
    const startSeconds = canResume ? (start?.startSeconds ?? 0) : 0;

    const { result: line } = await this.tracker.begin(
      { userId, screen, itemId: item.id },
      (playbackId) => this.screens.play(screen, item, startSeconds, playbackId),
    );
    this.log.log(line);
    const note = film ? startNote({ start, canResume, linked, from }) : '';
    return note ? `${line}.${note}` : line;
  }

  async stop(screenRef: string): Promise<string> {
    const screen = await this.screens.find(screenRef);
    if (!screen) throw new BadRequestException('I could not find that TV');
    return this.tracker.stop(screen, () => this.screens.stop(screen));
  }

  /** The films this person is part way through, most recent first, and
   * the last few they watched. Null when they have no linked account. */
  async watching(userId: string): Promise<{
    partWay: PartWay[];
    lastWatched: { itemId: string; title: string; finished: boolean }[];
  } | null> {
    const [partWay, recent] = await Promise.all([
      this.watchState.inProgress(userId, 'Movie'),
      this.watchState.recent(userId, 10),
    ]);
    if (!partWay || !recent) return null;
    const rules = await this.jellyfin.resumeRules();
    return {
      partWay: partWay.slice(0, 5).map((i) => ({
        itemId: i.id,
        title: i.name,
        year: i.year,
        ...howFar(i, rules),
      })),
      lastWatched: recent
        .filter((i) => i.type === 'Movie')
        .slice(0, 3)
        .map((i) => ({ itemId: i.id, title: i.name, finished: i.played })),
    };
  }

  /** How far this person is through one film. Null when they have no
   * linked account; 'not a film' for anything else, for now. */
  async howFar(
    userId: string,
    itemId: string,
  ): Promise<(HowFar & { title: string }) | 'not a film' | null> {
    const item = await this.watchState.position(userId, itemId);
    if (item === null) {
      if (!(await this.watchState.personFor(userId))) return null;
      throw new NotFoundException('That is not in the library');
    }
    if (item.type !== 'Movie') return 'not a film';
    return {
      title: item.name,
      ...howFar(item, await this.jellyfin.resumeRules()),
    };
  }
}
