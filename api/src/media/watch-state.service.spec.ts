import type { PersonalItem } from './jellyfin.service';
import { WatchStateService } from './watch-state.service';

const MIN = 60 * 10_000_000;
const RULES = {
  minResumePct: 5,
  maxResumePct: 90,
  minResumeDurationSeconds: 300,
};

// three Circuit Barn people; two linked, one not. Jellyfin holds a
// different position on the same film for each of the two linked people
function build() {
  const users: any[] = [
    { id: 'u-tyler', displayName: 'Tyler', jellyfinUserId: 'jf-tyler' },
    { id: 'u-bray', displayName: 'Bray', jellyfinUserId: 'jf-bray' },
    { id: 'u-emile', displayName: 'Emile', jellyfinUserId: null },
  ];
  const saved: Record<string, number> = {
    'jf-tyler': 40 * MIN,
    'jf-bray': 10 * MIN,
  };
  const asked: string[] = [];
  const film = (person: string): PersonalItem => ({
    id: 'notld',
    name: 'Night of the Living Dead',
    type: 'Movie',
    runtimeTicks: 96 * MIN,
    positionTicks: saved[person] ?? 0,
    played: false,
    playCount: 0,
  });

  const prisma: any = {
    user: {
      findUnique: jest.fn(
        async ({ where }: any) => users.find((u) => u.id === where.id) ?? null,
      ),
      findMany: jest.fn(async () => users),
      findFirst: jest.fn(
        async ({ where }: any) =>
          users.find(
            (u) =>
              u.jellyfinUserId === where.jellyfinUserId &&
              u.id !== where.NOT.id,
          ) ?? null,
      ),
      update: jest.fn(async ({ where, data }: any) => {
        Object.assign(
          users.find((u) => u.id === where.id),
          data,
        );
      }),
    },
  };
  const jellyfin: any = {
    forPerson: jest.fn(async (person: string) => {
      asked.push(person);
      return [film(person)];
    }),
    resumeFor: jest.fn(async (person: string) => {
      asked.push(person);
      return saved[person] ? [film(person)] : [];
    }),
    nextUpFor: jest.fn(async () => null),
    episodesFor: jest.fn(async () => []),
    recentFor: jest.fn(async (person: string) => {
      asked.push(person);
      return [];
    }),
    resumeRules: jest.fn(async () => RULES),
    accounts: jest.fn(async () => [
      { id: 'jf-tyler', name: 'tyler', admin: true },
      { id: 'jf-bray', name: 'Bray', admin: false },
      { id: 'jf-emile', name: 'Emile', admin: false },
      { id: 'jf-room', name: 'Bray Room', admin: false },
    ]),
  };
  return { svc: new WatchStateService(prisma, jellyfin), users, asked };
}

describe('whose progress it is', () => {
  it("answers from each person's own account", async () => {
    const { svc } = build();

    expect(
      (await svc.itemStart('u-tyler', 'notld', 'auto'))!.startSeconds,
    ).toBe(40 * 60);
    expect((await svc.itemStart('u-bray', 'notld', 'auto'))!.startSeconds).toBe(
      10 * 60,
    );
  });

  it('only ever asks Jellyfin about the person who is asking', async () => {
    const { svc, asked } = build();

    await svc.itemStart('u-bray', 'notld', 'auto');
    await svc.inProgress('u-bray');
    await svc.recent('u-bray');

    expect(new Set(asked)).toEqual(new Set(['jf-bray']));
  });

  it('gives someone with no linked account nothing personal at all', async () => {
    const { svc, asked } = build();

    expect(await svc.itemStart('u-emile', 'notld', 'auto')).toBeNull();
    expect(await svc.inProgress('u-emile')).toBeNull();
    expect(await svc.recent('u-emile')).toBeNull();
    expect(await svc.showStart('u-emile', 'office', 'auto')).toBeNull();
    // and in particular, nobody else's history — not even a room's
    expect(asked).toEqual([]);
  });

  it('has no idea which TV is involved, and needs none', async () => {
    const { svc } = build();
    // the method takes a person and an item; there is nowhere to put a TV
    expect(svc.itemStart.length).toBe(3);
  });
});

describe('linking a person to their own Jellyfin account', () => {
  it('links, and reports the account by name', async () => {
    const { svc } = build();

    const out = await svc.link('u-emile', 'jf-emile');

    expect(out.people.find((p) => p.name === 'Emile')!.jellyfinAccount).toBe(
      'Emile',
    );
  });

  it('refuses an account that does not exist', async () => {
    const { svc } = build();
    await expect(svc.link('u-emile', 'jf-nobody')).rejects.toThrow(
      /No such Jellyfin account/,
    );
  });

  it('refuses an account that is already someone else', async () => {
    const { svc } = build();
    await expect(svc.link('u-emile', 'jf-bray')).rejects.toThrow(
      /already Bray's/,
    );
  });

  it('can unlink someone, who then gets no personal answers', async () => {
    const { svc } = build();
    await svc.link('u-bray', null);
    expect(await svc.itemStart('u-bray', 'notld', 'auto')).toBeNull();
  });

  it('never sends Jellyfin passwords or tokens anywhere', async () => {
    const { svc } = build();
    const out = JSON.stringify(await svc.people());
    expect(out).not.toMatch(/password|token|apikey|api_key/i);
  });
});
