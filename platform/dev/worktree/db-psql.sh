#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: platform/dev/worktree/db-psql.sh [TASK_ID] [options] [-- <psql args...>]

Open psql for a worktree-scoped database via temporary port-forward.

Options:
  --task-id <id>               Task/worktree id (default: first arg or cwd basename)
  --local-port <port>          Local forwarded port (default: derived from task id)
  --namespace <name>           Worktree namespace override
  --secret <name>              Secret containing DB credentials (default: omta-wt-env)
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
wt_require_binary psql

task_id=""
local_port=""
psql_args=()

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
    --local-port)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --local-port" >&2
        exit 2
      }
      local_port="$2"
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
    --)
      shift
      psql_args=("$@")
      break
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
        psql_args=("$@")
        break
      fi
      ;;
  esac
done

[[ -n "$task_id" ]] || {
  echo "TASK_ID is required." >&2
  usage >&2
  exit 2
}

wt_derive_context "$task_id"

if [[ -z "$local_port" ]]; then
  local_port="$(wt_compute_local_port "$WT_ID_DNS" 15432)"
fi

db_password="$(wt_secret_value "$WT_NAMESPACE" "$WT_SECRET_NAME" "DB_PASSWORD")"

[[ -n "$db_password" ]] || {
  echo "Missing DB_PASSWORD in secret $WT_SECRET_NAME (namespace $WT_NAMESPACE). Run platform/dev/worktree/up.sh first." >&2
  exit 1
}

bash "$ROOT_DIR/platform/dev/worktree/db-forward.sh" \
  --task-id "$task_id" \
  --local-port "$local_port" \
  --shared-namespace "$SHARED_NAMESPACE" >/tmp/wt-db-forward-${WT_ID_DNS}.log 2>&1 &
forward_pid=$!

cleanup() {
  if kill -0 "$forward_pid" >/dev/null 2>&1; then
    kill "$forward_pid" >/dev/null 2>&1 || true
    wait "$forward_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

wait_status=0
wt_wait_for_local_port_with_pid "$local_port" "$forward_pid" 60 || wait_status=$?
if (( wait_status != 0 )); then
  if [[ "$wait_status" -eq 2 ]]; then
    echo "Local port-forward process exited before becoming ready on $local_port" >&2
  else
    echo "Timed out waiting for local port-forward on $local_port" >&2
  fi
  cat /tmp/wt-db-forward-${WT_ID_DNS}.log >&2 || true
  exit 1
fi

echo "[wt-db-psql] connecting task=$task_id namespace=$WT_NAMESPACE db=$WT_DB_NAME user=$WT_DB_USER local_port=$local_port"
PGPASSWORD="$db_password" psql "postgresql://$WT_DB_USER@127.0.0.1:$local_port/$WT_DB_NAME" "${psql_args[@]}"
