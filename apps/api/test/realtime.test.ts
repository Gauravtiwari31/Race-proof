import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  clientFor,
  newHackathon,
  newInvite,
  newTeam,
  newUser,
  startServer,
  type Server,
  type TestUser,
} from './helpers.js';
import { startReplica, type Replica } from './replica.js';

let api: Server;

beforeAll(async () => {
  api = await startServer();
});
afterAll(() => api.stop());

interface StreamEvent {
  id: string | null;
  event: string;
  data: any;
}

/** A minimal SSE client over fetch, so a test can send a cookie and Last-Event-ID. */
async function openStream(baseUrl: string, query: string, user: TestUser, lastEventId?: number) {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/events?${query}`, {
    headers: { cookie: user.cookie, ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) },
    signal: controller.signal,
  });
  const received: StreamEvent[] = [];
  const waiters: Array<() => void> = [];
  void (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (block.startsWith(':')) continue;
          const field = (name: string) => block.split('\n').find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2) ?? null;
          received.push({ id: field('id'), event: field('event') ?? 'message', data: JSON.parse(field('data') ?? 'null') });
          waiters.splice(0).forEach((wake) => wake());
        }
      }
    } catch {
      // aborted by the test
    }
  })();

  return {
    status: res.status,
    received,
    close: () => controller.abort(),
    async waitFor(predicate: (e: StreamEvent) => boolean, timeoutMs = 3000): Promise<StreamEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find(predicate);
        if (found) return found;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no matching event; saw ${JSON.stringify(received.map((e) => e.data?.action ?? e.event))}`);
        await Promise.race([
          new Promise<void>((wake) => waiters.push(wake)),
          new Promise((wake) => setTimeout(wake, left)),
        ]);
      }
    },
  };
}

describe('server-sent events', () => {
  it('sse.requires-auth: no session, no stream', async () => {
    const res = await fetch(`${api.url}/api/events?hackathon=${await newHackathon()}`);
    expect(res.status).toBe(401);
  });

  it('sse.needs-channel: a stream must name a hackathon or a team', async () => {
    expect((await api.get('/events', await newUser())).status).toBe(400);
  });

  it('sse.receives-join: a board client sees someone else join within a second', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    const watcher = await newUser();
    const stream = await openStream(api.url, `hackathon=${hackathonId}`, watcher);
    await stream.waitFor((e) => e.event === 'ready');

    const started = Date.now();
    const joiner = await newUser();
    expect((await api.post('/invites/redeem', joiner, { code })).status).toBe(201);
    const event = await stream.waitFor((e) => e.data?.action === 'member.joined', 1000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(event.data).toMatchObject({ teamId: team.id, userId: joiner.id, memberCount: 2 });
    expect(event.data.version).toBeGreaterThan(0);
    stream.close();
  });

  it('sse.team-channel: a team stream sees that team only', async () => {
    const hackathonId = await newHackathon();
    const [mine, other] = await Promise.all([newTeam(hackathonId, 2), newTeam(hackathonId, 2)]);
    const stream = await openStream(api.url, `team=${mine.id}`, mine.leader);
    await stream.waitFor((e) => e.event === 'ready');

    await api.post(`/teams/${other.id}/leave`, other.members[0]!);
    await api.post(`/teams/${mine.id}/leave`, mine.members[0]!);
    const event = await stream.waitFor((e) => e.data?.action === 'member.left');
    expect(event.data.teamId).toBe(mine.id);
    expect(stream.received.filter((e) => e.data?.teamId === other.id)).toEqual([]);
    stream.close();
  });

  it('sse.no-secrets: events carry no invite details', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const stream = await openStream(api.url, `hackathon=${hackathonId}`, team.leader);
    await stream.waitFor((e) => e.event === 'ready');
    const { id, code } = await newInvite(api, team);
    const event = await stream.waitFor((e) => e.data?.action === 'invite.created');
    const raw = JSON.stringify(event.data);
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(id);
    stream.close();
  });

  it('sse.resume: reconnecting with Last-Event-ID replays what was missed', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 3);
    const first = await openStream(api.url, `hackathon=${hackathonId}`, team.leader);
    await first.waitFor((e) => e.event === 'ready');
    await api.post(`/teams/${team.id}/leave`, team.members[0]!);
    const seen = await first.waitFor((e) => e.data?.action === 'member.left');
    first.close();

    await api.post(`/teams/${team.id}/leave`, team.members[1]!); // happens while disconnected

    const second = await openStream(api.url, `hackathon=${hackathonId}`, team.leader, Number(seen.id));
    const replayed = await second.waitFor((e) => e.data?.userId === team.members[1]!.id);
    expect(replayed.data.action).toBe('member.left');
    expect(Number(replayed.id)).toBeGreaterThan(Number(seen.id));
    second.close();
  });

  it('sse.versions-increase: seat events carry a strictly newer version, so stale deltas can be dropped', async () => {
    const hackathonId = await newHackathon({ max: 6 });
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    const stream = await openStream(api.url, `team=${team.id}`, team.leader);
    await stream.waitFor((e) => e.event === 'ready');
    for (let i = 0; i < 3; i++) await api.post('/invites/redeem', await newUser(), { code });
    await stream.waitFor((e) => e.data?.memberCount === 4);
    const versions = stream.received.filter((e) => e.data?.action === 'member.joined').map((e) => e.data.version);
    expect(versions).toHaveLength(3);
    expect(versions).toEqual([...new Set(versions)].sort((a, b) => a - b));
    stream.close();
  });
});

