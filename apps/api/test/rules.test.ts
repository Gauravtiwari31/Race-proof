import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  expectInvariants,
  leaderOf,
  memberIds,
  newHackathon,
  newInvite,
  newTeam,
  newUser,
  startServer,
  statusAndCode,
  teamRow,
  type Server,
  type TestUser,
} from './helpers.js';

let api: Server;

beforeAll(async () => {
  api = await startServer();
});
afterAll(() => api.stop());

describe('team rules', () => {
  it('rules.max-size: a full team refuses a sequential join', async () => {
    const hackathonId = await newHackathon({ max: 2 });
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    expect((await api.post('/invites/redeem', await newUser(), { code })).status).toBe(201);
    expect(statusAndCode(await api.post('/invites/redeem', await newUser(), { code }))).toBe('409 TEAM_FULL');
    await expectInvariants(hackathonId);
  });

  it('rules.min-size-forming: below the minimum a team is forming, at the minimum it is ready', async () => {
    const hackathonId = await newHackathon({ min: 2, max: 4 });
    const team = await newTeam(hackathonId, 1);
    expect((await api.get(`/teams/${team.id}`, team.leader)).body.status).toBe('forming');
    const { code } = await newInvite(api, team);
    expect((await api.post('/invites/redeem', await newUser(), { code })).status).toBe(201);
    expect((await api.get(`/teams/${team.id}`, team.leader)).body.status).toBe('ready');
  });

  it('rules.one-team: creating a team while in one fails and leaves nothing behind', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const res = await api.post(`/hackathons/${hackathonId}/teams`, team.leader, { name: 'second team' });
    expect(statusAndCode(res)).toBe('409 ALREADY_IN_TEAM');
    const { rows } = await admin.query(`SELECT 1 FROM teams WHERE hackathon_id = $1 AND name = 'second team'`, [hackathonId]);
    expect(rows).toHaveLength(0);
  });

  it('rules.one-team-per-hackathon: the same person may be in teams for different hackathons', async () => {
    const user = await newUser();
    const first = await api.post(`/hackathons/${await newHackathon()}/teams`, user, { name: 'one' });
    const second = await api.post(`/hackathons/${await newHackathon()}/teams`, user, { name: 'two' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('rules.team-name-unique: names are unique per hackathon, ignoring case', async () => {
    const hackathonId = await newHackathon();
    expect((await api.post(`/hackathons/${hackathonId}/teams`, await newUser(), { name: 'Rocket' })).status).toBe(201);
    const clash = await api.post(`/hackathons/${hackathonId}/teams`, await newUser(), { name: 'rOCKET' });
    expect(statusAndCode(clash)).toBe('409 TEAM_NAME_TAKEN');
  });

  it('rules.composite-fk: the database refuses a membership that lies about its hackathon', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const other = await newHackathon();
    const user = await newUser();
    await expect(
      admin.query(`INSERT INTO memberships (hackathon_id, user_id, team_id, role) VALUES ($1, $2, $3, 'member')`, [
        other,
        user.id,
        team.id,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rules.hackathon-not-found: creating a team in an unknown hackathon is a 404', async () => {
    const res = await api.post('/hackathons/00000000-0000-4000-8000-000000000000/teams', await newUser(), { name: 'x' });
    expect(statusAndCode(res)).toBe('404 HACKATHON_NOT_FOUND');
  });
});

describe('leaving', () => {
  it('leave.leader-promotes: leadership goes to the longest-standing member', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 3);
    const [senior] = team.members as [TestUser, TestUser];
    const res = await api.post(`/teams/${team.id}/leave`, team.leader);
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(senior.id);
    expect(await leaderOf(team.id)).toBe(senior.id);
    await expectInvariants(hackathonId);
  });

  it('leave.promote-tie-break: identical join times are decided by user id', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 3);
    await admin.query(`UPDATE memberships SET joined_at = '2026-01-01' WHERE team_id = $1 AND role = 'member'`, [team.id]);
    await api.post(`/teams/${team.id}/leave`, team.leader);
    const expected = team.members.map((m) => m.id).sort()[0];
    expect(await leaderOf(team.id)).toBe(expected);
  });

  it('leave.last-deletes: the last member leaving deletes the team but keeps its history', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const { code } = await newInvite(api, team);
    const res = await api.post(`/teams/${team.id}/leave`, team.leader);
    expect(res.body.teamDeleted).toBe(true);
    expect(await teamRow(team.id)).toBeUndefined();
    const invite = await admin.query('SELECT 1 FROM invite_codes WHERE team_id = $1', [team.id]);
    expect(invite.rows).toHaveLength(0);
    const audit = await admin.query('SELECT action FROM audit_events WHERE team_id = $1 ORDER BY id', [team.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(['invite.created', 'team.deleted']);
    expect(statusAndCode(await api.post('/invites/redeem', await newUser(), { code }))).toBe('404 CODE_INVALID');
  });

  it('leave.not-a-member: a stranger cannot leave, and no seat is lost', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 2);
    expect(statusAndCode(await api.post(`/teams/${team.id}/leave`, await newUser()))).toBe('409 NOT_A_MEMBER');
    expect((await teamRow(team.id))!.member_count).toBe(2);
    await expectInvariants(hackathonId);
  });

  it('leave.rejoin: someone who left may join another team', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 2), newTeam(hackathonId, 1)]);
    const mover = a.members[0]!;
    expect((await api.post(`/teams/${a.id}/leave`, mover)).status).toBe(200);
    const { code } = await newInvite(api, b);
    expect((await api.post('/invites/redeem', mover, { code })).status).toBe(201);
    await expectInvariants(hackathonId);
  });

  it('remove.by-leader: a leader can remove a member, not themselves', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 2);
    const member = team.members[0]!;
    expect(statusAndCode(await api.del(`/teams/${team.id}/members/${team.leader.id}`, team.leader))).toBe(
      '409 CANNOT_REMOVE_SELF',
    );
    expect((await api.del(`/teams/${team.id}/members/${member.id}`, team.leader)).status).toBe(200);
    expect(await memberIds(team.id)).toEqual([team.leader.id]);
    await expectInvariants(hackathonId);
  });

  it('transfer.explicit: a leader can hand over, but only to a member', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 2);
    const member = team.members[0]!;
    const stranger = await newUser();
    expect(statusAndCode(await api.post(`/teams/${team.id}/transfer`, team.leader, { userId: stranger.id }))).toBe(
      '409 NOT_A_MEMBER',
    );
    expect(await leaderOf(team.id)).toBe(team.leader.id);
    expect((await api.post(`/teams/${team.id}/transfer`, team.leader, { userId: member.id })).status).toBe(200);
    expect(await leaderOf(team.id)).toBe(member.id);
    await expectInvariants(hackathonId);
  });
});

