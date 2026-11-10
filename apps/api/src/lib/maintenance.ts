import type pg from 'pg';

const INTERVAL_MS = 10 * 60 * 1000;

/** Housekeeping safe to run on every replica at once: each statement is an idempotent DELETE. */
export function startMaintenance(pool: pg.Pool, onError: (err: unknown) => void): () => void {
  const timer = setInterval(() => {
    Promise.all([
      pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`),
      pool.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`),
      pool.query(`DELETE FROM sessions WHERE expires_at < now()`),
    ]).catch(onError);
  }, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
