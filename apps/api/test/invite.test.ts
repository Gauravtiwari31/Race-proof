import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalInviteCode, generateInviteCode, sha256 } from '../src/lib/crypto.js';
import {
  admin,
  countBy,
  expectInvariants,
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
  type Server,
} from './helpers.js';

let api: Server;

beforeAll(async () => {
  api = await startServer();
});
afterAll(() => api.stop());

describe('invite codes', () => {
  it('invite.format: codes look like TEAM-XXXX-XXXX-XX and forgive read-aloud mistakes', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^TEAM-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(canonicalInviteCode(code.toLowerCase())).toBe(code.replace(/TEAM|-/g, ''));
    expect(canonicalInviteCode('team-oil0-0000-00')).toBe('0110000000');
    expect(canonicalInviteCode('TEAM-SHORT')).toBeNull();
  });

  it('invite.hashed: the plaintext code is never stored', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const { id, code } = await newInvite(api, team);
    const { rows } = await admin.query<{ code_hash: Buffer }>('SELECT code_hash FROM invite_codes WHERE id = $1', [id]);
    expect(rows[0]!.code_hash.equals(sha256(canonicalInviteCode(code)!))).toBe(true);
    const anywhere = await admin.query(
      `SELECT 1 FROM audit_events WHERE team_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
      [team.id, code],
    );
    expect(anywhere.rows).toHaveLength(0);
  });

  it('invite.redeem: a valid code joins the team and counts a use', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const { id, code } = await newInvite(api, team);
    const user = await newUser();
    const res = await api.post('/invites/redeem', user, { code: code.toLowerCase() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ teamId: team.id, memberCount: 2 });
    expect(await memberIds(team.id)).toContain(user.id);
    const { rows } = await admin.query('SELECT uses FROM invite_codes WHERE id = $1', [id]);
    expect(rows[0].uses).toBe(1);
  });

  it('invite.expired: an expired code is rejected with its own error', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const { id, code } = await newInvite(api, team);
    await admin.query(`UPDATE invite_codes SET expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(statusAndCode(await api.post('/invites/redeem', await newUser(), { code }))).toBe('410 CODE_EXPIRED');
  });

  it('invite.revoked: a revoked code is rejected, and only the leader can revoke', async () => {
    const team = await newTeam(await newHackathon(), 2);
    const { id, code } = await newInvite(api, team);
    expect(statusAndCode(await api.del(`/teams/${team.id}/invites/${id}`, team.members[0]!))).toBe('403 NOT_LEADER');
    expect((await api.del(`/teams/${team.id}/invites/${id}`, team.leader)).status).toBe(200);
    expect(statusAndCode(await api.post('/invites/redeem', await newUser(), { code }))).toBe('410 CODE_REVOKED');
  });

  it('invite.max-uses: a code stops working after its last use', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const { code } = await newInvite(api, team, { maxUses: 1 });
    expect((await api.post('/invites/redeem', await newUser(), { code })).status).toBe(201);
    expect(statusAndCode(await api.post('/invites/redeem', await newUser(), { code }))).toBe('409 CODE_EXHAUSTED');
  });

  it('invite.max-uses-race: a single-use code admits one of many, and rolls back the others seats', async () => {
    const hackathonId = await newHackathon({ max: 20 });
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team, { maxUses: 1 });
    const users = await newUsers(15);
    const responses = await race(users.map((u) => () => api.post('/invites/redeem', u, { code })));
    expect(countBy(responses, statusAndCode)).toEqual({ '201': 1, '409 CODE_EXHAUSTED': 14 });
    expect((await teamRow(team.id))!.member_count).toBe(2);
    await expectInvariants(hackathonId);
  });

  it('invite.revoke-race: a redeem concurrent with a revoke either fully succeeds or fully fails', async () => {
    for (let run = 0; run < 15; run++) {
      const hackathonId = await newHackathon();
      const team = await newTeam(hackathonId, 1);
      const { id, code } = await newInvite(api, team);
      const user = await newUser();
      const [redeem, revoke] = await race([
        () => api.post('/invites/redeem', user, { code }),
        () => api.del(`/teams/${team.id}/invites/${id}`, team.leader),
      ]);
      expect(revoke!.status).toBe(200);
      expect(['201', '410 CODE_REVOKED']).toContain(statusAndCode(redeem!));
      expect((await teamRow(team.id))!.member_count).toBe(redeem!.status === 201 ? 2 : 1);
      await expectInvariants(hackathonId);
    }
  });

  it('invite.list: leaders see metadata, never a code, and others see nothing', async () => {
    const team = await newTeam(await newHackathon(), 2);
    const { id, code } = await newInvite(api, team);
    const listed = await api.get(`/teams/${team.id}/invites`, team.leader);
    expect(listed.body.invites.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(JSON.stringify(listed.body)).not.toContain(code);
    expect(statusAndCode(await api.get(`/teams/${team.id}/invites`, team.members[0]))).toBe('403 NOT_LEADER');
  });
});

