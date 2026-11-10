import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { checkInvariants } from '../src/db/invariants.js';
import { adminDbUrl, appDbUrl, serverAdminUrl, testDbName } from './urls.js';

/** Every run starts from an empty database, with the same migrations production gets. */
export async function setup() {
  const server = new pg.Client({ connectionString: serverAdminUrl });
  await server.connect();
  await server.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${testDbName}`);
  await server.end();
  await migrate(adminDbUrl, appDbUrl);
}

/** Tests check their own hackathon; this checks everything the whole run left behind. */
export async function teardown() {
  const pool = new pg.Pool({ connectionString: adminDbUrl });
  const violations = await checkInvariants(pool);
  await pool.end();
  if (violations.length) throw new Error(`Invariants violated after the run: ${JSON.stringify(violations)}`);
}
