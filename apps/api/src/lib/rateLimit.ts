import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { RateLimit } from '../config.js';
import { errorBody } from './errors.js';

export interface Reservation {
  allowed: boolean;
  retryAfterSeconds: number;
  /** Gives the hits back. Call it when the attempt turns out not to be a failure. */
  refund(): Promise<void>;
}

/**
 * Durable fixed-window limiter, shared by replicas and surviving restarts.
 *
 * It reserves before the attempt and refunds on success rather than counting failures afterwards.
 * Counting afterwards would let a burst of parallel guesses all pass the check before any is counted.
 * It runs outside the business transaction so a hot IP row is never locked for a whole join.
 */
export async function reserve(
  pool: pg.Pool,
  limit: RateLimit,
  scope: string,
  subject: string,
  ip: string,
): Promise<Reservation> {
  const taken: Array<{ key: string; windowStart: Date }> = [];
  const refund = async () => {
    for (const { key, windowStart } of taken) {
      await pool.query('UPDATE rate_limits SET hits = hits - 1 WHERE key = $1 AND window_start = $2', [key, windowStart]);
    }
  };

  const checks = [
    { key: `${scope}:subject:${subject}`, max: limit.perSubject },
    { key: `${scope}:ip:${ip}`, max: limit.perIp },
  ];
  for (const { key, max } of checks) {
    const { rows } = await pool.query<{ hits: number; window_start: Date; retry_after: string }>(
      `WITH w AS (SELECT to_timestamp(floor(extract(epoch FROM now()) / $2::int) * $2::int) AS start)
       INSERT INTO rate_limits (key, window_start, hits)
       SELECT $1, w.start, 1 FROM w
       ON CONFLICT (key, window_start) DO UPDATE SET hits = rate_limits.hits + 1
       RETURNING hits, window_start,
                 ceil(extract(epoch FROM rate_limits.window_start - now()) + $2::int) AS retry_after`,
      [key, limit.windowSeconds],
    );
    const row = rows[0]!;
    taken.push({ key, windowStart: row.window_start });
    if (row.hits > max) {
      await refund(); // a rejected attempt never reached the check, so it does not count as a guess
      return { allowed: false, retryAfterSeconds: Math.max(1, Number(row.retry_after)), refund: async () => {} };
    }
  }
  return { allowed: true, retryAfterSeconds: 0, refund };
}

/**
 * preHandler for writes that every board client hears about. Hits are never refunded: the cost is
 * the broadcast, whatever the outcome. It runs after validation, so a malformed body costs nothing.
 */
export function throttleWrites(pool: pg.Pool, limit: RateLimit) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const reservation = await reserve(pool, limit, 'write', req.user!.id, req.ip);
    if (reservation.allowed) return;
    return reply
      .header('Retry-After', reservation.retryAfterSeconds)
      .status(429)
      .send(errorBody('RATE_LIMITED', 'Slow down a little.'));
  };
}
