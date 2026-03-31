#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: platform/dev/worktree/test.sh [TASK_ID] [options] [-- <test command...>]

Run tests with a run-scoped DATABASE_URL while keeping host/port fixed.

Options:
  --task-id <id>              Task/worktree id (default: first arg or current directory name)
  --db-scope <scope>          Logical suite scope (default: auto-detected from command)
  --run-id <id>               Run identifier for DB isolation (default: timestamp+pid+random)
  --dry-run                   Print resolved DATABASE_URL/DB name and command without executing
  --no-db-sync                Skip `bun run db:migrate` before test command
  --drop-db-after             Drop the scoped database after command completion (default)
  --keep-db                   Keep scoped database after command completion
  -h, --help                  Show help

Environment:
  OMTA_TEST_RUN_ID            Overrides generated run id

Examples:
  platform/dev/worktree/test.sh OPS-1312
  platform/dev/worktree/test.sh OPS-1312 -- bun run --filter @omta/api test:integration:raw
  platform/dev/worktree/test.sh --task-id OPS-1312 --db-scope api --dry-run
USAGE
}

is_truthy() {
  local value
  value="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

task_id=""
db_scope=""
run_id="${OMTA_TEST_RUN_ID:-}"
dry_run=0
run_db_sync=1
drop_db_after=1
cmd=()

if is_truthy "${OMTA_ALLOW_DB_PUSH_RESET:-false}"; then
  echo "[wt-test] OMTA_ALLOW_DB_PUSH_RESET is retired; run-scoped test DBs already recreate from scratch." >&2
  exit 2
fi

if (($# == 0)); then
  task_id="$(basename "$PWD")"
fi

while (($#)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --task-id)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --task-id" >&2
        exit 2
      }
      task_id="$2"
      shift 2
      ;;
    --db-scope)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --db-scope" >&2
        exit 2
      }
      db_scope="$2"
      shift 2
      ;;
    --run-id)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --run-id" >&2
        exit 2
      }
      run_id="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --no-db-sync)
      run_db_sync=0
      shift
      ;;
    --drop-db-after)
      drop_db_after=1
      shift
      ;;
    --keep-db)
      drop_db_after=0
      shift
      ;;
    --allow-db-push-reset)
      echo "[wt-test] --allow-db-push-reset is retired; run-scoped test DBs already recreate from scratch." >&2
      exit 2
      ;;
    --)
      shift
      cmd=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$task_id" ]]; then
        task_id="$1"
        shift
      else
        cmd=("$@")
        break
      fi
      ;;
  esac
done

[[ -n "$task_id" ]] || {
  echo "TASK_ID is required (provide first arg or --task-id)." >&2
  usage >&2
  exit 2
}

