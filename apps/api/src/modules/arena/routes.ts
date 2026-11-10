import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { createDb, type Db } from '../../db/pool.js';
import { DomainError, errorBody, errors } from '../../lib/errors.js';
import { reserve } from '../../lib/rateLimit.js';
import { createInvite, redeemInvite, type Ctx } from '../teams/service.js';

export const ARENA_HACKATHON_ID = '00000000-0000-4000-8000-00000000a7e0';
const SEATS = 4;
const SEATED = SEATS - 1;
/** Enough concurrent transactions for the naive mode to admit several winners, and no more. */
const ARENA_POOL_MAX = 4;

/**
 * Runs real transactions from real rows in a sandbox hackathon: `bots` users race for one seat.
 * "naive" swaps in the read-then-write seat from the mutation check. It is safe to expose because
 * the team it corrupts is created here, for this run, and deleted before the response is sent.
 */
export async function arenaRoutes(instance: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  // Its own small pool: a run holds every connection it has, and those must never be the API's.
  const arena = createDb(config.databaseUrl, ARENA_POOL_MAX);
  instance.addHook('onClose', () => arena.close());
  let busy = false;

  async function runRace(mode: 'safe' | 'naive', bots: number, requestId: string) {
    const runId = randomUUID();
    const total = SEATED + bots;

    // Fresh bots per run keep concurrent runs from colliding on the one-team primary key.
    const users = await arena.pool.query<{ id: string; name: string }>(
      `INSERT INTO users (email, name, password_hash, timezone, avail_start_min, avail_end_min)
       SELECT 'bot-' || $1 || '-' || n || '@arena.invalid', 'Bot ' || n, 'unusable', 'UTC', 0, 0
         FROM generate_series(1, $2::int) AS n
       RETURNING id, name`,
      [runId, total],
    );
    const everyone = users.rows;
    const seated = everyone.slice(0, SEATED);
    const contestants = everyone.slice(SEATED);
    const ctx = (c: Ctx['c'], actorId: string): Ctx => ({
      c,
      actorId,
      requestId,
      unsafeSeat: mode === 'naive',
    });

    let teamId: string | undefined;
    try {
      // Exactly one seat left: three seated, four seats.
      teamId = await arena.tx(async (c) => {
        const team = await c.query<{ id: string }>(
          `INSERT INTO teams (hackathon_id, name, max_size, member_count, version)
           VALUES ($1, $2, $3, $4, 1) RETURNING id`,
          [ARENA_HACKATHON_ID, `arena-${runId}`, SEATS, SEATED],
        );
        const id = team.rows[0]!.id;
        await c.query(
          `INSERT INTO memberships (hackathon_id, user_id, team_id, role)
           SELECT $1, u, $2, CASE WHEN ord = 1 THEN 'leader' ELSE 'member' END
             FROM unnest($3::uuid[]) WITH ORDINALITY AS t(u, ord)`,
          [ARENA_HACKATHON_ID, id, seated.map((u) => u.id)],
        );
        return id;
      });

      const invite = await arena.tx((c) => createInvite(ctx(c, seated[0]!.id), teamId!, { expiresInHours: 1 }));
      const code = (invite.body as { code: string }).code;

      // Open the pool first. On a cold pool, transactions finish one by one while connections are
      // still being opened, so nothing actually overlaps and even the naive code gets one winner.
      await Promise.all(
        Array.from({ length: Math.min(ARENA_POOL_MAX, bots) }, () => arena.pool.query('SELECT pg_sleep(0.02)')),
      );

      // Everyone is released together, so they really do reach the seat UPDATE at the same time.
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = contestants.map(async (bot) => {
        await barrier;
        const started = performance.now();
        try {
          await arena.tx((c) => redeemInvite(ctx(c, bot.id), code));
          return { name: bot.name, outcome: 'won' as const, code: null, ms: performance.now() - started };
        } catch (err) {
          if (!(err instanceof DomainError)) throw err;
          return { name: bot.name, outcome: 'lost' as const, code: err.code, ms: performance.now() - started };
        }
      });
      const startedAt = performance.now();
      release();
      const results = await Promise.all(running);
      const elapsedMs = performance.now() - startedAt;

      const check = await arena.pool.query<{ member_count: number; actual: number }>(
        `SELECT t.member_count, (SELECT count(*)::int FROM memberships m WHERE m.team_id = t.id) AS actual
           FROM teams t WHERE t.id = $1`,
        [teamId],
      );
      const { member_count: memberCount, actual: actualMembers } = check.rows[0]!;

      return {
        mode,
        seats: SEATS,
        seatedBefore: SEATED,
        winners: results.filter((r) => r.outcome === 'won').length,
        memberCount,
        actualMembers,
        invariantHolds: memberCount === actualMembers && actualMembers <= SEATS,
        elapsedMs: Math.round(elapsedMs * 10) / 10,
        results: results.map((r) => ({ ...r, ms: Math.round(r.ms * 10) / 10 })),
      };
    } finally {
      if (teamId) await arena.pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
      await arena.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [everyone.map((u) => u.id)]);
    }
  }

  app.post(
    '/arena/run',
    {
      schema: {
        body: z.object({
          mode: z.enum(['safe', 'naive']).default('safe'),
          bots: z.number().int().min(2).max(50).default(50),
        }),
      },
    },
    async (req, reply) => {
      if (!config.arenaEnabled) throw new DomainError(404, 'NOT_FOUND', 'The arena is not enabled here.');
      // One run at a time per process, checked and taken with no await in between.
      if (busy) {
        return reply.header('Retry-After', 2).status(429).send(errorBody('RATE_LIMITED', 'A race is already running.'));
      }
      busy = true;
      try {
        const limit = await reserve(db.pool, config.arenaLimit, 'arena', req.user!.id, req.ip);
        if (!limit.allowed) {
          return reply
            .header('Retry-After', limit.retryAfterSeconds)
            .status(429)
            .send(errorBody('RATE_LIMITED', 'Give the arena a moment.'));
        }
        return await runRace(req.body.mode, req.body.bots, req.id);
      } finally {
        busy = false;
      }
    },
  );

  app.get('/arena/status', async () => {
    if (!config.arenaEnabled) throw errors.teamNotFound();
    return { enabled: true, seats: SEATS, seatedBefore: SEATED };
  });
}
