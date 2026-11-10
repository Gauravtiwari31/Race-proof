export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(method === 'GET' ? {} : { 'X-Requested-With': 'fetch' }),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? 'UNKNOWN', data?.error?.message ?? 'Something went wrong.');
  }
  return data as T;
}

export const newKey = (): string =>
  // randomUUID needs a secure context; a phone testing over a LAN IP is not one.
  crypto.randomUUID?.() ??
  '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16),
  );

/**
 * Sends one user intent. The key is created once and reused on retries, so a dropped connection
 * can never apply the action twice: the server replays the first answer instead.
 */
export async function sendIntent<T>(path: string, options: Omit<RequestOptions, 'idempotencyKey'>): Promise<T> {
  const idempotencyKey = newKey();
  for (let attempt = 0; ; attempt++) {
    try {
      return await api<T>(path, { ...options, idempotencyKey });
    } catch (err) {
      const retryable = !(err instanceof ApiError) || err.status >= 500;
      if (!retryable || attempt >= 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
}

export interface Me {
  id: string;
  email: string;
  name: string;
  skills: string[];
  primaryRole: string | null;
  timezone: string;
  availStartMin: number;
  availEndMin: number;
}

export interface Hackathon {
  id: string;
  name: string;
  minSize: number;
  maxSize: number;
}

export interface Standing {
  teamId: string | null;
  role: 'leader' | 'member' | null;
  looking: boolean | null;
  pitch: string | null;
  pendingTeamIds: string[];
  /** Team id to the id of the viewer's pending request there, so it can be withdrawn. */
  pendingRequests: Record<string, string>;
}

export interface MemberPreview {
  userId: string;
  name: string;
  role: 'leader' | 'member';
  optimistic?: boolean;
}

export interface BoardTeam {
  id: string;
  name: string;
  lookingFor: string[];
  memberCount: number;
  maxSize: number;
  version: number;
  members: MemberPreview[] | null;
}

export interface BoardPerson {
  id: string;
  name: string;
  skills: string[];
  primaryRole: string | null;
  timezone: string;
  pitch: string | null;
}

export interface Team extends Omit<BoardTeam, 'members'> {
  hackathonId: string;
  minSize: number;
  status: 'forming' | 'ready';
  members: MemberPreview[];
}

export interface JoinRequest {
  id: string;
  userId: string;
  name: string;
  skills: string[];
  message: string | null;
}

export interface Invite {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  maxUses: number | null;
  uses: number;
}

export interface HistoryEvent {
  id: number;
  action: string;
  actor_id: string;
  version: number | null;
  at: string;
  userId: string | null;
  promoted: string | null;
  from: string | null;
  to: string | null;
}

export interface LiveEvent {
  id: number;
  action: string;
  hackathonId: string;
  teamId: string | null;
  version: number | null;
  memberCount?: number;
  userId?: string;
}

export interface ScoreParts {
  coverage: number;
  redundancy: number;
  tz: number;
  role: number;
  recency: number;
}

export interface Explanation {
  covers: string[];
  alreadyHave: string[];
  tzOverlapHours: number;
  fillsRole: string | null;
  parts: ScoreParts;
}

export interface Suggestion {
  id: string;
  name: string;
  score: number;
  explanation: Explanation;
  skills?: string[];
  pitch?: string | null;
  lookingFor?: string[];
  memberCount?: number;
  maxSize?: number;
}

export interface ArenaResult {
  name: string;
  outcome: 'won' | 'lost';
  code: string | null;
  ms: number;
}

export interface ArenaRun {
  mode: 'safe' | 'naive';
  seats: number;
  seatedBefore: number;
  winners: number;
  memberCount: number;
  actualMembers: number;
  invariantHolds: boolean;
  elapsedMs: number;
  results: ArenaResult[];
}

export interface OpsStats {
  replica: string;
  uptimeSeconds: number;
  p95Ms: number;
  sampleSize: number;
  openStreams: number;
  joinsPerSecond: number;
  conflictsPerSecond: number;
}