if ((${#cmd[@]} == 0)); then
  cmd=("bun" "run" "test")
fi

if [[ -z "$db_scope" ]]; then
  cmd_text="${cmd[*]}"
  if [[ "$cmd_text" == *"apps/api"* ]]; then
    db_scope="api"
  elif [[ "$cmd_text" == *"apps/worker"* ]]; then
    db_scope="worker"
  else
    db_scope="test"
  fi
fi

if [[ -z "$run_id" ]]; then
  run_id="$(date +%Y%m%d%H%M%S)-$$-${RANDOM}"
fi

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root_dir"

source "$root_dir/platform/dev/worktree/lib/wt-common.sh"

db_lock_timeout_ms="${DB_LOCK_TIMEOUT_MS:-30000}"
db_statement_timeout_ms="${DB_STATEMENT_TIMEOUT_MS:-120000}"
temp_forward_pid=""
temp_forward_log=""

wt_load_env_defaults "$root_dir"
KUBECONFIG="$(wt_require_kubeconfig_path "$root_dir")"
export KUBECONFIG

wt_require_binary kubectl
wt_require_binary nc
wt_require_binary bun
wt_require_binary psql

wt_derive_context "$task_id"

forward_port="${WT_TEST_DB_FORWARD_PORT:-$(wt_compute_local_port "$WT_ID_DNS" 15432)}"
if nc -z 127.0.0.1 "$forward_port" >/dev/null 2>&1; then
  resolved_forward_port="$(wt_find_available_local_port "$forward_port")" || {
    echo "[wt-test] unable to find an available local port for shared Postgres forwarding." >&2
    exit 1
  }
  forward_port="$resolved_forward_port"
fi

db_meta=()
while IFS= read -r line; do
  db_meta+=("$line")
done < <(
  bun -e '
const user = process.argv[1];
const password = process.argv[2];
const port = process.argv[3];
const database = process.argv[4];
const adminDatabase = process.argv[5];
const baseUrl = new URL("postgresql://placeholder");
baseUrl.username = user;
baseUrl.password = password;
baseUrl.hostname = "127.0.0.1";
baseUrl.port = port;
baseUrl.pathname = `/${database}`;
const adminUrl = new URL(baseUrl.toString());
adminUrl.pathname = `/${adminDatabase}`;
console.log(baseUrl.toString());
console.log(adminUrl.toString());
' "${POSTGRES_USER:-postgres}" "${POSTGRES_PASSWORD:-postgres}" "$forward_port" "$WT_DB_NAME" "${POSTGRES_ADMIN_DATABASE:-postgres}"
)

database_url="${db_meta[0]:-}"
admin_database_url="${db_meta[1]:-}"

[[ -n "$database_url" && -n "$admin_database_url" ]] || {
  echo "[wt-test] failed to resolve runtime-contract DATABASE_URL." >&2
  exit 1
}

db_meta=()
while IFS= read -r line; do
  db_meta+=("$line")
done < <(
  bun -e '
const baseUrl = process.argv[1];
const taskId = process.argv[2];
const dbScope = process.argv[3];
const runId = process.argv[4];
let parsed;
try {
  parsed = new URL(baseUrl);
} catch {
  console.error("Invalid DATABASE_URL:", baseUrl);
  process.exit(1);
}
const normalize = (value, fallback) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || fallback;
const rawDb = parsed.pathname.replace(/^\/+/, "") || "app";
const normalizedDbBase = normalize(rawDb, "app");
const normalizedTask = normalize(taskId, "default");
const normalizedScope = normalize(dbScope, "test");
const normalizedRun = normalize(runId, "run");
const maxLen = 63;
let dbName = `${normalizedDbBase}_wt_${normalizedTask}_${normalizedScope}_${normalizedRun}`;
if (dbName.length > maxLen) dbName = dbName.slice(0, maxLen);
dbName = dbName.replace(/_+$/g, "") || "app_wt_default_test_run";
const worktreeUrl = new URL(parsed.toString());
worktreeUrl.pathname = `/${dbName}`;
const adminUrl = new URL(parsed.toString());
adminUrl.pathname = "/postgres";
console.log(dbName);
console.log(worktreeUrl.toString());
console.log(adminUrl.toString());
' "$database_url" "$task_id" "$db_scope" "$run_id"
)

db_name="${db_meta[0]:-}"
worktree_database_url="${db_meta[1]:-}"
scoped_admin_database_url="${db_meta[2]:-}"

[[ -n "$db_name" && -n "$worktree_database_url" && -n "$scoped_admin_database_url" ]] || {
  echo "Failed to resolve worktree DATABASE_URL." >&2
  exit 1
}

echo "[wt-test] task_id=${task_id}"
echo "[wt-test] db_scope=${db_scope}"
echo "[wt-test] run_id=${run_id}"
echo "[wt-test] db_name=${db_name}"
echo "[wt-test] database_url=${worktree_database_url}"
echo "[wt-test] db_lock_timeout_ms=${db_lock_timeout_ms}"
echo "[wt-test] db_statement_timeout_ms=${db_statement_timeout_ms}"
echo "[wt-test] command=${cmd[*]}"

if ((dry_run == 1)); then
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required for run-scoped DB provisioning." >&2
  exit 1
fi

temp_forward_log="/tmp/wt-test-db-forward-${WT_ID_DNS}-${run_id}.log"
bash "$root_dir/platform/dev/worktree/db-forward.sh" \
  --task-id "$WT_TASK_ID" \
  --local-port "$forward_port" \
  --shared-namespace "$SHARED_NAMESPACE" >"$temp_forward_log" 2>&1 &
temp_forward_pid=$!

wait_status=0
wt_wait_for_local_port_with_pid "$forward_port" "$temp_forward_pid" 60 || wait_status=$?
if ((wait_status != 0)); then
  if [[ "$wait_status" -eq 2 ]]; then
    echo "[wt-test] temporary DB port-forward exited before becoming ready ($forward_port)." >&2
  else
    echo "[wt-test] timed out waiting for temporary DB port-forward ($forward_port)." >&2
  fi
  cat "$temp_forward_log" >&2 || true
  if [[ -n "$temp_forward_pid" ]] && kill -0 "$temp_forward_pid" >/dev/null 2>&1; then
    kill "$temp_forward_pid" >/dev/null 2>&1 || true
    wait "$temp_forward_pid" >/dev/null 2>&1 || true
  fi
  exit 1
fi

escaped_db_name_literal="${db_name//\'/''}"
escaped_db_name="${db_name//\"/\"\"}"

cleanup_db() {
  if ((drop_db_after != 1)); then
    :
  else
    echo "[wt-test] dropping database ${db_name}"
    psql "$scoped_admin_database_url" \
      -v ON_ERROR_STOP=1 \
      -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${escaped_db_name_literal}' and pid <> pg_backend_pid();" \
      -c "drop database if exists \"${escaped_db_name}\"" \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "$temp_forward_pid" ]] && kill -0 "$temp_forward_pid" >/dev/null 2>&1; then
    kill "$temp_forward_pid" >/dev/null 2>&1 || true
    wait "$temp_forward_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup_db EXIT

echo "[wt-test] recreating isolated database ${db_name}"
psql "$scoped_admin_database_url" \
  -v ON_ERROR_STOP=1 \
  -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${escaped_db_name_literal}' and pid <> pg_backend_pid();" \
  -c "drop database if exists \"${escaped_db_name}\"" \
  -c "create database \"${escaped_db_name}\"" \
  >/dev/null

if ((run_db_sync == 1)); then
  echo "[wt-test] running bun run db:migrate"
  set +e
  DATABASE_URL="$worktree_database_url" \
    DB_LOCK_TIMEOUT_MS="$db_lock_timeout_ms" \
    DB_STATEMENT_TIMEOUT_MS="$db_statement_timeout_ms" \
    bun run db:migrate
  db_migrate_status=$?
  set -e
  if ((db_migrate_status != 0)); then
    echo "[wt-test] db:migrate failed after recreating the run-scoped database; fix migrations and retry." >&2
    exit "$db_migrate_status"
  fi
fi

set +e
OMTA_TEST_DATABASE_URL="$worktree_database_url" \
OMTA_TEST_RUN_ID="$run_id" \
DATABASE_URL="$worktree_database_url" \
  DB_LOCK_TIMEOUT_MS="$db_lock_timeout_ms" \
  DB_STATEMENT_TIMEOUT_MS="$db_statement_timeout_ms" \
  "${cmd[@]}"
cmd_status=$?
set -e

exit "$cmd_status"
