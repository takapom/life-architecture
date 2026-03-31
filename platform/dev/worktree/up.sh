#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: platform/dev/worktree/up.sh [TASK_ID] [options]

Create/update a worktree-isolated app environment on a shared local kind cluster.

Options:
  --task-id <id>             Task/worktree id (default: first arg or cwd basename)
  --namespace <name>         Worktree namespace override
  --release <name>           Worktree Helm release override
  --secret <name>            Worktree env secret name (default: omta-wt-env)
  --shared-namespace <name>  Shared infra namespace (default: omta-shared)
  --shared-release <name>    Shared infra Helm release (default: omta-shared)
  --host <fqdn>              Ingress host override (default: <task-id>.localhost)
  --host-suffix <suffix>     Host suffix when deriving ingress host (default: localhost)
  --skip-db-sync             Skip migration step (`bun run --filter @omta/db db:migrate`)
  --no-shared-up             Skip shared infra deploy; still require readiness validation
  -h, --help                 Show help
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/platform/dev/worktree/lib/wt-common.sh"
source "$ROOT_DIR/versions.env"

KUBECTL_ROLLOUT_TIMEOUT="${KUBECTL_ROLLOUT_TIMEOUT:-180s}"
KUBECONFIG="$(wt_require_kubeconfig_path "$ROOT_DIR")"
export KUBECONFIG

wt_require_binary kubectl
wt_require_binary helm
wt_require_binary bun
wt_require_binary nc
wt_require_binary docker
wt_require_binary skaffold

run_db_sync=1
run_shared_up=1
task_id=""
requested_public_host=""
requested_host_suffix=""

if (($# == 0)); then
  task_id="$(basename "$PWD")"
fi

while (($#)); do
  case "$1" in
    --task-id)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --task-id" >&2
        exit 2
      }
      task_id="$2"
      shift 2
      ;;
    --namespace)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --namespace" >&2
        exit 2
      }
      WT_NAMESPACE="$2"
      shift 2
      ;;
    --release)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --release" >&2
        exit 2
      }
      WT_RELEASE="$2"
      shift 2
      ;;
    --secret)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --secret" >&2
        exit 2
      }
      WT_SECRET_NAME="$2"
      shift 2
      ;;
    --shared-namespace)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --shared-namespace" >&2
        exit 2
      }
      SHARED_NAMESPACE="$2"
      shift 2
      ;;
    --shared-release)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --shared-release" >&2
        exit 2
      }
      SHARED_RELEASE="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --host" >&2
        exit 2
      }
      requested_public_host="$2"
      shift 2
      ;;
    --host-suffix)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --host-suffix" >&2
        exit 2
      }
      requested_host_suffix="$2"
      shift 2
      ;;
    --skip-db-sync)
      run_db_sync=0
      shift
      ;;
    --no-shared-up)
      run_shared_up=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -* )
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$task_id" ]]; then
        task_id="$1"
        shift
      else
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

[[ -n "$task_id" ]] || {
  echo "TASK_ID is required." >&2
  usage >&2
  exit 2
}

wt_load_env_defaults "$ROOT_DIR"
if [[ -n "$requested_public_host" ]]; then
  WT_PUBLIC_HOST="$requested_public_host"
fi
if [[ -n "$requested_host_suffix" ]]; then
  WT_HOST_SUFFIX="$requested_host_suffix"
fi

wt_derive_context "$task_id"

