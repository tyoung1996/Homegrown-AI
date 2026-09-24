// What one look at a TV means for one playback this app started. Pure: no
// network, no database, so every rule about when a playback counts, when it
// is over, and when to keep waiting is testable on its own.
//
// A playback only ever moves forward: STARTING -> ACTIVE -> CLOSED, or
// STARTING -> CLOSED. Nothing here can move a closed one anywhere.

import type { PlaybackState as TvState } from './screens.service';

/** how often the TVs are looked at */
export const POLL_MS = 30_000;
/** how long a new playback has to show up on its TV before it is given up */
export const STARTUP_WINDOW_MS = 90_000;
/**
 * How long a TV that has gone quiet — unreachable, or not saying where it
 * is — keeps its playback open. Long enough to ride out a Wi-Fi blip or a
 * slow receiver; short enough that Jellyfin, which gives up on a silent
 * session after about five minutes of its own, is never told more than the
 * TV last confirmed.
 */
export const GRACE_MS = 5 * 60_000;
/** how long the final position of a closed playback is retried */
export const SETTLE_WINDOW_MS = 60 * 60_000;
/** how long closed, settled playbacks are kept before they are removed */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
/** a position may run this far past what the TV says the length is */
const LENGTH_SLACK_SECONDS = 60;

export type Lifecycle = 'STARTING' | 'ACTIVE' | 'CLOSED';

export type CloseReason =
  | 'stopped' // the TV reports it stopped
  | 'idle' // nothing of ours open on the TV at all
  | 'different-playback' // the TV is playing another of our playbacks
  | 'different-media' // the TV is playing something else entirely
  | 'stopped-by-app' // someone stopped it from Circuit Barn
  | 'replaced' // Circuit Barn put something newer on the same TV
  | 'superseded' // the same person started the same film again elsewhere
  | 'lost' // the TV stayed quiet past the grace period
  | 'never-started' // the TV never showed it playing
  | 'failed-to-start' // the TV refused it outright
  | 'unlinked'; // the person's Jellyfin account changed or was removed

export interface PlaybackRecord {
  id: string;
  itemId: string;
  screenId: string;
  state: Lifecycle;
  startedAt: Date;
  lastSeenAt: Date | null;
}

/** One look at a TV, and which TV it was. */
export interface Observation extends TvState {
  screenId: string;
  at: Date;
}

export type Verdict =
  | { act: 'progress'; position: number; paused: boolean }
  | { act: 'close'; reason: CloseReason }
  | { act: 'wait'; why: string };

/** A position worth believing: a real number, not negative, and not far
 * past the end of what the TV says it is playing. */
export function validPosition(obs: TvState): number | null {
  const p = obs.positionSeconds;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) return null;
  const length = obs.durationSeconds;
  if (
    typeof length === 'number' &&
    length > 0 &&
    p > length + LENGTH_SLACK_SECONDS
  ) {
    return null;
  }
  return Math.floor(p);
}

export function judge(
  rec: PlaybackRecord,
  obs: Observation,
  now: Date,
): Verdict {
  if (rec.state === 'CLOSED') return { act: 'wait', why: 'closed for good' };
  // a look at some other TV says nothing about this playback
  if (obs.screenId !== rec.screenId) {
    return { act: 'wait', why: 'not its TV' };
  }
  // never let an older look overwrite a newer one
  if (rec.lastSeenAt && obs.at.getTime() <= rec.lastSeenAt.getTime()) {
    return { act: 'wait', why: 'older than what is known' };
  }

  // the TV has gone quiet: keep waiting, up to a point
  const quiet = (why: string): Verdict => {
    const since = (rec.lastSeenAt ?? rec.startedAt).getTime();
    const limit = rec.state === 'STARTING' ? STARTUP_WINDOW_MS : GRACE_MS;
    if (now.getTime() - since > limit) {
      return {
        act: 'close',
        reason: rec.state === 'STARTING' ? 'never-started' : 'lost',
      };
    }
    return { act: 'wait', why };
  };

  const ours = obs.playbackId === rec.id && obs.itemId === rec.itemId;
  const running = obs.state === 'playing' || obs.state === 'paused';
  const position = validPosition(obs);

  // until the TV has been seen playing it, nothing else it says counts
  // against it: straight after a start a TV can still be showing what it
  // had before, or be idle while it loads
  if (rec.state === 'STARTING') {
    if (ours && running && position !== null) {
      return { act: 'progress', position, paused: obs.state === 'paused' };
    }
    return quiet('not showing yet');
  }

  if (obs.state === 'unknown') return quiet('TV not answering');
  if (obs.state === 'buffering') return quiet('TV buffering');
  if (obs.state === 'idle') return { act: 'close', reason: 'idle' };
  if (obs.state === 'stopped') return { act: 'close', reason: 'stopped' };

  // playing or paused, and certainly something
  if (!ours) {
    return {
      act: 'close',
      reason:
        obs.itemId === rec.itemId ? 'different-playback' : 'different-media',
    };
  }
  if (position === null) return quiet('position not known');
  return { act: 'progress', position, paused: obs.state === 'paused' };
}
