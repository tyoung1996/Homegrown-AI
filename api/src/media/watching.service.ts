import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JellyfinService, PersonalItem } from './jellyfin.service';
import { STARTS_PART_WAY, Screen, ScreensService } from './screens.service';
import { PlaybackTracker } from './playback-tracker.service';
import { WatchStateService } from './watch-state.service';
import {
  From,
  StartPoint,
  episodeStart,
  inOrder,
  toSeconds,
} from './watch-rules';
import {
  HowFar,
  activityLine,
  episodeLabel,
  howFar,
  roughly,
  shortEpisode,
  spokenName,
  startNote,
} from './watch-words';
import { normalizeTitle, titlesMatch } from './filename';
import { parseEpisodeRef } from './query';

/** Something about to go on a TV. */
interface Playable {
  id: string;
  name: string;
  type: string;
  container?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

/** What someone asked of a show. */
export interface ShowRequest {
  /** the show as they said it; left out for "continue my show" */
  show?: string;
  /**
   * continue    pick up the part-watched episode, else the next unwatched
   * next        one on from the episode they are on, from the beginning
   * start-over  the very first episode, from the beginning
   * episode     exactly the episode named
   */
  action: 'continue' | 'next' | 'start-over' | 'episode';
  season?: number;
  episode?: number;
  /** for a named episode: 'start' to start it over */
  from?: 'auto' | 'start';
}

/** What a stop really did — see stopConfirmed. */
export type StopOutcome =
  | 'stopped'
  | 'nothing-playing'
  | 'unreachable'
  | 'failed'
  | 'still-playing'
  | 'unconfirmed'
  | 'unverifiable';

export type ShowOutcome =
  | { kind: 'playing'; message: string }
  | { kind: 'choose'; message: string; shows: string[] }
  | { kind: 'nothing'; message: string };

/** One recent thing someone watched, as the assistant is told it. */
export interface Activity extends HowFar {
  itemId: string;
  kind: 'film' | 'episode';
  title: string;
  /** "S1E3", for an episode */
  episode?: string;
  /** a ready-made sentence: "You were watching X. You're about 18 minutes in." */
  line: string;
}

const UNLINKED =
  "your viewing isn't linked to you yet, so I can't see where you're up to";

/**
 * Putting films and shows on a TV for one person, and what they have been
 * watching. The person is whoever is signed in to Circuit Barn; where they
 * are up to comes only from their own Jellyfin account. A TV that cannot
 * start part way starts from the beginning and says so.
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

  // ------------------------------------------------------------- playing

  /** Put one film or episode on a TV for this person. Something part
   * watched picks up where they left off, unless they asked to start over. */
  async play(
    userId: string,
    itemId: string,
    screenRef: string,
    from: From = 'auto',
  ): Promise<string> {
    const screen = await this.screen(screenRef);
    const [item] = await this.jellyfin.itemsById([itemId]);
    if (!item) throw new NotFoundException('That is not in the library');
    const linked = !!(await this.watchState.personFor(userId));
    const start =
      linked && (item.type === 'Movie' || item.type === 'Episode')
        ? await this.watchState.itemStart(userId, item.id, from)
        : null;
    return this.startOn(userId, screen, item, start, linked, from);
  }

