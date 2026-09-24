/**
 * The stop action: which TV, and what to say — with the real TV resolver,
 * the real registry, and a stop whose result each test decides.
 */
import { ScreensService, Screen } from '../../media/screens.service';
import type { StopOutcome } from '../../media/watching.service';
import { StopAction } from './stop.action';
import { VerifiedActions } from './verified-action';

const KS: Screen = {
  id: 'cast:1',
  name: "Kim and Sam's room",
  kind: 'cast',
  ready: false,
};
const LIVING: Screen = {
  id: 'dlna:2',
  name: 'Living room',
  kind: 'dlna',
  ready: false,
};
const DEN: Screen = { id: 'roku:3', name: 'Den', kind: 'roku', ready: false };

function build(
  opts: {
    outcome?: StopOutcome;
    playing?: { userId: string; screenId: string }[];
    said?: string[]; // this conversation, newest first
  } = {},
) {
  const screens = new ScreensService({ sessions: async () => [] } as never);
  (screens as unknown as { scan: unknown }).scan = {
    at: Date.now(),
    found: [KS, LIVING, DEN],
  };
  const watching = {
    stopConfirmed: jest.fn(
      async (...a: [Screen]) => (a[0] && opts.outcome) || 'stopped',
    ),
  };
  const prisma = {
    playback: {
      findMany: jest.fn(async ({ where }: { where: { userId: string } }) =>
        (opts.playing ?? []).filter((p) => p.userId === where.userId),
      ),
    },
    message: {
      findMany: jest.fn(async () =>
        (opts.said ?? []).map((content) => ({ content })),
      ),
    },
  };
  const stop = new StopAction(screens, watching as never, prisma as never);
  const actions = new VerifiedActions([stop]);
  const ask = (message: string) =>
    actions.handle({ userId: 'ann', conversationId: 'c1', message });
  const stoppedOn = () =>
    watching.stopConfirmed.mock.calls.map((c) => c[0].name);
  return { ask, stoppedOn, watching };
}

describe('stopping the TV they named', () => {
  it.each([
    "Stop Kim and Sam's room",
    "Stop the TV in Kim and Sam's room",
    "Turn off the TV in Kim and Sam's room",
    "Turn Kim and Sam's TV off",
    "Stop playing in Kim and Sam's room",
    "Stop playback on Kim and Sam's TV",
    'hey, could you PLEASE stop the TV in Kim and Sam’s room now, thanks!',
  ])('%s', async (said) => {
    const w = build();
    expect(await w.ask(said)).toEqual({
      action: 'stop',
      outcome: 'stopped',
      reply: "Stopped playback on the TV in Kim and Sam's room.",
    });
    expect(w.stoppedOn()).toEqual(["Kim and Sam's room"]);
  });

  it('stops only the one named, when several are playing', async () => {
    const w = build({
      playing: [
        { userId: 'ann', screenId: KS.id },
        { userId: 'ann', screenId: LIVING.id },
      ],
    });
    await w.ask('Stop the TV in the living room');
    expect(w.stoppedOn()).toEqual(['Living room']);
  });

  it('says so when there is no TV by that name, and stops nothing', async () => {
    const w = build();
    const got = await w.ask('Stop the TV in the attic');
    expect(got?.outcome).toBe('unknown-tv');
    expect(got?.reply).toBe(
      'I couldn\'t find a TV called "the attic". I can see: Kim and Sam\'s room, Living room, Den.',
    );
    expect(w.stoppedOn()).toEqual([]);
  });
});

