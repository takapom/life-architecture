#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bun run wt:refresh -- [options]

Options:
  --task-id <value>       Target task id (optional when run inside a task worktree)
  --worktree <path>       Explicit target task worktree path
  --main-worktree <path>  Main branch worktree path (default: auto-detect branch=main worktree)
  --dry-run               Print planned commands without mutating git state
  --help                  Show this help
USAGE
}

fail() {
  echo "[wt-refresh] ERROR: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../shared/git-common.sh"
OMTA_WT_TASK_START_SOURCE_ONLY=1 source "$SCRIPT_DIR/task-start.sh"

extract_task_id_from_branch() {
  local branch="${1:-}"
  extract_task_id_from_branch_name "$branch"
}

resolve_target_worktree() {
  local repo_root="$1"
  local main_worktree="$2"
  local task_id="$3"
  local explicit_worktree="$4"
  local current_branch=""
  current_branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

  if [[ -n "$explicit_worktree" ]]; then
    canonical_path "$explicit_worktree"
    return 0
  fi

  if [[ "$current_branch" == task/* ]]; then
    canonical_path "$repo_root"
    return 0
  fi

  [[ -n "$task_id" ]] || fail "--task-id is required when not run from a task worktree"
  canonical_path "$main_worktree/../wt/$task_id"
}

list_unique_commits() {
  local worktree_path="$1"
  git -C "$worktree_path" rev-list --reverse origin/main..HEAD
}

list_merge_commits() {
  local worktree_path="$1"
  git -C "$worktree_path" rev-list --merges origin/main..HEAD
}

restore_original_head() {
  local worktree_path="$1"
  local original_head="$2"
  git -C "$worktree_path" reset --hard "$original_head" >/dev/null
}

refresh_task_worktree() {
  local repo_root="$1"
  local main_worktree="$2"
  local worktree_path="$3"
  local dry_run="$4"

  local branch
  branch="$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [[ "$branch" == task/* ]] || fail "target worktree is not on a task branch: $worktree_path (${branch:-detached})"

  local task_id
  task_id="$(extract_task_id_from_branch "$branch" || true)"
  [[ -n "$task_id" ]] || fail "failed to resolve task id from task branch: $branch"
  ensure_worktree_path_policy "$main_worktree" "$worktree_path" "$task_id"

  ensure_clean_worktree "$worktree_path" "task worktree ($worktree_path)"
  ensure_clean_worktree "$main_worktree" "main worktree ($main_worktree)"
  exact_sync_main_worktree "$main_worktree"

  local merge_commits
  merge_commits="$(list_merge_commits "$worktree_path")"
  if [[ -n "$merge_commits" ]]; then
    fail "task branch contains merge commits and cannot be refreshed canonically. Recreate the task worktree and re-apply only task-owned commits."
  fi

  mapfile -t unique_commits < <(list_unique_commits "$worktree_path")
  local original_head
  original_head="$(git -C "$worktree_path" rev-parse HEAD)"

  if [[ "$dry_run" == "1" ]]; then
    echo "[wt-refresh] dry-run"
    echo "[wt-refresh] target task worktree : $worktree_path"
    echo "[wt-refresh] task branch          : $branch"
    echo "[wt-refresh] task id              : $task_id"
    echo "[wt-refresh] main worktree        : $main_worktree"
    echo "[wt-refresh] exact-sync main via fetch+reset to origin/main"
    echo "[wt-refresh] reset task branch to origin/main and cherry-pick unique commits:"
    if [[ ${#unique_commits[@]} -eq 0 ]]; then
      echo "  - <none>"
    else
      local commit
      for commit in "${unique_commits[@]}"; do
        echo "  - $commit"
      done
    fi
    echo "[wt-refresh] then: bun run task:ensure -- --task-id $task_id --branch $branch --write-marker"
    return 0
  fi

  git -C "$worktree_path" reset --hard origin/main >/dev/null
  local commit
  for commit in "${unique_commits[@]}"; do
    if ! git -C "$worktree_path" cherry-pick "$commit" >/dev/null 2>&1; then
      git -C "$worktree_path" cherry-pick --abort >/dev/null 2>&1 || true
      restore_original_head "$worktree_path" "$original_head"
      fail "failed to cherry-pick task commit during refresh: $commit"
    fi
  done

  (
    export_checkout_git_env "$worktree_path"
    local ensure_cmd=(bun run task:ensure -- --task-id "$task_id" --branch "$branch" --write-marker)
    local task_issue_source="${OMTA_TASK_ISSUE_SOURCE:-${ISSUE_GRAPH_SOURCE:-}}"
    if [[ -n "${OMTA_TASK_ISSUE_REPOSITORY:-}" ]]; then
      ensure_cmd+=(--repository "$OMTA_TASK_ISSUE_REPOSITORY")
    fi
    if [[ -n "$task_issue_source" ]]; then
      ensure_cmd+=(--source "$task_issue_source")
    fi
    "${ensure_cmd[@]}" >/dev/null
  )
  protect_task_worktree_from_auto_cleanup "$repo_root" "$worktree_path" "$task_id" "$branch" "wt-refresh"

  echo "[wt-refresh] main worktree : $main_worktree"
  echo "[wt-refresh] task branch   : $branch"
  echo "[wt-refresh] task worktree : $worktree_path"
  echo "[wt-refresh] refreshed onto origin/main with ${#unique_commits[@]} replayed task commit(s)"
}

if [[ "${OMTA_WT_REFRESH_SOURCE_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

task_id=""
explicit_worktree=""
main_worktree=""
dry_run="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-id)
      task_id="${2:-}"
      shift 2
      ;;
    --worktree)
      explicit_worktree="${2:-}"
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
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
done

repo_root="$(resolve_current_repo_root)"
[[ -n "$repo_root" ]] || fail "failed to resolve repo root"
repo_root="$(canonical_path "$repo_root")"

if [[ -z "$main_worktree" ]]; then
  main_worktree="$(resolve_base_main_worktree "$repo_root")"
fi
[[ -n "$main_worktree" ]] || fail "main worktree not found"
main_worktree="$(canonical_path "$main_worktree")"
[[ -d "$main_worktree" ]] || fail "--main-worktree does not exist: $main_worktree"

target_worktree="$(resolve_target_worktree "$repo_root" "$main_worktree" "$task_id" "$explicit_worktree")"
[[ -d "$target_worktree" ]] || fail "task worktree does not exist: $target_worktree"

refresh_task_worktree "$repo_root" "$main_worktree" "$target_worktree" "$dry_run"
