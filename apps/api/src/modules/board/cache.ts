import { createHash } from 'node:crypto';

export interface Cached {
  body: string;
  etag: string;
}

interface Entry {
  version: number;
  expiresAt: number;
  value: Promise<Cached>;
}

const TTL_MS = 1000;
const MAX_ENTRIES = 2000;

/**
 * Versioned micro-cache. The key includes the replica's board version, so any team change misses
 * at once, and the TTL bounds staleness if a NOTIFY is missed. Holding the promise rather than the
 * result collapses a stampede: 100 concurrent misses run one query, not 100.
 */
export class MicroCache {
  private readonly entries = new Map<string, Entry>();

  get(key: string, version: number, load: () => Promise<unknown>): Promise<Cached> {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.version === version && hit.expiresAt > now) return hit.value;

    if (this.entries.size >= MAX_ENTRIES) this.entries.clear();
    const value = load().then((data) => {
      const body = JSON.stringify(data);
      return { body, etag: `"${createHash('sha1').update(body).digest('base64url')}"` };
    });
    this.entries.set(key, { version, expiresAt: now + TTL_MS, value });
    value.catch(() => this.entries.delete(key)); // never cache a failure
    return value;
  }
}