describe('join requests', () => {
  it('request.accept: an accepted request becomes a membership', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const user = await newUser();
    const req = await api.post(`/teams/${team.id}/requests`, user, { message: 'I know postgres' });
    expect(req.status).toBe(201);
    const listed = await api.get(`/teams/${team.id}/requests`, team.leader);
    expect(listed.body.requests.map((r: { id: string }) => r.id)).toEqual([req.body.id]);
    expect((await api.post(`/requests/${req.body.id}/accept`, team.leader)).status).toBe(200);
    expect(await memberIds(team.id)).toContain(user.id);
    await expectInvariants(hackathonId);
  });

  it('request.decline: a declined request cannot then be accepted', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const user = await newUser();
    const req = await api.post(`/teams/${team.id}/requests`, user, {});
    expect((await api.post(`/requests/${req.body.id}/decline`, team.leader)).status).toBe(200);
    expect(statusAndCode(await api.post(`/requests/${req.body.id}/accept`, team.leader))).toBe('409 REQUEST_NOT_PENDING');
    expect(await memberIds(team.id)).not.toContain(user.id);
  });

  it('request.one-pending: a second pending request to the same team is refused', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const user = await newUser();
    expect((await api.post(`/teams/${team.id}/requests`, user, {})).status).toBe(201);
    expect(statusAndCode(await api.post(`/teams/${team.id}/requests`, user, {}))).toBe('409 REQUEST_ALREADY_PENDING');
  });

  it('request.member-cannot-request: someone already in a team cannot ask to join another', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
    expect(statusAndCode(await api.post(`/teams/${a.id}/requests`, b.leader, {}))).toBe('409 ALREADY_IN_TEAM');
  });

  it('request.cancel: only the requester can cancel', async () => {
    const team = await newTeam(await newHackathon(), 1);
    const user = await newUser();
    const req = await api.post(`/teams/${team.id}/requests`, user, {});
    expect(statusAndCode(await api.post(`/requests/${req.body.id}/cancel`, team.leader))).toBe('403 NOT_YOUR_REQUEST');
    expect((await api.post(`/requests/${req.body.id}/cancel`, user)).status).toBe(200);
    expect(statusAndCode(await api.post(`/requests/${req.body.id}/accept`, team.leader))).toBe('409 REQUEST_NOT_PENDING');
  });

  it('request.cancelled-on-join: joining one team cancels pending requests elsewhere', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
    const user = await newUser();
    const req = await api.post(`/teams/${b.id}/requests`, user, {});
    const { code } = await newInvite(api, a);
    expect((await api.post('/invites/redeem', user, { code })).status).toBe(201);
    const { rows } = await admin.query('SELECT status FROM join_requests WHERE id = $1', [req.body.id]);
    expect(rows[0].status).toBe('cancelled');
  });

  it('request.stale-accept: a requester who joined elsewhere meanwhile cannot be accepted', async () => {
    const hackathonId = await newHackathon();
    const [a, b] = await Promise.all([newTeam(hackathonId, 1), newTeam(hackathonId, 1)]);
    const user = await newUser();
    const req = await api.post(`/teams/${b.id}/requests`, user, {});
    await api.post(`/invites/redeem`, user, { code: (await newInvite(api, a)).code });
    expect(statusAndCode(await api.post(`/requests/${req.body.id}/accept`, b.leader))).toBe('409 REQUEST_NOT_PENDING');
    await expectInvariants(hackathonId);
  });

  it('looking.flag: joining takes you off the board and leaving puts you back', async () => {
    const hackathonId = await newHackathon();
    const team = await newTeam(hackathonId, 1);
    const user = await newUser();
    await admin.query('INSERT INTO participants (hackathon_id, user_id) VALUES ($1, $2)', [hackathonId, user.id]);
    const looking = async () =>
      (await admin.query('SELECT looking FROM participants WHERE user_id = $1', [user.id])).rows[0].looking;
    await api.post('/invites/redeem', user, { code: (await newInvite(api, team)).code });
    expect(await looking()).toBe(false);
    await api.post(`/teams/${team.id}/leave`, user);
    expect(await looking()).toBe(true);
  });
});
