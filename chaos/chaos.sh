#!/usr/bin/env bash
# Kills an API replica every 5 seconds under a write storm, then proves nothing was damaged.
# Requires the stack to be up: docker compose up -d --build
set -euo pipefail
export MSYS_NO_PATHCONV=1 # stops Git Bash on Windows rewriting /load/... into a Windows path
cd "$(dirname "$0")/.."

DURATION="${DURATION:-60}"
mkdir -p docs/reports

echo "== write storm for ${DURATION}s, killing a replica every 5s"
docker compose --profile load run --rm -e DURATION="${DURATION}s" -e K6_WEB_DASHBOARD=false k6 run /load/write-storm.js \
  > docs/reports/chaos-k6.log 2>&1 &
STORM=$!

kills=0
end=$((SECONDS + DURATION))
while [ "$SECONDS" -lt "$end" ]; do
  sleep 5
  victim=$([ $((kills % 2)) -eq 0 ] && echo api-a || echo api-b)
  docker compose kill -s SIGKILL "$victim" >/dev/null 2>&1
  kills=$((kills + 1))
  echo "   killed $victim (kill #$kills)"
  sleep 1
  docker compose up -d --no-deps "$victim" >/dev/null 2>&1
done

storm_status=0
wait "$STORM" || storm_status=$?
grep -E "(teams_created|seats_taken|leaves_completed|retries_after_failure|intents_abandoned)\.\.\.|http_reqs" docs/reports/chaos-k6.log || true

echo "== invariants: db/invariants.sql, the same checks every test runs"
violations=0
docker compose run --rm --no-deps -T migrate node dist/db/check-invariants.js || violations=1

echo "== result: $kills replicas killed, invariants $([ "$violations" -eq 0 ] && echo hold || echo VIOLATED), k6 exit $storm_status"
[ "$violations" -eq 0 ] && [ "$storm_status" -eq 0 ]
