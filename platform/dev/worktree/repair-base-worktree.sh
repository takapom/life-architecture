#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  bun run wt:cleanup:repair-base-worktree [options]

Options:
  --repo-root <path>  Explicit repository root override
  --dry-run           Print planned repair actions without mutating git state
  --help              Show this help
USAGE
}

fail() {
  echo "[base-worktree-repair] ERROR: $*" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../shared/git-common.sh"

resolve_repo_root() {
  local explicit_root="${repo_root_override:-${OMTA_BASE_WORKTREE_REPAIR_REPO_ROOT:-}}"
  if [[ -n "$explicit_root" ]]; then
    canonical_path "$explicit_root"
    return 0
  fi
  resolve_current_repo_root "$SCRIPT_DIR"
}

resolve_configured_core_worktree() {
  local repo_root="${1:?resolve_configured_core_worktree requires repo_root argument}"
  local configured_worktree
  configured_worktree="$(git -C "$repo_root" config --local --get core.worktree 2>/dev/null || true)"
  if [[ -z "$configured_worktree" ]]; then
    return 0
  fi
  if [[ "$configured_worktree" != /* ]]; then
    configured_worktree="$repo_root/$configured_worktree"
  fi
  canonical_path "$configured_worktree"
}

repo_root_override=""
dry_run="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      repo_root_override="${2:-}"
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

repo_root="$(resolve_repo_root)"
[[ -n "$repo_root" ]] || fail "failed to resolve repo root"

base_worktree="$(resolve_canonical_base_worktree "$repo_root" || true)"
[[ -n "$base_worktree" ]] || fail "failed to resolve canonical base worktree"

marker_before="$(read_base_worktree_marker "$repo_root")"
base_branch_before="$(git_in_checkout "$base_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
main_worktree="$(detect_main_worktree "$repo_root" || true)"
configured_core_worktree="$(resolve_configured_core_worktree "$base_worktree")"
base_dirty="$(git_in_checkout "$base_worktree" status --porcelain 2>/dev/null || true)"

core_worktree_repair_needed="0"
if [[ -n "$configured_core_worktree" && "$configured_core_worktree" != "$base_worktree" ]]; then
  core_worktree_repair_needed="1"
fi

marker_repair_needed="0"
if [[ -z "$marker_before" || "$marker_before" != "$base_worktree" ]]; then
  marker_repair_needed="1"
fi

branch_repair_needed="0"
if [[ "$base_branch_before" != "main" ]]; then
  branch_repair_needed="1"
fi

if [[ "$branch_repair_needed" == "1" && -n "$base_dirty" ]]; then
  fail "base worktree is dirty: commit or stash changes in $base_worktree before repair"
fi

if [[ "$branch_repair_needed" == "1" && -n "$main_worktree" && "$main_worktree" != "$base_worktree" ]]; then
  fail "main is currently checked out in another worktree: $main_worktree. Switch that worktree off main, then rerun this command."
fi

echo "[base-worktree-repair] repo_root=$repo_root"
echo "[base-worktree-repair] base_worktree=$base_worktree"
if [[ -n "$marker_before" ]]; then
  echo "[base-worktree-repair] marker_before=$marker_before"
fi
if [[ -n "$main_worktree" ]]; then
  echo "[base-worktree-repair] main_worktree=$main_worktree"
fi

if [[ "$dry_run" == "1" ]]; then
  if [[ "$core_worktree_repair_needed" == "1" ]]; then
    echo "[base-worktree-repair] dry-run: unset stale core.worktree in $base_worktree"
  fi
  if [[ "$marker_repair_needed" == "1" ]]; then
    echo "[base-worktree-repair] dry-run: persist base-worktree marker -> $base_worktree"
  fi
  if [[ "$branch_repair_needed" == "1" ]]; then
    echo "[base-worktree-repair] dry-run: git -C \"$base_worktree\" switch --quiet main"
  fi
  if [[ "$core_worktree_repair_needed" != "1" && "$marker_repair_needed" != "1" && "$branch_repair_needed" != "1" ]]; then
    echo "[base-worktree-repair] dry-run: reservation is already healthy"
  fi
  exit 0
fi

export OMTA_BASE_WORKTREE_REPAIR_IN_PROGRESS=1
repaired_base_worktree="$(repair_base_worktree_reservation "$repo_root" || true)"
[[ -n "$repaired_base_worktree" ]] || fail "failed to repair base worktree reservation"

base_branch_after="$(git_in_checkout "$repaired_base_worktree" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
[[ "$base_branch_after" == "main" ]] || fail "base worktree repair did not restore branch main: $repaired_base_worktree"

if [[ "$core_worktree_repair_needed" == "1" ]]; then
  echo "[base-worktree-repair] repaired stale core.worktree override"
fi
if [[ "$marker_repair_needed" == "1" ]]; then
  echo "[base-worktree-repair] repaired base-worktree marker"
fi
if [[ "$branch_repair_needed" == "1" ]]; then
  echo "[base-worktree-repair] restored base worktree to main"
fi
if [[ "$core_worktree_repair_needed" != "1" && "$marker_repair_needed" != "1" && "$branch_repair_needed" != "1" ]]; then
  echo "[base-worktree-repair] reservation is already healthy"
fi
