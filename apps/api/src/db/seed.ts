import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { checkInvariants } from './invariants.js';
import { dbDir } from './migrate.js';

const SEED_HACKATHON = '11111111-1111-4111-8111-111111111111';

const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('DATABASE_ADMIN_URL is required');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const existing = await client.query('SELECT 1 FROM hackathons WHERE id = $1', [SEED_HACKATHON]);
  if (existing.rowCount) {
    console.log('already seeded');
  } else {
    const started = Date.now();
    await client.query('BEGIN');
    await client.query(await readFile(path.join(dbDir, 'seed.sql'), 'utf8'));
    await client.query('COMMIT');
    await client.query('ANALYZE');
    console.log(`seeded 10,000 users and 2,000 teams in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
} finally {
  await client.end();
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
const violations = await checkInvariants(pool);
await pool.end();
if (violations.length) {
  console.error(JSON.stringify(violations, null, 2));
  process.exit(1);
}
console.log('all invariants hold');