JWT_SECRET="${JWT_SECRET:-dev-jwt-secret-change-me}"
COOKIE_SECRET="${COOKIE_SECRET:-dev-cookie-secret-change-me}"
CSRF_HMAC_KEY="${CSRF_HMAC_KEY:-dev-csrf-hmac-key-change-me}"
BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-dev-better-auth-secret-change-me}"
INTERNAL_TOKEN="${INTERNAL_TOKEN:-dev-internal-token-change-me}"
APP_ENCRYPTION_KEY="${APP_ENCRYPTION_KEY:-dev-app-encryption-key-change-me}"
GATEWAY_JWT_SECRET="${GATEWAY_JWT_SECRET:-$JWT_SECRET}"
SECRETS_ENCRYPTION_KEY="${SECRETS_ENCRYPTION_KEY:-secrets-encryption-key-change-me}"
WEBHOOK_HMAC_KEY="${WEBHOOK_HMAC_KEY:-dev-webhook-hmac-key-change-me}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-app}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
WT_IMAGE_REGISTRY="${WT_IMAGE_REGISTRY:-localhost:5001}"
WT_IMAGE_TAG="${WT_IMAGE_TAG:-dev}"
WT_DB_MIGRATE_IMAGE="${WT_DB_MIGRATE_IMAGE:-${WT_IMAGE_REGISTRY}/omta-api:${WT_IMAGE_TAG}}"

