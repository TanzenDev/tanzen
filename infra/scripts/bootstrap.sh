#!/usr/bin/env bash
# =============================================================================
# Tanzen — Bootstrap Script
#
# Sets up all prerequisites on an existing Kind cluster (or creates a new one)
# and prepares K8s secrets before running Helm.
#
# Usage:
#   ./infra/scripts/bootstrap.sh [OPTIONS]
#
# Options:
#   --namespace NS     Target namespace (default: tanzen-dev)
#   --cluster NAME     Kind cluster name to create (default: use current context)
#   --new-cluster      Create a new Kind cluster named by --cluster
#   --no-cilium        Use kindnet CNI instead of Cilium (for CI environments)
#   --no-monitoring    Skip kube-prometheus-stack/Grafana (faster CI installs)
#   --extra-values F   Additional Helm values file passed to tanzen chart install
#   --talos            Apply Talos-specific overrides (values-talos.yaml) — uses
#                      custom schema job instead of Temporal sub-chart schema jobs
#   --dry-run          Print what would be done without executing
#
# Prerequisites (must be on PATH):
#   kubectl, helm, kind (only if --new-cluster), openssl
#
# This script is idempotent: re-running it is safe.
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
NAMESPACE="${TANZEN_NAMESPACE:-tanzen-dev}"
CLUSTER_NAME="${TANZEN_CLUSTER:-tanzen-dev}"
NEW_CLUSTER=false
DRY_RUN=false
NO_MONITORING=false
NO_CILIUM=false
TALOS=false
EXTRA_VALUES=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CHART_DIR="${REPO_ROOT}/infra/charts/tanzen"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)      NAMESPACE="$2";     shift 2 ;;
    --cluster)        CLUSTER_NAME="$2";  shift 2 ;;
    --new-cluster)    NEW_CLUSTER=true;   shift   ;;
    --no-cilium)      NO_CILIUM=true;     shift   ;;
    --no-monitoring)  NO_MONITORING=true; shift   ;;
    --extra-values)   EXTRA_VALUES="$2"; shift 2  ;;
    --talos)          TALOS=true;         shift   ;;
    --dry-run)        DRY_RUN=true;       shift   ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[$(date -u +%H:%M:%S)] $*"; }
run()  { if $DRY_RUN; then echo "[dry-run] $*"; else "$@"; fi; }
need() {
  for cmd in "$@"; do
    command -v "$cmd" &>/dev/null || { echo "ERROR: '$cmd' not found on PATH"; exit 1; }
  done
}

# ---------------------------------------------------------------------------
# Prerequisites check
# ---------------------------------------------------------------------------
log "Checking prerequisites..."
if $NO_CILIUM; then
  need kubectl helm openssl
else
  need kubectl helm openssl cilium
fi
if $NEW_CLUSTER; then need kind; fi
log "Prerequisites OK."

# ---------------------------------------------------------------------------
# Helm repo setup
# ---------------------------------------------------------------------------
log "Adding Helm repositories..."
if ! $NO_CILIUM; then
  run helm repo add cilium      https://helm.cilium.io/                         --force-update
fi
run helm repo add cnpg        https://cloudnative-pg.github.io/charts          --force-update
run helm repo add temporal    https://go.temporal.io/helm-charts                --force-update
run helm repo add bitnami     https://charts.bitnami.com/bitnami                --force-update
run helm repo add prometheus  https://prometheus-community.github.io/helm-charts --force-update
run helm repo add kedacore    https://kedacore.github.io/charts                 --force-update
run helm repo update
log "Helm repositories updated."

# ---------------------------------------------------------------------------
# Optional: create a new Kind cluster
# ---------------------------------------------------------------------------
if $NEW_CLUSTER; then
  if kind get clusters 2>/dev/null | grep -q "^${CLUSTER_NAME}$"; then
    log "Kind cluster '${CLUSTER_NAME}' already exists — skipping creation."
  else
    log "Creating Kind cluster '${CLUSTER_NAME}'..."
    KIND_CONFIG="${SCRIPT_DIR}/kind-config.yaml"
    $NO_CILIUM && KIND_CONFIG="${SCRIPT_DIR}/kind-config-ci.yaml"
    run kind create cluster --name "${CLUSTER_NAME}" \
      --config "${KIND_CONFIG}"
    log "Cluster created. Current context: $(kubectl config current-context)"
  fi
fi

# ---------------------------------------------------------------------------
# Cilium CNI
# ---------------------------------------------------------------------------
if $NO_CILIUM; then
  log "Skipping Cilium CNI install (--no-cilium set; using kindnet)."
