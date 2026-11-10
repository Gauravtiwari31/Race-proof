import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { dbDir } from './migrate.js';

export interface Violation {
  check: string;
  rows: unknown[];
}

/** Runs db/invariants.sql. Each check is one statement, so it sees one consistent snapshot. */
export async function checkInvariants(pool: pg.Pool, hackathonId: string | null = null): Promise<Violation[]> {
  const sql = await readFile(path.join(dbDir, 'invariants.sql'), 'utf8');
  const violations: Violation[] = [];
  for (const block of sql.split(/^-- name: /m).slice(1)) {
    const newline = block.indexOf('\n');
    const check = block.slice(0, newline).trim();
    const { rows } = await pool.query(block.slice(newline), [hackathonId]);
    if (rows.length) violations.push({ check, rows });
  }
  return violations;
}
