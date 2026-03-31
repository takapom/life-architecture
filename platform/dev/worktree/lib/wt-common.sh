#!/usr/bin/env bash

WT_COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WT_COMMON_REPO_ROOT="$(cd "$WT_COMMON_DIR/../../../.." && pwd)"
source "$WT_COMMON_DIR/../../k8s/lib/resolve-kubeconfig.sh"
source "$WT_COMMON_DIR/../../shared/git-common.sh"

wt_normalize_dns_token() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  [[ -n "$value" ]] || value="wt"
  printf '%s' "$value"
}

wt_normalize_db_token() {
  local value="$1"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//; s/_+/_/g')"
  [[ -n "$value" ]] || value="wt"
  printf '%s' "$value"
}

wt_trim_name() {
  local value="$1"
  local max_len="$2"
  value="${value:0:max_len}"
  value="$(printf '%s' "$value" | sed -E 's/[-_]+$//')"
  [[ -n "$value" ]] || value="wt"
  printf '%s' "$value"
}

wt_require_binary() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1 || {
    echo "Missing required binary: $bin" >&2
    exit 1
  }
}

wt_runtime_contract_script() {
  printf '%s/platform/dev/worktree/resolve-worktree-runtime-contract.ts' "$WT_COMMON_REPO_ROOT"
}

wt_shared_data_lifecycle_script() {
  printf '%s/platform/dev/worktree/shared-data-lifecycle.ts' "$WT_COMMON_REPO_ROOT"
}

wt_append_arg_if_set() {
  local array_name="$1"
  local flag="$2"
  local value="$3"

  if [[ -n "$value" ]]; then
    # Bash 3.2 (macOS /bin/bash) has no nameref (`local -n`); append via evaluated array name.
    eval "$(printf '%q+=("%q" "%q")' "$array_name" "$flag" "$value")"
  fi
}

wt_append_runtime_contract_args() {
  local array_name="$1"

  wt_append_arg_if_set "$array_name" --namespace "${WT_NAMESPACE:-}"
  wt_append_arg_if_set "$array_name" --release "${WT_RELEASE:-}"
  wt_append_arg_if_set "$array_name" --secret "${WT_SECRET_NAME:-}"
  wt_append_arg_if_set "$array_name" --db-name "${WT_DB_NAME:-}"
  wt_append_arg_if_set "$array_name" --db-user "${WT_DB_USER:-}"
  wt_append_arg_if_set "$array_name" --bucket-name "${WT_BUCKET_NAME:-}"
  wt_append_arg_if_set "$array_name" --host "${WT_PUBLIC_HOST:-}"
  wt_append_arg_if_set "$array_name" --host-suffix "${WT_HOST_SUFFIX:-}"
  wt_append_arg_if_set "$array_name" --shared-namespace "${SHARED_NAMESPACE:-}"
  wt_append_arg_if_set "$array_name" --shared-release "${SHARED_RELEASE:-}"
}

wt_kubeconfig_default_path() {
  local root_dir="$1"
  local cluster_name="${CLUSTER_NAME:-omta}"
  printf '%s/.tmp/kubeconfig-%s' "$root_dir" "$cluster_name"
}

wt_resolve_kubeconfig_path() {
  local root_dir="$1"
  k8s_resolve_kubeconfig_path "$root_dir"
}

wt_validate_kubeconfig_path() {
  local resolved="$1"
  local segment=""

  if [[ -z "$resolved" ]]; then
    echo "[wt-kubeconfig] resolved kubeconfig path is empty." >&2
    return 1
  fi

  IFS=':' read -r -a segments <<< "$resolved"
  for segment in "${segments[@]}"; do
    [[ -n "$segment" ]] || continue
    if [[ ! -f "$segment" ]]; then
      echo "[wt-kubeconfig] kubeconfig file not found: $segment" >&2
      return 1
    fi
  done
}

