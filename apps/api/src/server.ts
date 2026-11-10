import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startMaintenance } from './lib/maintenance.js';

const { fastify, db } = await buildApp(loadConfig());
const stopMaintenance = startMaintenance(db.pool, (err) => fastify.log.error({ err }, 'maintenance failed'));

const address = await fastify.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
});
console.log(`listening ${address}`);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    // Graceful first; if anything holds the close open, exit anyway rather than hang the host.
    setTimeout(() => process.exit(1), 10_000).unref();
    stopMaintenance();
    void fastify.close().then(() => process.exit(0));
  });
}
