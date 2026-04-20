#!/usr/bin/env bash
# =============================================================================
# Tanzen — Smoke Test Suite
#
# Runs 10 in-cluster health checks against all M1 services.
# Exits 0 only if all tests pass.
#
# Usage:
#   ./infra/scripts/smoke-test.sh [--namespace NS] [--verbose]
#
# Prerequisites: kubectl on PATH, valid kubeconfig context.
# =============================================================================
set -euo pipefail

NAMESPACE="${TANZEN_NAMESPACE:-tanzen-dev}"
VERBOSE=false
PASS=0
FAIL=0
RESULTS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --verbose)   VERBOSE=true;   shift   ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
vlog() { $VERBOSE && echo "  [debug] $*" || true; }

# Execute a command inside an existing pod selected by label.
# kube_exec <selector> <container> <cmd...>
kube_exec() {
  local selector="$1"; local container="$2"; shift 2
  local pod
  pod=$(kubectl get pod -n "${NAMESPACE}" -l "${selector}" -o name 2>/dev/null | head -1)
  if [[ -z "$pod" ]]; then
    echo "no pod found for selector: ${selector}" >&2
    return 1
  fi
  kubectl exec -n "${NAMESPACE}" "${pod}" -c "${container}" -- "$@" 2>/dev/null
}

