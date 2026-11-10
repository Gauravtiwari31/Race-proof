import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  admin,
  auditFor,
  expectInvariants,
  memberIds,
  newHackathon,
  newInvite,
  newTeam,
  newUser,
  startServer,
  statusAndCode,
  type Response,
  type Server,
  type TestUser,
} from './helpers.js';
import { appDbUrl } from './urls.js';

let api: Server;

beforeAll(async () => {
  api = await startServer();
});
afterAll(() => api.stop());

const profile = () => ({
  email: `${randomUUID()}@test.local`,
  password: 'correct horse battery',
  name: 'Ada',
  skills: ['Postgres', 'postgres', 'k8s'],
  timezone: 'Asia/Kolkata',
  availStartMin: 540,
  availEndMin: 1020,
});

const sessionFrom = (res: Response, id: string): TestUser => {
  const header = [res.headers['set-cookie']].flat()[0]!;
  return { id, cookie: header.split(';')[0]! };
};

describe('authentication', () => {
  it('auth.signup: creates a session, normalises skills, and hashes with argon2id', async () => {
    const body = profile();
    const res = await api.post('/auth/signup', undefined, body);
    expect(res.status).toBe(201);
    expect(res.body.skills).toEqual(['postgres', 'k8s']);
    expect(JSON.stringify(res.body)).not.toContain('password');
    const cookie = [res.headers['set-cookie']].flat()[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await api.get('/me', sessionFrom(res, res.body.id));
    expect(me.body.id).toBe(res.body.id);
    const { rows } = await admin.query('SELECT password_hash FROM users WHERE id = $1', [res.body.id]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
  });

  it('auth.session-hashed: the database holds only a hash of the session token', async () => {
    const res = await api.post('/auth/signup', undefined, profile());
    const token = sessionFrom(res, res.body.id).cookie.split('=')[1]!;
    const { rows } = await admin.query<{ token_hash: Buffer }>('SELECT token_hash FROM sessions WHERE user_id = $1', [res.body.id]);
    expect(rows[0]!.token_hash.toString('utf8')).not.toContain(token);
    expect(rows[0]!.token_hash).toHaveLength(32);
  });

  it('auth.login-logout: logging out revokes the session on the server', async () => {
    const body = profile();
    const signup = await api.post('/auth/signup', undefined, body);
    expect(statusAndCode(await api.post('/auth/login', undefined, { email: body.email, password: 'wrong password' }))).toBe(
      '401 BAD_CREDENTIALS',
    );
    expect(statusAndCode(await api.post('/auth/login', undefined, { email: 'nobody@test.local', password: 'x' }))).toBe(
      '401 BAD_CREDENTIALS',
    );

    const login = await api.post('/auth/login', undefined, { email: body.email.toUpperCase(), password: body.password });
    expect(login.status).toBe(200);
    const session = sessionFrom(login, signup.body.id);
    expect((await api.get('/me', session)).status).toBe(200);
    expect((await api.post('/auth/logout', session)).status).toBe(200);
    expect(statusAndCode(await api.get('/me', session))).toBe('401 UNAUTHENTICATED');
  });

  it('auth.email-unique: an email is registered once, ignoring case', async () => {
    const body = profile();
    expect((await api.post('/auth/signup', undefined, body)).status).toBe(201);
    const again = await api.post('/auth/signup', undefined, { ...body, email: body.email.toUpperCase() });
    expect(statusAndCode(again)).toBe('409 EMAIL_TAKEN');
  });

  it('auth.expired-session: an expired session is rejected', async () => {
    const user = await newUser();
    await admin.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [user.id]);
    expect(statusAndCode(await api.get('/me', user))).toBe('401 UNAUTHENTICATED');
  });

  it('auth.sliding-expiry: an aging session is renewed by use', async () => {
    const user = await newUser();
    await admin.query(`UPDATE sessions SET expires_at = now() + interval '2 days' WHERE user_id = $1`, [user.id]);
    const res = await api.get('/me', user);
    expect(res.headers['set-cookie']).toBeDefined();
    const { rows } = await admin.query(`SELECT expires_at > now() + interval '6 days' AS renewed FROM sessions WHERE user_id = $1`, [user.id]);
    expect(rows[0].renewed).toBe(true);
  });

  it('ratelimit.login: repeated wrong passwords are limited per account', async () => {
    const limited = await startServer({ loginLimit: { perSubject: 3, perIp: 100_000, windowSeconds: 600 } });
    const body = profile();
    try {
      await limited.post('/auth/signup', undefined, body);
      for (let i = 0; i < 3; i++) {
        expect((await limited.post('/auth/login', undefined, { email: body.email, password: 'wrong wrong' })).status).toBe(401);
      }
      const blocked = await limited.post('/auth/login', undefined, { email: body.email, password: body.password });
      expect(statusAndCode(blocked)).toBe('429 RATE_LIMITED');
    } finally {
      await limited.stop();
    }
  });

  it('ratelimit.signup: one address cannot mint accounts without limit, and a refused signup creates nothing', async () => {
    const limited = await startServer({ signupLimit: { perSubject: 3, perIp: 3, windowSeconds: 600 } });
    await admin.query(`DELETE FROM rate_limits WHERE key LIKE 'signup:%'`); // earlier tests signed up from this address too
    try {
      for (let i = 0; i < 3; i++) expect((await limited.post('/auth/signup', undefined, profile())).status).toBe(201);
      const body = profile();
      const blocked = await limited.post('/auth/signup', undefined, body);
      expect(statusAndCode(blocked)).toBe('429 RATE_LIMITED');
      expect(blocked.headers['retry-after']).toBeDefined();
      const { rowCount } = await admin.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
      expect(rowCount).toBe(0);
    } finally {
      await limited.stop();
    }
  });
});

describe('authorisation', () => {
  it('authz.unauthenticated: every route not explicitly public rejects without a session', async () => {
    const fake = '00000000-0000-4000-8000-000000000000';
    const privateRoutes = api.app.routes.filter((r) => r.url.startsWith('/api/') && !r.public);
    expect(privateRoutes.length).toBeGreaterThan(15);

    for (const route of privateRoutes) {
      const path = route.url.replace('/api', '').replace(/:[A-Za-z]+/g, fake);
      const callers: Record<string, () => Promise<Response>> = {
        GET: () => api.get(path),
        DELETE: () => api.del(path),
        PATCH: () => api.patch(path, undefined, {}),
        POST: () => api.post(path, undefined, {}),
        PUT: () => api.put(path, undefined, {}),
      };
      const res = await callers[route.method]!();
      expect(`${route.method} ${route.url} -> ${statusAndCode(res)}`).toBe(
        `${route.method} ${route.url} -> 401 UNAUTHENTICATED`,
      );
    }
  });

  it('authz.csrf: a mutation without the custom header is refused even with a valid session', async () => {
    const user = await newUser();
    const res = await fetch(`${api.url}/api/hackathons/${await newHackathon()}/teams`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'csrf' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('CSRF_HEADER_REQUIRED');
  });

  it('authz.non-leader-accept: 403, no state change, no audit row', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 2);
    const applicant = await newUser();
    const req = await api.post(`/teams/${team.id}/requests`, applicant, {});
    const before = (await auditFor(team.id)).length;

    expect(statusAndCode(await api.post(`/requests/${req.body.id}/accept`, team.members[0]))).toBe('403 NOT_LEADER');
    expect(statusAndCode(await api.post(`/requests/${req.body.id}/decline`, applicant))).toBe('403 NOT_LEADER');

    expect(await memberIds(team.id)).not.toContain(applicant.id);
    expect(await auditFor(team.id)).toHaveLength(before);
    await expectInvariants(hackathonId);
  });

  it('authz.non-leader-remove: 403, no state change, no audit row, no version bump', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 3);
    const [member, target] = team.members as [TestUser, TestUser];
    const before = (await auditFor(team.id)).length;
    const version = async () => (await admin.query('SELECT version FROM teams WHERE id = $1', [team.id])).rows[0].version;
    const startVersion = await version();

    expect(statusAndCode(await api.del(`/teams/${team.id}/members/${target.id}`, member))).toBe('403 NOT_LEADER');

    expect(await memberIds(team.id)).toContain(target.id);
    expect(await auditFor(team.id)).toHaveLength(before);
    expect(await version()).toBe(startVersion);
    await expectInvariants(hackathonId);
  });

  it('authz.non-leader-others: invites, transfer and request lists are leader-only', async () => {
    const team = await newTeam(await newHackathon(), 2);
    const member = team.members[0]!;
    expect(statusAndCode(await api.post(`/teams/${team.id}/invites`, member, {}))).toBe('403 NOT_LEADER');
    expect(statusAndCode(await api.post(`/teams/${team.id}/transfer`, member, { userId: member.id }))).toBe('403 NOT_LEADER');
    expect(statusAndCode(await api.get(`/teams/${team.id}/requests`, member))).toBe('403 NOT_LEADER');
  });

  it('authz.foreign-leader: leading one team gives no power over another', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 2)]);
    expect(statusAndCode(await api.del(`/teams/${b.id}/members/${b.members[0]!.id}`, a.leader))).toBe('403 NOT_LEADER');
    expect(statusAndCode(await api.post(`/teams/${b.id}/invites`, a.leader, {}))).toBe('403 NOT_LEADER');
  });
});

