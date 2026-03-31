#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bun run wt:start -- --task-id <TASK_ID> --slug <short-title> [options]
  bun run wt:start -- --task-id <TASK_ID> --branch <task/...> [options]

Options:
  --task-id <value>       Task ID (required, e.g. OPS-269104)
  --slug <value>          Branch slug used with --task-id (required when --branch is omitted)
  --branch <value>        Explicit branch name (must start with task/)
  --worktree <path>       Worktree path (default: <repo>/../wt/<TASK_ID>, must be a direct child of <repo>/../wt)
  --main-worktree <path>  Main branch worktree path (default: auto-detect branch=main worktree)
  --dry-run               Print planned commands without mutating git state
  --help                  Show this help
USAGE
}

fail() {
  echo "[wt-start] ERROR: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_START_HELPER_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$SCRIPT_DIR/../shared/git-common.sh"

to_absolute_path() {
  local repo_root="$1"
  local raw="$2"
  if [[ "$raw" == /* ]]; then
    printf '%s\n' "$raw"
  else
    printf '%s\n' "$repo_root/$raw"
  fi
}

resolve_allowed_worktree_root() {
  local repo_root="$1"
  canonical_path "$repo_root/../wt"
}

ensure_worktree_path_policy() {
  local repo_root="$1"
  local candidate_path="$2"
  local expected_task_id="${3:-}"
  local allowed_root
  allowed_root="$(resolve_allowed_worktree_root "$repo_root")"
  case "$candidate_path" in
    "$allowed_root"/*) ;;
    *)
      fail "worktree path must be under $allowed_root: $candidate_path"
      ;;
  esac

  if [[ "$(dirname "$candidate_path")" != "$allowed_root" ]]; then
    fail \
      "canonical human task worktrees must be direct children of $allowed_root; received $candidate_path"
  fi

  if [[ -n "$expected_task_id" ]]; then
    local candidate_basename
    candidate_basename="$(basename "$candidate_path")"
    if [[ "$candidate_basename" != "$expected_task_id" ]]; then
      fail \
        "canonical human task worktree basename must equal task id $expected_task_id under $allowed_root; received $candidate_path"
    fi
  fi
}

sanitize_slug() {
  local raw="${1:-}"
  printf '%s' "$raw" |
    tr '[:upper:]' '[:lower:]' |
    sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-{2,}/-/g'
}

extract_task_id_from_branch_name() {
  local branch="${1:-}"
  if [[ "$branch" =~ ^task/(([A-Za-z0-9]+-)*[0-9]{3,}[A-Za-z]?)(-.+)?$ ]]; then
    local task_id="${BASH_REMATCH[1]}"
    local stem="$task_id"
    local suffix=""
    if [[ "$task_id" =~ ^(.+-[0-9]{3,})([A-Za-z])$ ]]; then
      stem="${BASH_REMATCH[1]}"
      suffix="${BASH_REMATCH[2]}"
    fi
    printf '%s%s\n' "$(printf '%s' "$stem" | tr '[:lower:]' '[:upper:]')" "$suffix"
    return 0
  fi
  return 1
}

ensure_clean_worktree() {
  local repo_path="$1"
  local label="$2"
  local dirty
  dirty="$(git -C "$repo_path" status --porcelain)"
  if [[ -n "$dirty" ]]; then
    fail "$label is dirty. Commit/stash changes before creating a new task worktree."
  fi
}

ensure_branch_not_checked_out() {
  local repo_root="$1"
  local branch="$2"
  local branch_ref="refs/heads/$branch"
  local worktree_path=""
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then
      worktree_path=""
      continue
    fi
    case "$line" in
      worktree\ *)
        worktree_path="${line#worktree }"
        ;;
      branch\ *)
        if [[ "${line#branch }" == "$branch_ref" ]]; then
          fail "branch is already checked out in another worktree: $(canonical_path "$worktree_path")"
        fi
        ;;
    esac
  done < <(git -C "$repo_root" worktree list --porcelain)
}

run_repoctl_task_worktree() {
  local repo_root="$1"
  shift
  local helper="$TASK_START_HELPER_ROOT/tools/repoctl/task-worktree.ts"
  [[ -f "$helper" ]] || fail "repoctl task worktree helper is missing: $helper"
  local command="$1"
  shift
  bun --silent "$helper" "$command" --repo-root "$repo_root" "$@"
}

run_task_session_helper() {
  local repo_root="$1"
  shift
  local helper="$TASK_START_HELPER_ROOT/platform/dev/worktree/task-session.ts"
  [[ -f "$helper" ]] || fail "task session helper is missing: $helper"
  local command="$1"
  shift
  bun --silent "$helper" "$command" --repo-root "$repo_root" "$@"
}

delete_main_equal_stale_branch() {
  local repo_root="$1"
  local main_worktree="$2"
  local branch="$3"
  run_repoctl_task_worktree \
    "$repo_root" \
    delete-main-equal-stale-branch \
    --main-worktree "$main_worktree" \
    --branch "$branch"
}

reconcile_task_worktree_start() {
  local repo_root="$1"
  local main_worktree="$2"
  local worktree_path="$3"
  local task_id="$4"
  local branch="$5"
  run_repoctl_task_worktree \
    "$repo_root" \
    reconcile-task-worktree \
    --main-worktree "$main_worktree" \
    --worktree-path "$worktree_path" \
    --task-id "$task_id" \
    --branch "$branch"
}

list_local_task_branches_for_task_id() {
  local repo_root="$1"
  local task_id="$2"
  git -C "$repo_root" for-each-ref --format='%(refname:short)' refs/heads/task |
    while IFS= read -r branch; do
      [[ -n "$branch" ]] || continue
      local branch_task_id=""
      branch_task_id="$(extract_task_id_from_branch_name "$branch" || true)"
      [[ "$branch_task_id" == "$task_id" ]] || continue
      printf '%s\n' "$branch"
    done
}

list_remote_task_branches_for_task_id() {
  local repo_root="$1"
  local task_id="$2"
  local output=""

  output="$(
    run_git_with_repo_auth "$repo_root" origin \
      git -C "$repo_root" ls-remote --heads origin 'refs/heads/task/*'
  )"

  printf '%s\n' "$output" |
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      local ref=""
      ref="$(printf '%s' "$line" | awk '{print $2}')"
      [[ "$ref" == refs/heads/task/* ]] || continue
      local branch="${ref#refs/heads/}"
      local branch_task_id=""
      branch_task_id="$(extract_task_id_from_branch_name "$branch" || true)"
      [[ "$branch_task_id" == "$task_id" ]] || continue
      printf '%s\n' "$branch"
    done
}

ensure_task_id_has_no_duplicate_branch_surface() {
  local repo_root="$1"
  local task_id="$2"
  local branch="$3"
  local local_duplicates=()
  local remote_duplicates=()

  while IFS= read -r existing_branch; do
    [[ -n "$existing_branch" && "$existing_branch" != "$branch" ]] || continue
    local_duplicates+=("$existing_branch")
  done < <(list_local_task_branches_for_task_id "$repo_root" "$task_id")

  while IFS= read -r existing_branch; do
    [[ -n "$existing_branch" && "$existing_branch" != "$branch" ]] || continue
    remote_duplicates+=("$existing_branch")
  done < <(list_remote_task_branches_for_task_id "$repo_root" "$task_id")

  if (( ${#local_duplicates[@]} == 0 && ${#remote_duplicates[@]} == 0 )); then
    return 0
  fi

  echo "[wt-start] ERROR: task $task_id already has another branch/worktree publish surface." >&2
  if (( ${#local_duplicates[@]} > 0 )); then
    printf '[wt-start] local duplicates: %s\n' "${local_duplicates[*]}" >&2
  fi
  if (( ${#remote_duplicates[@]} > 0 )); then
    printf '[wt-start] remote duplicates: %s\n' "${remote_duplicates[*]}" >&2
  fi
  echo "[wt-start] Collapse duplicate task surfaces before creating a new worktree." >&2
  exit 1
}

resolve_repository_from_origin() {
  local repo_root="$1"
  local origin=""

  origin="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
  [[ -n "$origin" ]] || fail "origin remote is required to resolve <owner>/<repo>"

  case "$origin" in
    git@github.com:*)
      origin="${origin#git@github.com:}"
      ;;
    https://github.com/*)
      origin="${origin#https://github.com/}"
      ;;
    ssh://git@github.com/*)
      origin="${origin#ssh://git@github.com/}"
      ;;
    *)
      fail "unsupported GitHub origin URL: $origin"
      ;;
  esac

  origin="${origin%.git}"
  if ! [[ "$origin" =~ ^[^/]+/[^/]+$ ]]; then
    fail "failed to resolve <owner>/<repo> from origin: $origin"
  fi

  printf '%s\n' "$origin"
}

run_git_with_repo_auth() {
  local target_repo_root="$1"
  local remote_name="$2"
  shift 2

  bun --silent "$target_repo_root/tools/orchestrator/pr/git-remote-auth.ts" --repo-root "$target_repo_root" --remote "$remote_name" -- "$@"
}

remote_branch_exists() {
  local repo_root="$1"
  local remote_name="$2"
  local branch="$3"
  local output=""

  output="$(
    run_git_with_repo_auth "$repo_root" "$remote_name" \
      git -C "$repo_root" ls-remote --heads "$remote_name" "$branch"
  )"
  [[ -n "$output" ]]
}

recover_existing_task_worktree_path() {
  local repo_root="$1"
  local worktree_path="$2"
  local task_id="$3"
  run_repoctl_task_worktree \
    "$repo_root" \
    recover-existing-task-worktree-path \
    --worktree-path "$worktree_path" \
    --task-id "$task_id"
}

exact_sync_main_worktree() {
  local main_worktree="$1"
  local expected_branch="main"
  local current_branch=""
  local ahead_count="0"
  local behind_count="0"

  current_branch="$(git -C "$main_worktree" branch --show-current)"
  if [[ "$current_branch" != "$expected_branch" ]]; then
    fail "main worktree must be on ${expected_branch} before exact sync: ${main_worktree} (current=${current_branch:-detached})"
  fi

  run_git_with_repo_auth "$main_worktree" origin git -C "$main_worktree" fetch origin --prune

  if ! git -C "$main_worktree" rev-parse --verify --quiet origin/main >/dev/null; then
    fail "origin/main is missing after fetch for main worktree: $main_worktree"
  fi

  read -r ahead_count behind_count <<<"$(git -C "$main_worktree" rev-list --left-right --count main...origin/main)"
  if [[ "$ahead_count" != "0" ]]; then
    fail "main worktree is ahead or diverged from origin/main and cannot be exact-synced safely: $main_worktree"
  fi

  git -C "$main_worktree" reset --hard origin/main >/dev/null
}

run_task_start_scope_preflight() {
  local repo_root="$1"
  local task_id="$2"
  local branch="$3"
  local task_issue_source="${4:-}"
  local repository=""
  repository="$(resolve_repository_from_origin "$repo_root")"

  local certify_task_sizing_cmd=(
    bun
    tools/orchestrator/task/certify-task-sizing.ts
    --repository
    "$repository"
    --repo-root
    "$repo_root"
    --branch
    "$branch"
    --task-id
    "$task_id"
    --include-overlapping-live-tasks
  )
  local write_task_scope_manifest_cmd=(
    bun
    run
    task:scope:write-manifest
    --
    --repo-root
    "$repo_root"
    --branch
    "$branch"
    --task-id
    "$task_id"
    --repository
    "$repository"
    --check-worktree-conflicts
  )
  local ensure_task_issue_cmd=(bun run task:ensure -- --task-id "$task_id" --branch "$branch" --write-marker)
  if [[ -n "$task_issue_source" ]]; then
    local certify_task_sizing_source
    certify_task_sizing_source="$(to_absolute_path "$repo_root" "$task_issue_source")"
    ensure_task_issue_cmd+=(--source "$certify_task_sizing_source")
    certify_task_sizing_cmd+=(--source "$certify_task_sizing_source")
    write_task_scope_manifest_cmd+=(--source "$certify_task_sizing_source")
  fi

  "${ensure_task_issue_cmd[@]}"
  "${write_task_scope_manifest_cmd[@]}"
  "${certify_task_sizing_cmd[@]}"
}

run_task_start_residue_cleanup_preflight() {
  local repo_root="$1"
  local repository="$2"
  local task_id="$3"
  local branch="$4"
  local task_issue_source="${5:-}"

  local cleanup_cmd=(
    bun
    run
    wt:cleanup:stale-task-worktrees
    --
    --repo-root
    "$repo_root"
    --apply
  )
  local steady_state_cmd=(
    bun
    run
    check:task-pr-steady-state
    --
    --repo-root
    "$repo_root"
    --repository
    "$repository"
    --task-id
    "$task_id"
    --startup-admission
    --task-branch
    "$branch"
  )

  if [[ -z "$task_issue_source" ]]; then
    bun run task:ensure -- \
      --task-id "$task_id" \
      --branch "$branch" \
      --repository "$repository" \
      --write-marker \
      --allow-closed-task-issue
  fi

  if [[ -n "$task_issue_source" ]]; then
    local source_path
    source_path="$(to_absolute_path "$repo_root" "$task_issue_source")"
    cleanup_cmd+=(--source "$source_path")
    steady_state_cmd+=(--source "$source_path")
  fi

  local cleanup_output=""
  local cleanup_status=0
  cleanup_output="$("${cleanup_cmd[@]}" 2>&1)" || cleanup_status=$?
  if (( cleanup_status != 0 )); then
    if [[ "$cleanup_output" == *"API rate limit exceeded"* && "$cleanup_output" == *"/pulls"* ]]; then
      printf '%s\n' "[wt-start] WARN: stale cleanup canonical PR lookup was rate-limited; continuing with degraded scoped startup preflight" >&2
      [[ -n "$cleanup_output" ]] && printf '%s\n' "$cleanup_output" >&2
    else
      [[ -n "$cleanup_output" ]] && printf '%s\n' "$cleanup_output" >&2
      return "$cleanup_status"
    fi
  elif [[ -n "$cleanup_output" ]]; then
    printf '%s\n' "$cleanup_output"
  fi

  local steady_state_report=""
  steady_state_report="$(mktemp "${TMPDIR:-/tmp}/wt-start-steady-state.XXXXXX.json")"
  steady_state_cmd+=(--output "$steady_state_report")

  local steady_state_output=""
  local steady_state_status=0
  steady_state_output="$("${steady_state_cmd[@]}" 2>&1)" || steady_state_status=$?
  if (( steady_state_status != 0 )); then
    if node -e '
      const fs = require("node:fs");
      const reportPath = process.argv[1];
      const raw = fs.readFileSync(reportPath, "utf8");
      const report = JSON.parse(raw);
      const violations = Array.isArray(report?.violations) ? report.violations : [];
      const hasRateLimitedPrSource = violations.some(
        (violation) => violation?.kind === "rate-limited-canonical-open-pr-source"
      );
      const onlyDegradedSafeViolations =
        violations.length > 0 &&
        violations.every(
          (violation) =>
            violation?.kind === "rate-limited-canonical-open-pr-source" ||
            violation?.resolution?.classification === "safe-auto-cleanup"
        );
      process.exit(hasRateLimitedPrSource && onlyDegradedSafeViolations ? 0 : 1);
    ' "$steady_state_report"; then
      printf '%s\n' "[wt-start] WARN: canonical open PR state could not be refreshed because GitHub API rate limits blocked pull enumeration; continuing because remaining residue findings are cleanup-safe" >&2
      [[ -n "$steady_state_output" ]] && printf '%s\n' "$steady_state_output" >&2
    else
      [[ -n "$steady_state_output" ]] && printf '%s\n' "$steady_state_output" >&2
      rm -f "$steady_state_report"
      return "$steady_state_status"
    fi
  elif [[ -n "$steady_state_output" ]]; then
    printf '%s\n' "$steady_state_output"
  fi

  rm -f "$steady_state_report"
}

bootstrap_worktree_dependencies() {
  local repo_root="$1"
  local main_worktree="$2"
  local worktree_path="$3"
  local startup_helper="$repo_root/platform/dev/worktree/dependency-image-startup.ts"

  if [[ ! -f "$startup_helper" ]]; then
    fail "dependency-image startup helper is missing: $startup_helper"
  fi

  echo "[wt-start] attaching dependency image into task worktree..."
  bun --silent "$startup_helper" bootstrap \
    --repo-root "$repo_root" \
    --source-worktree "$main_worktree" \
    --target-worktree "$worktree_path" >/dev/null
}

bootstrap_worktree_dependencies_legacy_usage_hint() {
  local repo_root="$1"
  local worktree_path="$2"
  local install_script="$repo_root/scripts/ensure-bun-install.sh"

  if [[ ! -x "$install_script" ]]; then
    fail "dependency bootstrap script is missing or not executable: $install_script"
  fi

  echo "  exact-sync main runtime must already be materialized before attach-first startup"
  printf '  source runtime repair (main only, not task): BUN_INSTALL_ROOT=%q %q\n' "$worktree_path" "$install_script"
}

sync_worktree_kubeconfig_from_main() {
  local main_worktree="$1"
  local worktree_path="$2"
  local cluster_name="${CLUSTER_NAME:-omta}"
  local source_kubeconfig="$main_worktree/.tmp/kubeconfig-${cluster_name}"
  local target_kubeconfig="$worktree_path/.tmp/kubeconfig-${cluster_name}"

  if [[ ! -f "$source_kubeconfig" ]]; then
    return 0
  fi

  echo "[wt-start] syncing local kubeconfig from main worktree..."
  mkdir -p "$(dirname "$target_kubeconfig")"
  cp -p "$source_kubeconfig" "$target_kubeconfig"
}

sync_worktree_env_from_main() {
  local main_worktree="$1"
  local worktree_path="$2"
  local source_env="$main_worktree/.env"
  local source_env_local="$main_worktree/.env.local"
  local source_env_tools="$main_worktree/.env.tools"
  local target_env="$worktree_path/.env"
  local target_env_local="$worktree_path/.env.local"
  local target_env_tools="$worktree_path/.env.tools"

  if [[ ! -f "$source_env" ]]; then
    fail "main worktree .env not found: $source_env"
  fi

  echo "[wt-start] syncing repo-local env files from main worktree..."
  cp -p "$source_env" "$target_env"
  if [[ -f "$source_env_local" ]]; then
    cp -p "$source_env_local" "$target_env_local"
  fi
  if [[ -f "$source_env_tools" ]]; then
    cp -p "$source_env_tools" "$target_env_tools"
  fi
}

resolve_env_from_file_set() {
  local env_file="$1"
  local env_local_file="$2"
  local key="$3"
  local value=""
  local args=()

  if [[ -f "$env_file" ]]; then
    args+=(--env-file="$env_file")
  fi
  if [[ -f "$env_local_file" ]]; then
    args+=(--env-file="$env_local_file")
  fi

  if [[ ${#args[@]} -eq 0 ]]; then
    printf '%s' ""
    return 0
  fi

  value="$(ENV_KEY="$key" bun --silent "${args[@]}" --print "process.env[process.env.ENV_KEY] ?? ''" 2>/dev/null || true)"
  printf '%s' "$value"
}

is_false_like() {
  local value="${1:-}"
  local normalized
  normalized="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$normalized" in
    false | 0 | off | no) return 0 ;;
    *) return 1 ;;
  esac
}

is_env_key_declared_in_file() {
  local key="$1"
  local env_file="$2"
  [[ -f "$env_file" ]] || return 1
  grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "$env_file"
}

append_unique_value() {
  local -n values_ref="$1"
  local candidate="$2"
  local existing
  for existing in "${values_ref[@]}"; do
    if [[ "$existing" == "$candidate" ]]; then
      return 0
    fi
  done
  values_ref+=("$candidate")
}

validate_no_retired_marketplace_env_aliases() {
  local worktree_path="$1"
  local source_hint="$2"
  local env_file="$worktree_path/.env"
  local env_local_file="$worktree_path/.env.local"
  local -a alias_pairs=(
    "MARKETPLACE_MODE:DISTRIBUTION_MODE"
    "MARKETPLACE_ENABLED:DISTRIBUTION_ENABLED"
    "MARKETPLACE_PUBLIC_ENABLED:DISTRIBUTION_PUBLIC_ENABLED"
    "MARKETPLACE_ORDERS_ENABLED:DISTRIBUTION_ORDERS_ENABLED"
    "MARKETPLACE_SIGNATURE_POLICY:DISTRIBUTION_SIGNATURE_POLICY"
    "MARKETPLACE_SIGNATURE_TRUSTED_KEYS:DISTRIBUTION_SIGNATURE_TRUSTED_KEYS"
    "NEXT_PUBLIC_MARKETPLACE_MODE:NEXT_PUBLIC_DISTRIBUTION_MODE"
    "NEXT_PUBLIC_MARKETPLACE_ENABLED:NEXT_PUBLIC_DISTRIBUTION_ENABLED"
    "NEXT_PUBLIC_MARKETPLACE_PUBLIC_ENABLED:NEXT_PUBLIC_DISTRIBUTION_PUBLIC_ENABLED"
    "NEXT_PUBLIC_MARKETPLACE_ORDERS_ENABLED:NEXT_PUBLIC_DISTRIBUTION_ORDERS_ENABLED"
  )
  local -a retired_keys=()
  local -a canonical_keys=()
  local pair=""
  local retired_key=""
  local canonical_key=""

  for pair in "${alias_pairs[@]}"; do
    retired_key="${pair%%:*}"
    canonical_key="${pair#*:}"
    if is_env_key_declared_in_file "$retired_key" "$env_file" || \
      is_env_key_declared_in_file "$retired_key" "$env_local_file"; then
      append_unique_value retired_keys "$retired_key"
      append_unique_value canonical_keys "$canonical_key"
    fi
  done

  if [[ ${#retired_keys[@]} -gt 0 ]]; then
    fail \
      "synced env contains unsupported retired marketplace aliases (${retired_keys[*]}). replace them in $source_hint/.env or $source_hint/.env.local with canonical distribution keys (${canonical_keys[*]})."
  fi
}

validate_synced_worktree_env() {
  local worktree_path="$1"
  local source_hint="$2"
  local env_file="$worktree_path/.env"
  local env_local_file="$worktree_path/.env.local"
  local api_base_url=""
  local auth_base_url=""
  local collab_enabled=""
  local collab_ws_url=""
  local missing=()

  validate_no_retired_marketplace_env_aliases "$worktree_path" "$source_hint"

  api_base_url="$(resolve_env_from_file_set "$env_file" "$env_local_file" "NEXT_PUBLIC_API_BASE_URL")"
  auth_base_url="$(resolve_env_from_file_set "$env_file" "$env_local_file" "NEXT_PUBLIC_BETTER_AUTH_URL")"
  collab_enabled="$(resolve_env_from_file_set "$env_file" "$env_local_file" "NEXT_PUBLIC_COLLAB_ENABLED")"
  collab_ws_url="$(resolve_env_from_file_set "$env_file" "$env_local_file" "NEXT_PUBLIC_COLLAB_HOCUSPOCUS_URL")"

  [[ -n "$api_base_url" ]] || missing+=("NEXT_PUBLIC_API_BASE_URL")
  [[ -n "$auth_base_url" ]] || missing+=("NEXT_PUBLIC_BETTER_AUTH_URL")

  if ! is_false_like "$collab_enabled"; then
    [[ -n "$collab_ws_url" ]] || missing+=("NEXT_PUBLIC_COLLAB_HOCUSPOCUS_URL")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    fail "synced env missing required web keys (${missing[*]}). define them in $source_hint/.env or $source_hint/.env.local"
  fi
}

protect_task_worktree_from_auto_cleanup() {
  local repo_root="$1"
  local worktree_path="$2"
  local task_id="$3"
  local branch="$4"
  local reason="${5:-wt-start}"
  local helper="$SCRIPT_DIR/task-worktree-protection.ts"

  [[ -f "$helper" ]] || fail "task worktree protection helper not found: $helper"

  bun --silent "$helper" protect \
    --repo-root "$repo_root" \
    --worktree "$worktree_path" \
    --branch "$branch" \
    --task-id "$task_id" \
    --reason "$reason"
}

append_runtime_contract_arg_if_set() {
  local array_name="$1"
  local flag="$2"
  local value="$3"

  if [[ -n "$value" ]]; then
    # Bash 3.2 (macOS /bin/bash) has no nameref (`local -n`); append via evaluated array name.
    eval "$(printf '%q+=("%q" "%q")' "$array_name" "$flag" "$value")"
  fi
}

write_worktree_runtime_contract() {
  local repo_root="$1"
  local worktree_path="$2"
  local task_id="$3"
  local env_file="$worktree_path/.env"
  local env_local_file="$worktree_path/.env.local"
  local resolver="$repo_root/platform/dev/worktree/resolve-worktree-runtime-contract.ts"
  local output_path="$worktree_path/.tmp/worktree-runtime-contract.json"
  local runtime_namespace=""
  local runtime_release=""
  local runtime_secret=""
  local runtime_db_name=""
  local runtime_db_user=""
  local runtime_bucket_name=""
  local runtime_host=""
  local runtime_host_suffix=""
  local shared_namespace=""
  local shared_release=""
  local shared_postgres_service=""
  local shared_minio_service=""
  local shared_redis_service=""
  local shared_temporal_service=""
  local rendered_shell=""
  local -a args=()

  runtime_namespace="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_NAMESPACE")"
  runtime_release="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_RELEASE")"
  runtime_secret="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_SECRET_NAME")"
  runtime_db_name="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_DB_NAME")"
  runtime_db_user="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_DB_USER")"
  runtime_bucket_name="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_BUCKET_NAME")"
  runtime_host="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_PUBLIC_HOST")"
  runtime_host_suffix="$(resolve_env_from_file_set "$env_file" "$env_local_file" "WT_HOST_SUFFIX")"
  shared_namespace="$(resolve_env_from_file_set "$env_file" "$env_local_file" "SHARED_NAMESPACE")"
  shared_release="$(resolve_env_from_file_set "$env_file" "$env_local_file" "SHARED_RELEASE")"
  shared_postgres_service="$(resolve_env_from_file_set "$env_file" "$env_local_file" "SHARED_POSTGRES_SERVICE")"
  shared_minio_service="$(resolve_env_from_file_set "$env_file" "$env_local_file" "SHARED_MINIO_SERVICE")"
  shared_redis_service="$(resolve_env_from_file_set "$env_file" "$env_local_file" "SHARED_REDIS_SERVICE")"
  shared_temporal_service="$(resolve_env_from_file_set "$env_file" "$env_local_file" "SHARED_TEMPORAL_SERVICE")"

  args=(--task-id "$task_id" --output "$output_path")
  append_runtime_contract_arg_if_set args --namespace "$runtime_namespace"
  append_runtime_contract_arg_if_set args --release "$runtime_release"
  append_runtime_contract_arg_if_set args --secret "$runtime_secret"
  append_runtime_contract_arg_if_set args --db-name "$runtime_db_name"
  append_runtime_contract_arg_if_set args --db-user "$runtime_db_user"
  append_runtime_contract_arg_if_set args --bucket-name "$runtime_bucket_name"
  append_runtime_contract_arg_if_set args --host "$runtime_host"
  append_runtime_contract_arg_if_set args --host-suffix "$runtime_host_suffix"
  append_runtime_contract_arg_if_set args --shared-namespace "$shared_namespace"
  append_runtime_contract_arg_if_set args --shared-release "$shared_release"
  append_runtime_contract_arg_if_set args --shared-postgres-service "$shared_postgres_service"
  append_runtime_contract_arg_if_set args --shared-minio-service "$shared_minio_service"
  append_runtime_contract_arg_if_set args --shared-redis-service "$shared_redis_service"
  append_runtime_contract_arg_if_set args --shared-temporal-service "$shared_temporal_service"

  mkdir -p "$(dirname "$output_path")"
  bun --silent "$resolver" "${args[@]}"

  args=(--task-id "$task_id" --format shell)
  append_runtime_contract_arg_if_set args --namespace "$runtime_namespace"
  append_runtime_contract_arg_if_set args --release "$runtime_release"
  append_runtime_contract_arg_if_set args --secret "$runtime_secret"
  append_runtime_contract_arg_if_set args --db-name "$runtime_db_name"
  append_runtime_contract_arg_if_set args --db-user "$runtime_db_user"
  append_runtime_contract_arg_if_set args --bucket-name "$runtime_bucket_name"
  append_runtime_contract_arg_if_set args --host "$runtime_host"
  append_runtime_contract_arg_if_set args --host-suffix "$runtime_host_suffix"
  append_runtime_contract_arg_if_set args --shared-namespace "$shared_namespace"
  append_runtime_contract_arg_if_set args --shared-release "$shared_release"
  append_runtime_contract_arg_if_set args --shared-postgres-service "$shared_postgres_service"
  append_runtime_contract_arg_if_set args --shared-minio-service "$shared_minio_service"
  append_runtime_contract_arg_if_set args --shared-redis-service "$shared_redis_service"
  append_runtime_contract_arg_if_set args --shared-temporal-service "$shared_temporal_service"
  rendered_shell="$(bun --silent "$resolver" "${args[@]}")"
  eval "$rendered_shell"

  echo "[wt-start] runtime namespace/release : $WT_NAMESPACE / $WT_RELEASE"
  echo "[wt-start] runtime host             : $WT_PUBLIC_HOST"
  echo "[wt-start] runtime db               : $WT_DB_NAME (user: $WT_DB_USER)"
  echo "[wt-start] runtime bucket           : $WT_BUCKET_NAME"
  echo "[wt-start] runtime contract         : $output_path"
}

ensure_current_repo_owns_worktree_root() {
  local repo_root="$1"
  local topology_helper="$TASK_START_HELPER_ROOT/platform/dev/worktree/worktree-topology.ts"
  [[ -f "$topology_helper" ]] || fail "worktree topology helper is missing: $topology_helper"
  bun --silent "$topology_helper" ensure-root-owner --repo-root "$repo_root" --write >/dev/null
}

cleanup_partial_task_start() {
  if [[ -n "${task_session_id:-}" ]]; then
    release_task_start_session_lease "$repo_root" "$repository" "$task_id" "wt-start failed" >/dev/null 2>&1 || true
  fi
  if [[ -z "${created_worktree_path:-}" ]]; then
    return 0
  fi
  run_repoctl_task_worktree \
    "$repo_root" \
    cleanup-task-worktree \
    --worktree-path "$created_worktree_path" \
    --branch "${created_branch:-}" >/dev/null 2>&1 || true
}

acquire_task_start_session_lease() {
  local repo_root="$1"
  local repository="$2"
  local task_id="$3"
  local branch="$4"
  local worktree_path="$5"
  local session_env=""

  session_env="$(
    run_task_session_helper \
      "$repo_root" \
      acquire \
      --repository "$repository" \
      --task-id "$task_id" \
      --holder-agent-id wt-start \
      --phase bootstrapping \
      --mode writer \
      --claimed-scope-key "task:$task_id" \
      --claimed-scope-key "branch:$branch" \
      --claimed-scope-key "worktree:$worktree_path" \
      --claimed-hot-root "$worktree_path" \
      --format shell \
      --prefix wt-start
  )" || return $?

  eval "$session_env"
  [[ -n "${WT_TASK_SESSION_ID:-}" ]] || fail "task session acquire did not return WT_TASK_SESSION_ID"
  task_session_id="$WT_TASK_SESSION_ID"
}

heartbeat_task_start_session_lease() {
  local repo_root="$1"
  local repository="$2"
  local task_id="$3"
  local phase="$4"

  if [[ -z "${task_session_id:-}" ]]; then
    return 0
  fi

  run_task_session_helper \
    "$repo_root" \
    heartbeat \
    --repository "$repository" \
    --task-id "$task_id" \
    --session-id "$task_session_id" \
    --phase "$phase" >/dev/null
}

release_task_start_session_lease() {
  local repo_root="$1"
  local repository="$2"
  local task_id="$3"
  local reason="$4"
  local rpc_timeout_ms="${WT_START_TASK_SESSION_RELEASE_RPC_TIMEOUT_MS:-15000}"

  if [[ -z "${task_session_id:-}" ]]; then
    return 0
  fi

  run_task_session_helper \
    "$repo_root" \
    release \
    --repository "$repository" \
    --task-id "$task_id" \
    --session-id "$task_session_id" \
    --reason "$reason" \
    --rpc-timeout-ms "$rpc_timeout_ms" >/dev/null
  task_session_id=""
  unset WT_TASK_SESSION_ID
}

run_task_start_repair_first_flow() {
  local repo_root="$1"
  local repository="$2"
  local main_worktree="$3"
  local worktree_path="$4"
  local task_id="$5"
  local branch="$6"
  local task_issue_source="${7:-}"

  exact_sync_main_worktree "$main_worktree"

  local local_main
  local local_remote_main
  local_main="$(git -C "$main_worktree" rev-parse main)"
  local_remote_main="$(git -C "$main_worktree" rev-parse origin/main)"
  if [[ "$local_main" != "$local_remote_main" ]]; then
    fail "main is not synchronized with origin/main after exact sync"
  fi

  acquire_task_start_session_lease "$repo_root" "$repository" "$task_id" "$branch" "$worktree_path"
  mkdir -p "$(dirname "$worktree_path")"
  created_worktree_path="$worktree_path"
  created_branch="$branch"
  heartbeat_task_start_session_lease "$repo_root" "$repository" "$task_id" "reconciling"
  reconcile_task_worktree_start "$repo_root" "$main_worktree" "$worktree_path" "$task_id" "$branch"
  run_task_start_residue_cleanup_preflight "$repo_root" "$repository" "$task_id" "$branch" "$task_issue_source"
  run_task_start_scope_preflight "$repo_root" "$task_id" "$branch" "$task_issue_source"
  heartbeat_task_start_session_lease "$repo_root" "$repository" "$task_id" "bundle_ready"
  protect_task_worktree_from_auto_cleanup "$repo_root" "$worktree_path" "$task_id" "$branch" "wt-start"

  sync_worktree_env_from_main "$main_worktree" "$worktree_path"
  sync_worktree_kubeconfig_from_main "$main_worktree" "$worktree_path"
  validate_synced_worktree_env "$worktree_path" "$main_worktree"
  write_worktree_runtime_contract "$repo_root" "$worktree_path" "$task_id"
  bootstrap_worktree_dependencies "$repo_root" "$main_worktree" "$worktree_path"
  release_task_start_session_lease "$repo_root" "$repository" "$task_id" "wt-start completed"
  created_worktree_path=""
  created_branch=""
}

if [[ "${OMTA_WT_TASK_START_SOURCE_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

task_id=""
slug=""
branch=""
worktree_path=""
main_worktree=""
dry_run="0"
created_worktree_path=""
created_branch=""
task_session_id=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-id)
      task_id="${2:-}"
      shift 2
      ;;
    --slug)
      slug="${2:-}"
      shift 2
      ;;
    --branch)
      branch="${2:-}"
      shift 2
      ;;
    --worktree)
      worktree_path="${2:-}"
      shift 2
      ;;
    --main-worktree)
      main_worktree="${2:-}"
      shift 2
      ;;
    --dry-run)
      dry_run="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[[ -n "$task_id" ]] || fail "--task-id is required"
if ! printf '%s' "$task_id" | grep -Eq '^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-[0-9]{3,}[a-z]?$'; then
  fail "--task-id must match <DOMAIN>-<NNN+> (example: OPS-269104)"
fi

repo_root="$(git rev-parse --show-toplevel)"
repository="$(resolve_repository_from_origin "$repo_root")"
current_worktree="$(canonical_path "$repo_root")"
ensure_clean_worktree "$current_worktree" "current worktree ($current_worktree)"
  repair_hint="Run: bun run wt:cleanup:repair-base-worktree"

if [[ -z "$main_worktree" ]]; then
  main_worktree="$(resolve_base_main_worktree "$repo_root")"
fi
[[ -n "$main_worktree" ]] || fail "main worktree not found. $repair_hint"
main_worktree="$(canonical_path "$main_worktree")"
[[ -d "$main_worktree" ]] || fail "--main-worktree does not exist: $main_worktree"

if [[ "$(git -C "$main_worktree" rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  fail "main worktree is not on branch main: $main_worktree. $repair_hint"
fi
ensure_clean_worktree "$main_worktree" "main worktree ($main_worktree)"

if [[ -z "$branch" ]]; then
  [[ -n "$slug" ]] || fail "--slug is required when --branch is omitted"
  normalized_slug="$(sanitize_slug "$slug")"
  [[ -n "$normalized_slug" ]] || fail "--slug must contain alphanumeric characters"
  lower_task_id="$(printf '%s' "$task_id" | tr '[:upper:]' '[:lower:]')"
  branch="task/${lower_task_id}-${normalized_slug}"
fi

if [[ "$branch" != task/* ]]; then
  fail "--branch must start with task/"
fi
if [[ "$branch" =~ [[:space:]] ]]; then
  fail "--branch must not contain spaces"
fi

if [[ -z "$worktree_path" ]]; then
  worktree_path="$repo_root/../wt/$task_id"
fi
worktree_path="$(to_absolute_path "$repo_root" "$worktree_path")"
worktree_path="$(canonical_path "$worktree_path")"
ensure_worktree_path_policy "$repo_root" "$worktree_path" "$task_id"
recover_existing_task_worktree_path "$repo_root" "$worktree_path" "$task_id"

if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
  if ! delete_main_equal_stale_branch "$repo_root" "$main_worktree" "$branch"; then
    fail "local branch already exists: $branch"
  fi
fi

if remote_branch_exists "$repo_root" origin "$branch"; then
  fail "remote branch already exists: $branch"
fi

ensure_branch_not_checked_out "$repo_root" "$branch"
ensure_task_id_has_no_duplicate_branch_surface "$repo_root" "$task_id" "$branch"

task_issue_source="${OMTA_TASK_ISSUE_SOURCE:-${ISSUE_GRAPH_SOURCE:-}}"

if [[ "$dry_run" == "1" ]]; then
  echo "[wt-start] dry-run"
  printf '  exact-sync main worktree via fetch+reset (post-merge hooks bypassed): %q %q\n' "$main_worktree" "origin/main"
  printf '  acquire daemon writer session via bun --silent %q acquire --repo-root %q --repository %q --task-id %q --holder-agent-id wt-start --phase bootstrapping --mode writer --claimed-scope-key %q --claimed-scope-key %q --claimed-scope-key %q --claimed-hot-root %q --format shell --prefix wt-start\n' "$TASK_START_HELPER_ROOT/platform/dev/worktree/task-session.ts" "$repo_root" "$repository" "$task_id" "task:$task_id" "branch:$branch" "worktree:$worktree_path" "$worktree_path"
  printf '  bun --silent %q reconcile-task-worktree --repo-root %q --main-worktree %q --worktree-path %q --task-id %q --branch %q\n' "$TASK_START_HELPER_ROOT/tools/repoctl/task-worktree.ts" "$repo_root" "$main_worktree" "$worktree_path" "$task_id" "$branch"
  printf '  post-reconcile cleanup + steady-state via run_task_start_residue_cleanup_preflight %q %q %q %q\n' "$repo_root" "$repository" "$task_id" "${task_issue_source:-}"
  printf '  post-reconcile task issue + scope + sizing via run_task_start_scope_preflight %q %q %q %q\n' "$repo_root" "$task_id" "$branch" "${task_issue_source:-}"
  printf '  heartbeat daemon writer session via bun --silent %q heartbeat --repo-root %q --repository %q --task-id %q --session-id <granted-session> --phase reconciling\n' "$TASK_START_HELPER_ROOT/platform/dev/worktree/task-session.ts" "$repo_root" "$repository" "$task_id"
  printf '  cp -p %q %q\n' "$main_worktree/.env" "$worktree_path/.env"
  printf '  [ -f %q ] && cp -p %q %q\n' "$main_worktree/.env.local" "$main_worktree/.env.local" "$worktree_path/.env.local"
  printf '  [ -f %q ] && cp -p %q %q\n' "$main_worktree/.env.tools" "$main_worktree/.env.tools" "$worktree_path/.env.tools"
  printf '  [ -f %q ] && mkdir -p %q && cp -p %q %q\n' "$main_worktree/.tmp/kubeconfig-${CLUSTER_NAME:-omta}" "$worktree_path/.tmp" "$main_worktree/.tmp/kubeconfig-${CLUSTER_NAME:-omta}" "$worktree_path/.tmp/kubeconfig-${CLUSTER_NAME:-omta}"
  printf '  bun --silent %q protect --repo-root %q --worktree %q --branch %q --task-id %q --reason wt-start\n' "$SCRIPT_DIR/task-worktree-protection.ts" "$repo_root" "$worktree_path" "$branch" "$task_id"
  printf '  validate synced env keys: NEXT_PUBLIC_API_BASE_URL, NEXT_PUBLIC_BETTER_AUTH_URL, NEXT_PUBLIC_COLLAB_HOCUSPOCUS_URL (unless NEXT_PUBLIC_COLLAB_ENABLED=false)\n'
  printf '  bun --silent %q bootstrap --repo-root %q --source-worktree %q --target-worktree %q\n' "$repo_root/platform/dev/worktree/dependency-image-startup.ts" "$repo_root" "$main_worktree" "$worktree_path"
  bootstrap_worktree_dependencies_legacy_usage_hint "$repo_root" "$main_worktree"
  exit 0
fi

ensure_current_repo_owns_worktree_root "$repo_root"

trap 'status=$?; if [[ $status -ne 0 ]]; then cleanup_partial_task_start; fi; exit $status' EXIT
run_task_start_repair_first_flow \
  "$repo_root" \
  "$repository" \
  "$main_worktree" \
  "$worktree_path" \
  "$task_id" \
  "$branch" \
  "${task_issue_source:-}"
trap - EXIT

echo "[wt-start] main worktree : $main_worktree"
echo "[wt-start] task branch   : $branch"
echo "[wt-start] task worktree : $worktree_path"
echo "[wt-start] next:"
echo "  cd \"$worktree_path\""
echo "  git status -sb"
