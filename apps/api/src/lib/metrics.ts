import { hostname } from 'node:os';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

const LATENCY_WINDOW = 2000;
const RATE_WINDOW_MS = 10_000;

/** A registry per app, so several apps in one test process do not collide. */
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2.5],
    registers: [registry],
  });
  const openStreams = new Gauge({ name: 'sse_open_streams', help: 'Open SSE streams', registers: [registry] });
  const joins = new Counter({ name: 'team_joins_total', help: 'Seats taken', registers: [registry] });
  const conflicts = new Counter({
    name: 'team_conflicts_total',
    help: 'Requests that lost a race',
    labelNames: ['code'],
    registers: [registry],
  });

  // The ops panel needs a cheap p95 for this replica without running PromQL.
  const latencies: number[] = [];
  const joinTimes: number[] = [];
  const conflictTimes: number[] = [];
  let latencyCursor = 0;

  const perSecond = (times: number[]) => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    while (times.length && times[0]! < cutoff) times.shift();
    return times.length / (RATE_WINDOW_MS / 1000);
  };

  return {
    registry,
    observeRequest(method: string, route: string, status: number, ms: number) {
      httpDuration.observe({ method, route, status }, ms / 1000);
      latencies[latencyCursor] = ms;
      latencyCursor = (latencyCursor + 1) % LATENCY_WINDOW;
    },
    recordJoin() {
      joins.inc();
      joinTimes.push(Date.now());
    },
    recordConflict(code: string) {
      conflicts.inc({ code });
      conflictTimes.push(Date.now());
    },
    streamOpened: () => openStreams.inc(),
    streamClosed: () => openStreams.dec(),
    async snapshot() {
      const sorted = [...latencies].sort((a, b) => a - b);
      const streams = await openStreams.get();
      return {
        replica: hostname(),
        uptimeSeconds: Math.round(process.uptime()),
        p95Ms: sorted.length ? Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 10) / 10 : 0,
        sampleSize: sorted.length,
        openStreams: streams.values[0]?.value ?? 0,
        joinsPerSecond: perSecond(joinTimes),
        conflictsPerSecond: perSecond(conflictTimes),
      };
    },
  };
}

export type Metrics = ReturnType<typeof createMetrics>;
