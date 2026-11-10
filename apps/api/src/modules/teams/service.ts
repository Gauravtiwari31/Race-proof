import { appendAudit } from '../../lib/audit.js';
import { canonicalInviteCode, generateInviteCode, sha256 } from '../../lib/crypto.js';
import { faultPoint } from '../../lib/fault.js';
import { errors, isPgError } from '../../lib/errors.js';
import type { Result } from '../../lib/mutation.js';
import type { Tx } from '../../db/pool.js';

/*
 * LOCK ORDER, for every mutation in this file: team row -> memberships -> user row -> requests / invite codes.
 *
 * Each transaction locks at most one team row, so team locks cannot form a cycle. The remaining
 * cross-team contact is a user's membership key, their user row and their pending requests, and the
 * fixed order means those cannot cycle either. race.mixed-no-deadlock checks this for real.
 *
 * The USER ROW is a per-person mutex between "join a team" and "ask to join another team". Without it
 * a request committed while its author joins elsewhere is invisible to the join's cleanup and stays
 * pending forever. race.request-vs-join pins this down.
 *
 * AUTHORISATION comes in a separate statement AFTER the team lock, never in the WHERE clause of the
 * statement taking it. When READ COMMITTED re-checks a blocked UPDATE it re-reads only the locked
 * row; a subquery on memberships keeps the old snapshot and would still see a just-demoted leader.
 * A new statement gets a new snapshot. race.stale-leader-check pins this down.
 */

export interface Ctx {
  c: Tx;
  actorId: string;
  requestId: string;
  unsafeSeat: boolean;
}

interface TeamLock {
  id: string;
  hackathon_id: string;
  version: number;
  member_count: number;
}

const TEAM_COLUMNS = 'id, hackathon_id, version, member_count';

async function lockTeam(c: Tx, teamId: string): Promise<TeamLock> {
  // NO KEY: blocks other writers of this team but not inserts of rows that reference it.
  const { rows } = await c.query<TeamLock>(`SELECT ${TEAM_COLUMNS} FROM teams WHERE id = $1 FOR NO KEY UPDATE`, [teamId]);
  if (!rows[0]) throw errors.teamNotFound();
  return rows[0];
}

async function assertLeader(c: Tx, teamId: string, userId: string): Promise<void> {
  const { rowCount } = await c.query(
    `SELECT 1 FROM memberships WHERE team_id = $1 AND user_id = $2 AND role = 'leader'`,
    [teamId, userId],
  );
  if (!rowCount) throw errors.notLeader();
}

/**
 * Takes a seat atomically: the WHERE clause IS the capacity check.
 *
 * Racers block on the row lock. When the winner commits, READ COMMITTED re-evaluates the WHERE
 * against the new row version, finds member_count = max_size, and updates 0 rows. There is no gap
 * between check and act because they are one statement.
 */
async function takeSeat(ctx: Ctx, teamId: string): Promise<TeamLock> {
  if (ctx.unsafeSeat) return takeSeatUnsafely(ctx.c, teamId);

  const { rows } = await ctx.c.query<TeamLock>(
    `UPDATE teams SET member_count = member_count + 1, version = version + 1, updated_at = now()
      WHERE id = $1 AND member_count < max_size
      RETURNING ${TEAM_COLUMNS}`,
    [teamId],
  );
  if (rows[0]) return rows[0];

  const exists = await ctx.c.query('SELECT 1 FROM teams WHERE id = $1', [teamId]);
  throw exists.rowCount ? errors.teamFull() : errors.teamNotFound();
}

/** The classic bug, kept only so race.mutation-check can show the race test catching it. */
async function takeSeatUnsafely(c: Tx, teamId: string): Promise<TeamLock> {
  const { rows } = await c.query<{ member_count: number; max_size: number }>(
    'SELECT member_count, max_size FROM teams WHERE id = $1',
    [teamId],
  );
  const team = rows[0];
  if (!team) throw errors.teamNotFound();
  if (team.member_count >= team.max_size) throw errors.teamFull();
  const updated = await c.query<TeamLock>(
    `UPDATE teams SET member_count = $2, version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING ${TEAM_COLUMNS}`,
    [teamId, team.member_count + 1],
  );
  return updated.rows[0]!;
}

