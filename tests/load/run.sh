#!/usr/bin/env bash
# tests/load/run.sh — Run load tests against a local or remote Tanzen instance.
#
# Usage:
#   ./tests/load/run.sh baseline          # k6 API baseline (10 VUs, 3 min)
#   ./tests/load/run.sh compile           # k6 compile throughput
#   ./tests/load/run.sh run-burst         # k6 run submission burst
#   ./tests/load/run.sh sse-hold          # k6 SSE connection hold
#   ./tests/load/run.sh worker            # k6 worker concurrency
#   ./tests/load/run.sh locust            # Locust multi-step flow (50 users, 10 min)
#   ./tests/load/run.sh all               # all k6 scenarios sequentially
#
# Required env vars:
#   TANZEN_URL    — API base URL (default: http://localhost:3000)
#   TANZEN_TOKEN  — Bearer JWT
#   TANZEN_WF_ID  — workflow UUID for run tests (echo workflow)
#   TANZEN_RUN_ID — completed run UUID for SSE test

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${TANZEN_URL:-http://localhost:3000}"
TOKEN="${TANZEN_TOKEN:-}"
WF_ID="${TANZEN_WF_ID:-}"
RUN_ID="${TANZEN_RUN_ID:-}"

k6_run() {
  local script="$1"; shift
  k6 run \
    -e BASE_URL="$BASE" \
    -e TOKEN="$TOKEN" \
    -e WF_ID="$WF_ID" \
    -e RUN_ID="$RUN_ID" \
    "$@" \
    "${SCRIPT_DIR}/k6/${script}.js"
}

case "${1:-help}" in
  baseline)
    k6_run baseline
    ;;
  compile)
    k6_run compile
    ;;
  run-burst)
    k6_run run-burst
    ;;
  sse-hold)
    k6_run sse-hold
    ;;
  worker)
    k6_run worker-concurrency -e "CONCURRENCY=${CONCURRENCY:-20}"
    ;;
  locust)
    cd "${SCRIPT_DIR}/locust"
    locust -f tanzen_flow.py \
      --host "$BASE" \
      --users "${LOCUST_USERS:-50}" \
      --spawn-rate "${LOCUST_SPAWN_RATE:-5}" \
      --run-time "${LOCUST_RUN_TIME:-10m}" \
      --headless \
      --only-summary
    ;;
  all)
    for t in baseline compile run-burst sse-hold; do
      echo "==> Running: $t"
      k6_run "$t"
      echo
    done
    ;;
  *)
    echo "Usage: $0 {baseline|compile|run-burst|sse-hold|worker|locust|all}"
    exit 1
    ;;
esac
