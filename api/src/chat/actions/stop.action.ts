import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Screen, ScreensService } from '../../media/screens.service';
import { StopOutcome, WatchingService } from '../../media/watching.service';
import { ActionContext, ActionReply, VerifiedAction } from './verified-action';
import { StopIntent, recogniseStop, tidy } from './stop-intent';

/**
 * "Stop the TV in the den", "turn Emmy's TV off", "stop the movie". Which
 * TV comes from what they said; failing that from this conversation; failing
 * that from the one thing this person has playing. Never a guess between
 * two. The reply is written from what the TV was seen to do afterwards.
 */
@Injectable()
export class StopAction implements VerifiedAction<StopIntent> {
  readonly name = 'stop';

  constructor(
    private screens: ScreensService,
    private watching: WatchingService,
    private prisma: PrismaService,
  ) {}

  recognise(message: string): StopIntent | null {
    return recogniseStop(message);
  }

  async perform(
    ctx: ActionContext,
    intent: StopIntent,
  ): Promise<ActionReply | null> {
    let screen: Screen | null;
    if (intent.tv) {
      screen = await this.resolve(intent.tv);
      if (!screen) {
        // "stop being silly" named no TV at all: not ours to answer
        if (!intent.named) return null;
        return this.reply(
          'unknown-tv',
          `I couldn't find a TV called "${intent.tv}".${await this.canSee()}`,
        );
      }
    } else {
      screen = await this.unnamed(ctx);
      if (!screen) {
        return this.reply(
          'which-tv',
          `Which TV do you want me to stop?${await this.canSee()}`,
        );
      }
    }
    const outcome = await this.watching.stopConfirmed(screen);
    return this.reply(outcome, stopReply(outcome, screen.name));
  }

  /** The TV they named, through the same resolver as everything else —
   * tried as said, and as people also say it ("Emmy's TV" for "Emmy's
   * room"). */
  private async resolve(tv: string): Promise<Screen | null> {
    const base = tv.replace(/^the /, '');
    const bare = base.replace(/ (tv|television|telly|screen)$/, '');
    const tries = [tv, base, bare, `${bare} room`, bare.replace(/ room$/, '')];
    for (const t of [...new Set(tries)]) {
      const s = t ? await this.screens.find(t) : null;
      if (s) return s;
    }
    return null;
  }

  /**
   * No TV named: the one this conversation was just about, as long as it
   * does not disagree with what the person has playing; otherwise the one
   * TV this person has something playing on; otherwise nobody knows.
   */
  private async unnamed(ctx: ActionContext): Promise<Screen | null> {
    const screens = await this.screens.list();
    const active = [
      ...new Set(
        (
          await this.prisma.playback.findMany({
            where: {
              userId: ctx.userId,
              state: { in: ['STARTING', 'ACTIVE'] },
            },
            select: { screenId: true },
          })
        ).map((p) => p.screenId),
      ),
    ];

    const recent = await this.prisma.message.findMany({
      where: { conversationId: ctx.conversationId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { content: true },
    });
    let talkedAbout: Screen | null = null;
    for (const m of recent) {
      const text = ` ${tidy(m.content)} `;
      const hits = screens.filter((s) => text.includes(` ${tidy(s.name)} `));
      if (hits.length === 1) talkedAbout = hits[0];
      if (hits.length) break; // the most recent mention decides, even if unclear
    }

    if (talkedAbout && (!active.length || active.includes(talkedAbout.id))) {
      return talkedAbout;
    }
    if (!talkedAbout && active.length === 1) {
      return screens.find((s) => s.id === active[0]) ?? null;
    }
    return null;
  }

  private async canSee(): Promise<string> {
    const names = (await this.screens.list()).map((s) => s.name);
    return names.length ? ` I can see: ${names.join(', ')}.` : '';
  }

  private reply(outcome: string, reply: string): ActionReply {
    return { action: this.name, outcome, reply };
  }
}

/** What to call a TV in a sentence: "the TV in Emmy and Ty's room". */
function theTv(name: string): string {
  return /\broom$/i.test(name) ? `the TV in ${name}` : name;
}

/** The reply, from what the TV actually did. */
export function stopReply(outcome: StopOutcome, name: string): string {
  const tv = theTv(name);
  switch (outcome) {
    case 'stopped':
      return `Stopped playback on ${tv}.`;
    case 'nothing-playing':
      return `Nothing is playing on ${tv}.`;
    case 'unreachable':
      return `I couldn't reach ${tv}.`;
    case 'failed':
      return `I couldn't stop playback on ${tv}.`;
    case 'still-playing':
      return `I couldn't stop playback on ${tv} — I told it to stop, but it's still playing.`;
    case 'unconfirmed':
      return `I told ${tv} to stop, but then it stopped answering, so I can't be sure it did.`;
    case 'unverifiable':
      return `I've told ${tv} to stop, but that TV can't tell me whether it did.`;
  }
}
