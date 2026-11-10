import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { errors } from '../../lib/errors.js';
import { idParams } from '../../lib/schemas.js';
import { rank, scoreCandidate, type Person } from './score.js';

const CANDIDATE_CAP = 500;

const PERSON_JSON = `json_build_object(
  'id', u.id, 'skills', u.skills, 'primaryRole', u.primary_role, 'timezone', u.timezone,
  'availStartMin', u.avail_start_min, 'availEndMin', u.avail_end_min)`;

export async function suggestRoutes(instance: FastifyInstance, { db }: { db: Db }) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/hackathons/:id/suggestions',
    {
      schema: {
        params: idParams,
        querystring: z.object({
          for: z.enum(['team', 'user']).default('team'),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }),
      },
    },
    async (req) => {
      const hackathonId = req.params.id;
      const now = new Date();

      if (req.query.for === 'team') {
        const team = await db.pool.query<{ id: string; looking_for: string[]; members: Person[] }>(
          `SELECT t.id, t.looking_for,
                  (SELECT json_agg(${PERSON_JSON}) FROM memberships m JOIN users u ON u.id = m.user_id
                    WHERE m.team_id = t.id) AS members
             FROM memberships me JOIN teams t ON t.id = me.team_id
            WHERE me.hackathon_id = $1 AND me.user_id = $2`,
          [hackathonId, req.user!.id],
        );
        const mine = team.rows[0];
        if (!mine) throw errors.notAMember();

        // The GIN pre-filter keeps scoring bounded. With nothing specific sought, take recent people.
        const candidates = await db.pool.query<Person & { name: string; pitch: string | null; updatedAt: Date }>(
          `SELECT u.id, u.name, u.skills, u.primary_role AS "primaryRole", u.timezone,
                  u.avail_start_min AS "availStartMin", u.avail_end_min AS "availEndMin",
                  p.pitch, p.updated_at AS "updatedAt"
             FROM participants p JOIN users u ON u.id = p.user_id
            WHERE p.hackathon_id = $1 AND p.looking
              AND (cardinality($2::text[]) = 0 OR u.skills && $2::text[])
              AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.hackathon_id = $1 AND m.user_id = u.id)
            ORDER BY p.updated_at DESC, u.id
            LIMIT $3`,
          [hackathonId, mine.looking_for, CANDIDATE_CAP],
        );

        const profile = { lookingFor: mine.looking_for, members: mine.members };
        const scored = candidates.rows.map((c) => ({
          id: c.id,
          userId: c.id,
          name: c.name,
          skills: c.skills,
          pitch: c.pitch,
          ...scoreCandidate(profile, c, { at: now, candidateUpdatedAt: c.updatedAt }),
        }));
        return { for: 'team', teamId: mine.id, suggestions: rank(scored, req.query.limit) };
      }

      const me = await db.pool.query<Person & { updatedAt: Date | null }>(
        `SELECT u.id, u.skills, u.primary_role AS "primaryRole", u.timezone,
                u.avail_start_min AS "availStartMin", u.avail_end_min AS "availEndMin",
                (SELECT updated_at FROM participants p WHERE p.hackathon_id = $1 AND p.user_id = u.id) AS "updatedAt"
           FROM users u WHERE u.id = $2`,
        [hackathonId, req.user!.id],
      );
      const person = me.rows[0]!;

      const teams = await db.pool.query<{
        id: string;
        name: string;
        looking_for: string[];
        member_count: number;
        max_size: number;
        members: Person[];
      }>(
        `SELECT t.id, t.name, t.looking_for, t.member_count, t.max_size,
                (SELECT json_agg(${PERSON_JSON}) FROM memberships m JOIN users u ON u.id = m.user_id
                  WHERE m.team_id = t.id) AS members
           FROM teams t
          WHERE t.hackathon_id = $1 AND t.member_count < t.max_size
            AND (cardinality($2::text[]) = 0 OR t.looking_for && $2::text[])
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT $3`,
        [hackathonId, person.skills, CANDIDATE_CAP],
      );

      const scored = teams.rows.map((t) => ({
        id: t.id,
        teamId: t.id,
        name: t.name,
        lookingFor: t.looking_for,
        memberCount: t.member_count,
        maxSize: t.max_size,
        ...scoreCandidate({ lookingFor: t.looking_for, members: t.members }, person, {
          at: now,
          candidateUpdatedAt: person.updatedAt,
        }),
      }));
      return { for: 'user', suggestions: rank(scored, req.query.limit) };
    },
  );
}