/** Inserts the membership; the primary key refuses a second team however the calls interleave. */
async function addMember(ctx: Ctx, team: TeamLock, userId: string): Promise<void> {
  try {
    await ctx.c.query(`INSERT INTO memberships (hackathon_id, user_id, team_id, role) VALUES ($1, $2, $3, 'member')`, [
      team.hackathon_id,
      userId,
      team.id,
    ]);
  } catch (err) {
    if (isPgError(err, '23505', 'memberships_pkey')) throw errors.alreadyInTeam();
    throw err;
  }
}

/**
 * Serialises one person's joins against their new join requests. NO KEY: foreign-key checks on the
 * user row take KEY SHARE, which this does not block.
 */
async function lockUser(c: Tx, userId: string): Promise<void> {
  await c.query('SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
}

/** Once someone is in a team, their other requests are moot and they are no longer looking. */
async function settleNewMember(c: Tx, hackathonId: string, userId: string): Promise<void> {
  // Lock first: the cancel below is a new statement, so it sees any request committed while we waited.
  await lockUser(c, userId);
  await c.query(
    `UPDATE join_requests SET status = 'cancelled'
      WHERE user_id = $1 AND status = 'pending'
        AND team_id IN (SELECT id FROM teams WHERE hackathon_id = $2)`,
    [userId, hackathonId],
  );
  await c.query(`UPDATE participants SET looking = false, updated_at = now() WHERE hackathon_id = $1 AND user_id = $2`, [
    hackathonId,
    userId,
  ]);
}

/** The team as GET /teams/:id shows it. Takes a transaction too, so a write can answer with it. */
export async function readTeam(c: Pick<Tx, 'query'>, teamId: string) {
  const { rows } = await c.query(
    `SELECT t.id, t.hackathon_id AS "hackathonId", t.name, t.looking_for AS "lookingFor",
            t.max_size AS "maxSize", t.member_count AS "memberCount", t.version,
            h.min_team_size AS "minSize",
            CASE WHEN t.member_count < h.min_team_size THEN 'forming' ELSE 'ready' END AS status,
            (SELECT json_agg(json_build_object(
                      'userId', m.user_id, 'name', u.name, 'role', m.role, 'joinedAt', m.joined_at)
                      ORDER BY m.joined_at, m.user_id)
               FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.team_id = t.id) AS members
       FROM teams t JOIN hackathons h ON h.id = t.hackathon_id
      WHERE t.id = $1`,
    [teamId],
  );
  if (!rows[0]) throw errors.teamNotFound();
  return rows[0];
}

export async function createTeam(
  ctx: Ctx,
  hackathonId: string,
  input: { name: string; lookingFor: string[] },
): Promise<Result> {
  let team: TeamLock | undefined;
  try {
    const { rows } = await ctx.c.query<TeamLock>(
      `INSERT INTO teams (hackathon_id, name, looking_for, max_size, member_count, version)
       SELECT h.id, $2, $3, h.max_team_size, 1, 1 FROM hackathons h WHERE h.id = $1
       RETURNING ${TEAM_COLUMNS}`,
      [hackathonId, input.name, input.lookingFor],
    );
    team = rows[0];
  } catch (err) {
    if (isPgError(err, '23505', 'teams_name_uq')) throw errors.teamNameTaken();
    throw err;
  }
  if (!team) throw errors.hackathonNotFound();

  try {
    await ctx.c.query(`INSERT INTO memberships (hackathon_id, user_id, team_id, role) VALUES ($1, $2, $3, 'leader')`, [
      hackathonId,
      ctx.actorId,
      team.id,
    ]);
  } catch (err) {
    if (isPgError(err, '23505', 'memberships_pkey')) throw errors.alreadyInTeam();
    throw err;
  }
  await settleNewMember(ctx.c, hackathonId, ctx.actorId);
  await appendAudit(ctx.c, {
    hackathonId,
    teamId: team.id,
    actorId: ctx.actorId,
    action: 'team.created',
    teamVersion: team.version,
    payload: { name: input.name, userId: ctx.actorId, memberCount: team.member_count },
    requestId: ctx.requestId,
  });
  return { status: 201, body: { teamId: team.id, memberCount: team.member_count, version: team.version } };
}

interface InviteState {
  id: string;
  team_id: string;
  hackathon_id: string;
  expired: boolean;
  revoked: boolean;
  exhausted: boolean;
}

function assertUsable(invite: InviteState): void {
  if (invite.revoked) throw errors.codeRevoked();
  if (invite.expired) throw errors.codeExpired();
  if (invite.exhausted) throw errors.codeExhausted();
}

async function readInvite(c: Tx, where: string, value: string | Buffer): Promise<InviteState | undefined> {
  const { rows } = await c.query<InviteState>(
    `SELECT i.id, i.team_id, t.hackathon_id,
            i.expires_at <= clock_timestamp() AS expired,
            i.revoked_at IS NOT NULL AS revoked,
            i.max_uses IS NOT NULL AND i.uses >= i.max_uses AS exhausted
       FROM invite_codes i JOIN teams t ON t.id = i.team_id
      WHERE ${where} = $1`,
    [value],
  );
  return rows[0];
}

export async function redeemInvite(ctx: Ctx, rawCode: string): Promise<Result> {
  const code = canonicalInviteCode(rawCode);
  if (!code) throw errors.codeInvalid();

  // Unlocked read to find the team. The code row is NOT locked yet: locking it before the team
  // deadlocks with a last-member leave, which holds the team and cascades to its codes.
  const invite = await readInvite(ctx.c, 'i.code_hash', sha256(code));
  if (!invite) throw errors.codeInvalid();
  assertUsable(invite); // fast, precise failure; the guarded UPDATE below remains the real check

  // Advisory: gives a precise error and avoids queueing on the team lock. The PK is the referee.
  const already = await ctx.c.query('SELECT 1 FROM memberships WHERE hackathon_id = $1 AND user_id = $2', [
    invite.hackathon_id,
    ctx.actorId,
  ]);
  if (already.rowCount) throw errors.alreadyInTeam();

  const team = await takeSeat(ctx, invite.team_id);
  faultPoint('after_seat_update');
  await addMember(ctx, team, ctx.actorId);

  const consumed = await ctx.c.query(
    `UPDATE invite_codes SET uses = uses + 1
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
        AND (max_uses IS NULL OR uses < max_uses)
      RETURNING id`,
    [invite.id],
  );
  if (!consumed.rowCount) {
    const latest = await readInvite(ctx.c, 'i.id', invite.id);
    if (latest) assertUsable(latest);
    throw errors.codeInvalid();
  }

  await settleNewMember(ctx.c, team.hackathon_id, ctx.actorId);
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorId: ctx.actorId,
    action: 'member.joined',
    teamVersion: team.version,
    payload: { userId: ctx.actorId, via: 'invite', inviteId: invite.id, memberCount: team.member_count },
    requestId: ctx.requestId,
  });
  return { status: 201, body: { teamId: team.id, memberCount: team.member_count, version: team.version } };
}

