import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { createDb, type Db } from './db/pool.js';
import { DomainError, errorBody } from './lib/errors.js';
import { createMetrics, type Metrics } from './lib/metrics.js';
import { arenaRoutes } from './modules/arena/routes.js';
import { authRoutes, installAuthHook } from './modules/auth/routes.js';
import { boardRoutes } from './modules/board/routes.js';
import { EventHub } from './modules/events/hub.js';
import { eventRoutes } from './modules/events/routes.js';
import { suggestRoutes } from './modules/suggest/routes.js';
import { teamRoutes } from './modules/teams/routes.js';

export interface RouteInfo {
  method: string;
  url: string;
  public: boolean;
}

export interface App {
  fastify: FastifyInstance;
  db: Db;
  hub: EventHub;
  metrics: Metrics;
  routes: RouteInfo[];
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

export async function buildApp(config: Config): Promise<App> {
  const db = createDb(config.databaseUrl, config.poolMax);
  const metrics = createMetrics();
  const routes: RouteInfo[] = [];

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    // A function, not a number: this fastify treats a bare hop count as "trust nothing".
    trustProxy: config.trustProxyHops > 0 ? (_addr: string, hop: number) => hop < config.trustProxyHops : false,
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const hub = new EventHub(config.directDatabaseUrl, db.pool, app.log);

  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD') routes.push({ method, url: route.url, public: route.config?.public === true });
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route.startsWith('/api/')) metrics.observeRequest(req.method, route, reply.statusCode, reply.elapsedTime);
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof DomainError) return reply.status(err.status).send(errorBody(err.code, err.message));
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send(errorBody('VALIDATION_ERROR', err.message));
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send(errorBody('BAD_REQUEST', err.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(errorBody('INTERNAL', 'Something went wrong.')); // never a stack trace
  });

  const hasSpa = existsSync(path.join(publicDir, 'index.html'));
  app.setNotFoundHandler((req, reply) => {
    // Browser routes such as /teams/123 are the SPA's; anything under /api is a real 404.
    if (hasSpa && req.method === 'GET' && !req.url.startsWith('/api/') && req.url !== '/metrics') {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(errorBody('NOT_FOUND', 'No such route.'));
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        // Only ask browsers to upgrade where HTTPS exists; on http://localhost it would break the app.
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    strictTransportSecurity: config.cookieSecure,
  });
  await app.register(cookie);
  installAuthHook(app, db, config);

  if (hasSpa) {
    await app.register(fastifyStatic, {
      root: publicDir,
      wildcard: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.header('Cache-Control', 'public, max-age=31536000, immutable'); // content-hashed names
        }
      },
    });
  }

  app.get('/metrics', async (req, reply) => {
    if (config.metricsToken && req.headers.authorization !== `Bearer ${config.metricsToken}`) {
      return reply.status(401).send(errorBody('UNAUTHENTICATED', 'Metrics token required.'));
    }
    return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
  });

  await app.register(
    async (api) => {
      api.get('/healthz', { config: { public: true } }, async () => ({ ok: true }));
      api.get('/ops/stats', async () => metrics.snapshot());
      await api.register(authRoutes, { db, config });
      await api.register(teamRoutes, { db, config, metrics });
      await api.register(boardRoutes, { db, hub, config });
      await api.register(suggestRoutes, { db });
      await api.register(eventRoutes, { db, hub, metrics, config });
      await api.register(arenaRoutes, { db, config });
    },
    { prefix: '/api' },
  );

  await hub.start();
  // Before the server stops accepting: open SSE sockets would otherwise hold close() open forever.
  app.addHook('preClose', async () => {
    await hub.stop();
    app.server.closeAllConnections();
  });
  app.addHook('onClose', async () => db.close());
  return { fastify: app, db, hub, metrics, routes };
}