  /** Continue, next episode, start over, or one named episode of a show. */
  async playShow(
    userId: string,
    req: ShowRequest,
    screenRef: string,
  ): Promise<ShowOutcome> {
    const screen = await this.screen(screenRef);
    const linked = !!(await this.watchState.personFor(userId));
    req = episodeInName(req);

    // which show
    let show: { id: string; name: string };
    if (req.show) {
      const found = await this.findShow(req.show);
      if (found.kind !== 'one') return found.outcome;
      show = found.show;
    } else {
      if (req.action === 'start-over' || req.action === 'episode') {
        return nothing('Which show do you mean?');
      }
      if (!linked) return nothing(`Sorry — ${UNLINKED}.`);
      const shows =
        req.action === 'next'
          ? await this.latestShow(userId)
          : await this.showsToContinue(userId);
      if (!shows.length) {
        return nothing("You haven't been watching any shows yet.");
      }
      if (shows.length > 1) {
        const names = shows.map((s) => s.name);
        return {
          kind: 'choose',
          shows: names,
          message: `You've got more than one show going: ${names.join(' and ')}. Which one?`,
        };
      }
      show = shows[0];
    }

    // which episode, and from where
    let start: StartPoint | null;
    let from: From = 'auto';
    switch (req.action) {
      case 'continue': {
        if (!linked) {
          return nothing(
            `Sorry — ${UNLINKED} in ${show.name}. Tell me which episode and I'll put it on.`,
          );
        }
        from = 'resume';
        start = await this.watchState.showStart(userId, show.id, 'resume');
        if (!start) {
          return nothing(
            `You've watched every episode of ${show.name} that's here.`,
          );
        }
        break;
      }
      case 'next': {
        if (!linked) {
          return nothing(
            `Sorry — ${UNLINKED} in ${show.name}. Tell me which episode and I'll put it on.`,
          );
        }
        const next = await this.watchState.nextEpisode(userId, show.id);
        if (next === 'end' || next === null) {
          return nothing(
            `You've reached the end of ${show.name} — there isn't a next ` +
              'episode in the library.',
          );
        }
        start = next;
        break;
      }
      case 'start-over': {
        from = 'start';
        start = linked
          ? await this.watchState.showStart(userId, show.id, 'start')
          : this.first(await this.watchState.plainEpisodes(show.id));
        if (!start) return nothing(`${show.name} has no episodes here.`);
        break;
      }
      case 'episode': {
        if (req.season == null || req.episode == null) {
          return nothing(`Which episode of ${show.name}?`);
        }
        from = req.from === 'start' ? 'start' : 'auto';
        start = linked
          ? await this.watchState.namedEpisodeStart(
              userId,
              show.id,
              req.season,
              req.episode,
              from,
            )
          : episodeStart(
              await this.watchState.plainEpisodes(show.id),
              req.season,
              req.episode,
              from,
              await this.jellyfin.resumeRules(),
            );
        if (!start) {
          const which = episodeLabel({
            seasonNumber: req.season,
            episodeNumber: req.episode,
          });
          return nothing(`${show.name} ${which} isn't in the library.`);
        }
        break;
      }
    }

    const e = start.item;
    const message = await this.startOn(
      userId,
      screen,
      {
        id: e.id,
        name: e.name,
        type: 'Episode',
        container: e.container,
        seriesName: e.seriesName ?? show.name,
        seasonNumber: e.seasonNumber,
        episodeNumber: e.episodeNumber,
      },
      linked ? start : { ...start, startSeconds: 0 },
      linked,
      from,
    );
    return { kind: 'playing', message };
  }

  async stop(screenRef: string): Promise<string> {
    const screen = await this.screens.find(screenRef);
    if (!screen) throw new BadRequestException('I could not find that TV');
    return this.tracker.stop(screen, () => this.screens.stop(screen));
  }

  /**
   * Stop a TV and find out whether it really stopped. The answer is what
   * the TV was seen to do, never just that the command went through:
   *   stopped          it was playing, and now says it has stopped
   *   nothing-playing  it was not playing anything to begin with
   *   unreachable      it did not answer before the stop
   *   failed           the stop itself went wrong
   *   still-playing    the stop went through and it is still playing
   *   unconfirmed      the stop went through and then it would not say
   *   unverifiable     a TV that cannot be asked (a Roku): told, not checked
   */
  async stopConfirmed(screen: Screen): Promise<StopOutcome> {
    if (screen.kind === 'roku') {
      try {
        await this.tracker.stop(screen, () => this.screens.stop(screen));
        return 'unverifiable';
      } catch {
        return 'failed';
      }
    }
    const before = await this.screens.nowPlaying(screen);
    if (before.state === 'unknown') return 'unreachable';
    if (before.state === 'idle' || before.state === 'stopped') {
      // anything this app still had open there is finished with
      await this.tracker.refresh(screen.id);
      return 'nothing-playing';
    }
    try {
      const done = await this.tracker.stopConfirmed(
        screen,
        () => this.screens.stop(screen),
        () => this.confirmStopped(screen),
      );
      return done;
    } catch {
      return 'failed';
    }
  }

