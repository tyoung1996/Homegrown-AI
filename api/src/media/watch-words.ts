// How far through something someone is, said the way a person would say
// it. No clock times, no ticks, nothing about how a TV is reached.

import type { PersonalItem, ResumeRules } from './jellyfin.service';
import { From, StartPoint, resumable, toSeconds } from './watch-rules';

/** "about 42 minutes", "about 1 hour 5 minutes", "less than a minute" */
export function roughly(seconds: number): string {
  const minutes = Math.round(Math.max(0, seconds) / 60);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m
    ? `about ${hours} ${m} minute${m === 1 ? '' : 's'}`
    : `about ${hours}`;
}

export interface HowFar {
  state: 'not started' | 'part way' | 'finished';
  /** "about 42 minutes in", when part way */
  watched?: string;
  /** "about 54 minutes left", when part way and the length is known */
  left?: string;
}

export function howFar(item: PersonalItem, rules: ResumeRules): HowFar {
  if (item.played) return { state: 'finished' };
  if (!resumable(item, rules)) return { state: 'not started' };
  const at = toSeconds(item.positionTicks);
  const length = item.runtimeTicks ? toSeconds(item.runtimeTicks) : 0;
  return {
    state: 'part way',
    watched: `${roughly(at)} in`,
    left: length > at ? `${roughly(length - at)} left` : undefined,
  };
}

/**
 * The sentence added after "Playing X on the TV", saying where it started
 * and why — and never claiming a TV picked up part way when it cannot.
 */
export function startNote(p: {
  start: StartPoint | null;
  canResume: boolean;
  linked: boolean;
  from: From;
}): string {
  if (!p.linked) {
    return p.from === 'resume'
      ? " I can't see where you left off — your viewing isn't linked to " +
          "you yet — so it's starting from the beginning."
      : '';
  }
  if (!p.start) return '';
  const at = `${roughly(p.start.startSeconds)} in`;
  switch (p.start.why) {
    case 'resuming':
      return p.canResume
        ? ` Picking up where you left off, ${at}.`
        : ` That TV can only start from the beginning — you were ${at}.`;
    case 'asked to start over':
      return ' Starting from the beginning, as asked.';
    case 'watched already, starting again':
      return p.from === 'resume'
        ? " You finished it last time, so it's starting from the beginning."
        : '';
    case 'nothing to resume':
      return p.start.item.played
        ? " You finished it last time, so it's starting from the beginning."
        : " There's nowhere to pick up from, so it's starting from the beginning.";

    default:
      return '';
  }
}
