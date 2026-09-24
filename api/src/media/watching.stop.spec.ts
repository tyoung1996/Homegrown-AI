/**
 * Stopping a TV and finding out whether it really stopped. The TVs here
 * say whatever each test tells them to, in order.
 */
import { WatchingService } from './watching.service';
import type { PlaybackState, Screen } from './screens.service';

const cast: Screen = {
  id: 'cast:1',
  name: 'Kids room',
  kind: 'cast',
  ready: false,
};
const roku: Screen = { id: 'roku:3', name: 'Den', kind: 'roku', ready: false };
const playing: PlaybackState = {
  state: 'playing',
  itemId: 'x',
  playbackId: 'a',
  positionSeconds: 300,
};

function build(
  looks: PlaybackState[],
  stop: () => Promise<string> = async () => 'Stopped',
) {
  let i = 0;
  const screens = {
    // each look takes the next state; the last one repeats
    nowPlaying: jest.fn(async () => looks[Math.min(i++, looks.length - 1)]),
    stop: jest.fn(stop),
    find: jest.fn(async () => cast),
  };
  const tracker = {
    // the real tracker's contract: stop, then confirm, and say which
    stopConfirmed: jest.fn(
      async (
        _s: Screen,
        doStop: () => Promise<unknown>,
        confirm: () => Promise<string>,
      ) => {
        await doStop();
        const seen = await confirm();
        return seen === 'stopped'
          ? 'stopped'
          : seen === 'playing'
            ? 'still-playing'
            : 'unconfirmed';
      },
    ),
    refresh: jest.fn(async () => undefined),
    stop: jest.fn(async (_s: Screen, doStop: () => Promise<string>) =>
      doStop(),
    ),
  };
  const service = new WatchingService(
    screens as never,
    {} as never,
    {} as never,
    tracker as never,
  );
  service.confirmEveryMs = 0;
  return { service, screens, tracker };
}

describe('stopping a TV, and checking it stopped', () => {
  it('playing, told to stop, then idle: stopped', async () => {
    const w = build([playing, playing, { state: 'idle' }]);
    expect(await w.service.stopConfirmed(cast)).toBe('stopped');
    expect(w.screens.stop).toHaveBeenCalledTimes(1);
  });

  it('already stopped: nothing is sent, and what was open is looked at', async () => {
    const w = build([{ state: 'idle' }]);
    expect(await w.service.stopConfirmed(cast)).toBe('nothing-playing');
    expect(w.screens.stop).not.toHaveBeenCalled();
    expect(w.tracker.refresh).toHaveBeenCalledWith('cast:1');
  });

  it('unreachable: nothing is sent', async () => {
    const w = build([{ state: 'unknown', detail: 'EHOSTUNREACH' }]);
    expect(await w.service.stopConfirmed(cast)).toBe('unreachable');
    expect(w.screens.stop).not.toHaveBeenCalled();
  });

  it('the stop itself fails: failed', async () => {
    const w = build([playing], async () => {
      throw new Error('socket hang up');
    });
    expect(await w.service.stopConfirmed(cast)).toBe('failed');
  });

  it('the stop goes through but the TV keeps playing: still playing, not stopped', async () => {
    const w = build([playing]);
    expect(await w.service.stopConfirmed(cast)).toBe('still-playing');
    expect(w.screens.nowPlaying.mock.calls.length).toBeGreaterThan(2);
  });

  it('the stop goes through and then the TV goes quiet: unconfirmed', async () => {
    const w = build([playing, { state: 'unknown' }]);
    expect(await w.service.stopConfirmed(cast)).toBe('unconfirmed');
  });

  it('a Roku cannot be asked: told, and said to be unchecked', async () => {
    const w = build([{ state: 'unknown' }]);
    expect(await w.service.stopConfirmed(roku)).toBe('unverifiable');
    expect(w.screens.stop).toHaveBeenCalled();
  });
});
