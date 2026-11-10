import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const admin = new URL(process.env.TEST_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres');

/** A clean database per run, built from the same migrations as production. */
export default async function globalSetup() {
  const server = new pg.Client({ connectionString: admin.toString() });
  await server.connect();
  await server.query('DROP DATABASE IF EXISTS fndn_e2e WITH (FORCE)');
  await server.query('CREATE DATABASE fndn_e2e');
  await server.end();

  const dbUrl = new URL(admin);
  dbUrl.pathname = '/fndn_e2e';
  const db = new pg.Client({ connectionString: dbUrl.toString() });
  await db.connect();
  const dir = path.resolve(here, '../../../db/migrations');
  for (const file of readdirSync(dir).sort()) await db.query(readFileSync(path.join(dir, file), 'utf8'));
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fndn_api_e2e') THEN
      CREATE ROLE fndn_api_e2e LOGIN PASSWORD 'e2e-only';
    END IF;
  END $$`);
  await db.query('GRANT fndn_app TO fndn_api_e2e');
  await db.query(`INSERT INTO hackathons (name, min_team_size, max_team_size) VALUES ('E2E Hack', 2, 2)`);
  await db.end();
}