  /** Stop a TV by name, and say which, with what really happened. */
  async stopNamed(
    screenRef: string,
  ): Promise<{ outcome: StopOutcome; name: string }> {
    const screen = await this.screens.find(screenRef);
    if (!screen) throw new BadRequestException('I could not find that TV');
    return { outcome: await this.stopConfirmed(screen), name: screen.name };
  }

  /** how long to wait between looks when confirming a stop; tests shorten it */
  confirmEveryMs = 1500;

  /** Ask the TV a few times whether it has stopped. */
  private async confirmStopped(
    screen: Screen,
  ): Promise<'stopped' | 'playing' | 'unknown'> {
    let last: 'playing' | 'unknown' = 'unknown';
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, this.confirmEveryMs));
      const now = await this.screens.nowPlaying(screen);
      if (now.state === 'idle' || now.state === 'stopped') return 'stopped';
      last = now.state === 'unknown' ? 'unknown' : 'playing';
    }
    return last;
  }

  // ------------------------------------------------------------- looking

  /** What this person has watched lately — films and shows together, most
   * recent first, one line per film or show. Null when not linked. */
  async watching(userId: string, limit = 4): Promise<Activity[] | null> {
    const recent = await this.watchState.recent(userId, 12);
    if (!recent) return null;
    const rules = await this.jellyfin.resumeRules();
    const seen = new Set<string>();
    const out: Activity[] = [];
    for (const i of recent) {
      const episode = i.type === 'Episode';
      const key = episode
        ? `show:${i.seriesId ?? i.seriesName}`
        : `film:${i.id}`;
      if (seen.has(key)) continue; // a show once, at its latest episode
      seen.add(key);
      out.push({
        itemId: i.id,
        kind: episode ? 'episode' : 'film',
        title: episode ? (i.seriesName ?? i.name) : i.name,
        ...(episode ? { episode: shortEpisode(i) } : {}),
        ...howFar(i, rules),
        line: activityLine(i, rules),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** How far someone is through a film, an episode, or a show — as one
   * sentence. Null when they have no linked account. */
  async howFar(
    userId: string,
    target: { itemId?: string; show?: string },
  ): Promise<string | null> {
    if (!(await this.watchState.personFor(userId))) return null;

    if (target.show) {
      const found = await this.findShow(target.show);
      if (found.kind !== 'one') return found.outcome.message;
      const { name } = found.show;
      const where = await this.watchState.whereInShow(userId, found.show.id);
      if (!where) return null;
      const { current, next, rules } = where;
      if (!current) return `You haven't started ${name} yet.`;
      const far = howFar(current, rules);
      const at = episodeLabel(current);
      if (far.state === 'part way') {
        const mins = roughly(toSeconds(current.positionTicks));
        return `You're ${mins} into ${name}, ${at}.`;
      }
      if (far.state === 'finished') {
        return next
          ? `You've watched ${name}, ${at}. Next up is ${episodeLabel(next)}.`
          : `You've watched ${name}, ${at} — that's the last episode here.`;
      }
      return `You've only just started ${name}, ${at}.`;
    }

    const item = await this.watchState.position(userId, target.itemId ?? '');
    if (!item) throw new NotFoundException('That is not in the library');
    const what = spokenName(item);
    const far = howFar(item, await this.jellyfin.resumeRules());
    if (far.state === 'finished') return `You've watched ${what}.`;
    if (far.state === 'not started') return `You haven't started ${what} yet.`;
    return `You're ${roughly(toSeconds(item.positionTicks))} into ${what}.`;
  }

  // ------------------------------------------------------------- helpers

  private async screen(screenRef: string): Promise<Screen> {
    const screen = await this.screens.find(screenRef);
    if (screen) return screen;
    const names = (await this.screens.list()).map((s) => s.name).join(', ');
    throw new BadRequestException(
      names
        ? `I could not find that TV. Right now I can see: ${names}.`
        : 'I cannot see any TVs on the network right now.',
    );
  }

  /** The one place anything goes on a TV: where it starts depends on the
   * TV, the tracker writes it down first, and the reply says what happened. */
  private async startOn(
    userId: string,
    screen: Screen,
    item: Playable,
    start: StartPoint | null,
    linked: boolean,
    from: From,
  ): Promise<string> {
    const canResume = STARTS_PART_WAY[screen.kind] === 'yes';
    const startSeconds = canResume ? (start?.startSeconds ?? 0) : 0;
    const named = { ...item, name: spokenName(item) };
    const { result: line } = await this.tracker.begin(
      { userId, screen, itemId: item.id },
      (playbackId) =>
        this.screens.play(screen, named, startSeconds, playbackId),
    );
    this.log.log(line);
    const note = startNote({
      start,
      canResume,
      linked,
      from,
      episode: item.type === 'Episode',
    });
    return note ? `${line}.${note}` : line;
  }

  /** A show in the library by the name someone used for it. */
  private async findShow(
    said: string,
  ): Promise<
    | { kind: 'one'; show: { id: string; name: string } }
    | { kind: 'other'; outcome: ShowOutcome }
  > {
    const shows = (await this.jellyfin.items()).filter(
      (i) => i.type === 'Series',
    );
    const exact = shows.filter(
      (s) => normalizeTitle(s.name) === normalizeTitle(said),
    );
    const close = exact.length
      ? exact
      : shows.filter((s) => titlesMatch(s.name, said));
    if (close.length === 1) {
      return { kind: 'one', show: { id: close[0].id, name: close[0].name } };
    }
    if (!close.length) {
      return {
        kind: 'other',
        outcome: nothing(`I can't find ${said} in the library.`),
      };
    }
    const names = close.map((s) => s.name);
    return {
      kind: 'other',
      outcome: {
        kind: 'choose',
        shows: names,
        message: `Which one — ${names.join(' or ')}?`,
      },
    };
  }

  /** "Continue my show": a show with an episode part watched; failing that,
   * the shows they have watched lately. More than one means asking. */
  private async showsToContinue(userId: string) {
    const partWay = (await this.watchState.inProgress(userId, 'Episode')) ?? [];
    const shows = seriesOf(partWay);
    if (shows.length) return shows;
    const recent = (await this.watchState.recent(userId, 20)) ?? [];
    return seriesOf(recent.filter((i) => i.type === 'Episode'));
  }

  /** "Play the next episode": the show they watched most recently. */
  private async latestShow(userId: string) {
    const recent = (await this.watchState.recent(userId, 20)) ?? [];
    return seriesOf(recent.filter((i) => i.type === 'Episode')).slice(0, 1);
  }

  private first(episodes: PersonalItem[]): StartPoint | null {
    const [e] = inOrder(episodes);
    return e ? { item: e, startSeconds: 0, why: 'asked to start over' } : null;
  }
}

/**
 * "The Office S03E12" or "the office season 3 episode 12", said as the
 * show: the episode is in the name, read with the same parser the library
 * search uses. Numbers given on their own win over ones in the name. Next
 * and start over are about the whole show, so a number there is dropped.
 */
function episodeInName(req: ShowRequest): ShowRequest {
  const ref = req.show ? parseEpisodeRef(req.show) : null;
  if (!ref) return req;
  const show = ref.title || req.show;
  if (
    ref.episode == null ||
    req.action === 'next' ||
    req.action === 'start-over'
  ) {
    return { ...req, show };
  }
  return {
    ...req,
    show,
    action: 'episode',
    season: req.season ?? ref.season,
    episode: req.episode ?? ref.episode,
  };
}

function nothing(message: string): ShowOutcome {
  return { kind: 'nothing', message };
}

/** The shows a list of episodes belongs to, in the order first met. */
function seriesOf(episodes: PersonalItem[]): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const e of episodes) {
    if (!e.seriesId || out.some((s) => s.id === e.seriesId)) continue;
    out.push({ id: e.seriesId, name: e.seriesName ?? 'that show' });
  }
  return out;
}
