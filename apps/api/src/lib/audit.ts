import type { Tx } from '../db/pool.js';

export interface AuditEvent {
  hackathonId: string;
  teamId: string | null;
  actorId: string;
  action: string;
  teamVersion: number | null;
  payload: Record<string, unknown>;
  requestId: string;
}

/**
 * Appends the audit row and queues the wake-up in the caller's transaction.
 *
 * NOTIFY inside a transaction is delivered only on commit and is discarded on rollback, so a crash
 * right after commit cannot lose the wake-up and a rolled-back savepoint cannot announce anything.
 */
export async function appendAudit(c: Tx, e: AuditEvent): Promise<void> {
  await c.query(
    `WITH event AS (
       INSERT INTO audit_events (hackathon_id, team_id, actor_id, action, team_version, payload, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id
     )
     SELECT pg_notify('team_events', id::text) FROM event`,
    [e.hackathonId, e.teamId, e.actorId, e.action, e.teamVersion, JSON.stringify(e.payload), e.requestId],
  );
}
