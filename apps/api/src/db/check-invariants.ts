import pg from 'pg';
import { checkInvariants } from './invariants.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL });
const violations = await checkInvariants(pool);
await pool.end();
if (violations.length) {
  console.error(JSON.stringify(violations, null, 2));
  process.exit(1);
}
console.log('all invariants hold');