wt_refresh_default_kubeconfig_if_stale() {
  local root_dir="$1"
  local resolved="$2"
  local default_path="$3"
  local cluster_name="${CLUSTER_NAME:-omta}"

  [[ "$resolved" == "$default_path" ]] || return 0

  if ! command -v kubectl >/dev/null 2>&1 || ! command -v kind >/dev/null 2>&1; then
    return 0
  fi

  if kubectl --kubeconfig "$default_path" cluster-info >/dev/null 2>&1; then
    return 0
  fi

  if ! kind get clusters 2>/dev/null | grep -q "^${cluster_name}$"; then
    return 0
  fi

  echo "[wt-kubeconfig] refreshing stale worktree-local kubeconfig: $default_path" >&2
  mkdir -p "$(dirname "$default_path")"
  if ! kind export kubeconfig --name "$cluster_name" --kubeconfig "$default_path" >/dev/null 2>&1; then
    return 0
  fi

  if ! kubectl --kubeconfig "$default_path" cluster-info >/dev/null 2>&1; then
    return 0
  fi

  echo "[wt-kubeconfig] refreshed worktree-local kubeconfig from kind cluster '$cluster_name'." >&2
}

wt_require_kubeconfig_path() {
  local root_dir="$1"
  local resolved default_path
  resolved="$(wt_resolve_kubeconfig_path "$root_dir")" || return 1
  default_path="$(wt_kubeconfig_default_path "$root_dir")"

  if ! wt_validate_kubeconfig_path "$resolved"; then
    if [[ -n "${OMTA_KUBECONFIG_PATH:-}" ]]; then
      echo "[wt-kubeconfig] Fix OMTA_KUBECONFIG_PATH or unset it before retrying." >&2
      return 1
    fi

    if k8s_bool_true "${OMTA_K8S_USE_EXTERNAL_KUBECONFIG:-false}"; then
      echo "[wt-kubeconfig] OMTA_K8S_USE_EXTERNAL_KUBECONFIG=true requires a valid external KUBECONFIG." >&2
      return 1
    fi

    echo "[wt-kubeconfig] Missing worktree-local kubeconfig: $default_path" >&2
    echo "[wt-kubeconfig] Run 'bun run k8s:up' in this worktree to mint it, or set OMTA_KUBECONFIG_PATH for explicit shared-cluster access." >&2
    return 1
  fi

  if [[ -z "${OMTA_KUBECONFIG_PATH:-}" ]] && ! k8s_bool_true "${OMTA_K8S_USE_EXTERNAL_KUBECONFIG:-false}"; then
    wt_refresh_default_kubeconfig_if_stale "$root_dir" "$resolved" "$default_path"
  fi

  printf '%s' "$resolved"
}

wt_load_env_defaults() {
  local root_dir="$1"
  source "$root_dir/platform/dev/local/lib/load-env-defaults.sh"
  load_local_env_defaults "$root_dir"
}

wt_secret_value() {
  local namespace="$1"
  local secret_name="$2"
  local key="$3"
  kubectl -n "$namespace" get secret "$secret_name" -o "go-template={{ index .data \"$key\" | base64decode }}" 2>/dev/null || true
}

wt_random_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32
    echo
    return
  fi

  # Fallback when openssl is unavailable.
  date +%s%N | shasum | awk '{print substr($1,1,32)}'
}

wt_compute_local_port() {
  local id="$1"
  local base_port="${2:-15432}"
  local slot
  slot="$(printf '%s' "$id" | cksum | awk '{print $1 % 200}')"
  printf '%s' "$((base_port + slot))"
}

