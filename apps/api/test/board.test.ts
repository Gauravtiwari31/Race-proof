import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  auditFor,
  newHackathon,
  newInvite,
  newTeam,
  newUser,
  newUsers,
  startServer,
  statusAndCode,
  type Server,
} from './helpers.js';
import { checkInvariants } from '../src/db/invariants.js';

let api: Server;

beforeAll(async () => {
  api = await startServer();
});
afterAll(() => api.stop());

describe('board', () => {
  it('board.keyset: paging returns every open team exactly once, even with identical timestamps', async () => {
    const hackathonId = await newHackathon();
    const teams = await Promise.all(Array.from({ length: 25 }, () => newTeam(hackathonId, 1)));
    // Microseconds apart: a cursor that went through a JS Date would skip or repeat these.
    await admin.query(
      `UPDATE teams SET updated_at = '2026-11-01 10:00:00.123456+00'::timestamptz + (random() * interval '900 microseconds')
        WHERE hackathon_id = $1`,
      [hackathonId],
    );
    const viewer = await newUser();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const res = await api.get(`/hackathons/${hackathonId}/board/teams?limit=7${query}`, viewer);
      expect(res.status).toBe(200);
      seen.push(...res.body.teams.map((t: { id: string }) => t.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(4);
    expect(seen).toHaveLength(25);
    expect(new Set(seen)).toEqual(new Set(teams.map((t) => t.id)));
  });

  it('board.bad-cursor: a forged cursor is a 400, not a database error', async () => {
    const hackathonId = await newHackathon();
    const viewer = await newUser();
    for (const cursor of ['nonsense', Buffer.from('["not-a-date","x"]').toString('base64url')]) {
      const res = await api.get(`/hackathons/${hackathonId}/board/teams?cursor=${cursor}`, viewer);
      expect(statusAndCode(res)).toBe('400 VALIDATION_ERROR');
    }
  });

  it('board.open-seats: full teams leave the board', async () => {
    const hackathonId = await newHackathon({ max: 2 });
    const [full, open] = await Promise.all([newTeam(hackathonId, 2), newTeam(hackathonId, 1)]);
    const res = await api.get(`/hackathons/${hackathonId}/board/teams`, full.leader);
    expect(res.body.teams.map((t: { id: string }) => t.id)).toEqual([open.id]);
  });

  it('board.skill-filter: filters teams and people by skill', async () => {
    const hackathonId = await newHackathon();
    const [pg, rust] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
    await admin.query(`UPDATE teams SET looking_for = '{postgres}' WHERE id = $1`, [pg.id]);
    await admin.query(`UPDATE teams SET looking_for = '{rust}' WHERE id = $1`, [rust.id]);
    const [p1, p2] = await newUsers(2);
    await admin.query(`UPDATE users SET skills = '{postgres}' WHERE id = $1`, [p1!.id]);
    await admin.query(`UPDATE users SET skills = '{rust}' WHERE id = $1`, [p2!.id]);
    await api.put(`/hackathons/${hackathonId}/participation`, p1, { looking: true });
    await api.put(`/hackathons/${hackathonId}/participation`, p2, { looking: true });

    const teams = await api.get(`/hackathons/${hackathonId}/board/teams?skill=POSTGRES`, p1);
    expect(teams.body.teams.map((t: { id: string }) => t.id)).toEqual([pg.id]);
    const people = await api.get(`/hackathons/${hackathonId}/board/people?skill=rust`, p1);
    expect(people.body.people.map((u: { id: string }) => u.id)).toEqual([p2!.id]);
  });

  it('board.narrow: a person on the board exposes no email or password hash', async () => {
    const hackathonId = await newHackathon();
    const user = await newUser();
    await api.put(`/hackathons/${hackathonId}/participation`, user, { looking: true, pitch: 'hi' });
    const res = await api.get(`/hackathons/${hackathonId}/board/people`, user);
    expect(res.body.people[0].pitch).toBe('hi');
    expect(JSON.stringify(res.body)).not.toMatch(/email|password|@test\.local/);
  });

  it('board.etag: an unchanged board answers 304, and a change gives a new body', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const path = `/hackathons/${hackathonId}/board/teams`;
    const first = await api.get(path, team.leader);
    const etag = first.headers.etag as string;
    expect(etag).toBeDefined();
    const same = await api.get(path, team.leader, { 'if-none-match': etag });
    expect(same.status).toBe(304);

    const { code } = await newInvite(api, team);
    await api.post('/invites/redeem', await newUser(), { code });
    await expect
      .poll(async () => (await api.get(path, team.leader)).body.teams[0].memberCount, { timeout: 2000 })
      .toBe(2);
    expect((await api.get(path, team.leader)).headers.etag).not.toBe(etag);
  });

  it('board.cache-single-flight: 100 concurrent reads run one query', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    let queries = 0;
    const original = api.app.db.pool.query.bind(api.app.db.pool) as (...args: unknown[]) => unknown;
    (api.app.db.pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      if (String(args[0]).includes('FROM teams t') && String(args[0]).includes('json_agg')) queries++;
      return original(...args);
    };
    try {
      const responses = await Promise.all(
        Array.from({ length: 100 }, () => api.get(`/hackathons/${hackathonId}/board/teams`, team.leader)),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(queries).toBe(1);
    } finally {
      (api.app.db.pool as unknown as { query: unknown }).query = original;
    }
  });

  it('board.lists: sandbox hackathons are hidden', async () => {
    const hackathonId = await newHackathon();
    const res = await api.get('/hackathons', await newUser());
    const ids = res.body.hackathons.map((h: { id: string }) => h.id);
    expect(ids).toContain(hackathonId);
    expect(ids).not.toContain('00000000-0000-4000-8000-00000000a7e0');
  });
});

describe('participation', () => {
  it('participation.me: reports team, role, and pending requests', async () => {
    const hackathonId = await newHackathon();
    const [team, other] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
    expect((await api.get(`/hackathons/${hackathonId}/me`, team.leader)).body).toMatchObject({ teamId: team.id, role: 'leader' });
    const user = await newUser();
    await api.post(`/teams/${other.id}/requests`, user, {});
    expect((await api.get(`/hackathons/${hackathonId}/me`, user)).body).toMatchObject({ teamId: null, pendingTeamIds: [other.id] });
  });

  it('participation.member-refused: someone in a team cannot mark themselves as looking', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const res = await api.put(`/hackathons/${hackathonId}/participation`, team.leader, { looking: true });
    expect(statusAndCode(res)).toBe('409 ALREADY_IN_TEAM');
  });

  it('participation.unknown-hackathon: a 404, not a foreign-key error', async () => {
    const res = await api.put('/hackathons/00000000-0000-4000-8000-000000000000/participation', await newUser(), { looking: true });
    expect(statusAndCode(res)).toBe('404 HACKATHON_NOT_FOUND');
  });

  it('participation.audited: updates are in the log', async () => {
    const hackathonId = await newHackathon();
    const user = await newUser();
    await api.put(`/hackathons/${hackathonId}/participation`, user, { looking: true });
    const { rows } = await admin.query(`SELECT action, actor_id FROM audit_events WHERE hackathon_id = $1`, [hackathonId]);
    expect(rows).toEqual([{ action: 'participant.updated', actor_id: user.id }]);
  });
});