else
  log "Installing Cilium CNI..."
  API_SERVER_IP=$(kubectl get node "${CLUSTER_NAME}-control-plane" \
    -o 'jsonpath={.status.addresses[?(@.type=="InternalIP")].address}')
  run helm upgrade --install cilium cilium/cilium \
    --namespace kube-system \
    --set kubeProxyReplacement=true \
    --set socketLB.hostNamespaceOnly=true \
    --set k8sServiceHost="${API_SERVER_IP}" \
    --set k8sServicePort=6443 \
    --set operator.replicas=1 \
    --set l2announcements.enabled=true \
    --set l2announcements.leaseDuration=3s \
    --set l2announcements.renewDeadline=1s \
    --set l2announcements.retryPeriod=200ms \
    --set externalIPs.enabled=true \
    --set hubble.relay.enabled=true \
    --set hubble.ui.enabled=true \
    --wait

  log "Waiting for Cilium to be ready..."
  run cilium status --wait --wait-duration 5m
  log "Cilium ready."
fi

# ---------------------------------------------------------------------------
# Kata Containers (requires nested virt; skipped in CI alongside --no-cilium)
# ---------------------------------------------------------------------------
if $NO_CILIUM; then
  log "Skipping Kata Containers install (--no-cilium set; nested virt unavailable in CI)."
else
  # kata-deploy ships as a Helm chart in GitHub releases; update KATA_VERSION when bumping.
  KATA_VERSION="3.29.0"
  KATA_CHART_URL="https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-deploy-${KATA_VERSION}.tgz"
  log "Installing Kata Containers (${KATA_VERSION})..."
  run helm upgrade --install kata-deploy "${KATA_CHART_URL}" \
    --namespace kube-system \
    --set k8sDistribution=k8s \
    --set node-feature-discovery.enabled=false \
    --wait \
    || log "WARN: kata-deploy not ready (nested-virt may be unavailable on macOS Docker)"
  log "Kata RuntimeClasses installed."
fi

# ---------------------------------------------------------------------------
# L2 Announcement resources (Cilium-only)
# ---------------------------------------------------------------------------
if $NO_CILIUM; then
  log "Skipping L2 Announcement resources (--no-cilium set)."
else
  log "Applying L2 Announcement resources..."
  # 172.18.100.200/29 = 6 usable IPs within Kind's default Docker bridge (172.18.0.0/16)
  run kubectl apply -f - <<'EOF'
---
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata:
  name: kind-pool
spec:
  blocks:
    - cidr: "172.18.100.200/29"
---
apiVersion: cilium.io/v2alpha1
kind: CiliumL2AnnouncementPolicy
metadata:
  name: default
spec:
  loadBalancerIPs: true
  externalIPs: true
  interfaces:
    - ^eth[0-9]+
EOF
  log "L2 Announcement resources applied."
fi

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------
log "Ensuring namespace '${NAMESPACE}' exists..."
if kubectl get namespace "${NAMESPACE}" &>/dev/null; then
  log "Namespace '${NAMESPACE}' already exists — skipping."
else
  run kubectl create namespace "${NAMESPACE}"
  log "Namespace '${NAMESPACE}' created."
fi

# ---------------------------------------------------------------------------
# Install cluster-level operators (KEDA, CloudNativePG)
# These are cluster-scoped and installed into their own namespaces.
# ---------------------------------------------------------------------------
log "Installing KEDA operator..."
if helm status keda -n keda &>/dev/null 2>&1; then
  log "KEDA already installed — upgrading..."
  run helm upgrade keda kedacore/keda \
    --namespace keda \
    --create-namespace \
    --wait \
    --timeout 5m
else
  run helm install keda kedacore/keda \
    --namespace keda \
    --create-namespace \
    --wait \
    --timeout 5m
fi
log "KEDA ready."

log "Installing CloudNativePG operator..."
if helm status cnpg -n cnpg-system &>/dev/null 2>&1; then
  log "CloudNativePG already installed — upgrading..."
  run helm upgrade cnpg cnpg/cloudnative-pg \
    --namespace cnpg-system \
    --create-namespace \
    --wait \
    --timeout 5m
else
  run helm install cnpg cnpg/cloudnative-pg \
    --namespace cnpg-system \
    --create-namespace \
    --wait \
    --timeout 5m
fi
log "CloudNativePG ready."

# ---------------------------------------------------------------------------
# Install NGINX ingress controller (required for Grafana ingress in dev)
# ---------------------------------------------------------------------------
log "Installing NGINX ingress controller..."
if helm status ingress-nginx -n ingress-nginx &>/dev/null 2>&1; then
  log "NGINX ingress already installed — skipping."