describe('two API processes', () => {
  let a: Replica;
  let b: Replica;

  beforeAll(async () => {
    [a, b] = await Promise.all([startReplica(), startReplica()]);
  });
  afterAll(() => {
    a?.process.kill();
    b?.process.kill();
  });

  it('sse.two-replicas: a client on one process sees a change made through the other', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const clientA = clientFor(a.url);
    const clientB = clientFor(b.url);
    try {
      const { code } = await newInvite(clientA, team);
      const stream = await openStream(b.url, `hackathon=${hackathonId}`, team.leader);
      await stream.waitFor((e) => e.event === 'ready');

      const joiner = await newUser();
      expect((await clientA.post('/invites/redeem', joiner, { code })).status).toBe(201);
      const event = await stream.waitFor((e) => e.data?.action === 'member.joined', 1500);
      expect(event.data.userId).toBe(joiner.id);

      // And the other replica's board cache was invalidated by the same NOTIFY.
      const board = await clientB.get(`/hackathons/${hackathonId}/board/teams`, team.leader);
      expect(board.body.teams[0].memberCount).toBe(2);
      stream.close();
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
    }
  });
});

describe('crash safety', () => {
  it('chaos.fault-rollback: a process killed between seat and commit loses nothing, and the retry lands once', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    const user = await newUser();
    const key = crypto.randomUUID();

    const doomed = await startReplica({ FAULT_POINT: 'after_seat_update' });
    const client = clientFor(doomed.url);
    await expect(client.post('/invites/redeem', user, { code }, { 'idempotency-key': key })).rejects.toThrow();
    await doomed.exited;
    await client.close().catch(() => {});

    // Postgres rolled the transaction back when the connection died. Wait for it to notice.
    await expect
      .poll(async () => (await admin.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1`, [key])).rows[0].n)
      .toBe(0);
    const before = await admin.query('SELECT member_count FROM teams WHERE id = $1', [team.id]);
    expect(before.rows[0].member_count).toBe(1);

    const retry = await api.post('/invites/redeem', user, { code }, { 'idempotency-key': key });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    const replay = await api.post('/invites/redeem', user, { code }, { 'idempotency-key': key });
    expect(replay.body).toEqual(retry.body);
    const after = await admin.query('SELECT member_count FROM teams WHERE id = $1', [team.id]);
    expect(after.rows[0].member_count).toBe(2);
  });
});
