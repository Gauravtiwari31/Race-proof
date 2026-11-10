import pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';

export interface PublicEvent {
  id: number;
  action: string;
  hackathonId: string;
  teamId: string | null;
  version: number | null;
  at: string;
  memberCount?: number;
  userId?: string;
  promoted?: string | null;
  name?: string;
  lookingFor?: string[];
  to?: string;
}

interface EventRow {
  id: number;
  hackathon_id: string;
  team_id: string | null;
  action: string;
  team_version: number | null;
  payload: Record<string, unknown>;
  created_at: Date;
}

export const EVENT_COLUMNS = 'id, hackathon_id, team_id, action, team_version, payload, created_at';

/** Who asked to join which team, and who was turned down, is the leader's business alone. */
const PRIVATE_USER_ACTIONS = /^(invite|request)\./;

// Only these payload fields ever leave the server, so a new internal field cannot leak by accident.
export function toPublicEvent(row: EventRow): PublicEvent {
  const p = row.payload;
  return {
    id: row.id,
    action: row.action,
    hackathonId: row.hackathon_id,
    teamId: row.team_id,
    version: row.team_version,
    at: row.created_at.toISOString(),
    ...(typeof p.memberCount === 'number' ? { memberCount: p.memberCount } : {}),
    ...(typeof p.userId === 'string' && !PRIVATE_USER_ACTIONS.test(row.action) ? { userId: p.userId } : {}),
    ...(p.promoted !== undefined ? { promoted: p.promoted as string | null } : {}),
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
    ...(Array.isArray(p.lookingFor) ? { lookingFor: p.lookingFor as string[] } : {}),
    ...(typeof p.to === 'string' ? { to: p.to } : {}),
  };
}

export interface Subscriber {
  hackathonId: string | null;
  teamId: string | null;
  send(event: PublicEvent): void;
  resync(): void;
}

const FLUSH_MS = 100;
const RECONNECT_MS = 1000;

/**
 * Per-replica fan-out. The event source is the audit row committed with the change (transactional
 * outbox), so there is no dual write: if the change committed, the event exists. NOTIFY only wakes
 * each replica, which then reads the committed rows and pushes them to its own SSE clients.
 */
export class EventHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly boardVersions = new Map<string, number>();
  private pending = new Set<number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private listener: pg.Client | null = null;
  private stopped = false;
  private everConnected = false;

  constructor(
    private readonly directUrl: string,
    private readonly pool: pg.Pool,
    private readonly log: FastifyBaseLogger,
  ) {}

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.directUrl });
    const retry = () => {
      if (this.listener === client) this.listener = null;
      if (!this.stopped) setTimeout(() => void this.connect(), RECONNECT_MS).unref();
    };
    client.on('error', (err) => this.log.warn({ err }, 'event listener error'));
    client.once('end', retry);
    client.on('notification', (msg) => {
      this.pending.add(Number(msg.payload));
      this.flushTimer ??= setTimeout(() => void this.flush(), FLUSH_MS);
    });
    try {
      await client.connect();
      await client.query('LISTEN team_events');
      this.listener = client;
      // Anything committed while we were deaf was never pushed, so tell clients to refetch.
      if (this.everConnected) this.resyncAll();
      this.everConnected = true;
    } catch (err) {
      this.log.warn({ err }, 'event listener could not connect; retrying');
      client.removeListener('end', retry);
      void client.end().catch(() => {});
      retry();
    }
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const ids = [...this.pending];
    this.pending = new Set();
    if (!ids.length || this.stopped) return;
    try {
      const { rows } = await this.pool.query<EventRow>(
        `SELECT ${EVENT_COLUMNS} FROM audit_events WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [ids],
      );
      for (const row of rows) this.publish(row);
    } catch (err) {
      this.log.error({ err }, 'event flush failed');
      this.resyncAll();
    }
  }

  private publish(row: EventRow): void {
    const current = this.boardVersions.get(row.hackathon_id) ?? 0;
    this.boardVersions.set(row.hackathon_id, Math.max(current, row.id));
    const event = toPublicEvent(row);
    for (const sub of this.subscribers) {
      if (sub.hackathonId === row.hackathon_id || (sub.teamId !== null && sub.teamId === row.team_id)) sub.send(event);
    }
  }

  private resyncAll(): void {
    for (const sub of this.subscribers) sub.resync();
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Highest event seen by this replica; the board cache key, so any team change invalidates it. */
  boardVersion(hackathonId: string): number {
    return this.boardVersions.get(hackathonId) ?? 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.resyncAll();
    await this.listener?.end().catch(() => {});
  }
}
