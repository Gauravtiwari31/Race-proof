import pg from 'pg';

// bigint columns (team version, event id) stay far below 2^53, so numbers are safe and JSON-friendly.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Tx = pg.PoolClient;

export interface Db {
  pool: pg.Pool;
  tx<T>(work: (c: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(connectionString: string, max: number): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
  });

  return {
    pool,
    async tx(work) {
      const c = await pool.connect();
      let broken: Error | undefined;
      try {
        await c.query('BEGIN'); // READ COMMITTED: the seat UPDATE relies on its re-check behaviour
        const result = await work(c);
        await c.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await c.query('ROLLBACK');
        } catch (rollbackErr) {
          broken = rollbackErr as Error; // connection is dead, do not return it to the pool
        }
        throw err;
      } finally {
        c.release(broken);
      }
    },
    close: () => pool.end(),
  };
}
