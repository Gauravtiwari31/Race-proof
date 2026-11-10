import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Agent, request } from 'undici';
import { expect } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { defaults, type Config } from '../src/config.js';
import { checkInvariants } from '../src/db/invariants.js';
import { sha256 } from '../src/lib/crypto.js';
import { adminDbUrl, appDbUrl } from './urls.js';

/** Owner connection for arranging states the API refuses to create, and for reading results. */
export const admin = new pg.Pool({ connectionString: adminDbUrl, max: 5 });

export interface TestUser {
  id: string;
  cookie: string;
}

export interface Response {
  status: number;
  // Test code asserts on response shapes directly; a stricter type would only add casts.
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

const NO_LIMIT = { perSubject: 1_000_000, perIp: 1_000_000, windowSeconds: 600 };

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  ...defaults,
  databaseUrl: appDbUrl,
  directDatabaseUrl: appDbUrl,
  poolMax: 15,
  logLevel: 'silent',
  // Every test request comes from 127.0.0.1, so only the rate-limit tests turn limits on.
  inviteLimit: NO_LIMIT,
  loginLimit: NO_LIMIT,
  signupLimit: NO_LIMIT,
  ...overrides,
});

export interface Client {
  get(path: string, user?: TestUser, headers?: Record<string, string>): Promise<Response>;
  post(path: string, user?: TestUser, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  del(path: string, user?: TestUser, headers?: Record<string, string>): Promise<Response>;
  patch(path: string, user?: TestUser, body?: unknown): Promise<Response>;
  put(path: string, user?: TestUser, body?: unknown): Promise<Response>;
  /** Opens real connections up front, so a race measures the database rather than TCP handshakes. */
  warm(connections: number): Promise<void>;
  close(): Promise<void>;
}

export function clientFor(baseUrl: string, connections = 128): Client {
  const dispatcher = new Agent({ connections, pipelining: 1, keepAliveTimeout: 30_000 });

  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    user?: TestUser,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await request(`${baseUrl}/api${path}`, {
      method,
      dispatcher,
      headers: {
        ...(method === 'GET' ? {} : { 'x-requested-with': 'test' }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(user ? { cookie: user.cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.body.text();
    return { status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  return {
    get: (path, user, headers) => call('GET', path, user, undefined, headers),
    post: (path, user, body, headers) => call('POST', path, user, body, headers),
    del: (path, user, headers) => call('DELETE', path, user, undefined, headers),
    patch: (path, user, body) => call('PATCH', path, user, body),
    put: (path, user, body) => call('PUT', path, user, body),
    async warm(n) {
      await Promise.all(Array.from({ length: n }, () => call('GET', '/healthz')));
    },
    close: () => dispatcher.close(),
  };
}

export interface Server extends Client {
  app: App;
  url: string;
  stop(): Promise<void>;
}

export async function startServer(overrides: Partial<Config> = {}): Promise<Server> {
  const app = await buildApp(testConfig(overrides));
  const url = await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const client = clientFor(url);
  return {
    ...client,
    app,
    url,
    async stop() {
      await client.close();
      await app.fastify.close();
    },
  };
}

export async function newHackathon(opts: { min?: number; max?: number } = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO hackathons (name, min_team_size, max_team_size) VALUES ('test', $1, $2) RETURNING id`,
    [opts.min ?? 1, opts.max ?? 4],
  );
  return rows[0]!.id;
}

/** Inserts users with live sessions directly: Argon2 per user would make race setup take minutes. */
export async function newUsers(count: number): Promise<TestUser[]> {
  const tokens = Array.from({ length: count }, () => randomBytes(32).toString('base64url'));
  const ids = tokens.map(() => randomUUID());
  await admin.query(
    `WITH new_users AS (
       INSERT INTO users (id, email, name, password_hash, timezone, avail_start_min, avail_end_min)
       SELECT id, id || '@test.local', 'User ' || left(id::text, 8), 'unusable', 'UTC', 540, 1020
         FROM unnest($1::uuid[]) AS id
       RETURNING id
     )
     INSERT INTO sessions (token_hash, user_id, expires_at)
     SELECT hash, id, now() + interval '7 days'
       FROM unnest($1::uuid[], $2::bytea[]) AS s(id, hash)
       JOIN new_users USING (id)`,
    [ids, tokens.map(sha256)],
  );
  return ids.map((id, i) => ({ id, cookie: `sid=${tokens[i]}` }));
}

export const newUser = async (): Promise<TestUser> => (await newUsers(1))[0]!;

export interface TestTeam {
  id: string;
  hackathonId: string;
  leader: TestUser;
  members: TestUser[];
}

/** Builds a team of `size` atomically, so a concurrent invariant check never sees it half-built. */
export async function newTeam(hackathonId: string, size: number): Promise<TestTeam> {
  const users = await newUsers(size);
  const [leader, ...members] = users as [TestUser, ...TestUser[]];
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO teams (hackathon_id, name, max_size, member_count, version)
       SELECT id, $2, max_team_size, $3, 1 FROM hackathons WHERE id = $1 RETURNING id`,
      [hackathonId, `team-${randomUUID()}`, size],
    );
    const id = rows[0]!.id;
    await client.query(
      `INSERT INTO memberships (hackathon_id, user_id, team_id, role, joined_at)
       SELECT $1, user_id, $2, CASE WHEN ord = 1 THEN 'leader' ELSE 'member' END,
              now() + make_interval(secs => ord)
         FROM unnest($3::uuid[]) WITH ORDINALITY AS u(user_id, ord)`,
      [hackathonId, id, users.map((u) => u.id)],
    );
    await client.query('COMMIT');
    return { id, hackathonId, leader, members };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function newInvite(api: Client, team: TestTeam, body: object = {}): Promise<{ id: string; code: string }> {
  const res = await api.post(`/teams/${team.id}/invites`, team.leader, body);
  expect(res.status).toBe(201);
  return res.body;
}

/**
 * Releases every request in the same tick. A race test that fires requests one after another
 * proves nothing, because each would see the previous one's committed result.
 */
export async function race<T>(attempts: Array<() => Promise<T>>): Promise<T[]> {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = attempts.map(async (attempt) => {
    await barrier;
    return attempt();
  });
  release();
  return Promise.all(running);
}

/**
 * Waits until some backend is blocked on a lock held by `holder`. Lets a test force one exact
 * interleaving, because the dangerous ones can be far too rare to hit by firing requests at once.
 */
export async function waitUntilBlockedBy(holder: pg.PoolClient): Promise<void> {
  const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  for (let attempt = 0; attempt < 1000; attempt++) {
    const blocked = await admin.query('SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [
      rows[0]!.pid,
    ]);
    if (blocked.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the request never blocked on the held lock');
}

export const countBy = (responses: Response[], pick: (r: Response) => string | number): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const r of responses) {
    const key = String(pick(r));
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

export const statusAndCode = (r: Response) => `${r.status}${r.body?.error ? ` ${r.body.error.code}` : ''}`;

export async function expectInvariants(hackathonId: string): Promise<void> {
  expect(await checkInvariants(admin, hackathonId)).toEqual([]);
}

export async function teamRow(id: string) {
  const { rows } = await admin.query<{ member_count: number; version: number; max_size: number }>(
    'SELECT member_count, version, max_size FROM teams WHERE id = $1',
    [id],
  );
  return rows[0];
}

export async function memberIds(teamId: string): Promise<string[]> {
  const { rows } = await admin.query<{ user_id: string }>('SELECT user_id FROM memberships WHERE team_id = $1', [teamId]);
  return rows.map((r) => r.user_id);
}

export async function leaderOf(teamId: string): Promise<string | undefined> {
  const { rows } = await admin.query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE team_id = $1 AND role = 'leader'`,
    [teamId],
  );
  return rows[0]?.user_id;
}

export async function auditFor(teamId: string) {
  const { rows } = await admin.query<{ action: string; actor_id: string; team_version: number | null; payload: any }>(
    'SELECT action, actor_id, team_version, payload FROM audit_events WHERE team_id = $1 ORDER BY id',
    [teamId],
  );
  return rows;
}
