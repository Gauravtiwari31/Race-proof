import { hostname } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { errorBody } from '../../lib/errors.js';
import type { Metrics } from '../../lib/metrics.js';
import { uuid } from '../../lib/schemas.js';
import { EVENT_COLUMNS, toPublicEvent, type EventHub, type PublicEvent } from './hub.js';

const HEARTBEAT_MS = 15_000;
const REPLAY_LIMIT = 200;
/** A client this far behind is not reading; drop it and let it reconnect and resync. */
const MAX_BUFFERED_BYTES = 256 * 1024;
/** Per replica. Every event is written to every matching stream, so streams are not free. */
const MAX_STREAMS_TOTAL = 2000;

export async function eventRoutes(
  instance: FastifyInstance,
  { db, hub, metrics, config }: { db: Db; hub: EventHub; metrics: Metrics; config: Config },
) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const openByUser = new Map<string, number>();
  let openTotal = 0;

  app.get(
    '/events',
    {
      schema: {
        querystring: z
          .object({ hackathon: uuid.optional(), team: uuid.optional() })
          .refine((q) => q.hackathon || q.team, 'Give a hackathon or a team'),
      },
    },
    async (req, reply) => {
      const hackathonId = req.query.hackathon ?? null;
      const teamId = req.query.team ?? null;
      const lastEventId = Number(req.headers['last-event-id']);

      // Checked before hijacking, while the reply can still be an ordinary 429.
      const userId = req.user!.id;
      const mine = openByUser.get(userId) ?? 0;
      if (mine >= config.streamsPerUser || openTotal >= MAX_STREAMS_TOTAL) {
        return reply.header('Retry-After', 5).status(429).send(errorBody('RATE_LIMITED', 'Too many open live streams.'));
      }
      openByUser.set(userId, mine + 1);
      openTotal++;

      reply.hijack(); // from here on this handler owns the socket
      const raw = reply.raw;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const write = (chunk: string) => {
        if (raw.destroyed) return;
        if (raw.writableLength > MAX_BUFFERED_BYTES) {
          raw.destroy();
          return;
        }
        raw.write(chunk);
      };
      const sendEvent = (event: PublicEvent) => write(`id: ${event.id}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
      const resync = () => write('event: resync\ndata: {}\n\n');

      // Subscribe BEFORE replaying, so nothing falls in the gap. A duplicate is harmless because
      // clients apply a delta only if its version is newer than what they hold.
      const unsubscribe = hub.subscribe({ hackathonId, teamId, send: sendEvent, resync });
      metrics.streamOpened();

      const heartbeat = setInterval(() => write(': heartbeat\n\n'), HEARTBEAT_MS);
      heartbeat.unref();

      req.raw.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        metrics.streamClosed();
        const left = (openByUser.get(userId) ?? 1) - 1;
        if (left) openByUser.set(userId, left);
        else openByUser.delete(userId);
        openTotal--;
      });

      write(`event: ready\ndata: ${JSON.stringify({ replica: hostname() })}\n\n`);

      if (Number.isSafeInteger(lastEventId) && lastEventId > 0) {
        const { rows } = await db.pool.query(
          `SELECT ${EVENT_COLUMNS} FROM audit_events
            WHERE id > $1 AND (hackathon_id = $2 OR team_id = $3)
            ORDER BY id LIMIT $4`,
          [lastEventId, hackathonId, teamId, REPLAY_LIMIT],
        );
        for (const row of rows) sendEvent(toPublicEvent(row));
        if (rows.length === REPLAY_LIMIT) resync();
      }
    },
  );
}