/** Shared by leave and remove. Takes the team lock first, so concurrent departures serialise. */
async function depart(ctx: Ctx, teamId: string, userId: string, removedByLeader: boolean): Promise<Result> {
  const { rows } = await ctx.c.query<TeamLock>(
    `UPDATE teams SET member_count = member_count - 1, version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING ${TEAM_COLUMNS}`,
    [teamId],
  );
  const team = rows[0];
  if (!team) throw errors.teamNotFound();
  if (removedByLeader) await assertLeader(ctx.c, teamId, ctx.actorId);

  const gone = await ctx.c.query<{ role: string }>(
    'DELETE FROM memberships WHERE team_id = $1 AND user_id = $2 RETURNING role',
    [teamId, userId],
  );
  const role = gone.rows[0]?.role;
  if (!role) throw errors.notAMember();

  await ctx.c.query(`UPDATE participants SET looking = true, updated_at = now() WHERE hackathon_id = $1 AND user_id = $2`, [
    team.hackathon_id,
    userId,
  ]);

  const base = { hackathonId: team.hackathon_id, teamId, actorId: ctx.actorId, requestId: ctx.requestId };

  if (team.member_count === 0) {
    await ctx.c.query('DELETE FROM teams WHERE id = $1', [teamId]);
    await appendAudit(ctx.c, {
      ...base,
      action: 'team.deleted',
      teamVersion: team.version,
      payload: { userId, memberCount: 0 },
    });
    return { status: 200, body: { teamDeleted: true, memberCount: 0 } };
  }

  let promoted: string | null = null;
  if (role === 'leader') {
    // Longest-standing member; user id breaks ties, so the outcome is deterministic and testable.
    const next = await ctx.c.query<{ user_id: string }>(
      `UPDATE memberships SET role = 'leader'
        WHERE (hackathon_id, user_id) = (
          SELECT hackathon_id, user_id FROM memberships
           WHERE team_id = $1 ORDER BY joined_at, user_id LIMIT 1)
        RETURNING user_id`,
      [teamId],
    );
    promoted = next.rows[0]!.user_id;
  }

  await appendAudit(ctx.c, {
    ...base,
    action: removedByLeader ? 'member.removed' : 'member.left',
    teamVersion: team.version,
    payload: { userId, promoted, memberCount: team.member_count },
  });
  return { status: 200, body: { teamDeleted: false, memberCount: team.member_count, version: team.version, promoted } };
}

