import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { sha256 } from '../../lib/crypto.js';
import { errorBody, errors, isPgError } from '../../lib/errors.js';
import { reserve } from '../../lib/rateLimit.js';
import { minuteOfDay, name, tags, timezone } from '../../lib/schemas.js';

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 7;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
/** Sliding expiry writes at most once a day per session, not on every request. */
const RENEW_WHEN_REMAINING_MS = SESSION_MS - 24 * 60 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// OWASP's minimum Argon2id profile, chosen to stay usable on a very small free-tier CPU.
const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
// Verified when the email is unknown, so response time does not reveal which emails are registered.
const dummyHash = hash(randomBytes(32).toString('hex'), ARGON2);

const password = z.string().min(10).max(200);
const USER_COLUMNS = `id, email, name, skills, primary_role AS "primaryRole", timezone,
  avail_start_min AS "availStartMin", avail_end_min AS "availEndMin"`;

export interface SessionUser {
  id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
  interface FastifyContextConfig {
    /** Routes are private unless they opt out, so a forgotten check fails closed. */
    public?: boolean;
  }
}

/** Default-deny: every matched route needs a session, and every mutation needs the CSRF header. */
export function installAuthHook(app: FastifyInstance, db: Db, config: Config): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Everything under /api is private by default. Unmatched routes fall through to the 404 handler,
    // and outside /api there is only the SPA's static files and /metrics, which has its own token.
    if (!req.routeOptions.url?.startsWith('/api/')) return;

    // Browsers cannot add a custom header cross-site without a CORS preflight, which we never grant.
    if (!SAFE_METHODS.has(req.method) && !req.headers['x-requested-with']) throw errors.csrf();
    if (req.routeOptions.config.public) return;

    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw errors.unauthenticated();

    const tokenHash = sha256(token);
    const { rows } = await db.pool.query<{ user_id: string; expires_at: Date }>(
      'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()',
      [tokenHash],
    );
    const session = rows[0];
    if (!session) throw errors.unauthenticated();
    req.user = { id: session.user_id };

    if (session.expires_at.getTime() - Date.now() < RENEW_WHEN_REMAINING_MS) {
      await db.pool.query(`UPDATE sessions SET expires_at = now() + make_interval(days => $2) WHERE token_hash = $1`, [
        tokenHash,
        SESSION_DAYS,
      ]);
      setSessionCookie(reply, token, config);
    }
  });
}

function setSessionCookie(reply: FastifyReply, token: string, config: Config): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: SESSION_MS / 1000,
  });
}

async function startSession(db: Db, config: Config, reply: FastifyReply, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url'); // 256 bits
  await db.pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), userId, SESSION_DAYS],
  );
  setSessionCookie(reply, token, config);
}

export async function authRoutes(instance: FastifyInstance, { db, config }: { db: Db; config: Config }) {
  const app = instance.withTypeProvider<ZodTypeProvider>();

  app.post(
    '/auth/signup',
    {
      config: { public: true },
      schema: {
        body: z.object({
          email: z.email().max(254),
          password,
          name,
          skills: tags.default([]),
          primaryRole: z.string().trim().toLowerCase().max(32).optional(),
          timezone,
          availStartMin: minuteOfDay,
          availEndMin: minuteOfDay,
        }),
      },
    },
    async (req, reply) => {
      // Before the hash, so a flood of signups costs the server one cheap query each. Never refunded.
      const limit = await reserve(db.pool, config.signupLimit, 'signup', req.ip, req.ip);
      if (!limit.allowed) {
        return reply
          .header('Retry-After', limit.retryAfterSeconds)
          .status(429)
          .send(errorBody('RATE_LIMITED', 'Too many sign-ups from this address. Try again later.'));
      }
      const b = req.body;
      const passwordHash = await hash(b.password, ARGON2);
      try {
        const { rows } = await db.pool.query(
          `INSERT INTO users (email, name, password_hash, skills, primary_role, timezone, avail_start_min, avail_end_min)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${USER_COLUMNS}`,
          [b.email, b.name, passwordHash, b.skills, b.primaryRole ?? null, b.timezone, b.availStartMin, b.availEndMin],
        );
        await startSession(db, config, reply, rows[0].id);
        return reply.status(201).send(rows[0]);
      } catch (err) {
        if (isPgError(err, '23505', 'users_email_key')) throw errors.emailTaken();
        throw err;
      }
    },
  );

  app.post(
    '/auth/login',
    {
      config: { public: true },
      schema: { body: z.object({ email: z.email().max(254), password: z.string().min(1).max(200) }) },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase();
      // Strict per (account, address), loose per account: a guesser elsewhere cannot lock the owner out,
      // and spraying one account from many addresses still hits the account-wide brake.
      const brake = await reserve(db.pool, config.loginAccountLimit, 'login-account', email, req.ip);
      const limit = brake.allowed
        ? await reserve(db.pool, config.loginLimit, 'login', `${email}|${req.ip}`, req.ip)
        : brake;
      if (!limit.allowed) {
        await brake.refund();
        return reply
          .header('Retry-After', limit.retryAfterSeconds)
          .status(429)
          .send(errorBody('RATE_LIMITED', 'Too many failed attempts. Try again later.'));
      }

      const { rows } = await db.pool.query<{ id: string; password_hash: string }>(
        'SELECT id, password_hash FROM users WHERE email = $1',
        [email],
      );
      const user = rows[0];
      const valid = await verify(user?.password_hash ?? (await dummyHash), req.body.password);
      if (!user || !valid) throw errors.badCredentials();

      await limit.refund();
      await brake.refund();
      await startSession(db, config, reply, user.id);
      return { id: user.id };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    await db.pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(req.cookies[SESSION_COOKIE]!)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const { rows } = await db.pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.user!.id]);
    return rows[0];
  });

  app.patch(
    '/me',
    {
      schema: {
        body: z
          .object({
            name,
            skills: tags,
            primaryRole: z.string().trim().toLowerCase().max(32),
            timezone,
            availStartMin: minuteOfDay,
            availEndMin: minuteOfDay,
          })
          .partial(),
      },
    },
    async (req) => {
      const b = req.body;
      const { rows } = await db.pool.query(
        `UPDATE users SET
           name = COALESCE($2, name),
           skills = COALESCE($3, skills),
           primary_role = COALESCE($4, primary_role),
           timezone = COALESCE($5, timezone),
           avail_start_min = COALESCE($6, avail_start_min),
           avail_end_min = COALESCE($7, avail_end_min)
         WHERE id = $1
         RETURNING ${USER_COLUMNS}`,
        [
          req.user!.id,
          b.name ?? null,
          b.skills ?? null,
          b.primaryRole ?? null,
          b.timezone ?? null,
          b.availStartMin ?? null,
          b.availEndMin ?? null,
        ],
      );
      return rows[0];
    },
  );
}