wt_wait_for_local_port() {
  local port="$1"
  local retries="${2:-60}"
  local i
  for ((i = 0; i < retries; i++)); do
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wt_wait_for_local_port_with_pid() {
  local port="$1"
  local pid="$2"
  local retries="${3:-60}"
  local settle_seconds="${4:-1}"
  local i
  for ((i = 0; i < retries; i++)); do
    if ! kill -0 "$pid" >/dev/null 2>&1; then
      return 2
    fi

    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      # Guard against race where another process already binds the port and
      # port-forward exits moments later (e.g. address already in use).
      sleep "$settle_seconds"
      if kill -0 "$pid" >/dev/null 2>&1; then
        if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
          return 0
        fi
        continue
      fi
      return 2
    fi

    sleep 1
  done
  return 1
}

wt_find_available_local_port() {
  local start_port="$1"
  local max_tries="${2:-200}"
  local port="$start_port"
  local i

  for ((i = 0; i < max_tries; i++)); do
    if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
      printf '%s' "$port"
      return 0
    fi
    port=$((port + 1))
    if (( port > 65535 )); then
      port=1024
    fi
  done

  return 1
}

wt_derive_context() {
  local task_id="$1"
  local resolver rendered
  local -a args

  wt_require_binary bun
  resolver="$(wt_runtime_contract_script)"
  args=(--task-id "$task_id" --format shell)
  wt_append_runtime_contract_args args
  rendered="$(bun --silent "$resolver" "${args[@]}")" || return 1
  eval "$rendered"
  export WT_TASK_ID WT_ID_DNS WT_ID_DB
  export WT_NAMESPACE WT_RELEASE WT_SECRET_NAME
  export WT_DB_NAME WT_DB_USER WT_BUCKET_NAME WT_PUBLIC_HOST WT_HOST_SUFFIX
  export SHARED_NAMESPACE SHARED_RELEASE SHARED_POSTGRES_SERVICE SHARED_MINIO_SERVICE SHARED_REDIS_SERVICE SHARED_TEMPORAL_SERVICE
  export WT_SHARED_POSTGRES_HOST WT_SHARED_MINIO_HOST WT_SHARED_REDIS_HOST
  export WT_TEMPORAL_ADDRESS WT_API_BASE_URL WT_WEB_ORIGIN_URL WT_SOCKET_REDIS_URL WT_MINIO_ENDPOINT
}

wt_write_runtime_contract_artifact() {
  local task_id="$1"
  local output_path="$2"
  local resolver
  local -a args

  wt_require_binary bun
  resolver="$(wt_runtime_contract_script)"
  mkdir -p "$(dirname "$output_path")"
  args=(--task-id "$task_id" --output "$output_path")
  wt_append_runtime_contract_args args
  bun --silent "$resolver" "${args[@]}"
}

wt_ensure_shared_data_resources() {
  local task_id="$1"
  local db_password="$2"
  local minio_mc_image="$3"
  local rendered
  local script
  local -a args

  wt_require_binary bun
  script="$(wt_shared_data_lifecycle_script)"
  args=(
    ensure
    --format shell
    --task-id "$task_id"
    --namespace "$WT_NAMESPACE"
    --secret "$WT_SECRET_NAME"
    --db-name "$WT_DB_NAME"
    --db-user "$WT_DB_USER"
    --db-password "$db_password"
    --bucket-name "$WT_BUCKET_NAME"
    --shared-namespace "$SHARED_NAMESPACE"
    --shared-release "$SHARED_RELEASE"
    --minio-mc-image "$minio_mc_image"
  )
  rendered="$(bun --silent "$script" "${args[@]}")" || return 1
  eval "$rendered"
  export WT_SHARED_POSTGRES_ADMIN_USER WT_SHARED_POSTGRES_ADMIN_PASSWORD
}

wt_purge_shared_data_resources() {
  local task_id="$1"
  local minio_mc_image="$2"
  local script
  local -a args

  wt_require_binary bun
  script="$(wt_shared_data_lifecycle_script)"
  args=(
    purge
    --task-id "$task_id"
    --namespace "$WT_NAMESPACE"
    --secret "$WT_SECRET_NAME"
    --db-name "$WT_DB_NAME"
    --db-user "$WT_DB_USER"
    --bucket-name "$WT_BUCKET_NAME"
    --shared-namespace "$SHARED_NAMESPACE"
    --shared-release "$SHARED_RELEASE"
    --minio-mc-image "$minio_mc_image"
  )
  bun --silent "$script" "${args[@]}"
}
