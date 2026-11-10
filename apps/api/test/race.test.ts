import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  clientFor,
  countBy,
  expectInvariants,
  leaderOf,
  memberIds,
  newHackathon,
  newInvite,
  newTeam,
  newUser,
  newUsers,
  race,
  startServer,
  statusAndCode,
  teamRow,
  waitUntilBlockedBy,
  type Client,
  type Response,
  type Server,
  type TestUser,
} from './helpers.js';
import { startReplica, type Replica } from './replica.js';

let api: Server;

beforeAll(async () => {
  api = await startServer();
  await api.warm(64);
});
afterAll(() => api.stop());

async function lastSeatScenario(client: Client, contestants = 50) {
  const hackathonId = await newHackathon({ max: 4 });
  const team = await newTeam(hackathonId, 3); // exactly one seat left
  const { code } = await newInvite(api, team);
  const users = await newUsers(contestants);
  const responses = await race(users.map((u) => () => client.post('/invites/redeem', u, { code })));
  return { hackathonId, team, responses };
}

describe('races', () => {
  it('race.last-seat-50: exactly one of 50 wins the last seat, 20 times over', async () => {
    for (let run = 0; run < 20; run++) {
      const { hackathonId, team, responses } = await lastSeatScenario(api);
      expect(countBy(responses, statusAndCode)).toEqual({ '201': 1, '409 TEAM_FULL': 49 });
      expect((await teamRow(team.id))!.member_count).toBe(4);
      expect(await memberIds(team.id)).toHaveLength(4);
      await expectInvariants(hackathonId);
    }
  });

  it('race.mutation-check: the same test catches a read-then-write seat', async () => {
    // Without this, the test above could be passing by luck. Same scenario, seat logic swapped.
    const broken = await startServer({ unsafeSeatForMutationCheck: true });
    await broken.warm(64);
    let caught: Response[] | undefined;
    const created: string[] = [];
    try {
      for (let run = 0; run < 5 && !caught; run++) {
        const hackathonId = await newHackathon({ max: 4 });
        const team = await newTeam(hackathonId, 3);
        created.push(team.id);
        const { code } = await newInvite(api, team);
        const users = await newUsers(50);
        const responses = await race(users.map((u) => () => broken.post('/invites/redeem', u, { code })));
        if (responses.filter((r) => r.status === 201).length > 1) caught = responses;
      }
    } finally {
      await broken.stop();
      // Remove the corrupted teams, or the end-of-run invariant check would rightly fail.
      await admin.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [created]);
    }
    expect(caught, 'the unsafe seat should have let several people through').toBeDefined();
  });

  describe('race.last-seat-replicas', () => {
    const replicas: Replica[] = [];

    afterAll(() => {
      for (const replica of replicas) replica.process.kill();
    });

    it('holds when requests are spread across two API processes', async () => {
      replicas.push(...(await Promise.all([startReplica(), startReplica()])));
      const clients = replicas.map((r) => clientFor(r.url));
      await Promise.all(clients.map((c) => c.warm(30)));
      try {
        for (let run = 0; run < 5; run++) {
          const hackathonId = await newHackathon({ max: 4 });
          const team = await newTeam(hackathonId, 3);
          const { code } = await newInvite(api, team);
          const users = await newUsers(50);
          const responses = await race(
            users.map((u, i) => () => clients[i % 2]!.post('/invites/redeem', u, { code })),
          );
          expect(countBy(responses, statusAndCode)).toEqual({ '201': 1, '409 TEAM_FULL': 49 });
          await expectInvariants(hackathonId);
        }
      } finally {
        await Promise.all(clients.map((c) => c.close()));
      }
    });
  });

  it('race.accept-last-seat: 10 concurrent accepts for 1 seat admit exactly one', async () => {
    const hackathonId = await newHackathon({ max: 2 });
    const team = await newTeam(hackathonId, 1);
    const applicants = await newUsers(10);
    const requests = await Promise.all(
      applicants.map((u) => api.post(`/teams/${team.id}/requests`, u, { message: 'hi' })),
    );
    const responses = await race(requests.map((r) => () => api.post(`/requests/${r.body.id}/accept`, team.leader)));
    expect(countBy(responses, statusAndCode)).toEqual({ '200': 1, '409 TEAM_FULL': 9 });
    await expectInvariants(hackathonId);
  });

  it('race.double-accept: a double click accepts once', async () => {
    const hackathonId = await newHackathon({ max: 4 });
    const team = await newTeam(hackathonId, 1);
    const request = await api.post(`/teams/${team.id}/requests`, await newUser(), {});
    const responses = await race([1, 2, 3].map(() => () => api.post(`/requests/${request.body.id}/accept`, team.leader)));
    expect(countBy(responses, statusAndCode)).toEqual({ '200': 1, '409 REQUEST_NOT_PENDING': 2 });
    expect((await teamRow(team.id))!.member_count).toBe(2);
    await expectInvariants(hackathonId);
  });

  it('race.user-two-teams: one person racing into two teams ends up in one, and no seat leaks', async () => {
    for (let run = 0; run < 10; run++) {
      const hackathonId = await newHackathon({ max: 4 });
      const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
      const [inviteA, inviteB] = await Promise.all([newInvite(api, a), newInvite(api, b)]);
      const user = await newUser();
      const responses = await race([
        () => api.post('/invites/redeem', user, { code: inviteA.code }),
        () => api.post('/invites/redeem', user, { code: inviteB.code }),
      ]);
      expect(countBy(responses, statusAndCode)).toEqual({ '201': 1, '409 ALREADY_IN_TEAM': 1 });
      const counts = [(await teamRow(a.id))!.member_count, (await teamRow(b.id))!.member_count].sort();
      expect(counts).toEqual([1, 2]);
      await expectInvariants(hackathonId);
    }
  });

  it('race.leader-and-member-leave: concurrent leaves never leave a team leaderless', async () => {
    for (let run = 0; run < 15; run++) {
      const hackathonId = await newHackathon({ max: 4 });
      const team = await newTeam(hackathonId, 3);
      const [m1, m2] = team.members as [TestUser, TestUser];
      const responses = await race([
        () => api.post(`/teams/${team.id}/leave`, team.leader),
        () => api.post(`/teams/${team.id}/leave`, m1),
      ]);
      expect(countBy(responses, (r) => r.status)).toEqual({ '200': 2 });
      expect(await leaderOf(team.id)).toBe(m2.id);
      await expectInvariants(hackathonId);
    }
  });

  it('race.last-two-leave: the team is deleted exactly once, with no orphans', async () => {
    for (let run = 0; run < 15; run++) {
      const hackathonId = await newHackathon({ max: 4 });
      const team = await newTeam(hackathonId, 2);
      const responses = await race([
        () => api.post(`/teams/${team.id}/leave`, team.leader),
        () => api.post(`/teams/${team.id}/leave`, team.members[0]!),
      ]);
      expect(countBy(responses, (r) => r.status)).toEqual({ '200': 2 });
      expect(responses.filter((r) => r.body.teamDeleted)).toHaveLength(1);
      expect(await teamRow(team.id)).toBeUndefined();
      expect(await memberIds(team.id)).toEqual([]);
      const { rows } = await admin.query(`SELECT 1 FROM audit_events WHERE team_id = $1 AND action = 'team.deleted'`, [team.id]);
      expect(rows).toHaveLength(1);
    }
  });

  it('race.join-vs-last-leave: a join against a vanishing team neither deadlocks nor leaks', async () => {
    for (let run = 0; run < 25; run++) {
      const hackathonId = await newHackathon({ max: 4 });
      const team = await newTeam(hackathonId, 1);
      const { code } = await newInvite(api, team);
      const joiner = await newUser();
      const [leave, join] = await race([
        () => api.post(`/teams/${team.id}/leave`, team.leader),
        () => api.post('/invites/redeem', joiner, { code }),
      ]);
      expect(leave!.status).toBe(200);
      expect(['201', '404 CODE_INVALID', '404 TEAM_NOT_FOUND']).toContain(statusAndCode(join!));
      if (join!.status === 201) {
        expect(await leaderOf(team.id)).toBe(joiner.id);
      } else {
        expect(await teamRow(team.id)).toBeUndefined();
      }
      await expectInvariants(hackathonId);
    }
  });

  it('race.accept-vs-redeem: accepting a user who is redeeming elsewhere does not deadlock', async () => {
    for (let run = 0; run < 25; run++) {
      const hackathonId = await newHackathon({ max: 4 });
      const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
      const user = await newUser();
      const request = await api.post(`/teams/${b.id}/requests`, user, {});
      const { code } = await newInvite(api, a);
      const responses = await race([
        () => api.post('/invites/redeem', user, { code }),
        () => api.post(`/requests/${request.body.id}/accept`, b.leader),
      ]);
      expect(responses.every((r) => r.status < 500), JSON.stringify(responses.map((r) => r.body))).toBe(true);
      expect(responses.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
      await expectInvariants(hackathonId);
    }
  });

  it('race.lock-order-redeem-vs-delete: a redeem holds no code lock while it waits for the team', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    const joiner = await newUser();

    // Stop a last-member leave halfway: it holds the team, and has yet to cascade to the code.
    const leave = await admin.connect();
    try {
      await leave.query('BEGIN');
      await leave.query('UPDATE teams SET member_count = member_count - 1 WHERE id = $1', [team.id]);
      await leave.query('DELETE FROM memberships WHERE team_id = $1', [team.id]);

      const redeem = api.post('/invites/redeem', joiner, { code });
      await waitUntilBlockedBy(leave);

      // If the redeem had locked the code first, this cascade would complete a deadlock.
      await leave.query('DELETE FROM teams WHERE id = $1', [team.id]);
      await leave.query('COMMIT');
      expect(statusAndCode(await redeem)).toBe('404 TEAM_NOT_FOUND');
    } finally {
      leave.release();
    }
    await expectInvariants(hackathonId);
  });

  it('race.lock-order-accept-vs-redeem: an accept holds no request lock while it waits for the member', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
    const user = await newUser();
    const request = await api.post(`/teams/${b.id}/requests`, user, {});

    // Stop a redeem into team A halfway: it holds the membership key, and has yet to cancel requests.
    const redeem = await admin.connect();
    try {
      await redeem.query('BEGIN');
      await redeem.query('UPDATE teams SET member_count = member_count + 1 WHERE id = $1', [a.id]);
      await redeem.query(`INSERT INTO memberships (hackathon_id, user_id, team_id, role) VALUES ($1, $2, $3, 'member')`, [
        hackathonId,
        user.id,
        a.id,
      ]);

      const accept = api.post(`/requests/${request.body.id}/accept`, b.leader);
      await waitUntilBlockedBy(redeem);

      // If the accept had closed the request first, this update would complete a deadlock.
      await redeem.query(`UPDATE join_requests SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'`, [user.id]);
      await redeem.query('COMMIT');
      expect(statusAndCode(await accept)).toBe('409 ALREADY_IN_TEAM');
    } finally {
      redeem.release();
    }
    expect((await teamRow(b.id))!.member_count).toBe(1); // the seat taken before the conflict came back
    await expectInvariants(hackathonId);
  });

  it('race.request-vs-join: a request made while its author joins elsewhere never stays pending', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);

    // Order 1: the request commits first, while the join waits on the person. The join's cleanup
    // must then see the request and cancel it.
    const first = await newUser();
    const { code } = await newInvite(api, a);
    const asking = await admin.connect();
    let requestId: string;
    try {
      await asking.query('BEGIN');
      await asking.query('SELECT 1 FROM teams WHERE id = $1 FOR NO KEY UPDATE', [b.id]);
      await asking.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [first.id]);
      const { rows } = await asking.query<{ id: string }>(
        'INSERT INTO join_requests (team_id, user_id) VALUES ($1, $2) RETURNING id',
        [b.id, first.id],
      );
      requestId = rows[0]!.id;

      const join = api.post('/invites/redeem', first, { code });
      await waitUntilBlockedBy(asking);
      await asking.query('COMMIT');
      expect((await join).status).toBe(201);
    } finally {
      asking.release();
    }
    const { rows: after } = await admin.query('SELECT status FROM join_requests WHERE id = $1', [requestId]);
    expect(after[0].status).toBe('cancelled');

    // Order 2: the join commits first, while the request waits on the person. The request must then
    // see the membership and be refused.
    const second = await newUser();
    const joining = await admin.connect();
    try {
      await joining.query('BEGIN');
      await joining.query('UPDATE teams SET member_count = member_count + 1 WHERE id = $1', [a.id]);
      await joining.query(`INSERT INTO memberships (hackathon_id, user_id, team_id, role) VALUES ($1, $2, $3, 'member')`, [
        hackathonId,
        second.id,
        a.id,
      ]);
      await joining.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [second.id]);

      const ask = api.post(`/teams/${b.id}/requests`, second, {});
      await waitUntilBlockedBy(joining);
      await joining.query('COMMIT');
      expect(statusAndCode(await ask)).toBe('409 ALREADY_IN_TEAM');
    } finally {
      joining.release();
    }
    await expectInvariants(hackathonId);
  });

  it('race.stale-leader-check: a leader demoted while the request waits is refused', async () => {
    const hackathonId = await newHackathon({ max: 4 });
    const team = await newTeam(hackathonId, 3);
    const [heir, bystander] = team.members as [TestUser, TestUser];

    // Hold the team lock and demote the leader, uncommitted, exactly as a transfer would.
    const transfer = await admin.connect();
    try {
      await transfer.query('BEGIN');
      await transfer.query('SELECT 1 FROM teams WHERE id = $1 FOR NO KEY UPDATE', [team.id]);
      await transfer.query(`UPDATE memberships SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [team.id, team.leader.id]);
      await transfer.query(`UPDATE memberships SET role = 'leader' WHERE team_id = $1 AND user_id = $2`, [team.id, heir.id]);

      const removal = api.del(`/teams/${team.id}/members/${bystander.id}`, team.leader);
      await waitUntilBlockedBy(transfer);
      await transfer.query('COMMIT');

      const res = await removal;
      expect(statusAndCode(res)).toBe('403 NOT_LEADER');
      expect(await memberIds(team.id)).toContain(bystander.id);
    } finally {
      transfer.release();
    }
    await expectInvariants(hackathonId);
  });

  it('race.mixed-no-deadlock: 500 random concurrent operations produce no 5xx and hold every invariant', async () => {
    const hackathonId = await newHackathon({ max: 4 });
    const seeded = await Promise.all(Array.from({ length: 8 }, () => newTeam(hackathonId, 2)));
    const people = await newUsers(80);
    const usersById = new Map(
      [...people, ...seeded.flatMap((t) => [t.leader, ...t.members])].map((u) => [u.id, u] as const),
    );
    const user = (id: string) => usersById.get(id)!;
    const codes = new Map<string, string>();

    // mulberry32 with a fixed seed, so a failing mix can be replayed.
    let seed = 20261115;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const pick = <T,>(list: T[]): T => list[random(list.length)]!;

    // One burst of 500 saturates every team and most calls bounce without contending. Rounds planned
    // against the committed state keep each call plausible, so they really do fight over locks.
    const responses: Response[] = [];
    const readMemberships = async () =>
      (
        await admin.query<{ team_id: string; user_id: string; role: string }>(
          'SELECT team_id, user_id, role FROM memberships WHERE hackathon_id = $1',
          [hackathonId],
        )
      ).rows;
    const unseated = (rows: Array<{ user_id: string }>) => {
      const seated = new Set(rows.map((m) => m.user_id));
      return [...usersById.values()].filter((u) => !seated.has(u.id));
    };

    for (let round = 0; round < 10; round++) {
      // Departures can wipe out every team; keep enough alive for the round to contend over.
      let rows = await readMemberships();
      for (const founder of unseated(rows).slice(0, Math.max(0, 6 - new Set(rows.map((m) => m.team_id)).size))) {
        await api.post(`/hackathons/${hackathonId}/teams`, founder, { name: `topup-${round}-${founder.id}` });
      }
      rows = await readMemberships();

      const memberships = { rows };
      const pending = await admin.query<{ id: string; team_id: string }>(
        `SELECT r.id, r.team_id FROM join_requests r JOIN teams t ON t.id = r.team_id
          WHERE t.hackathon_id = $1 AND r.status = 'pending'`,
        [hackathonId],
      );
      const leaders = new Map(rows.filter((m) => m.role === 'leader').map((m) => [m.team_id, m.user_id]));
      const free = unseated(rows);
      const teamIds = [...leaders.keys()];

      for (const teamId of teamIds) {
        if (codes.has(teamId)) continue;
        const invite = await api.post(`/teams/${teamId}/invites`, user(leaders.get(teamId)!), {});
        codes.set(teamId, invite.body.code);
      }

      const leave = () => {
        const m = pick(memberships.rows);
        return api.post(`/teams/${m.team_id}/leave`, user(m.user_id));
      };

      const operations = Array.from({ length: 50 }, (_, i): (() => Promise<Response>) => {
        const teamId = pick(teamIds);
        const leader = user(leaders.get(teamId)!);
        const teammates = memberships.rows.filter((m) => m.team_id === teamId);
        const teammate = pick(teammates).user_id;
        const request = pending.rows.length ? pick(pending.rows) : undefined;
        const requestLeader = request && leaders.get(request.team_id);
        const newcomer = free.length ? pick(free) : undefined;

        switch (random(10)) {
          case 0:
          case 1:
          case 2:
            return newcomer ? () => api.post('/invites/redeem', newcomer, { code: codes.get(teamId) }) : leave;
          case 3:
            return leave;
          case 4:
            return request && requestLeader
              ? () => api.post(`/requests/${request.id}/accept`, user(requestLeader))
              : leave;
          case 5:
            return request && requestLeader
              ? () => api.post(`/requests/${request.id}/decline`, user(requestLeader))
              : leave;
          case 6:
            return newcomer ? () => api.post(`/teams/${teamId}/requests`, newcomer, {}) : leave;
          case 7:
            return () => api.del(`/teams/${teamId}/members/${teammate}`, leader);
          case 8:
            return () => api.post(`/teams/${teamId}/transfer`, leader, { userId: teammate });
          default:
            return newcomer
              ? () => api.post(`/hackathons/${hackathonId}/teams`, newcomer, { name: `mixed-${round}-${i}` })
              : leave;
        }
      });

      responses.push(...(await race(operations)));
      await expectInvariants(hackathonId);
    }

    expect(responses).toHaveLength(500);
    expect(responses.filter((r) => r.status >= 500).map((r) => r.body)).toEqual([]);
    expect(responses.filter((r) => r.status < 300).length, 'the mix should do real work').toBeGreaterThan(150);
  });
});
