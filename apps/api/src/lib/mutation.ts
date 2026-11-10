import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db, Tx } from '../db/pool.js';
import { sha256 } from './crypto.js';
import { DomainError, errorBody, errors } from './errors.js';

export interface Result {
  status: number;
  body: unknown;
}

export interface Outcome extends Result {
  replayed: boolean;
  errorCode?: string;
}

const keySchema = z.string().uuid();

const fromDomainError = (err: DomainError): Outcome => ({
  status: err.status,
  body: errorBody(err.code, err.message),
  replayed: false,
  errorCode: err.code,
});

/**
 * Runs one mutation as one transaction, idempotently when the client sends Idempotency-Key.
 *
 * The key row commits in the same transaction as the business change. A crash therefore rolls back
 * both, so there is no "in progress forever" state, and a concurrent duplicate blocks on the primary
 * key until the first request commits, then replays its answer. This is only valid because every
 * side effect is local to this one ACID database.
 */
export async function execute(
  db: Db,
  req: FastifyRequest,
  work: (c: Tx) => Promise<Result>,
  options: { storeResponse: boolean } = { storeResponse: true },
): Promise<Outcome> {
  // storeResponse: false is for responses holding a secret, which must never land in idempotency_keys.
  const rawKey = options.storeResponse ? req.headers['idempotency-key'] : undefined;

  if (rawKey === undefined) {
    try {
      return { ...(await db.tx(work)), replayed: false };
    } catch (err) {
      if (err instanceof DomainError) return fromDomainError(err);
      throw err;
    }
  }

  const parsed = keySchema.safeParse(rawKey);
  if (!parsed.success) {
    return fromDomainError(new DomainError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be a UUID.'));
  }

  const userId = req.user!.id;
  const endpoint = `${req.method} ${req.routeOptions.url}`;
  const requestHash = sha256(JSON.stringify([endpoint, req.params, req.body ?? null]));

  try {
    return await db.tx(async (c): Promise<Outcome> => {
      const claim = await c.query(
        `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash, response_code, response_body)
         VALUES ($1, $2, $3, $4, 0, '{}')
         ON CONFLICT (user_id, key) DO NOTHING
         RETURNING 1`,
        [userId, parsed.data, endpoint, requestHash],
      );

      if (!claim.rowCount) {
        const { rows } = await c.query<{ request_hash: Buffer; response_code: number; response_body: unknown }>(
          'SELECT request_hash, response_code, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
          [userId, parsed.data],
        );
        const stored = rows[0]!;
        if (!stored.request_hash.equals(requestHash)) throw errors.idempotencyKeyReused();
        return { status: stored.response_code, body: stored.response_body, replayed: true };
      }

      // Domain failures roll back to here, keeping the claim, so TEAM_FULL replays as TEAM_FULL
      // even after a seat frees up. Anything unexpected aborts the whole transaction, key included,
      // so a retry gets a fresh attempt instead of a stored 500.
      await c.query('SAVEPOINT work');
      let outcome: Outcome;
      try {
        outcome = { ...(await work(c)), replayed: false };
        await c.query('RELEASE SAVEPOINT work');
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        await c.query('ROLLBACK TO SAVEPOINT work');
        outcome = fromDomainError(err);
      }

      await c.query(
        'UPDATE idempotency_keys SET response_code = $3, response_body = $4 WHERE user_id = $1 AND key = $2',
        [userId, parsed.data, outcome.status, JSON.stringify(outcome.body)],
      );
      return outcome;
    });
  } catch (err) {
    if (err instanceof DomainError) return fromDomainError(err);
    throw err;
  }
}

export function send(reply: FastifyReply, outcome: Outcome): FastifyReply {
  if (outcome.replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.status(outcome.status).send(outcome.body);
}
