// Where to start something, for one person. Pure functions over what
// Jellyfin has recorded — no network, no disk — so every rule is testable.
//
// Jellyfin keeps the watch history; nothing here stores any. These only
// decide, from Jellyfin's record, what "play", "continue" and "start over"
// should mean for this person right now.

import type { PersonalItem, ResumeRules } from './jellyfin.service';

export type From = 'auto' | 'resume' | 'start';

export interface StartPoint {
  item: PersonalItem;
  /** where to begin, in seconds; 0 is the beginning */
  startSeconds: number;
  why:
    | 'resuming'
    | 'from the beginning'
    | 'watched already, starting again'
    | 'asked to start over'
    | 'nothing to resume'
    | 'next episode'
    | 'first episode';
}

const TICKS_PER_SECOND = 10_000_000;

export const toSeconds = (ticks: number) =>
  Math.floor(ticks / TICKS_PER_SECOND);

/**
 * Is there a position here worth going back to? Jellyfin only keeps one
 * between its own thresholds and marks an item played past the upper one,
 * so this mostly agrees with what Jellyfin stored; it also guards against a
 * stored position that falls outside the rules as they are configured now.
 */
export function resumable(item: PersonalItem, rules: ResumeRules): boolean {
  if (item.played || item.positionTicks <= 0) return false;
  const runtime = item.runtimeTicks ?? 0;
  if (!runtime) return true; // no runtime to judge by: trust what was saved
  if (runtime / TICKS_PER_SECOND < rules.minResumeDurationSeconds) return false;
  const pct = (item.positionTicks / runtime) * 100;
  return pct >= rules.minResumePct && pct < rules.maxResumePct;
}

/**
 * A film (or one named episode).
 *   play, partly watched      -> resume
 *   play, never / finished    -> the beginning
 *   start over                -> the beginning, always
 *   continue, partly watched  -> resume
 *   continue, nothing saved   -> the beginning, and say so
 */
export function startFor(
  item: PersonalItem,
  from: From,
  rules: ResumeRules,
): StartPoint {
  if (from === 'start') {
    return { item, startSeconds: 0, why: 'asked to start over' };
  }
  if (resumable(item, rules)) {
    return {
      item,
      startSeconds: toSeconds(item.positionTicks),
      why: 'resuming',
    };
  }
  if (from === 'resume') {
    return { item, startSeconds: 0, why: 'nothing to resume' };
  }
  return {
    item,
    startSeconds: 0,
    why: item.played ? 'watched already, starting again' : 'from the beginning',
  };
}

const isSpecial = (e: PersonalItem) => (e.seasonNumber ?? 0) === 0;

/** Episodes in the order they are meant to be watched, specials left out —
 * nobody means a special when they say "the next one". */
export function inOrder(episodes: PersonalItem[]): PersonalItem[] {
  return episodes
    .filter((e) => !isSpecial(e))
    .sort(
      (a, b) =>
        (a.seasonNumber ?? 0) - (b.seasonNumber ?? 0) ||
        (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0),
    );
}

/**
 * A show, for one person:
 *   1. an episode they are part way through is resumed
 *   2. otherwise the next one Jellyfin says is up — trusted as given, so a
 *      special is only ever chosen when Jellyfin itself chose it
 *   3. otherwise the first unwatched episode after the last one they
 *      finished, specials excluded
 *   4. never watched at all: the first episode of the first season
 * "start over" means the very first episode, from the top.
 * Returns null when every episode has been watched.
 */
export function seriesStart(
  input: {
    resuming: PersonalItem[]; // in-progress episodes of this show, newest first
    nextUp: PersonalItem | null;
    episodes: PersonalItem[];
  },
  from: From,
  rules: ResumeRules,
): StartPoint | null {
  const ordered = inOrder(input.episodes);
  if (!ordered.length) return null;

  if (from === 'start') {
    return { item: ordered[0], startSeconds: 0, why: 'asked to start over' };
  }

  const partly = input.resuming.find((e) => resumable(e, rules));
  if (partly) {
    return {
      item: partly,
      startSeconds: toSeconds(partly.positionTicks),
      why: 'resuming',
    };
  }

  if (input.nextUp && !input.nextUp.played) {
    const up = input.nextUp;
    return resumable(up, rules)
      ? { item: up, startSeconds: toSeconds(up.positionTicks), why: 'resuming' }
      : { item: up, startSeconds: 0, why: 'next episode' };
  }

  const watched = ordered.filter((e) => e.played);
  if (!watched.length) {
    return { item: ordered[0], startSeconds: 0, why: 'first episode' };
  }
  const last = watched[watched.length - 1];
  const after = ordered.slice(ordered.indexOf(last) + 1).find((e) => !e.played);
  return after ? { item: after, startSeconds: 0, why: 'next episode' } : null;
}

/** Has this person been anywhere near it: started, part watched or finished. */
const touched = (e: PersonalItem) =>
  !!e.lastPlayed || e.played || e.positionTicks > 0;

/**
 * The episode someone is on: the regular episode they watched most
 * recently, whether they finished it or not. Specials never count — they
 * sit outside the order, so there is no "next" after one.
 */
export function currentEpisode(episodes: PersonalItem[]): PersonalItem | null {
  const ordered = inOrder(episodes);
  let best: PersonalItem | null = null;
  for (const e of ordered.filter(touched)) {
    // most recent wins; with no dates to go on, the later episode does
    if (!best || (e.lastPlayed ?? '') >= (best.lastPlayed ?? '')) best = e;
  }
  return best;
}

/**
 * "Play the next episode": one on from the episode they are on, from the
 * beginning — even when the one they are on is only part watched, since
 * picking that back up is what "continue" is for. Crosses into the next
 * season, never chooses a special, and never wraps round: at the end of
 * what is in the library it returns null.
 */
export function nextEpisodeStart(episodes: PersonalItem[]): StartPoint | null {
  const ordered = inOrder(episodes);
  if (!ordered.length) return null;
  const current = currentEpisode(episodes);
  if (!current) {
    return { item: ordered[0], startSeconds: 0, why: 'first episode' };
  }
  const next = ordered[ordered.indexOf(current) + 1];
  return next ? { item: next, startSeconds: 0, why: 'next episode' } : null;
}

/** One named episode, including a special when it is named. */
export function episodeStart(
  episodes: PersonalItem[],
  season: number,
  episode: number,
  from: From,
  rules: ResumeRules,
): StartPoint | null {
  const hit = episodes.find(
    (e) => e.seasonNumber === season && e.episodeNumber === episode,
  );
  return hit ? startFor(hit, from, rules) : null;
}
