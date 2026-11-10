#!/usr/bin/env bash
# Runs the reproducible load and chaos suite against the local Compose stack. Takes about 8 minutes.
set -uo pipefail
failed=0
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."
mkdir -p docs/reports

echo "== board: 100 VUs, reads only"
docker compose --profile load run --rm -e K6_WEB_DASHBOARD_EXPORT=/out/load-report.html k6 run /load/board.js \
  > docs/reports/board-k6.log 2>&1
status=$?; echo "exit $status"; [ "$status" -eq 0 ] || failed=1

echo "== mixed: 90 readers, 10 writers, 300 open SSE streams"
docker compose --profile load run --rm -e K6_WEB_DASHBOARD_EXPORT=/out/load-report-mixed.html k6 run /load/mixed.js \
  > docs/reports/mixed-k6.log 2>&1
status=$?; echo "exit $status"; [ "$status" -eq 0 ] || failed=1

echo "== chaos"
bash chaos/chaos.sh 2>&1 | tee docs/reports/chaos.log
status=${PIPESTATUS[0]}; echo "chaos exit $status"; [ "$status" -eq 0 ] || failed=1

echo "== suite $([ "$failed" -eq 0 ] && echo passed || echo FAILED)"
exit "$failed"