else
  run helm install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx \
    --create-namespace \
    --wait \
    --timeout 5m \
    --set controller.service.type=NodePort \
    2>/dev/null || \
  # Add the ingress-nginx repo if it's missing
  (helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx --force-update && \
   helm repo update && \
   run helm install ingress-nginx ingress-nginx/ingress-nginx \
     --namespace ingress-nginx \
     --create-namespace \
     --wait \
     --timeout 5m \
     --set controller.service.type=NodePort)
fi
log "NGINX ingress ready."

# ---------------------------------------------------------------------------
# Generate and store secrets
# Idempotent: skips secret creation if the secret already exists.
# ---------------------------------------------------------------------------
gen_password() { openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32; }

create_secret_if_missing() {
  local name="$1"; local namespace="$2"; shift 2
  if kubectl get secret "${name}" -n "${namespace}" &>/dev/null; then
    log "Secret '${name}' already exists in '${namespace}' — skipping."
  else
    run kubectl create secret generic "${name}" -n "${namespace}" "$@"
    # Add Helm adoption labels/annotations so helm upgrade --install can own the secret
    kubectl annotate secret "${name}" -n "${namespace}" \
      meta.helm.sh/release-name=tanzen \
      meta.helm.sh/release-namespace="${namespace}" \
      --overwrite &>/dev/null
    kubectl label secret "${name}" -n "${namespace}" \
      app.kubernetes.io/managed-by=Helm \
      --overwrite &>/dev/null
    log "Secret '${name}' created."
  fi
}

log "Generating secrets..."

TEMPORAL_DB_PASS=$(gen_password)
TANZEN_DB_PASS=$(gen_password)
SEAWEEDFS_DB_PASS=$(gen_password)
SEAWEEDFS_ACCESS_KEY=$(gen_password)
SEAWEEDFS_SECRET_KEY=$(gen_password)
GRAFANA_ADMIN_PASS=$(gen_password)

create_secret_if_missing temporal-db-credentials "${NAMESPACE}" \
  --from-literal=username=temporal_user \
  --from-literal=password="${TEMPORAL_DB_PASS}"

create_secret_if_missing tanzen-db-credentials "${NAMESPACE}" \
  --from-literal=username=tanzen_user \
  --from-literal=password="${TANZEN_DB_PASS}"

create_secret_if_missing seaweedfs-db-credentials "${NAMESPACE}" \
  --from-literal=username=seaweedfs_user \
  --from-literal=password="${SEAWEEDFS_DB_PASS}"

create_secret_if_missing seaweedfs-s3-credentials "${NAMESPACE}" \
  --from-literal=access_key="${SEAWEEDFS_ACCESS_KEY}" \
  --from-literal=secret_key="${SEAWEEDFS_SECRET_KEY}"

if ! $NO_MONITORING; then
  create_secret_if_missing grafana-admin-credentials "${NAMESPACE}" \
    --from-literal=admin-password="${GRAFANA_ADMIN_PASS}"
fi

log "Secrets ready."

# ---------------------------------------------------------------------------
# Apply Grafana dashboard ConfigMap (namespace substitution)
# ---------------------------------------------------------------------------
if ! $NO_MONITORING; then
  log "Applying Grafana dashboard ConfigMap..."
  DASHBOARD_CM="${REPO_ROOT}/infra/deps/grafana/dashboards-configmap.yaml"
  if [ -f "${DASHBOARD_CM}" ]; then
    run sed "s/{{ NAMESPACE }}/${NAMESPACE}/g" "${DASHBOARD_CM}" | \
      kubectl apply -n "${NAMESPACE}" -f -
    # Add Helm adoption labels so helm upgrade --install can own the ConfigMap
    kubectl annotate configmap tanzen-grafana-dashboards -n "${NAMESPACE}" \
      meta.helm.sh/release-name=tanzen \
      meta.helm.sh/release-namespace="${NAMESPACE}" \
      --overwrite &>/dev/null
    kubectl label configmap tanzen-grafana-dashboards -n "${NAMESPACE}" \
      app.kubernetes.io/managed-by=Helm \
      --overwrite &>/dev/null
  fi
fi

# ---------------------------------------------------------------------------
# Helm install / upgrade of the Tanzen umbrella chart
# ---------------------------------------------------------------------------
log "Running helm dependency update..."
run helm dependency update "${CHART_DIR}"

