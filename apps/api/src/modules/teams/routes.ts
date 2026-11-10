import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db, Tx } from '../../db/pool.js';
import { errorBody, errors } from '../../lib/errors.js';
import { execute, send, type Outcome } from '../../lib/mutation.js';
import type { Metrics } from '../../lib/metrics.js';
import { reserve, throttleWrites } from '../../lib/rateLimit.js';
import { idParams, name, tags, uuid } from '../../lib/schemas.js';
import * as teams from './service.js';

const FAILED_GUESSES = new Set(['CODE_INVALID', 'CODE_EXPIRED', 'CODE_REVOKED']);

const LOST_RACE = new Set(['TEAM_FULL', 'ALREADY_IN_TEAM', 'CODE_EXHAUSTED', 'REQUEST_NOT_PENDING']);

/**
 * The actions that change who is in the team, which is all the timeline replays. Each needs a
 * member, a leader's accept or a valid code, so an outsider cannot pad the history with requests.
 */
const ROSTER_ACTIONS = ['team.created', 'member.joined', 'member.left', 'member.removed', 'leader.transferred', 'team.deleted'];
const HISTORY_PAGE = 500;
const historyQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });

export async function teamRoutes(
  instance: FastifyInstance,
  { db, config, metrics }: { db: Db; config: Config; metrics: Metrics },
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const throttle = throttleWrites(db.pool, config.writeLimit);

  const ctx = (req: FastifyRequest, c: Tx): teams.Ctx => ({
    c,
    actorId: req.user!.id,
    requestId: req.id,
    unsafeSeat: config.unsafeSeatForMutationCheck,
  });

  /** Counts seats taken and races lost, for /metrics and the ops panel. */
  const record = (outcome: Outcome) => {
    if (outcome.replayed) return outcome;
    if (outcome.status < 300) metrics.recordJoin();
    else if (LOST_RACE.has(outcome.errorCode ?? '')) metrics.recordConflict(outcome.errorCode!);
    return outcome;
  };

  /** Reads and writes share one leader check, so a non-leader cannot list what they cannot change. */
  async function requireLeader(teamId: string, userId: string) {
    const { rowCount } = await db.pool.query(
      `SELECT 1 FROM memberships WHERE team_id = $1 AND user_id = $2 AND role = 'leader'`,
      [teamId, userId],
    );
    if (!rowCount) throw errors.notLeader();
  }

  app.post(
    '/hackathons/:id/teams',
    {
      schema: {
        params: idParams,
        body: z.object({ name, lookingFor: tags.default([]) }),
      },
    },
    async (req, reply) =>
      send(reply, await execute(db, req, (c) => teams.createTeam(ctx(req, c), req.params.id, req.body))),
  );

  app.get('/teams/:id', { schema: { params: idParams } }, async (req) => teams.readTeam(db.pool, req.params.id));

  app.patch(
    '/teams/:id',
    {
      preHandler: throttle,
      schema: {
        params: idParams,
        body: z
          .object({ name: name.optional(), lookingFor: tags.optional() })
          .refine((b) => b.name !== undefined || b.lookingFor !== undefined, 'Give a name or lookingFor'),
      },
    },
    async (req, reply) =>
      send(reply, await execute(db, req, (c) => teams.updateTeam(ctx(req, c), req.params.id, req.body))),
  );

  /**
   * Open to any signed-in user, and it keeps working after the team is deleted: that is the point.
   * Oldest first, so a page always starts from team.created; pass nextCursor as `after` for more.
   */
  app.get('/teams/:id/history', { schema: { params: idParams, querystring: historyQuery } }, async (req) => {
    const { rows } = await db.pool.query<{ id: number; actor_id: string; payload: Record<string, unknown> }>(
      `SELECT id, action, actor_id, team_version AS version, payload, created_at AS at
         FROM audit_events
        WHERE team_id = $1 AND action = ANY($2::text[]) AND id > $3
        ORDER BY id LIMIT $4`,
      [req.params.id, ROSTER_ACTIONS, req.query.after, HISTORY_PAGE],
    );
    const userIds = new Set<string>();
    for (const e of rows) {
      userIds.add(e.actor_id);
      for (const key of ['userId', 'promoted', 'from', 'to']) {
        if (typeof e.payload[key] === 'string') userIds.add(e.payload[key] as string);
      }
    }
    const names = await db.pool.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [
      [...userIds],
    ]);
    return {
      events: rows.map(({ payload, ...e }) => ({
        ...e,
        userId: payload.userId ?? null,
        promoted: payload.promoted ?? null,
        from: payload.from ?? null,
        to: payload.to ?? null,
      })),
      names: Object.fromEntries(names.rows.map((u) => [u.id, u.name])),
      nextCursor: rows.length === HISTORY_PAGE ? rows.at(-1)!.id : null,
    };
  });

  app.post('/teams/:id/leave', { schema: { params: idParams } }, async (req, reply) =>
    send(reply, await execute(db, req, (c) => teams.leaveTeam(ctx(req, c), req.params.id))),
  );

  app.delete(
    '/teams/:id/members/:userId',
    { schema: { params: z.object({ id: uuid, userId: uuid }) } },
    async (req, reply) =>
      send(reply, await execute(db, req, (c) => teams.removeMember(ctx(req, c), req.params.id, req.params.userId))),
  );

  app.post(
    '/teams/:id/transfer',
    { schema: { params: idParams, body: z.object({ userId: uuid }) } },
    async (req, reply) =>
      send(reply, await execute(db, req, (c) => teams.transferLeadership(ctx(req, c), req.params.id, req.body.userId))),
  );

  app.post(
    '/teams/:id/invites',
    {
      schema: {
        params: idParams,
        body: z.object({
          expiresInHours: z.number().int().min(1).max(168).default(48),
          maxUses: z.number().int().min(1).max(1000).optional(),
        }),
      },
    },
    // The response holds the plaintext code, so it is never written to idempotency_keys. A retry just
    // mints another code; the unused one expires or gets revoked.
    async (req, reply) =>
      send(
        reply,
        await execute(db, req, (c) => teams.createInvite(ctx(req, c), req.params.id, req.body), { storeResponse: false }),
      ),
  );

  app.get('/teams/:id/invites', { schema: { params: idParams } }, async (req) => {
    await requireLeader(req.params.id, req.user!.id);
    const { rows } = await db.pool.query(
      `SELECT id, expires_at AS "expiresAt", revoked_at AS "revokedAt", max_uses AS "maxUses", uses
         FROM invite_codes WHERE team_id = $1 ORDER BY expires_at DESC`,
      [req.params.id],
    );
    return { invites: rows };
  });

  app.delete(
    '/teams/:id/invites/:inviteId',
    { schema: { params: z.object({ id: uuid, inviteId: uuid }) } },
    async (req, reply) =>
      send(reply, await execute(db, req, (c) => teams.revokeInvite(ctx(req, c), req.params.id, req.params.inviteId))),
  );

  app.post(
    '/invites/redeem',
    { schema: { body: z.object({ code: z.string().min(1).max(40) }) } },
    async (req, reply) => {
      const limit = await reserve(db.pool, config.inviteLimit, 'invite', req.user!.id, req.ip);
      if (!limit.allowed) {
        return reply
          .header('Retry-After', limit.retryAfterSeconds)
          .status(429)
          .send(errorBody('RATE_LIMITED', 'Too many invalid codes. Try again later.'));
      }

      const outcome = record(await execute(db, req, (c) => teams.redeemInvite(ctx(req, c), req.body.code)));
      const failedGuess = !outcome.replayed && FAILED_GUESSES.has(outcome.errorCode ?? '');
      if (!failedGuess) await limit.refund();
      return send(reply, outcome);
    },
  );

  app.post(
    '/teams/:id/requests',
    { preHandler: throttle, schema: { params: idParams, body: z.object({ message: z.string().trim().max(500).optional() }) } },
    async (req, reply) =>
      send(reply, await execute(db, req, (c) => teams.createJoinRequest(ctx(req, c), req.params.id, req.body.message))),
  );

  app.get('/teams/:id/requests', { schema: { params: idParams } }, async (req) => {
    await requireLeader(req.params.id, req.user!.id);
    const { rows } = await db.pool.query(
      `SELECT r.id, r.user_id AS "userId", u.name, u.skills, r.message, r.created_at AS "createdAt"
         FROM join_requests r JOIN users u ON u.id = r.user_id
        WHERE r.team_id = $1 AND r.status = 'pending'
        ORDER BY r.created_at, r.id`,
      [req.params.id],
    );
    return { requests: rows };
  });

  app.post('/requests/:id/accept', { schema: { params: idParams } }, async (req, reply) =>
    send(reply, record(await execute(db, req, (c) => teams.acceptRequest(ctx(req, c), req.params.id)))),
  );

  app.post('/requests/:id/decline', { schema: { params: idParams } }, async (req, reply) =>
    send(reply, await execute(db, req, (c) => teams.declineRequest(ctx(req, c), req.params.id))),
  );

  app.post('/requests/:id/cancel', { preHandler: throttle, schema: { params: idParams } }, async (req, reply) =>
    send(reply, await execute(db, req, (c) => teams.cancelRequest(ctx(req, c), req.params.id))),
  );
}