describe('team history', () => {
  it('history.survives-deletion: the timeline stays readable after the team is gone', async () => {
    const hackathonId = await newHackathon();
    const leader = await newUser();
    const created = await api.post(`/hackathons/${hackathonId}/teams`, leader, { name: 'Timeline' });
    const teamId = created.body.teamId;
    await api.post(`/teams/${teamId}/leave`, leader);
    const res = await api.get(`/teams/${teamId}/history`, await newUser());
    expect(res.body.events.map((e: { action: string }) => e.action)).toEqual(['team.created', 'team.deleted']);
    expect(res.body.names[leader.id]).toMatch(/^User /);
    expect((await auditFor(teamId)).length).toBe(2);
  });
});

describe('race arena', () => {
  it('arena.safe: one winner of 50, invariant holds, and nothing is left behind', async () => {
    const user = await newUser();
    const users = async () => (await admin.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@arena.invalid'`)).rows[0].n;
    const before = await users();
    const res = await api.post('/arena/run', user, { mode: 'safe' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ winners: 1, seats: 4, memberCount: 4, actualMembers: 4, invariantHolds: true });
    expect(res.body.results).toHaveLength(50);
    expect(res.body.results.filter((r: { code: string }) => r.code === 'TEAM_FULL')).toHaveLength(49);
    expect(await users()).toBe(before);
  });

  it('arena.naive: the read-then-write seat visibly breaks, safely inside the sandbox', async () => {
    const res = await api.post('/arena/run', await newUser(), { mode: 'naive' });
    expect(res.status).toBe(200);
    expect(res.body.winners).toBeGreaterThan(1);
    expect(res.body.invariantHolds).toBe(false);
    const leftovers = await admin.query(`SELECT 1 FROM teams WHERE name LIKE 'arena-%' AND member_count > max_size`);
    expect(leftovers.rows).toHaveLength(0);
    expect(await checkInvariants(admin)).toEqual([]);
  });

  it('arena.rate-limited: repeated runs are limited', async () => {
    const limited = await startServer({ arenaLimit: { perSubject: 1, perIp: 1000, windowSeconds: 60 } });
    const user = await newUser();
    try {
      expect((await limited.post('/arena/run', user, { bots: 2 })).status).toBe(200);
      expect(statusAndCode(await limited.post('/arena/run', user, { bots: 2 }))).toBe('429 RATE_LIMITED');
    } finally {
      await limited.stop();
    }
  });

  it('arena.disabled: off when configured off', async () => {
    const off = await startServer({ arenaEnabled: false });
    try {
      expect((await off.post('/arena/run', await newUser(), {})).status).toBe(404);
    } finally {
      await off.stop();
    }
  });
});

describe('observability', () => {
  it('metrics.exposed: counts joins and conflicts in Prometheus format', async () => {
    const hackathonId = await newHackathon({ max: 2 });
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    await api.post('/invites/redeem', await newUser(), { code });
    await api.post('/invites/redeem', await newUser(), { code });
    const text = await (await fetch(`${api.url}/metrics`)).text();
    expect(text).toMatch(/team_joins_total \d+/);
    expect(text).toMatch(/team_conflicts_total\{code="TEAM_FULL"\} \d+/);
    expect(text).toContain('http_request_duration_seconds_bucket');
  });

  it('metrics.token: with a token configured, metrics need it', async () => {
    const locked = await startServer({ metricsToken: 'secret-token' });
    try {
      expect((await fetch(`${locked.url}/metrics`)).status).toBe(401);
      const ok = await fetch(`${locked.url}/metrics`, { headers: { authorization: 'Bearer secret-token' } });
      expect(ok.status).toBe(200);
    } finally {
      await locked.stop();
    }
  });

  it('ops.stats: signed-in users get this replica\'s live numbers', async () => {
    const res = await api.get('/ops/stats', await newUser());
    expect(res.body).toMatchObject({ replica: expect.any(String), openStreams: expect.any(Number) });
    expect(res.body.p95Ms).toBeGreaterThanOrEqual(0);
  });
});