describe('audit log', () => {
  it('audit.every-mutation: each mutation writes exactly one event with actor, action and version', async () => {
    const hackathonId = await newHackathon({ max: 5 });
    const leader = await newUser();
    const created = await api.post(`/hackathons/${hackathonId}/teams`, leader, { name: 'audited' });
    const teamId = created.body.teamId;
    const team = { id: teamId, hackathonId, leader, members: [] };

    const invite = await newInvite(api, team);
    const joiner = await newUser();
    await api.post('/invites/redeem', joiner, { code: invite.code });
    await api.del(`/teams/${teamId}/invites/${invite.id}`, leader);

    const asker = await newUser();
    const req1 = await api.post(`/teams/${teamId}/requests`, asker, {});
    await api.post(`/requests/${req1.body.id}/decline`, leader);
    const req2 = await api.post(`/teams/${teamId}/requests`, asker, {});
    await api.post(`/requests/${req2.body.id}/cancel`, asker);
    const req3 = await api.post(`/teams/${teamId}/requests`, asker, {});
    await api.post(`/requests/${req3.body.id}/accept`, leader);

    await api.post(`/teams/${teamId}/transfer`, leader, { userId: joiner.id });
    await api.del(`/teams/${teamId}/members/${asker.id}`, joiner);
    await api.post(`/teams/${teamId}/leave`, leader);
    await api.post(`/teams/${teamId}/leave`, joiner);

    const events = await auditFor(teamId);
    expect(events.map((e) => [e.action, e.actor_id])).toEqual([
      ['team.created', leader.id],
      ['invite.created', leader.id],
      ['member.joined', joiner.id],
      ['invite.revoked', leader.id],
      ['request.created', asker.id],
      ['request.declined', leader.id],
      ['request.created', asker.id],
      ['request.cancelled', asker.id],
      ['request.created', asker.id],
      ['member.joined', leader.id],
      ['leader.transferred', leader.id],
      ['member.removed', joiner.id],
      ['member.left', leader.id],
      ['team.deleted', joiner.id],
    ]);

    // Seat and leadership events carry a strictly increasing team version for the realtime client.
    const versions = events.map((e) => e.team_version).filter((v): v is number => v !== null);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('audit.append-only: the application role cannot rewrite history', async () => {
    const team = await newTeam(await newHackathon(), 1);
    await newInvite(api, team);
    const appRole = new pg.Client({ connectionString: appDbUrl });
    await appRole.connect();
    try {
      await expect(appRole.query(`UPDATE audit_events SET action = 'forged'`)).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.query('DELETE FROM audit_events')).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.query('TRUNCATE audit_events')).rejects.toMatchObject({ code: '42501' });
      await expect(appRole.query(`UPDATE hackathons SET max_team_size = 99`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await appRole.end();
    }
  });

  it('audit.rollback: a failed mutation leaves no event', async () => {
    const team = await newTeam(await newHackathon({ max: 1 }), 1);
    const { code } = await newInvite(api, team);
    const before = await auditFor(team.id);
    expect(statusAndCode(await api.post('/invites/redeem', await newUser(), { code }))).toBe('409 TEAM_FULL');
    expect(await auditFor(team.id)).toEqual(before);
  });
});

describe('validation', () => {
  const expect400 = (res: Response) => expect(statusAndCode(res)).toBe('400 VALIDATION_ERROR');

  it('validation.team-name: oversized and blank names are refused', async () => {
    const path = `/hackathons/${await newHackathon()}/teams`;
    const user = await newUser();
    expect400(await api.post(path, user, { name: 'x'.repeat(81) }));
    expect400(await api.post(path, user, { name: '   ' }));
    expect400(await api.post(path, user, {}));
  });

  it('validation.uuid: malformed ids are refused before reaching SQL', async () => {
    const user = await newUser();
    expect400(await api.get('/teams/not-a-uuid', user));
    expect400(await api.post(`/teams/1' OR '1'='1/leave`.replace(/ /g, '%20'), user));
    expect400(await api.post('/requests/123/accept', user));
  });

  it('validation.timezone: unknown zones and raw offsets are refused, real names and aliases accepted', async () => {
    expect400(await api.post('/auth/signup', undefined, { ...profile(), timezone: 'Mars/Olympus' }));
    expect400(await api.post('/auth/signup', undefined, { ...profile(), timezone: '+05:30' }));
    for (const timezone of ['UTC', 'Asia/Kolkata', 'Asia/Calcutta', 'America/New_York']) {
      expect((await api.post('/auth/signup', undefined, { ...profile(), timezone })).status).toBe(201);
    }
  });

  it('validation.signup: weak passwords, bad emails, bad tags and bad minutes are refused', async () => {
    expect400(await api.post('/auth/signup', undefined, { ...profile(), password: 'short' }));
    expect400(await api.post('/auth/signup', undefined, { ...profile(), email: 'not-an-email' }));
    expect400(await api.post('/auth/signup', undefined, { ...profile(), skills: ['<script>'] }));
    expect400(await api.post('/auth/signup', undefined, { ...profile(), skills: Array(21).fill(0).map((_, i) => `s${i}`) }));
    expect400(await api.post('/auth/signup', undefined, { ...profile(), availStartMin: 1440 }));
  });

  it('validation.invite: nonsense expiry and limits are refused', async () => {
    const team = await newTeam(await newHackathon(), 1);
    expect400(await api.post(`/teams/${team.id}/invites`, team.leader, { expiresInHours: 0 }));
    expect400(await api.post(`/teams/${team.id}/invites`, team.leader, { maxUses: 0 }));
  });

  it('errors.no-internals: failures use stable codes and leak nothing', async () => {
    const res = await api.get('/no/such/route');
    expect(statusAndCode(res)).toBe('404 NOT_FOUND');
    const malformed = await fetch(`${api.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'test' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(await malformed.json())).not.toMatch(/stack|node_modules/);
  });

  it('headers.security: helmet headers are present', async () => {
    const res = await api.get('/healthz');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
