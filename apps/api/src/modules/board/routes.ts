import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { appendAudit } from '../../lib/audit.js';
import { errors, isPgError } from '../../lib/errors.js';
import { execute, send } from '../../lib/mutation.js';
import { throttleWrites } from '../../lib/rateLimit.js';
import { idParams, tags } from '../../lib/schemas.js';
import type { EventHub } from '../events/hub.js';
import { MicroCache } from './cache.js';

/**
 * The cursor carries updated_at as Postgres text, not a JS Date. Date truncates to milliseconds,
 * while timestamptz has microseconds, so a Date cursor would skip or repeat rows in the same ms.
 */
const cursorSchema = z
  .string()
  .max(200)
  .transform((raw, ctx) => {
    try {
      const parsed = z
        .tuple([z.string().refine((ts) => !Number.isNaN(Date.parse(ts))), z.string().uuid()])
        .parse(JSON.parse(Buffer.from(raw, 'base64url').toString()));
      return { ts: parsed[0], id: parsed[1] };
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid cursor' });
      return z.NEVER;
    }
  });

const encodeCursor = (ts: string, id: string) => Buffer.from(JSON.stringify([ts, id])).toString('base64url');

const boardQuery = z.object({
  cursor: cursorSchema.optional(),
  // Empty segments (a half-typed "react,") are ignored; a malformed tag is a 400, never "no filter".
  skill: z
    .string()
    .max(200)
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(tags)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});

const teamBoardQuery = boardQuery.extend({ q: z.string().trim().min(1).max(80).optional() });