# Run a one-shot pod, capture its logs, delete it.
# kube_run_probe <pod-name-prefix> <image> <cmd...>
kube_run_probe() {
  local prefix="$1"; local image="$2"; shift 2
  local name="${prefix}-$$"
  kubectl run "${name}" \
    --restart=Never \
    --image="${image}" \
    --namespace="${NAMESPACE}" \
    --timeout=60s \
    --quiet \
    -- "$@" >/dev/null 2>&1 || true
  # Wait for the pod to complete (Succeeded or Failed)
  local phase
  for _ in $(seq 1 30); do
    phase=$(kubectl get pod "${name}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [[ "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
    sleep 1
  done
  local output
  output=$(kubectl logs "${name}" -n "${NAMESPACE}" 2>/dev/null || true)
  kubectl delete pod "${name}" -n "${NAMESPACE}" --ignore-not-found >/dev/null 2>&1 || true
  echo "${output}"
  [[ "$phase" == "Succeeded" ]]
}

record() {
  local id="$1"; local name="$2"; local result="$3"; local detail="${4:-}"
  if [[ "$result" == "PASS" ]]; then
    PASS=$((PASS + 1))
    RESULTS+=("  ✓  ${id}  ${name}")
  else
    FAIL=$((FAIL + 1))
    RESULTS+=("  ✗  ${id}  ${name}${detail:+  →  ${detail}}")
  fi
}

run_test() {
  local id="$1"; local name="$2"; shift 2
  vlog "Running ${id}: ${name}"
  local output detail
  if output=$("$@" 2>&1); then
    record "${id}" "${name}" PASS
    vlog "  Output: ${output}"
  else
    detail="${output:-command failed}"
    record "${id}" "${name}" FAIL "${detail}"
  fi
}

# ---------------------------------------------------------------------------
# Wait for all pods in namespace to settle before testing
# ---------------------------------------------------------------------------
log "Waiting for all pods in '${NAMESPACE}' to be ready (up to 5 min)..."
kubectl wait --for=condition=ready pod \
  --all -n "${NAMESPACE}" \
  --timeout=300s \
  2>/dev/null || log "Warning: not all pods ready — proceeding with tests anyway."

echo ""
log "Running Tanzen smoke tests against namespace: ${NAMESPACE}"
echo "--------------------------------------------------------------"

# ---------------------------------------------------------------------------
# ST-01: PostgreSQL — tanzen database connection
# Uses exec into the CNPG primary pod (postgres binary available there).
# ---------------------------------------------------------------------------
run_test ST-01 "PostgreSQL: tanzen database reachable" bash -c "
  PASS=\$(kubectl get secret tanzen-db-credentials -n ${NAMESPACE} \
    -o jsonpath='{.data.password}' | base64 -d)
  kubectl exec -n ${NAMESPACE} tanzen-postgres-1 -c postgres -- \
    env PGPASSWORD=\$PASS \
    psql -h tanzen-postgres-rw -U tanzen_user -d tanzen -c 'SELECT 1' -t 2>/dev/null \
    | grep -q '1'
"

# ---------------------------------------------------------------------------
# ST-02: PostgreSQL — temporal database connection
# ---------------------------------------------------------------------------
run_test ST-02 "PostgreSQL: temporal database reachable" bash -c "
  PASS=\$(kubectl get secret temporal-db-credentials -n ${NAMESPACE} \
    -o jsonpath='{.data.password}' | base64 -d)
  kubectl exec -n ${NAMESPACE} tanzen-postgres-1 -c postgres -- \
    env PGPASSWORD=\$PASS \
    psql -h tanzen-postgres-rw -U temporal_user -d temporal -c 'SELECT 1' -t 2>/dev/null \
    | grep -q '1'
"

# ---------------------------------------------------------------------------
# ST-03: Temporal — cluster health
# ---------------------------------------------------------------------------
run_test ST-03 "Temporal: cluster health SERVING" bash -c "
  kubectl exec -n ${NAMESPACE} deploy/tanzen-temporal-admintools -- \
    temporal operator cluster health --address tanzen-temporal-frontend:7233 2>/dev/null \
    | grep -qi 'SERVING'
"

# ---------------------------------------------------------------------------
# ST-04: Temporal — default namespace exists
# ---------------------------------------------------------------------------
run_test ST-04 "Temporal: default namespace registered" bash -c "
  kubectl exec -n ${NAMESPACE} deploy/tanzen-temporal-admintools -- \
    temporal operator namespace describe --namespace default \
    --address tanzen-temporal-frontend:7233 2>/dev/null \
    | grep -q 'default'
"

# ---------------------------------------------------------------------------
# ST-05: SeaweedFS — S3 bucket listing (4 buckets: workflows, agents, artifacts, scripts)
# Uses the filer HTTP JSON API from the admintools pod (no S3 auth needed).
# ---------------------------------------------------------------------------
run_test ST-05 "SeaweedFS: four S3 buckets exist" bash -c "
  COUNT=\$(kubectl exec -n ${NAMESPACE} deploy/tanzen-temporal-admintools -- \
    sh -c \"wget -qO- --header='Accept: application/json' \
      'http://seaweedfs-filer:8888/buckets/' 2>/dev/null\" \
    | grep -oE '\"FullPath\":\"/buckets/[^\"]+\"' \
    | grep -cE 'workflows|agents|artifacts|scripts' || true)
  [[ \"\$COUNT\" -ge 4 ]]
"

# ---------------------------------------------------------------------------
# ST-06: SeaweedFS — S3 put/get round-trip via one-shot awscli pod
# ---------------------------------------------------------------------------
_st06_s3_roundtrip() {
  local AK SK name phase output
  AK=$(kubectl get secret seaweedfs-s3-credentials -n "${NAMESPACE}" \
    -o jsonpath='{.data.access_key}' | base64 -d)
  SK=$(kubectl get secret seaweedfs-s3-credentials -n "${NAMESPACE}" \
    -o jsonpath='{.data.secret_key}' | base64 -d)
  name="s3-rtrip-$$"
  kubectl run "${name}" \
    --restart=Never \
    --image=amazon/aws-cli:2.17.0 \
    --namespace="${NAMESPACE}" \
    --env="AWS_ACCESS_KEY_ID=${AK}" \
    --env="AWS_SECRET_ACCESS_KEY=${SK}" \
    --env="AWS_DEFAULT_REGION=us-east-1" \
    --timeout=60s \
    --quiet \
    --command -- sh -c "
      echo smoke-test > /tmp/smoke.txt &&
      aws s3 cp /tmp/smoke.txt s3://artifacts/smoke-test.txt \
        --endpoint-url http://seaweedfs-filer:8333 --no-progress &&
      aws s3 cp s3://artifacts/smoke-test.txt /tmp/smoke-out.txt \
        --endpoint-url http://seaweedfs-filer:8333 --no-progress &&
      grep -q smoke-test /tmp/smoke-out.txt &&
      aws s3 rm s3://artifacts/smoke-test.txt \
        --endpoint-url http://seaweedfs-filer:8333
    " >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    phase=$(kubectl get pod "${name}" -n "${NAMESPACE}" \
      -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    [[ "$phase" == "Succeeded" || "$phase" == "Failed" ]] && break
    sleep 1
  done
  output=$(kubectl logs "${name}" -n "${NAMESPACE}" 2>/dev/null || true)
  kubectl delete pod "${name}" -n "${NAMESPACE}" --ignore-not-found >/dev/null 2>&1 || true
  echo "${output}"
  [[ "$phase" == "Succeeded" ]]
}
run_test ST-06 "SeaweedFS: S3 PutObject + GetObject round-trip" _st06_s3_roundtrip

# ---------------------------------------------------------------------------
# ST-07: Redis — PING
# ---------------------------------------------------------------------------
run_test ST-07 "Redis: PING returns PONG" bash -c "
  kubectl exec -n ${NAMESPACE} tanzen-redis-master-0 -- \
    redis-cli -h tanzen-redis-master ping 2>/dev/null | grep -q 'PONG'
"

# ---------------------------------------------------------------------------
# ST-08: Redis — pub/sub round-trip
# ---------------------------------------------------------------------------
run_test ST-08 "Redis: PUBLISH + SUBSCRIBE round-trip" bash -c "
  # Subscribe in background, publish a message, verify delivery
  kubectl exec -n ${NAMESPACE} tanzen-redis-master-0 -- \
    sh -c '
      redis-cli -h tanzen-redis-master SUBSCRIBE smoke-test &
      sleep 1
      redis-cli -h tanzen-redis-master PUBLISH smoke-test hello
      sleep 1
      kill %1 2>/dev/null || true
    ' 2>/dev/null | grep -q 'hello'
"

# ---------------------------------------------------------------------------
# ST-09: KEDA — ScaledObject CRD is registered (worker scaler is M3)
# ---------------------------------------------------------------------------
run_test ST-09 "KEDA: ScaledObject CRD is registered" bash -c "
  kubectl get crd scaledobjects.keda.sh 2>/dev/null | grep -q 'scaledobjects.keda.sh'
"

# ---------------------------------------------------------------------------
# ST-10: Grafana — health endpoint
# ---------------------------------------------------------------------------
run_test ST-10 "Grafana: /api/health returns 200" bash -c "
  kubectl exec -n ${NAMESPACE} deploy/tanzen-grafana -c grafana -- \
    wget -qO- http://localhost:3000/api/health 2>/dev/null | grep -q 'ok'
"

# ---------------------------------------------------------------------------
# Results summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Tanzen Smoke Test Results"
echo "============================================================"
echo ""
printf "  %-6s  %-8s  %s\n" "TEST" "RESULT" "NAME"
echo "  ------  --------  ----------------------------------------"
for r in "${RESULTS[@]}"; do echo "$r"; done
echo ""
echo "  Passed: ${PASS} / $((PASS + FAIL))"
echo "============================================================"

if [[ ${FAIL} -gt 0 ]]; then
  echo ""
  echo "  SMOKE TESTS FAILED — ${FAIL} test(s) did not pass."
  echo "  Check logs: kubectl get pods -n ${NAMESPACE}"
  echo "              kubectl logs -n ${NAMESPACE} <pod-name>"
  exit 1
fi

echo ""
echo "  All smoke tests passed. Milestone 1 complete."
echo ""