export const leaveTeam = (ctx: Ctx, teamId: string) => depart(ctx, teamId, ctx.actorId, false);

export function removeMember(ctx: Ctx, teamId: string, userId: string): Promise<Result> {
  if (userId === ctx.actorId) throw errors.cannotRemoveSelf();
  return depart(ctx, teamId, userId, true);
}

export async function transferLeadership(ctx: Ctx, teamId: string, newLeaderId: string): Promise<Result> {
  await lockTeam(ctx.c, teamId);
  await assertLeader(ctx.c, teamId, ctx.actorId);
  if (newLeaderId === ctx.actorId) return { status: 200, body: { leaderId: ctx.actorId } };

  // Demote first: the one-leader unique index is checked per statement and cannot be deferred.
  await ctx.c.query(`UPDATE memberships SET role = 'member' WHERE team_id = $1 AND user_id = $2`, [teamId, ctx.actorId]);
  const promoted = await ctx.c.query(`UPDATE memberships SET role = 'leader' WHERE team_id = $1 AND user_id = $2`, [
    teamId,
    newLeaderId,
  ]);
  if (!promoted.rowCount) throw errors.notAMember();

  const { rows } = await ctx.c.query<TeamLock>(
    `UPDATE teams SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${TEAM_COLUMNS}`,
    [teamId],
  );
  const team = rows[0]!;
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId,
    actorId: ctx.actorId,
    action: 'leader.transferred',
    teamVersion: team.version,
    payload: { from: ctx.actorId, to: newLeaderId },
    requestId: ctx.requestId,
  });
  return { status: 200, body: { leaderId: newLeaderId, version: team.version } };
}