describe('stopping with no TV named', () => {
  it('uses the one TV this person has something playing on', async () => {
    const w = build({ playing: [{ userId: 'ann', screenId: LIVING.id }] });
    expect((await w.ask('Stop the movie'))?.reply).toBe(
      'Stopped playback on the TV in Living room.',
    );
  });

  it('asks when this person has more than one TV going', async () => {
    const w = build({
      playing: [
        { userId: 'ann', screenId: KS.id },
        { userId: 'ann', screenId: LIVING.id },
      ],
    });
    const got = await w.ask('Stop playback');
    expect(got?.outcome).toBe('which-tv');
    expect(got?.reply).toMatch(/^Which TV do you want me to stop\?/);
    expect(w.stoppedOn()).toEqual([]);
  });

  it("never picks someone else's playback", async () => {
    const w = build({ playing: [{ userId: 'ben', screenId: KS.id }] });
    expect((await w.ask('Stop the show'))?.outcome).toBe('which-tv');
    expect(w.stoppedOn()).toEqual([]);
  });

  it('uses the TV this conversation was just about', async () => {
    const w = build({
      said: [
        'Stop the show',
        "Playing The Lighthouse on Kim and Sam's room. Picking up where you left off.",
      ],
    });
    await w.ask('Stop the show');
    expect(w.stoppedOn()).toEqual(["Kim and Sam's room"]);
  });

  it('asks when the conversation and what is playing disagree', async () => {
    const w = build({
      said: ["Playing it on Kim and Sam's room"],
      playing: [{ userId: 'ann', screenId: LIVING.id }],
    });
    expect((await w.ask('Turn the TV off'))?.outcome).toBe('which-tv');
    expect(w.stoppedOn()).toEqual([]);
  });

  it('asks when the conversation mentioned two TVs at once', async () => {
    const w = build({ said: ["Kim and Sam's room or the Living room?"] });
    expect((await w.ask('Stop playback'))?.outcome).toBe('which-tv');
  });
});

describe('saying what really happened', () => {
  it.each<[StopOutcome, string]>([
    ['stopped', "Stopped playback on the TV in Kim and Sam's room."],
    ['nothing-playing', "Nothing is playing on the TV in Kim and Sam's room."],
    ['unreachable', "I couldn't reach the TV in Kim and Sam's room."],
    ['failed', "I couldn't stop playback on the TV in Kim and Sam's room."],
    [
      'still-playing',
      "I couldn't stop playback on the TV in Kim and Sam's room — I told it to stop, but it's still playing.",
    ],
    [
      'unconfirmed',
      "I told the TV in Kim and Sam's room to stop, but then it stopped answering, so I can't be sure it did.",
    ],
  ])('%s', async (outcome, reply) => {
    const w = build({ outcome });
    expect(await w.ask("Stop Kim and Sam's room")).toEqual({
      action: 'stop',
      outcome,
      reply,
    });
  });

  it('a TV that cannot be asked is told, and the reply says it was not checked', async () => {
    const w = build({ outcome: 'unverifiable' });
    expect((await w.ask('Stop the Den'))?.reply).toBe(
      "I've told Den to stop, but that TV can't tell me whether it did.",
    );
  });
});

describe('leaving everything else to the conversation', () => {
  it.each([
    "Don't stop Kim and Sam's TV",
    'Do not stop the TV',
    "Don't turn the TV off",
    "I don't want you to stop the movie",
    // taken back or questioned after the request itself
    "Stop the TV in Kim and Sam's room? No, don't!",
    "Stop Kim and Sam's room — actually no",
    "Stop the TV in Kim and Sam's room, would it be ok?",
    "Stop Kim and Sam's room, what happens then?",
    "Can you tell me how to stop Kim and Sam's TV?",
    'What happens if I turn the TV off?',
    'Stop being silly',
    'Stop, what time is it?',
    'Turn off the lights',
    "I'm off to bed",
    'What should we watch tonight?',
  ])('"%s" is not handled and stops nothing', async (said) => {
    const w = build({ playing: [{ userId: 'ann', screenId: KS.id }] });
    expect(await w.ask(said)).toBeNull();
    expect(w.stoppedOn()).toEqual([]);
  });
});

describe('the registry', () => {
  it('tries each action in turn, and a hand-back falls through', async () => {
    const never = {
      name: 'never',
      recognise: () => null,
      perform: jest.fn(),
    };
    const declines = {
      name: 'declines',
      recognise: () => ({}),
      perform: jest.fn(async () => null),
    };
    const takes = {
      name: 'takes',
      recognise: () => ({}),
      perform: jest.fn(async () => ({
        action: 'takes',
        outcome: 'ok',
        reply: 'Done.',
      })),
    };
    const reg = new VerifiedActions([never, declines, takes]);
    expect(
      await reg.handle({ userId: 'u', conversationId: 'c', message: 'x' }),
    ).toEqual({ action: 'takes', outcome: 'ok', reply: 'Done.' });
    expect(never.perform).not.toHaveBeenCalled();
    expect(declines.perform).toHaveBeenCalled();
    expect(
      await new VerifiedActions([never]).handle({
        userId: 'u',
        conversationId: 'c',
        message: 'x',
      }),
    ).toBeNull();
  });
});