wt_require_secret_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "[wt-up] ${name} is required." >&2
    exit 1
  fi
  if [[ "$value" == *"change-me"* ]]; then
    echo "[wt-up] ${name} still uses placeholder value (*change-me*)." >&2
    exit 1
  fi
  if ((${#value} < 16)); then
    echo "[wt-up] ${name} must be at least 16 characters." >&2
    exit 1
  fi
}

wt_require_secret_value "JWT_SECRET" "$JWT_SECRET"
wt_require_secret_value "COOKIE_SECRET" "$COOKIE_SECRET"
wt_require_secret_value "CSRF_HMAC_KEY" "$CSRF_HMAC_KEY"
wt_require_secret_value "BETTER_AUTH_SECRET" "$BETTER_AUTH_SECRET"
wt_require_secret_value "INTERNAL_TOKEN" "$INTERNAL_TOKEN"
wt_require_secret_value "APP_ENCRYPTION_KEY" "$APP_ENCRYPTION_KEY"
wt_require_secret_value "GATEWAY_JWT_SECRET" "$GATEWAY_JWT_SECRET"
wt_require_secret_value "WEBHOOK_HMAC_KEY" "$WEBHOOK_HMAC_KEY"
if [[ "$SECRETS_ENCRYPTION_KEY" == "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" ]]; then
  echo "[wt-up] SECRETS_ENCRYPTION_KEY uses the retired sample key. Rotate it before running wt:up." >&2
  exit 1
fi
if ! [[ "$SECRETS_ENCRYPTION_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  echo "[wt-up] SECRETS_ENCRYPTION_KEY must be a 32-byte base64 value." >&2
  exit 1
fi

wt_compute_kind_image_ref() {
  local requested_image="$1"
  if ! docker image inspect "$requested_image" >/dev/null 2>&1; then
    return 1
  fi

  local image_id image_ref_without_digest image_repo immutable_tag immutable_ref
  image_id="$(docker image inspect "$requested_image" --format '{{.Id}}')"
  immutable_tag="${image_id#sha256:}"
  image_ref_without_digest="${requested_image%%@*}"
  image_repo="$image_ref_without_digest"
  if [[ "${image_ref_without_digest##*/}" == *:* ]]; then
    image_repo="${image_ref_without_digest%:*}"
  fi
  immutable_ref="${image_repo}:${immutable_tag}"
  printf '%s\n' "$immutable_ref"
}

wt_resolve_kind_image() {
  local requested_image="$1"
  local immutable_ref
  if ! immutable_ref="$(wt_compute_kind_image_ref "$requested_image")"; then
    printf '%s\n' "$requested_image"
    return 0
  fi

  echo "[wt-up] loading local image into kind as ${immutable_ref}" >&2
  SKAFFOLD_IMAGE="$requested_image" bash platform/dev/local/load-kind-image.sh >&2
  printf '%s\n' "$immutable_ref"
}

wt_latest_immutable_image_for_repo() {
  local repo="$1"
  local tag image_id
  while read -r tag image_id; do
    [[ -n "$tag" && -n "$image_id" ]] || continue
    if [[ "$tag" == "${image_id#sha256:}" ]]; then
      printf '%s:%s\n' "$repo" "$tag"
      return 0
    fi
  done < <(docker image ls "$repo" --no-trunc --format '{{.Tag}} {{.ID}}')

  return 1
}

wt_build_worktree_images() {
  local skaffold_args=(
    build
    --filename "$ROOT_DIR/skaffold.yaml"
    -q
    --output '{{json .}}'
    -b omta-api-dev-runtime
    -b omta-worker-dev-runtime
    -b omta-web-dev-runtime
    -b omta-public-site-dev-runtime
    -b omta-gateway-dev-runtime
    -b omta-agent-batch-runtime
  )

  echo "[wt-up] building worktree app images via skaffold..."
  skaffold "${skaffold_args[@]}" >/dev/null

  wt_api_image="$(wt_latest_immutable_image_for_repo "localhost:5001/omta-api-dev-runtime" || true)"
  wt_worker_image="$(wt_latest_immutable_image_for_repo "localhost:5001/omta-worker-dev-runtime" || true)"
  wt_web_image="$(wt_latest_immutable_image_for_repo "localhost:5001/omta-web-dev-runtime" || true)"
  wt_public_site_image="$(wt_latest_immutable_image_for_repo "localhost:5001/omta-public-site-dev-runtime" || true)"
  wt_gateway_image="$(wt_latest_immutable_image_for_repo "localhost:5001/omta-gateway-dev-runtime" || true)"
  wt_batch_runtime_image="$(wt_latest_immutable_image_for_repo "localhost:5001/omta-agent-batch-runtime" || true)"

  [[ -n "$wt_api_image" ]] || {
    echo "[wt-up] failed to resolve the latest immutable API dev-runtime image after skaffold build." >&2
    exit 1
  }
  [[ -n "$wt_worker_image" ]] || {
    echo "[wt-up] failed to resolve the latest immutable worker dev-runtime image after skaffold build." >&2
    exit 1
  }
  [[ -n "$wt_web_image" ]] || {
    echo "[wt-up] failed to resolve the latest immutable web dev-runtime image after skaffold build." >&2
    exit 1
  }
  [[ -n "$wt_public_site_image" ]] || {
    echo "[wt-up] failed to resolve the latest immutable public-site dev-runtime image after skaffold build." >&2
    exit 1
  }
  [[ -n "$wt_gateway_image" ]] || {
    echo "[wt-up] failed to resolve the latest immutable gateway dev-runtime image after skaffold build." >&2
    exit 1
  }
  [[ -n "$wt_batch_runtime_image" ]] || {
    echo "[wt-up] failed to resolve the latest immutable batch runtime image after skaffold build." >&2
    exit 1
  }

  wt_api_image="$(wt_resolve_kind_image "$wt_api_image")"
  wt_worker_image="$(wt_resolve_kind_image "$wt_worker_image")"
  wt_web_image="$(wt_resolve_kind_image "$wt_web_image")"
  wt_public_site_image="$(wt_resolve_kind_image "$wt_public_site_image")"
  wt_gateway_image="$(wt_resolve_kind_image "$wt_gateway_image")"
  wt_batch_runtime_image="$(wt_resolve_kind_image "$wt_batch_runtime_image")"
}

web_port="$(wt_compute_local_port "$WT_ID_DNS" 13000)"
api_port="$(wt_compute_local_port "$WT_ID_DNS" 14000)"

echo "[wt-up] task=$WT_TASK_ID namespace=$WT_NAMESPACE release=$WT_RELEASE"
echo "[wt-up] shared namespace=$SHARED_NAMESPACE release=$SHARED_RELEASE"
echo "[wt-up] ingress host=$WT_PUBLIC_HOST"

echo "[wt-up] ensuring kind cluster and ingress..."
bash platform/dev/k8s/ensure-cluster.sh

if (( run_shared_up == 1 )); then
  echo "[wt-up] ensuring shared infra release"
  RELEASE_NAME="$SHARED_RELEASE" \
    NAMESPACE="$SHARED_NAMESPACE" \
    WAIT_TIMEOUT="$KUBECTL_ROLLOUT_TIMEOUT" \
    POSTGRES_USER="$POSTGRES_USER" \
    POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    POSTGRES_DB="$POSTGRES_DB" \
    MINIO_ROOT_USER="$MINIO_ROOT_USER" \
    MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
    bash platform/dev/k8s/deps-up.sh
else
  echo "[wt-up] shared infra deploy skipped; validating existing shared infra contract"
  RELEASE_NAME="$SHARED_RELEASE" \
    NAMESPACE="$SHARED_NAMESPACE" \
    WAIT_TIMEOUT="$KUBECTL_ROLLOUT_TIMEOUT" \
    DEPS_VALIDATE_ONLY=1 \
    bash platform/dev/k8s/deps-up.sh
fi

echo "[wt-up] creating namespace $WT_NAMESPACE"
kubectl create namespace "$WT_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

existing_db_password="$(wt_secret_value "$WT_NAMESPACE" "$WT_SECRET_NAME" "DB_PASSWORD")"
if [[ -n "$existing_db_password" ]]; then
  WT_DB_PASSWORD="$existing_db_password"
else
  WT_DB_PASSWORD="$(wt_random_password)"
fi

wt_write_runtime_contract_artifact "$WT_TASK_ID" "$ROOT_DIR/.tmp/worktree-runtime-contract.json"

wt_ensure_shared_data_resources "$WT_TASK_ID" "$WT_DB_PASSWORD" "$MINIO_MC_IMAGE"

wt_database_url="postgresql://$WT_DB_USER:$WT_DB_PASSWORD@$WT_SHARED_POSTGRES_HOST:5432/$WT_DB_NAME"
wt_database_migration_url="postgresql://$WT_SHARED_POSTGRES_ADMIN_USER:$WT_SHARED_POSTGRES_ADMIN_PASSWORD@$WT_SHARED_POSTGRES_HOST:5432/$WT_DB_NAME"

kubectl -n "$WT_NAMESPACE" create secret generic "$WT_SECRET_NAME" \
  --from-literal=DATABASE_URL="$wt_database_url" \
  --from-literal=DATABASE_MIGRATION_URL="$wt_database_url" \
  --from-literal=DB_NAME="$WT_DB_NAME" \
  --from-literal=DB_USER="$WT_DB_USER" \
  --from-literal=DB_PASSWORD="$WT_DB_PASSWORD" \
  --from-literal=SOCKET_REDIS_URL="$WT_SOCKET_REDIS_URL" \
  --from-literal=MINIO_BUCKET="$WT_BUCKET_NAME" \
  --from-literal=MINIO_ENDPOINT="$WT_MINIO_ENDPOINT" \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=COOKIE_SECRET="$COOKIE_SECRET" \
  --from-literal=CSRF_HMAC_KEY="$CSRF_HMAC_KEY" \
  --from-literal=BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  --from-literal=INTERNAL_TOKEN="$INTERNAL_TOKEN" \
  --from-literal=APP_ENCRYPTION_KEY="$APP_ENCRYPTION_KEY" \
  --from-literal=GATEWAY_JWT_SECRET="$GATEWAY_JWT_SECRET" \
  --from-literal=SECRETS_ENCRYPTION_KEY="$SECRETS_ENCRYPTION_KEY" \
  --from-literal=WEBHOOK_HMAC_KEY="$WEBHOOK_HMAC_KEY" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

wt_gateway_jwt_secret_version="$(kubectl -n "$WT_NAMESPACE" get secret "$WT_SECRET_NAME" -o jsonpath='{.metadata.resourceVersion}' 2>/dev/null || true)"
if [[ -z "$wt_gateway_jwt_secret_version" ]]; then
  echo "[wt-up] failed to resolve gateway.jwtSecretVersion from secret ${WT_SECRET_NAME}." >&2
  exit 1
fi

if (( run_db_sync == 1 )); then
  wt_db_migrate_image_resolved="$(wt_resolve_kind_image "$WT_DB_MIGRATE_IMAGE")"
  db_migrate_pod="$(wt_trim_name "wt-db-migrate-$WT_ID_DNS" 63)"
  echo "[wt-up] running db:migrate in-cluster pod ($db_migrate_pod image=$wt_db_migrate_image_resolved)"
  kubectl -n "$WT_NAMESPACE" delete pod "$db_migrate_pod" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$WT_NAMESPACE" run "$db_migrate_pod" \
    --image="$wt_db_migrate_image_resolved" \
    --restart=Never \
    --rm \
    -i \
    --env="DATABASE_URL=$wt_database_migration_url" \
    --env="DATABASE_MIGRATION_URL=$wt_database_migration_url" \
    --command -- sh -ceu "bun run --filter @omta/db db:migrate"
fi

wt_build_worktree_images
wt_runtime_values_path="$ROOT_DIR/.tmp/wt-values-${WT_ID_DNS}.yaml"
bun --silent platform/dev/worktree/render-worktree-values.ts \
  --mode runtime \
  --task-id "$WT_TASK_ID" \
  --namespace "$WT_NAMESPACE" \
  --release "$WT_RELEASE" \
  --secret "$WT_SECRET_NAME" \
  --host "$WT_PUBLIC_HOST" \
  --host-suffix "$WT_HOST_SUFFIX" \
  --shared-namespace "$SHARED_NAMESPACE" \
  --shared-release "$SHARED_RELEASE" \
  --api-image "$wt_api_image" \
  --worker-image "$wt_worker_image" \
  --web-image "$wt_web_image" \
  --public-site-image "$wt_public_site_image" \
  --gateway-image "$wt_gateway_image" \
  --batch-runtime-image "$wt_batch_runtime_image" \
  --gateway-jwt-secret-version "$wt_gateway_jwt_secret_version" \
  --output "$wt_runtime_values_path"

echo "[wt-up] deploying app release"
helm_args=(
  upgrade --install "$WT_RELEASE" platform/runtime/charts/omta
  --namespace "$WT_NAMESPACE"
  --create-namespace
  -f platform/runtime/charts/omta/values.yaml
  -f platform/runtime/charts/omta/values.dev-hotreload.yaml
  -f platform/runtime/charts/omta/values.wt-app.yaml
  -f "$wt_runtime_values_path"
)

helm "${helm_args[@]}"

kubectl rollout status "deploy/omta-api" -n "$WT_NAMESPACE" --timeout="$KUBECTL_ROLLOUT_TIMEOUT"
kubectl rollout status "deploy/omta-web" -n "$WT_NAMESPACE" --timeout="$KUBECTL_ROLLOUT_TIMEOUT"
kubectl rollout status "deploy/omta-worker" -n "$WT_NAMESPACE" --timeout="$KUBECTL_ROLLOUT_TIMEOUT"
kubectl rollout status "deploy/omta-gateway" -n "$WT_NAMESPACE" --timeout="$KUBECTL_ROLLOUT_TIMEOUT"

cat <<MSG
[wt-up] ready.
  task              : $WT_TASK_ID
  namespace/release : $WT_NAMESPACE / $WT_RELEASE
  db                : $WT_DB_NAME (user: $WT_DB_USER)
  minio bucket      : $WT_BUCKET_NAME

Public URL:
  http://$WT_PUBLIC_HOST

Debug port-forward access:
  kubectl -n $WT_NAMESPACE port-forward svc/omta-api $api_port:4000
  kubectl -n $WT_NAMESPACE port-forward svc/omta-web $web_port:3000

DB debug helpers:
  bash platform/dev/worktree/db-psql.sh $WT_TASK_ID
  bash platform/dev/worktree/db-forward.sh --task-id $WT_TASK_ID
MSG