/** Renames the team or changes what it is looking for. Seats are untouched. */
export async function updateTeam(
  ctx: Ctx,
  teamId: string,
  input: { name?: string | undefined; lookingFor?: string[] | undefined },
): Promise<Result> {
  await lockTeam(ctx.c, teamId);
  await assertLeader(ctx.c, teamId, ctx.actorId);

  const { rows: old } = await ctx.c.query<{ name: string; looking_for: string[] }>(
    'SELECT name, looking_for FROM teams WHERE id = $1',
    [teamId],
  );
  const before = old[0]!;
  let team: TeamLock & typeof before;
  try {
    // The version bump is what lets live clients order this against seat changes.
    const { rows } = await ctx.c.query<TeamLock & typeof before>(
      `UPDATE teams SET name = COALESCE($2, name), looking_for = COALESCE($3, looking_for),
              version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING ${TEAM_COLUMNS}, name, looking_for`,
      [teamId, input.name ?? null, input.lookingFor ?? null],
    );
    team = rows[0]!;
  } catch (err) {
    if (isPgError(err, '23505', 'teams_name_uq')) throw errors.teamNameTaken();
    throw err;
  }
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId,
    actorId: ctx.actorId,
    action: 'team.updated',
    teamVersion: team.version,
    payload: {
      name: team.name,
      lookingFor: team.looking_for,
      memberCount: team.member_count,
      previous: { name: before.name, lookingFor: before.looking_for },
    },
    requestId: ctx.requestId,
  });
  return { status: 200, body: await readTeam(ctx.c, teamId) };
}

export async function createInvite(
  ctx: Ctx,
  teamId: string,
  input: { expiresInHours: number; maxUses?: number | undefined },
): Promise<Result> {
  const team = await lockTeam(ctx.c, teamId);
  await assertLeader(ctx.c, teamId, ctx.actorId);

  const code = generateInviteCode();
  const { rows } = await ctx.c.query<{ id: string; expires_at: Date }>(
    `INSERT INTO invite_codes (team_id, code_hash, expires_at, max_uses, created_by)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)
     RETURNING id, expires_at`,
    [teamId, sha256(canonicalInviteCode(code)!), input.expiresInHours, input.maxUses ?? null, ctx.actorId],
  );
  const invite = rows[0]!;
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId,
    actorId: ctx.actorId,
    action: 'invite.created',
    teamVersion: null,
    payload: { inviteId: invite.id, maxUses: input.maxUses ?? null, expiresAt: invite.expires_at },
    requestId: ctx.requestId,
  });
  return { status: 201, body: { id: invite.id, code, expiresAt: invite.expires_at, maxUses: input.maxUses ?? null } };
}

export async function revokeInvite(ctx: Ctx, teamId: string, inviteId: string): Promise<Result> {
  const team = await lockTeam(ctx.c, teamId);
  await assertLeader(ctx.c, teamId, ctx.actorId);

  const { rowCount } = await ctx.c.query(
    'UPDATE invite_codes SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND team_id = $2',
    [inviteId, teamId],
  );
  if (!rowCount) throw errors.inviteNotFound();
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId,
    actorId: ctx.actorId,
    action: 'invite.revoked',
    teamVersion: null,
    payload: { inviteId },
    requestId: ctx.requestId,
  });
  return { status: 200, body: { id: inviteId, revoked: true } };
}

export async function createJoinRequest(ctx: Ctx, teamId: string, message: string | undefined): Promise<Result> {
  const team = await lockTeam(ctx.c, teamId);
  // After this, a concurrent join by the same person has either committed (and the check below sees
  // it) or not reached its cleanup yet (and that cleanup will see and cancel this request).
  await lockUser(ctx.c, ctx.actorId);

  const already = await ctx.c.query('SELECT 1 FROM memberships WHERE hackathon_id = $1 AND user_id = $2', [
    team.hackathon_id,
    ctx.actorId,
  ]);
  if (already.rowCount) throw errors.alreadyInTeam();

  let id: string;
  try {
    const { rows } = await ctx.c.query<{ id: string }>(
      `INSERT INTO join_requests (team_id, user_id, message) VALUES ($1, $2, $3) RETURNING id`,
      [teamId, ctx.actorId, message ?? null],
    );
    id = rows[0]!.id;
  } catch (err) {
    if (isPgError(err, '23505', 'one_pending_request')) throw errors.requestPending();
    throw err;
  }
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId,
    actorId: ctx.actorId,
    action: 'request.created',
    teamVersion: null,
    payload: { requestId: id },
    requestId: ctx.requestId,
  });
  return { status: 201, body: { id, status: 'pending' } };
}

