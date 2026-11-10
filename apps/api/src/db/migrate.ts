import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
export const dbDir = path.resolve(here, '../../../../db');

/** Applies pending migrations as the owner role, then ensures the API's login role exists. */
export async function migrate(adminUrl: string, appUrl?: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    // Replicas may start at once; only one of them may migrate.
    await client.query(`SELECT pg_advisory_lock(hashtext('fndn_migrations'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);

    const dir = path.join(dbDir, 'migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const name of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (done.rowCount) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(path.join(dir, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(name);
    }
    if (appUrl) await ensureLoginRole(client, appUrl);
  } finally {
    await client.end(); // releases the session-level advisory lock too
  }
  return applied;
}

async function ensureLoginRole(client: pg.Client, appUrl: string): Promise<void> {
  const url = new URL(appUrl);
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
  // CREATE ROLE cannot take bind parameters, so format() does the quoting.
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  const ddl = await client.query<{ sql: string }>(
    `SELECT format('${verb} ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS sql`,
    [user, password],
  );
  await client.query(ddl.rows[0]!.sql);
  const grant = await client.query<{ sql: string }>(`SELECT format('GRANT fndn_app TO %I', $1::text) AS sql`, [user]);
  await client.query(grant.rows[0]!.sql);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) throw new Error('DATABASE_ADMIN_URL is required');
  const applied = await migrate(adminUrl, process.env.DATABASE_URL);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'already up to date');
}
