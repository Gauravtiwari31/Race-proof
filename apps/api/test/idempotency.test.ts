import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  auditFor,
  expectInvariants,
  memberIds,
  newHackathon,
  newInvite,
  newTeam,
  newUser,
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

const withKey = (key: string) => ({ 'idempotency-key': key });

describe('idempotency', () => {
  it('idem.double-click: same key twice concurrently joins once, with identical answers', async () => {
    for (let run = 0; run < 10; run++) {
      const hackathonId = await newHackathon();
      const team = await newTeam(hackathonId, 1);
      const { code } = await newInvite(api, team);
      const user = await newUser();
      const key = randomUUID();

      const [a, b] = await race([
        () => api.post('/invites/redeem', user, { code }, withKey(key)),
        () => api.post('/invites/redeem', user, { code }, withKey(key)),
      ]);

      expect(a!.status).toBe(201);
      expect(b!.status).toBe(201);
      expect(a!.body).toEqual(b!.body);
      expect([a!.headers['idempotent-replayed'], b!.headers['idempotent-replayed']].filter(Boolean)).toEqual(['true']);
      expect((await teamRow(team.id))!.member_count).toBe(2);
      expect((await auditFor(team.id)).filter((e) => e.action === 'member.joined')).toHaveLength(1);
      await expectInvariants(hackathonId);
    }
  });

  it('idem.replay-error: TEAM_FULL replays as TEAM_FULL even after a seat frees up', async () => {
    const hackathonId = await newHackathon({ max: 2 });
    const team = await newTeam(hackathonId, 2);
    const { code } = await newInvite(api, team);
    const user = await newUser();
    const key = randomUUID();

    const first = await api.post('/invites/redeem', user, { code }, withKey(key));
    expect(statusAndCode(first)).toBe('409 TEAM_FULL');

    expect((await api.post(`/teams/${team.id}/leave`, team.members[0]!)).status).toBe(200);

    const replay = await api.post('/invites/redeem', user, { code }, withKey(key));
    expect(statusAndCode(replay)).toBe('409 TEAM_FULL');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(await memberIds(team.id)).not.toContain(user.id);

    const freshIntent = await api.post('/invites/redeem', user, { code }, withKey(randomUUID()));
    expect(freshIntent.status).toBe(201);
  });

  it('idem.key-reuse: the same key with a different body is refused', async () => {
    const hackathonId = await newHackathon();
    const user = await newUser();
    const key = randomUUID();
    const first = await api.post(`/hackathons/${hackathonId}/teams`, user, { name: 'first name' }, withKey(key));
    expect(first.status).toBe(201);
    const second = await api.post(`/hackathons/${hackathonId}/teams`, user, { name: 'other name' }, withKey(key));
    expect(statusAndCode(second)).toBe('422 IDEMPOTENCY_KEY_REUSED');
  });

  it('idem.key-reuse-endpoint: the same key on a different endpoint is refused', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 2);
    const key = randomUUID();
    expect((await api.post(`/teams/${team.id}/leave`, team.members[0]!, undefined, withKey(key))).status).toBe(200);
    const other = await api.post(`/hackathons/${hackathonId}/teams`, team.members[0]!, { name: 'x' }, withKey(key));
    expect(statusAndCode(other)).toBe('422 IDEMPOTENCY_KEY_REUSED');
  });

  it('idem.key-scope: two users may use the same key independently', async () => {
    const hackathonId = await newHackathon();
    const key = randomUUID();
    const [a, b] = [await newUser(), await newUser()];
    const first = await api.post(`/hackathons/${hackathonId}/teams`, a, { name: 'scope a' }, withKey(key));
    const second = await api.post(`/hackathons/${hackathonId}/teams`, b, { name: 'scope b' }, withKey(key));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.teamId).not.toBe(second.body.teamId);
  });

  it('idem.create-team-retry: a retried create returns the same team', async () => {
    const hackathonId = await newHackathon();
    const user = await newUser();
    const key = randomUUID();
    const body = { name: 'retry team' };
    const first = await api.post(`/hackathons/${hackathonId}/teams`, user, body, withKey(key));
    const retry = await api.post(`/hackathons/${hackathonId}/teams`, user, body, withKey(key));
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body.teamId).toBe(first.body.teamId);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('idem.bad-key: a malformed key is a 400', async () => {
    const res = await api.post('/invites/redeem', await newUser(), { code: 'nope' }, withKey('not-a-uuid'));
    expect(statusAndCode(res)).toBe('400 VALIDATION_ERROR');
  });

  it('idem.secret-not-stored: an invite response with its plaintext code is never persisted', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const key = randomUUID();
    const res = await api.post(`/teams/${team.id}/invites`, team.leader, {}, withKey(key));
    expect(res.status).toBe(201);
    const { rows } = await admin.query('SELECT 1 FROM idempotency_keys WHERE key = $1', [key]);
    expect(rows).toHaveLength(0);
  });
});
