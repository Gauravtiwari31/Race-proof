# Race-proof Team Formation

Hackathon team formation where every hard guarantee is enforced by Postgres in a single transaction, proven by an automated test, and visible inside the product.

**Live URL:** _add after deploying_  **Design doc:** [docs/design.pdf](docs/design.pdf)  **Load report:** [docs/reports/load-report.html](docs/reports/load-report.html)

## Try it

```sh
docker compose up -d --build
```

Open <http://localhost:8080> and sign in as `user1@seed.local` with the password `demo-password-123`. Then open **Arena** and press **Unleash 50 bots**. Switch to the naive seat logic and run it again to see what the conditional `UPDATE` prevents.

Grafana is at <http://localhost:3001>, with no login.

## How requirements are met

| Requirement | How it is met | Evidence |
|:--|:--|:--|
| Size min/max, one team per person | `CHECK` on `member_count`, conditional `UPDATE`, `memberships` primary key, composite foreign key | `rules.*`, [0001_schema.sql](db/migrations/0001_schema.sql) |
| Invite codes expire | `expires_at`, `revoked_at`, optional `max_uses`, re-checked after the team lock | `invite.expired`, `invite.revoked`, `invite.max-uses`, `invite.revoke-race` |
| Leadership passes on | Earliest `joined_at`, then `user_id`; a partial unique index allows one leader | `leave.leader-promotes`, `leave.promote-tie-break` |
| Last member leaves, team deleted | Same transaction deletes the team; audit rows have no foreign key, so they survive | `leave.last-deletes`, `race.last-two-leave`, `history.survives-deletion` |
| 50 people, 1 last seat | Single-statement conditional `UPDATE` plus the unique membership; 20 repetitions and across 2 processes | `race.last-seat-50`, `race.last-seat-replicas`, `race.mutation-check` |
| Idempotent retries | `Idempotency-Key` row in the same transaction; a savepoint keeps domain errors replayable | `idem.*`, `chaos.fault-rollback` |
| Real-time board and team | SSE from a transactional outbox, `NOTIFY` fan-out, snapshot plus versioned deltas, `Last-Event-ID` | `sse.*`, `e2e.live-update` |
| Security | Argon2id, hashed sessions and codes, private-by-default routes, leader checks after the lock, durable rate limits, zod on every input | `auth.*`, `authz.*`, `ratelimit.*`, `validation.*`, `race.stale-leader-check` |
| Audit log | Append-only `audit_events` written inside each team mutation; the app role cannot update or delete | `audit.*`, [0002_app_role.sql](db/migrations/0002_app_role.sql) |
| Teammate suggestions | Weighted score with a per-candidate explanation | `suggest.*` |
| At least 20 API tests in CI | Vitest against real Postgres, with no mocked data layer | [ci.yml](.github/workflows/ci.yml) |
| Seed 10k users, 2k teams | One SQL script, about 1.5 seconds | [seed.sql](db/seed.sql), `pnpm seed` |
| Load test p95 under 200 ms | k6, 100 VUs, thresholds that fail the run | [load/](load/), [report](docs/reports/load-report.html), [workflow](.github/workflows/load-test.yml) |
| React UI, phone and keyboard | Radix primitives, focus management, axe checks, command palette | `e2e.keyboard-only`, `e2e.phone`, `e2e.command-palette` |
| Live URL | Same-origin deploy: the API serves the SPA | [render.yaml](render.yaml) |
| Bonus: optimistic UI | Placeholder seat with rollback and a reason | `e2e.optimistic-rollback` |
| Bonus: Compose | Two replicas, Caddy, Postgres, Prometheus, Grafana | [docker-compose.yml](docker-compose.yml) |
| Bonus: metrics | `prom-client`, ops panel, Grafana dashboard | `metrics.*`, `ops.stats` |
| Bonus: chaos | Deterministic crash point, plus killing replicas under a write storm | `chaos.fault-rollback`, [chaos.sh](chaos/chaos.sh) |

## The guarantees, and what holds them up

| Guarantee | Enforced by | Proven by |
|:--|:--|:--|
| Exactly one person gets the last seat | Conditional `UPDATE` in [service.ts](apps/api/src/modules/teams/service.ts) | `race.last-seat-50`, `race.mutation-check` |
| One team per person, per hackathon | `memberships` primary key plus a composite foreign key | `race.user-two-teams`, `rules.composite-fk` |
| Always exactly one leader | Partial unique index plus the team lock | `race.leader-and-member-leave` |
| No deadlocks | One lock order: team, then memberships, then requests and codes | `race.mixed-no-deadlock`, `race.lock-order-*` |
| Authorisation cannot go stale | Leader check in a new statement after the team lock | `race.stale-leader-check` |
| Retries apply once | Key row in the same transaction, in [mutation.ts](apps/api/src/lib/mutation.ts) | `idem.*` |
| Brute-force limits hold under bursts | Reserve then refund, in [rateLimit.ts](apps/api/src/lib/rateLimit.ts) | `ratelimit.burst` |
| A crash loses nothing | One transaction per mutation; Postgres rolls back on disconnect | `chaos.fault-rollback`, [chaos.sh](chaos/chaos.sh) |

## Tests

The tests need a real Postgres, because a mock cannot prove anything about races. They create and drop their own databases.

```sh
pnpm install
docker compose up -d db
pnpm test                         # API tests
pnpm build && pnpm e2e            # browser tests; set PW_CHANNEL=chrome to use an installed browser
bash load/run-all.sh              # load and chaos suite, about 8 minutes
```

To use another Postgres server, point `TEST_ADMIN_URL` at a superuser connection.

## Known limitations

- A join request created at the same moment its author joins another team can stay `pending`. Accepting it fails with `ALREADY_IN_TEAM`, and the leader can decline it.
- Auth and profile changes are not in the audit log, because that table is scoped to a hackathon.
- The rate limiter uses fixed windows, so a client can make up to twice the limit across a window boundary.
- Signup is not rate limited.
- There is no organiser UI. Hackathons are created by the seed or by SQL.
- The invariant check skips sandbox hackathons on purpose, because the arena's naive mode corrupts its own throwaway team to show the bug.

## Measured locally

Local Compose stack with two replicas, seeded with 10,000 users and 2,000 teams, and k6 on the same 12-thread laptop. The live URL has not been load tested yet.

| Test | Load | Result |
|:--|:--|:--|
| Board reads | 100 VUs for 3 minutes | p95 60.4 ms, 3,179 requests/s, 0 failures of 572,719 |
| Reads during writes | 90 readers, 10 writers, 300 open SSE streams | Reader p95 40.6 ms, 0 failures |
| Chaos | A replica killed every few seconds under a write storm | 9 kills, 1,457 seats taken, 0 invariant violations, 0 abandoned intents |