describe('rate limits', () => {
  const badCode = () => `TEAM-${randomBytes(6).toString('hex').toUpperCase().replace(/[^0-9A-F]/g, '0').slice(0, 10)}`;

  it('ratelimit.invite-bruteforce: the 11th bad guess is a 429, and that survives a restart', async () => {
    const limited = await startServer({ inviteLimit: { perSubject: 10, perIp: 100_000, windowSeconds: 600 } });
    const user = await newUser();
    try {
      for (let i = 0; i < 10; i++) {
        expect(statusAndCode(await limited.post('/invites/redeem', user, { code: badCode() }))).toBe('404 CODE_INVALID');
      }
      const blocked = await limited.post('/invites/redeem', user, { code: badCode() });
      expect(statusAndCode(blocked)).toBe('429 RATE_LIMITED');
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.stop();
    }

    const restarted = await startServer({ inviteLimit: { perSubject: 10, perIp: 100_000, windowSeconds: 600 } });
    try {
      expect(statusAndCode(await restarted.post('/invites/redeem', user, { code: badCode() }))).toBe('429 RATE_LIMITED');
    } finally {
      await restarted.stop();
    }
  });

  it('ratelimit.burst: 50 parallel guesses cannot slip past the limit', async () => {
    const limited = await startServer({ inviteLimit: { perSubject: 10, perIp: 100_000, windowSeconds: 600 } });
    const user = await newUser();
    try {
      const responses = await race(
        Array.from({ length: 50 }, () => () => limited.post('/invites/redeem', user, { code: badCode() })),
      );
      expect(countBy(responses, statusAndCode)).toEqual({ '404 CODE_INVALID': 10, '429 RATE_LIMITED': 40 });
    } finally {
      await limited.stop();
    }
  });

  it('ratelimit.success-is-free: successful and replayed redemptions do not use up the allowance', async () => {
    const limited = await startServer({ inviteLimit: { perSubject: 2, perIp: 100_000, windowSeconds: 600 } });
    const hackathonId = await newHackathon({ max: 20 });
    const team = await newTeam(hackathonId, 1);
    const user = await newUser();
    try {
      const { code } = await newInvite(limited, team);
      for (let i = 0; i < 5; i++) {
        await limited.post(`/invites/redeem`, user, { code });
        await limited.post(`/teams/${team.id}/leave`, user);
      }
      expect((await limited.post('/invites/redeem', user, { code })).status).toBe(201);
    } finally {
      await limited.stop();
    }
  });

  it('ratelimit.per-ip: many accounts behind one address hit the IP limit', async () => {
    const limited = await startServer({
      trustProxyHops: 1,
      inviteLimit: { perSubject: 1000, perIp: 3, windowSeconds: 600 },
    });
    const ip = { 'x-forwarded-for': `203.0.113.${1 + (randomBytes(1)[0]! % 250)}` };
    try {
      const users = await newUsers(4);
      const statuses: string[] = [];
      for (const user of users) {
        statuses.push(statusAndCode(await limited.post('/invites/redeem', user, { code: badCode() }, ip)));
      }
      expect(statuses).toEqual(['404 CODE_INVALID', '404 CODE_INVALID', '404 CODE_INVALID', '429 RATE_LIMITED']);
    } finally {
      await limited.stop();
    }
  });
});