log "Installing / upgrading Tanzen chart into namespace '${NAMESPACE}'..."
MONITORING_SET=""
$NO_MONITORING && MONITORING_SET="--set monitoring.enabled=false"
EXTRA_VALUES_FLAG=""
[ -n "${EXTRA_VALUES}" ] && EXTRA_VALUES_FLAG="--values ${EXTRA_VALUES}"
TALOS_VALUES_FLAG=""
$TALOS && TALOS_VALUES_FLAG="--values ${CHART_DIR}/values-talos.yaml"

# Grafana OIDC SSO — injected when OIDC_ISSUER is set in the environment.
# Requires a "grafana" confidential client in the IdP with the tanzen_role claim.
GRAFANA_OIDC_SETS=""
if [ -n "${OIDC_ISSUER:-}" ]; then
  OIDC_CLIENT_ID="${OIDC_GRAFANA_CLIENT_ID:-grafana}"
  OIDC_CLIENT_SECRET="${OIDC_GRAFANA_CLIENT_SECRET:-}"
  GRAFANA_OIDC_SETS=" \
    --set 'kube-prometheus-stack.grafana.grafana\.ini.auth\.generic_oauth.enabled=true' \
    --set 'kube-prometheus-stack.grafana.grafana\.ini.auth\.generic_oauth.client_id=${OIDC_CLIENT_ID}' \
    --set 'kube-prometheus-stack.grafana.grafana\.ini.auth\.generic_oauth.client_secret=${OIDC_CLIENT_SECRET}' \
    --set 'kube-prometheus-stack.grafana.grafana\.ini.auth\.generic_oauth.auth_url=${OIDC_ISSUER}/protocol/openid-connect/auth' \
    --set 'kube-prometheus-stack.grafana.grafana\.ini.auth\.generic_oauth.token_url=${OIDC_ISSUER}/protocol/openid-connect/token' \
    --set 'kube-prometheus-stack.grafana.grafana\.ini.auth\.generic_oauth.api_url=${OIDC_ISSUER}/protocol/openid-connect/userinfo'"
  log "OIDC_ISSUER set — enabling Grafana SSO (client: ${OIDC_CLIENT_ID})"
fi

# shellcheck disable=SC2086
run helm upgrade --install tanzen "${CHART_DIR}" \
  --namespace "${NAMESPACE}" \
  --create-namespace \
  --values "${CHART_DIR}/values.yaml" \
  --set "global.namespace=${NAMESPACE}" \
  ${MONITORING_SET} \
  ${TALOS_VALUES_FLAG} \
  ${EXTRA_VALUES_FLAG} \
  ${GRAFANA_OIDC_SETS} \
  --wait \
  --timeout 20m

log "Helm install complete."

# ---------------------------------------------------------------------------
# Post-install: register Temporal 'default' namespace
# ---------------------------------------------------------------------------
log "Registering Temporal 'default' namespace..."
# Wait for admintools pod to be ready
run kubectl wait --for=condition=ready pod \
  -l app.kubernetes.io/component=admintools \
  -n "${NAMESPACE}" \
  --timeout=120s

# Check if namespace already exists before registering
if kubectl exec -n "${NAMESPACE}" \
    deploy/tanzen-temporal-admintools -- \
    tctl --address tanzen-temporal-frontend:7233 namespace describe default \
    &>/dev/null 2>&1; then
  log "Temporal 'default' namespace already registered."
else
  run kubectl exec -n "${NAMESPACE}" \
    deploy/tanzen-temporal-admintools -- \
    tctl --address tanzen-temporal-frontend:7233 namespace register default
  log "Temporal 'default' namespace registered."
fi

# ---------------------------------------------------------------------------
# Completion summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
echo "  Tanzen infrastructure deployed successfully!"
echo "============================================================"
echo ""
echo "  Namespace:    ${NAMESPACE}"
echo ""
echo "  Grafana admin password (save this):"
echo "    kubectl get secret grafana-admin-credentials -n ${NAMESPACE} \\"
echo "      -o jsonpath='{.data.admin-password}' | base64 -d && echo"
echo ""
echo "  Access Grafana (dev):"
echo "    kubectl port-forward -n ${NAMESPACE} svc/tanzen-grafana 3000:80"
echo "    Then open: http://grafana.tanzen.local"
echo "    (Add '127.0.0.1 grafana.tanzen.local' to /etc/hosts)"
echo ""
echo "  Access Temporal Web UI (internal only):"
echo "    kubectl port-forward -n ${NAMESPACE} svc/temporal-web 8080:8080"
echo "    Then open: http://localhost:8080"
echo ""
echo "  Run smoke tests:"
echo "    ./infra/scripts/smoke-test.sh --namespace ${NAMESPACE}"
echo ""