interface JoinRequest {
  team_id: string;
  user_id: string;
  status: string;
}

/** Reads the team id unlocked, then takes the team lock and re-reads the request under it. */
async function lockRequest(ctx: Ctx, requestId: string): Promise<{ team: TeamLock; request: JoinRequest }> {
  const first = await ctx.c.query<{ team_id: string }>('SELECT team_id FROM join_requests WHERE id = $1', [requestId]);
  if (!first.rows[0]) throw errors.requestNotFound();

  const team = await lockTeam(ctx.c, first.rows[0].team_id);
  const { rows } = await ctx.c.query<JoinRequest>('SELECT team_id, user_id, status FROM join_requests WHERE id = $1', [
    requestId,
  ]);
  if (!rows[0]) throw errors.requestNotFound();
  return { team, request: rows[0] };
}

async function closeRequest(ctx: Ctx, requestId: string, status: 'accepted' | 'declined' | 'cancelled'): Promise<void> {
  const { rowCount } = await ctx.c.query(
    `UPDATE join_requests SET status = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [requestId, status, ctx.actorId],
  );
  if (!rowCount) throw errors.requestNotPending();
}

export async function acceptRequest(ctx: Ctx, requestId: string): Promise<Result> {
  const { team: locked, request } = await lockRequest(ctx, requestId);
  await assertLeader(ctx.c, locked.id, ctx.actorId);
  if (request.status !== 'pending') throw errors.requestNotPending();

  const team = await takeSeat(ctx, locked.id);
  // Membership before request, as everywhere else. The reverse order deadlocks with a redeem by the
  // same user, which holds the membership key while it cancels this very request.
  await addMember(ctx, team, request.user_id);
  await closeRequest(ctx, requestId, 'accepted');
  await settleNewMember(ctx.c, team.hackathon_id, request.user_id);
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorId: ctx.actorId,
    action: 'member.joined',
    teamVersion: team.version,
    payload: { userId: request.user_id, via: 'request', requestId, memberCount: team.member_count },
    requestId: ctx.requestId,
  });
  return {
    status: 200,
    body: { id: requestId, status: 'accepted', memberCount: team.member_count, version: team.version },
  };
}

export async function declineRequest(ctx: Ctx, requestId: string): Promise<Result> {
  const { team, request } = await lockRequest(ctx, requestId);
  await assertLeader(ctx.c, team.id, ctx.actorId);
  await closeRequest(ctx, requestId, 'declined');
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorId: ctx.actorId,
    action: 'request.declined',
    teamVersion: null,
    payload: { requestId, userId: request.user_id },
    requestId: ctx.requestId,
  });
  return { status: 200, body: { id: requestId, status: 'declined' } };
}

export async function cancelRequest(ctx: Ctx, requestId: string): Promise<Result> {
  const { team, request } = await lockRequest(ctx, requestId);
  if (request.user_id !== ctx.actorId) throw errors.notYourRequest();
  await closeRequest(ctx, requestId, 'cancelled');
  await appendAudit(ctx.c, {
    hackathonId: team.hackathon_id,
    teamId: team.id,
    actorId: ctx.actorId,
    action: 'request.cancelled',
    teamVersion: null,
    payload: { requestId },
    requestId: ctx.requestId,
  });
  return { status: 200, body: { id: requestId, status: 'cancelled' } };
}
