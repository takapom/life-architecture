#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: platform/dev/worktree/db-forward.sh [options]

Temporarily forward shared Postgres service to localhost.

Options:
  --local-port <port>          Local port to bind (default: derived from cwd task id)
  --task-id <id>               Task/worktree id for deterministic local port
  --shared-namespace <name>    Shared infra namespace (default: omta-shared)
  -h, --help                   Show help
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/platform/dev/worktree/lib/wt-common.sh"

KUBECONFIG="$(wt_require_kubeconfig_path "$ROOT_DIR")"
export KUBECONFIG

wt_require_binary kubectl
wt_require_binary nc

task_id="$(basename "$PWD")"
local_port=""

while (($#)); do
  case "$1" in
    --local-port)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --local-port" >&2
        exit 2
      }
      local_port="$2"
      shift 2
      ;;
    --task-id)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --task-id" >&2
        exit 2
      }
      task_id="$2"
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
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

wt_derive_context "$task_id"

if [[ -z "$local_port" ]]; then
  local_port="$(wt_compute_local_port "$WT_ID_DNS" 15432)"
fi

echo "[wt-db-forward] namespace=$SHARED_NAMESPACE service=$SHARED_POSTGRES_SERVICE local_port=$local_port"
exec kubectl -n "$SHARED_NAMESPACE" port-forward "svc/$SHARED_POSTGRES_SERVICE" "$local_port:5432"
