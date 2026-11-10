# Lastseat: race-proof team formation

[![CI](https://github.com/Gauravtiwari31/Race-proof/actions/workflows/ci.yml/badge.svg)](https://github.com/Gauravtiwari31/Race-proof/actions/workflows/ci.yml)

Hackathon team formation where every hard guarantee is enforced by Postgres in a single transaction, proven by an automated test, and visible inside the product. Fifty people click Join on one last seat; exactly one gets it, on any number of servers.

| | |
|:--|:--|
| **Live demo** | <https://lastseat-b4mi.onrender.com> (free tier; the first request after a quiet spell can take up to a minute) |
| **Sign in** | `user1@seed.local` / `demo-password-123` (every seeded user shares this password) |
| **Demo video** | 3:39 walkthrough, linked from the submission page ([how it is made](media/README.md)) |
| **Pitch deck** | [media/deck/lastseat-pitch.pdf](media/deck/lastseat-pitch.pdf) ([.pptx](media/deck/lastseat-pitch.pptx)) |
| **Design doc** | [docs/design.pdf](docs/design.pdf) |
| **Load reports** | [board](docs/reports/load-report.html), [reads during writes](docs/reports/load-report-mixed.html), [chaos](docs/reports/chaos.log), [query plans](docs/reports/explain.txt) |

## Try it

Open the live demo, sign in, then open **Arena** and press **Unleash 50 bots**: fifty real transactions race for one seat, and one wins. Switch to the naive seat logic and run it again to see what the conditional `UPDATE` prevents.

To run everything locally, with two API replicas behind Caddy:

```sh
docker compose up -d --build
```

Then open <http://localhost:8080> and sign in the same way.

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
| Security | Argon2id, hashed sessions and codes, private-by-default routes, leader checks after the lock, durable rate limits on codes, logins, sign-ups and writes, zod on every input | `auth.*`, `authz.*`, `ratelimit.*`, `validation.*`, `race.stale-leader-check` |
| Audit log | Append-only `audit_events` written inside each team mutation; the app role cannot update or delete | `audit.*`, [0002_app_role.sql](db/migrations/0002_app_role.sql) |
| Teammate suggestions | Weighted score with a per-candidate explanation | `suggest.*` |
| At least 20 API tests in CI | Vitest against real Postgres, with no mocked data layer | [ci.yml](.github/workflows/ci.yml) |
| Seed 10k users, 2k teams | One SQL script, about 1.5 seconds | [seed.sql](db/seed.sql), `pnpm seed` |
| Load test p95 under 200 ms | k6, 100 VUs, thresholds that fail the run | [load/](load/), [report](docs/reports/load-report.html), [workflow](.github/workflows/load-test.yml) |
| React UI, phone and keyboard | Radix primitives, focus management, axe checks, command palette | `e2e.keyboard-only`, `e2e.phone`, `e2e.command-palette` |
| Live URL | Same-origin deploy on Render: the API serves the SPA | <https://lastseat-b4mi.onrender.com>, [render.yaml](render.yaml) |
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
| No deadlocks | One lock order: team, then memberships, then the user row, then requests and codes | `race.mixed-no-deadlock`, `race.lock-order-*` |
| A join never strands a request | The user row serialises joining a team and asking to join another | `race.request-vs-join`, invariant `no_pending_request_from_member` |
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

- Auth and profile changes are not in the audit log, because that table is scoped to a hackathon.
- The rate limiter uses fixed windows, so a client can make up to twice the limit across a window boundary.
- The live site runs on one free Render instance with Render's free Postgres, which expires after 30 days. The two-replica proof comes from Compose and the tests.
- There is no organiser UI. Hackathons are created by the seed or by SQL.
- The invariant check skips sandbox hackathons on purpose, because the arena's naive mode corrupts its own throwaway team to show the bug.

## Measured locally

Local Compose stack with two replicas, seeded with 10,000 users and 2,000 teams, and k6 on the same 12-thread laptop, on 10 Nov 2026. The last row is the same stack on a GitHub runner, which anyone can rerun from the Actions tab. Rerun with `bash load/run-all.sh`; it fails if any threshold fails.

| Test | Load | Result |
|:--|:--|:--|
| Board reads | 100 VUs for 3 minutes | p95 114.1 ms against a 200 ms budget, 1,811 requests/s, 0 failures of 326,379 |
| Reads during writes | 90 readers, 10 writers, 300 open SSE streams | Reader p95 107.2 ms, 0 failures in any scenario |
| Chaos | A replica killed every 5 seconds under a write storm | 8 kills, 1,280 seats taken, 0 abandoned intents, all invariants hold |
| Tests | `pnpm test`, `pnpm e2e` | 122 API tests on real Postgres, 9 browser tests |
| Board reads on GitHub Actions | 100 VUs for 3 minutes, [Load test workflow](https://github.com/Gauravtiwari31/Race-proof/actions/runs/42836141637) | p95 68.9 ms, 2,828 requests/s, 0 failures of 509,320 |

On the live site, a 50-bot arena race returns one winner in about a second, and the naive mode visibly breaks its sandbox team.
