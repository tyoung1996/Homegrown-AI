/**
 * A stop request is done and answered before the model ever sees the
 * message; anything else goes on to the model exactly as before.
 */
import { ChatService, StreamEvent } from './chat.service';

function build(
  handled: { action: string; outcome: string; reply: string } | null,
) {
  const order: string[] = [];
  const saved: { role: string; content: string }[] = [];
  const prisma = {
    conversation: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'c1' })),
      update: jest.fn(async () => ({})),
    },
    message: {
      create: jest.fn(
        async ({ data }: { data: { role: string; content: string } }) => {
          order.push(`saved ${data.role}`);
          saved.push(data);
          return data;
        },
      ),
      // only the model path reads the history back
      findMany: jest.fn(async () => {
        order.push('model path');
        throw new Error('reached the model');
      }),
    },
  };
  const actions = {
    handle: jest.fn(async () => {
      order.push('action ran');
      return handled;
    }),
  };
  const chat = new ChatService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    actions as never,
  );
  const events: StreamEvent[] = [];
  const send = (message: string) =>
    chat.sendStream('ann', message, undefined, undefined, (e) =>
      events.push(e),
    );
  return { send, events, order, saved, actions };
}

const REAL_FETCH = global.fetch;
afterEach(() => {
  global.fetch = REAL_FETCH;
});

describe('a verified action in the chat', () => {
  it('is done first, answered from its result, and the model is never asked', async () => {
    global.fetch = jest.fn(() => {
      throw new Error('the model must not be called');
    }) as never;
    const w = build({
      action: 'stop',
      outcome: 'stopped',
      reply: "Stopped playback on the TV in Kim and Sam's room.",
    });

    await w.send("Turn off the TV in Kim and Sam's room");

    expect(w.order).toEqual(['saved user', 'action ran', 'saved assistant']);
    expect(w.saved.at(-1)).toEqual({
      conversationId: 'c1',
      role: 'assistant',
      content: "Stopped playback on the TV in Kim and Sam's room.",
    });
    expect(w.events).toEqual([
      { type: 'meta', conversationId: 'c1' },
      {
        type: 'token',
        text: "Stopped playback on the TV in Kim and Sam's room.",
      },
      { type: 'done' },
    ]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('a failure is reported as a failure', async () => {
    const w = build({
      action: 'stop',
      outcome: 'still-playing',
      reply:
        "I couldn't stop playback on the TV in Kim and Sam's room — I told it to stop, but it's still playing.",
    });
    await w.send("Stop Kim and Sam's room");
    expect(w.events[1]).toEqual({
      type: 'token',
      text: "I couldn't stop playback on the TV in Kim and Sam's room — I told it to stop, but it's still playing.",
    });
  });

  it('anything it does not handle goes on to the model as before', async () => {
    const w = build(null);
    await expect(w.send("Don't stop Kim and Sam's TV")).rejects.toThrow(
      'reached the model',
    );
    expect(w.actions.handle).toHaveBeenCalledWith({
      userId: 'ann',
      conversationId: 'c1',
      message: "Don't stop Kim and Sam's TV",
    });
    expect(w.order).toEqual(['saved user', 'action ran', 'model path']);
  });
});
