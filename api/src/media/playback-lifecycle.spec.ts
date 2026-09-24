import {
  GRACE_MS,
  Observation,
  PlaybackRecord,
  STARTUP_WINDOW_MS,
  judge,
  validPosition,
} from './playback-lifecycle';

const T0 = new Date('2026-09-24T12:00:00Z').getTime();
const at = (ms: number) => new Date(T0 + ms);
const PB = '0123456789abcdef';

const rec = (over: Partial<PlaybackRecord> = {}): PlaybackRecord => ({
  id: PB,
  itemId: 'film',
  screenId: 'cast:1',
  state: 'ACTIVE',
  startedAt: at(0),
  lastSeenAt: at(30_000),
  ...over,
});
const look = (over: Partial<Observation> = {}): Observation => ({
  screenId: 'cast:1',
  at: at(60_000),
  state: 'playing',
  itemId: 'film',
  playbackId: PB,
  positionSeconds: 600,
  durationSeconds: 5744,
  ...over,
});

describe('judging one look', () => {
  it('counts only the same playback of the same film', () => {
    expect(judge(rec(), look(), at(60_000))).toEqual({
      act: 'progress',
      position: 600,
      paused: false,
    });
    expect(
      judge(rec(), look({ playbackId: 'ffffffffffffffff' }), at(60_000)),
    ).toEqual({
      act: 'close',
      reason: 'different-playback',
    });
    expect(judge(rec(), look({ playbackId: undefined }), at(60_000))).toEqual({
      act: 'close',
      reason: 'different-playback',
    });
    expect(judge(rec(), look({ itemId: 'other' }), at(60_000))).toEqual({
      act: 'close',
      reason: 'different-media',
    });
  });

  it('never moves a closed playback', () => {
    for (const state of ['playing', 'paused', 'stopped', 'idle'] as const) {
      expect(
        judge(rec({ state: 'CLOSED' }), look({ state }), at(60_000)).act,
      ).toBe('wait');
    }
  });

  it('ignores a look at another TV', () => {
    expect(judge(rec(), look({ screenId: 'dlna:2' }), at(60_000)).act).toBe(
      'wait',
    );
  });

  it('ignores a look no newer than the last one', () => {
    expect(judge(rec(), look({ at: at(30_000) }), at(60_000)).act).toBe('wait');
    expect(judge(rec(), look({ at: at(10_000) }), at(60_000)).act).toBe('wait');
  });

  it('while starting, only a confirming look counts', () => {
    const starting = rec({ state: 'STARTING', lastSeenAt: null });
    for (const o of [
      look({ state: 'stopped' }),
      look({ state: 'idle' }),
      look({ playbackId: 'ffffffffffffffff' }),
      look({ itemId: 'other' }),
      look({ positionSeconds: undefined }),
    ]) {
      expect(judge(starting, o, at(60_000)).act).toBe('wait');
    }
    expect(judge(starting, look({ state: 'paused' }), at(60_000)).act).toBe(
      'progress',
    );
    expect(
      judge(starting, look({ state: 'idle' }), at(STARTUP_WINDOW_MS + 1)),
    ).toEqual({
      act: 'close',
      reason: 'never-started',
    });
  });

  it('waits out an unreachable TV for exactly the grace period', () => {
    const quiet = look({
      state: 'unknown',
      itemId: undefined,
      playbackId: undefined,
    });
    expect(judge(rec(), quiet, at(30_000 + GRACE_MS)).act).toBe('wait');
    expect(judge(rec(), quiet, at(30_000 + GRACE_MS + 1))).toEqual({
      act: 'close',
      reason: 'lost',
    });
    expect(judge(rec(), look({ state: 'buffering' }), at(60_000)).act).toBe(
      'wait',
    );
  });

  it('closes on stopped and idle', () => {
    expect(judge(rec(), look({ state: 'stopped' }), at(60_000))).toEqual({
      act: 'close',
      reason: 'stopped',
    });
    expect(judge(rec(), look({ state: 'idle' }), at(60_000))).toEqual({
      act: 'close',
      reason: 'idle',
    });
  });
});

describe('believable positions', () => {
  it.each([
    [600, 5744, 600],
    [600.9, 5744, 600],
    [0, 5744, 0],
    [5800, 5744, 5800], // a little past the stated end is fine
    [5900, 5744, null],
    [-1, 5744, null],
    [NaN, 5744, null],
    [Infinity, undefined, null],
    [undefined, 5744, null],
    [600, undefined, 600],
  ])('%p of %p -> %p', (p, d, want) => {
    expect(
      validPosition({
        state: 'playing',
        positionSeconds: p,
        durationSeconds: d,
      }),
    ).toBe(want);
  });
});