/** A name search matches literally: % and _ typed by the user are not wildcards. */
const containsPattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function boardRoutes(
  instance: FastifyInstance,
  { db, hub, config }: { db: Db; hub: EventHub; config: Config },
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const cache = new MicroCache();

  async function sendCached(
    req: FastifyRequest,
    reply: FastifyReply,
    key: string,
    hackathonId: string,
    load: () => Promise<unknown>,
  ) {
    const { body, etag } = await cache.get(key, hub.boardVersion(hackathonId), load);
    reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.type('application/json').send(body);
  }

  app.get('/hackathons', async () => {
    const { rows } = await db.pool.query(
      `SELECT h.id, h.name, h.min_team_size AS "minSize", h.max_team_size AS "maxSize",
              (SELECT count(*)::int FROM teams t WHERE t.hackathon_id = h.id) AS "teamCount",
              (SELECT count(*)::int FROM participants p WHERE p.hackathon_id = h.id AND p.looking) AS "lookingCount"
         FROM hackathons h WHERE NOT h.is_sandbox ORDER BY h.name, h.id`,
    );
    return { hackathons: rows };
  });

  app.get('/hackathons/:id', { schema: { params: idParams } }, async (req) => {
    const { rows } = await db.pool.query(
      `SELECT id, name, min_team_size AS "minSize", max_team_size AS "maxSize" FROM hackathons WHERE id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw errors.hackathonNotFound();
    return rows[0];
  });

  /** Where the signed-in person stands in this hackathon. */
  app.get('/hackathons/:id/me', { schema: { params: idParams } }, async (req) => {
    const { rows } = await db.pool.query(
      `SELECT (SELECT team_id FROM memberships WHERE hackathon_id = $1 AND user_id = $2) AS "teamId",
              (SELECT role FROM memberships WHERE hackathon_id = $1 AND user_id = $2) AS role,
              (SELECT looking FROM participants WHERE hackathon_id = $1 AND user_id = $2) AS looking,
              (SELECT pitch FROM participants WHERE hackathon_id = $1 AND user_id = $2) AS pitch,
              ARRAY(SELECT r.team_id FROM join_requests r JOIN teams t ON t.id = r.team_id
                     WHERE r.user_id = $2 AND r.status = 'pending' AND t.hackathon_id = $1) AS "pendingTeamIds",
              COALESCE((SELECT json_object_agg(r.team_id, r.id) FROM join_requests r JOIN teams t ON t.id = r.team_id
                         WHERE r.user_id = $2 AND r.status = 'pending' AND t.hackathon_id = $1), '{}') AS "pendingRequests"`,
      [req.params.id, req.user!.id],
    );
    return rows[0];
  });

  app.get('/hackathons/:id/board/teams', { schema: { params: idParams, querystring: teamBoardQuery } }, async (req, reply) => {
    const { cursor, limit, q } = req.query;
    const skills = req.query.skill?.length ? req.query.skill : null;
    // q is free text, so it goes last: nothing after it can be confused with part of it.
    const key = `teams|${req.params.id}|${cursor?.ts ?? ''}|${cursor?.id ?? ''}|${skills?.join(',') ?? ''}|${limit}|${q ?? ''}`;

    return sendCached(req, reply, key, req.params.id, async () => {
      const { rows } = await db.pool.query(
        `SELECT t.id, t.name, t.looking_for AS "lookingFor", t.member_count AS "memberCount",
                t.max_size AS "maxSize", t.version, t.updated_at::text AS ts,
                (SELECT json_agg(json_build_object('userId', m.user_id, 'name', u.name, 'role', m.role)
                                 ORDER BY m.joined_at, m.user_id)
                   FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.team_id = t.id) AS members
           FROM teams t
          WHERE t.hackathon_id = $1
            AND t.member_count < t.max_size
            AND ($2::text[] IS NULL OR t.looking_for && $2::text[])
            AND ($3::timestamptz IS NULL OR (t.updated_at, t.id) < ($3::timestamptz, $4::uuid))
            AND ($6::text IS NULL OR t.name ILIKE $6)
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT $5`,
        [req.params.id, skills, cursor?.ts ?? null, cursor?.id ?? null, limit, q ? containsPattern(q) : null],
      );
      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        teams: rows.map(({ ts: _ts, ...team }) => team),
        nextCursor: last ? encodeCursor(last.ts, last.id) : null,
      };
    });
  });

  app.get('/hackathons/:id/board/people', { schema: { params: idParams, querystring: boardQuery } }, async (req, reply) => {
    const { cursor, limit } = req.query;
    const skills = req.query.skill?.length ? req.query.skill : null;
    const key = `people|${req.params.id}|${cursor?.ts ?? ''}|${cursor?.id ?? ''}|${skills?.join(',') ?? ''}|${limit}`;

    return sendCached(req, reply, key, req.params.id, async () => {
      const { rows } = await db.pool.query(
        `SELECT u.id, u.name, u.skills, u.primary_role AS "primaryRole", u.timezone, p.pitch,
                p.updated_at::text AS ts
           FROM participants p JOIN users u ON u.id = p.user_id
          WHERE p.hackathon_id = $1
            AND p.looking
            AND ($2::text[] IS NULL OR u.skills && $2::text[])
            AND ($3::timestamptz IS NULL OR (p.updated_at, p.user_id) < ($3::timestamptz, $4::uuid))
          ORDER BY p.updated_at DESC, p.user_id DESC
          LIMIT $5`,
        [req.params.id, skills, cursor?.ts ?? null, cursor?.id ?? null, limit],
      );
      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        people: rows.map(({ ts: _ts, ...person }) => person),
        nextCursor: last ? encodeCursor(last.ts, last.id) : null,
      };
    });
  });

  /** Joins the board or updates your entry. Someone already in a team stays off the board. */
  app.put(
    '/hackathons/:id/participation',
    {
      preHandler: throttleWrites(db.pool, config.writeLimit),
      schema: {
        params: idParams,
        body: z.object({ looking: z.boolean(), pitch: z.string().trim().max(280).optional() }),
      },
    },
    async (req, reply) =>
      send(
        reply,
        await execute(db, req, async (c) => {
          const userId = req.user!.id;
          const seated = await c.query('SELECT 1 FROM memberships WHERE hackathon_id = $1 AND user_id = $2', [
            req.params.id,
            userId,
          ]);
          if (seated.rowCount && req.body.looking) throw errors.alreadyInTeam();
          // A repeat of what is already stored writes nothing: no audit row, no broadcast, and no
          // bump to the top of the board.
          let changed: number | null;
          try {
            ({ rowCount: changed } = await c.query(
              `INSERT INTO participants (hackathon_id, user_id, looking, pitch) VALUES ($1, $2, $3, $4)
               ON CONFLICT (hackathon_id, user_id)
               DO UPDATE SET looking = EXCLUDED.looking, pitch = COALESCE(EXCLUDED.pitch, participants.pitch), updated_at = now()
                WHERE participants.looking IS DISTINCT FROM EXCLUDED.looking
                   OR (EXCLUDED.pitch IS NOT NULL AND EXCLUDED.pitch IS DISTINCT FROM participants.pitch)`,
              [req.params.id, userId, req.body.looking, req.body.pitch ?? null],
            ));
          } catch (err) {
            if (isPgError(err, '23503')) throw errors.hackathonNotFound();
            throw err;
          }
          if (changed) {
            await appendAudit(c, {
              hackathonId: req.params.id,
              teamId: null,
              actorId: userId,
              action: 'participant.updated',
              teamVersion: null,
              payload: { userId, looking: req.body.looking },
              requestId: req.id,
            });
          }
          return { status: 200, body: { looking: req.body.looking } };
        }),
      ),
  );
}
