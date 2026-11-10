import { z } from 'zod';

export interface RateLimit {
  perSubject: number;
  perIp: number;
  windowSeconds: number;
}

export interface Config {
  databaseUrl: string;
  /** Direct (non-pooled) host for LISTEN, which does not work through a transaction-mode pooler. */
  directDatabaseUrl: string;
  poolMax: number;
  cookieSecure: boolean;
  /**
   * How many proxies in front of the API append to X-Forwarded-For (Caddy: 1). Only those hops are
   * trusted, so a client-supplied left-most entry can never pick the rate-limit bucket. 0 = none.
   */
  trustProxyHops: number;
  logLevel: string;
  inviteLimit: RateLimit;
  /** Strict, per account and address: a guesser elsewhere cannot lock the owner out. */
  loginLimit: RateLimit;
  /** Loose, per account from anywhere: the brake on spraying one account from many addresses. */
  loginAccountLimit: RateLimit;
  /** Per address: every signup costs an Argon2 hash and a row, so a script cannot mint accounts freely. */
  signupLimit: RateLimit;
  /** Participation, join requests and team edits: each one fans out to every board client. */
  writeLimit: RateLimit;
  /** Live streams one account may hold open at once; a browser tab needs one. */
  streamsPerUser: number;
  arenaLimit: RateLimit;
  /**
   * On by default: the arena is the demo centrepiece. It runs on its own small pool, one run at a
   * time per process, so it can never starve real traffic. ARENA_ENABLED=false turns it off.
   */
  arenaEnabled: boolean;
  /** When set, GET /metrics requires it as a bearer token. */
  metricsToken: string | null;
  /**
   * Swaps the atomic seat UPDATE for a read-then-write, to prove the race test can catch the bug.
   * Refused in production by loadConfig.
   */
  unsafeSeatForMutationCheck: boolean;
}

export const defaults = {
  poolMax: 20,
  cookieSecure: false,
  trustProxyHops: 0,
  logLevel: 'info',
  inviteLimit: { perSubject: 10, perIp: 100, windowSeconds: 600 },
  loginLimit: { perSubject: 10, perIp: 100, windowSeconds: 600 },
  loginAccountLimit: { perSubject: 100, perIp: 100_000, windowSeconds: 3600 },
  signupLimit: { perSubject: 30, perIp: 30, windowSeconds: 600 },
  writeLimit: { perSubject: 30, perIp: 300, windowSeconds: 60 },
  streamsPerUser: 8,
  arenaLimit: { perSubject: 3, perIp: 30, windowSeconds: 60 },
  arenaEnabled: true,
  metricsToken: null,
  unsafeSeatForMutationCheck: false,
} satisfies Omit<Config, 'databaseUrl' | 'directDatabaseUrl'>;

const flag = (fallback: 'true' | 'false' = 'false') =>
  z.enum(['true', 'false']).default(fallback).transform((v) => v === 'true');

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  DATABASE_DIRECT_URL: z.string().min(1).optional(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(defaults.poolMax),
  COOKIE_SECURE: flag(),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(defaults.trustProxyHops),
  LOG_LEVEL: z.string().default(defaults.logLevel),
  // A whole venue can share one IP, so this has to be tunable without a redeploy of the code.
  INVITE_LIMIT_PER_IP: z.coerce.number().int().positive().default(defaults.inviteLimit.perIp),
  SIGNUP_LIMIT_PER_IP: z.coerce.number().int().positive().default(defaults.signupLimit.perIp),
  SSE_STREAMS_PER_USER: z.coerce.number().int().positive().default(defaults.streamsPerUser),
  ARENA_ENABLED: flag('true'),
  METRICS_TOKEN: z.string().min(1).optional(),
  UNSAFE_SEAT_FOR_MUTATION_CHECK: flag(),
  FAULT_POINT: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  if (e.NODE_ENV === 'production' && (e.UNSAFE_SEAT_FOR_MUTATION_CHECK || e.FAULT_POINT)) {
    throw new Error('UNSAFE_SEAT_FOR_MUTATION_CHECK and FAULT_POINT are not allowed in production');
  }
  return {
    ...defaults,
    databaseUrl: e.DATABASE_URL,
    directDatabaseUrl: e.DATABASE_DIRECT_URL ?? e.DATABASE_URL,
    poolMax: e.PG_POOL_MAX,
    cookieSecure: e.COOKIE_SECURE,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    logLevel: e.LOG_LEVEL,
    inviteLimit: { ...defaults.inviteLimit, perIp: e.INVITE_LIMIT_PER_IP },
    signupLimit: { ...defaults.signupLimit, perSubject: e.SIGNUP_LIMIT_PER_IP, perIp: e.SIGNUP_LIMIT_PER_IP },
    streamsPerUser: e.SSE_STREAMS_PER_USER,
    arenaEnabled: e.ARENA_ENABLED,
    metricsToken: e.METRICS_TOKEN ?? null,
    unsafeSeatForMutationCheck: e.UNSAFE_SEAT_FOR_MUTATION_CHECK,
  };
}
