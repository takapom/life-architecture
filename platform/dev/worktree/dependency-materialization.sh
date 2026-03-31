#!/usr/bin/env bash

WT_DEP_MATERIALIZATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/wt-common.sh
source "$WT_DEP_MATERIALIZATION_DIR/lib/wt-common.sh"
ATTACH_GUARD_SCRIPT="$WT_DEP_MATERIALIZATION_DIR/../shared/dependency-image-attach-guard.ts"

WT_DEP_ATTACH_MODE=""
WT_DEP_ATTACH_DEP_IMAGE_ID=""
WT_DEP_ATTACH_IMAGE_ROOT=""
WT_DEP_ATTACH_STATE_PATH=""
WT_DEP_ATTACH_MATERIALIZED_PATHS=()
WT_DEP_DELETE_TRASH_BATCH_ROOT=""

wt_materialization_task_root() {
  local repo_root="$1"
  local canonical_repo_root=""
  canonical_repo_root="$(canonical_path "$repo_root")"

  if [[ "$(basename "$(dirname "$canonical_repo_root")")" == "wt" ]]; then
    printf '%s\n' "$(dirname "$canonical_repo_root")"
    return 0
  fi

  canonical_path "$canonical_repo_root/../wt"
}

wt_materialized_dependency_root() {
  local repo_root="$1"
  printf '%s/.omta/materialized-deps\n' "$(wt_materialization_task_root "$repo_root")"
}

wt_delete_trash_root() {
  local repo_root="$1"
  printf '%s/.omta/delete-trash\n' "$(wt_materialization_task_root "$repo_root")"
}

wt_sanitize_delete_trash_component() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | tr -cs 'A-Za-z0-9._-' '-')"
  value="${value#-}"
  value="${value%-}"
  if [[ -z "$value" ]]; then
    printf 'cleanup\n'
    return 0
  fi
  printf '%s\n' "$value"
}

wt_ensure_delete_trash_batch_root() {
  local repo_root="$1"
  local worktree_path="$2"
  local batch_label=""
  if [[ -n "$WT_DEP_DELETE_TRASH_BATCH_ROOT" ]]; then
    return 0
  fi

  batch_label="$(wt_sanitize_delete_trash_component "$(basename "$(canonical_path "$worktree_path")")")"
  WT_DEP_DELETE_TRASH_BATCH_ROOT="$(printf '%s/%s-%s-%s\n' \
    "$(wt_delete_trash_root "$repo_root")" \
    "$(date -u +"%Y%m%dT%H%M%SZ")" \
    "$batch_label" \
    "$$")"
}

wt_materialized_dependency_entry_path() {
  local repo_root="$1"
  local worktree_path="$2"
  local canonical_worktree_path=""
  canonical_worktree_path="$(canonical_path "$worktree_path")"
  printf '%s/%s\n' \
    "$(wt_materialized_dependency_root "$repo_root")" \
    "$(basename "$canonical_worktree_path")"
}

wt_materialized_dependency_node_modules_path() {
  local repo_root="$1"
  local worktree_path="$2"
  printf '%s/node_modules\n' "$(wt_materialized_dependency_entry_path "$repo_root" "$worktree_path")"
}

wt_delete_path() {
  local target_path="$1"
  [[ -n "$target_path" ]] || return 0
  [[ -e "$target_path" || -L "$target_path" ]] || return 0
  rm -rf "$target_path"
}

wt_make_path_writable_for_detach() {
  local target_path="$1"
  [[ -e "$target_path" || -L "$target_path" ]] || return 0
  chmod -R u+w "$target_path" >/dev/null 2>&1 || true
  chmod u+w "$(dirname "$target_path")" >/dev/null 2>&1 || true
}

wt_reset_dependency_image_cleanup_plan() {
  WT_DEP_ATTACH_MODE=""
  WT_DEP_ATTACH_DEP_IMAGE_ID=""
  WT_DEP_ATTACH_IMAGE_ROOT=""
  WT_DEP_ATTACH_STATE_PATH=""
  WT_DEP_ATTACH_MATERIALIZED_PATHS=()
}

wt_read_dependency_image_cleanup_plan() {
  local worktree_path="$1"
  local key=""
  local value=""

  wt_reset_dependency_image_cleanup_plan
  [[ -f "$ATTACH_GUARD_SCRIPT" ]] || return 0

  while IFS=$'\t' read -r key value; do
    case "$key" in
      attach_mode)
        WT_DEP_ATTACH_MODE="$value"
        ;;
      dep_image_id)
        WT_DEP_ATTACH_DEP_IMAGE_ID="$value"
        ;;
      image_root)
        WT_DEP_ATTACH_IMAGE_ROOT="$value"
        ;;
      state_path)
        WT_DEP_ATTACH_STATE_PATH="$value"
        ;;
      materialized_path)
        [[ -n "$value" ]] && WT_DEP_ATTACH_MATERIALIZED_PATHS+=("$value")
        ;;
    esac
  done < <(bun --silent "$ATTACH_GUARD_SCRIPT" cleanup-plan --repo-root "$worktree_path")
}

wt_cleanup_legacy_externalized_dependency_materialization() {
  local repo_root="$1"
  local worktree_path="$2"
  local mode="${3:-apply}"
  local entry_path=""

  entry_path="$(wt_materialized_dependency_entry_path "$repo_root" "$worktree_path")"

  if [[ ! -e "$entry_path" && ! -L "$entry_path" ]]; then
    return 0
  fi

  if [[ "$mode" == "dry-run" ]]; then
    wt_ensure_delete_trash_batch_root "$repo_root" "$worktree_path"
    printf '[wt-deps] dry-run cleanup: move %s into %s\n' \
      "$entry_path" \
      "$WT_DEP_DELETE_TRASH_BATCH_ROOT"
    return 0
  fi

  wt_stage_path_for_delete_trash "$repo_root" "$worktree_path" "$entry_path"
}

wt_cleanup_task_worktree_node_modules() {
  local repo_root="$1"
  local worktree_path="$2"
  local mode="${3:-apply}"
  local node_modules_path="$worktree_path/node_modules"

  if [[ ! -e "$node_modules_path" && ! -L "$node_modules_path" ]]; then
    return 0
  fi

  if [[ "$mode" == "dry-run" ]]; then
    wt_ensure_delete_trash_batch_root "$repo_root" "$worktree_path"
    printf '[wt-deps] dry-run cleanup: move %s into %s\n' \
      "$node_modules_path" \
      "$WT_DEP_DELETE_TRASH_BATCH_ROOT"
    return 0
  fi

  wt_stage_path_for_delete_trash "$repo_root" "$worktree_path" "$node_modules_path"
}

wt_stage_path_for_delete_trash() {
  local repo_root="$1"
  local worktree_path="$2"
  local source_path="$3"
  local canonical_worktree=""
  local canonical_source=""
  local relative_path=""
  local batch_root=""
  local target_path=""

  [[ -e "$source_path" || -L "$source_path" ]] || return 0

  canonical_worktree="$(canonical_path "$worktree_path")"
  canonical_source="$(canonical_path "$source_path")"
  wt_ensure_delete_trash_batch_root "$repo_root" "$worktree_path"
  batch_root="$WT_DEP_DELETE_TRASH_BATCH_ROOT"

  if [[ "$canonical_source" == "$canonical_worktree" ]]; then
    relative_path="worktree-root"
  elif [[ "$canonical_source" == "$canonical_worktree/"* ]]; then
    relative_path="${canonical_source#"$canonical_worktree"/}"
  else
    relative_path="$(basename "$canonical_source")"
  fi

  target_path="$batch_root/$relative_path"
  mkdir -p "$(dirname "$target_path")"
  wt_make_path_writable_for_detach "$source_path"
  mv "$source_path" "$target_path"
  printf '[wt-deps] staged path for delete-trash: %s -> %s\n' "$canonical_source" "$target_path"
}

wt_cleanup_task_worktree_attached_node_modules() {
  local repo_root="$1"
  local worktree_path="$2"
  local mode="${3:-apply}"
  local relative_path=""
  local source_path=""

  wt_read_dependency_image_cleanup_plan "$worktree_path"
  if [[ "$WT_DEP_ATTACH_MODE" != "shared-ro" ]]; then
    return 1
  fi

  if [[ "$mode" == "dry-run" ]]; then
    wt_ensure_delete_trash_batch_root "$repo_root" "$worktree_path"
    for relative_path in "${WT_DEP_ATTACH_MATERIALIZED_PATHS[@]}"; do
      printf '[wt-deps] dry-run cleanup attached runtime: move %s into %s\n' \
        "$worktree_path/$relative_path" \
        "$WT_DEP_DELETE_TRASH_BATCH_ROOT"
    done
    if [[ -n "$WT_DEP_ATTACH_STATE_PATH" ]]; then
      printf '[wt-deps] dry-run cleanup attach state: rm -f %s\n' \
        "$WT_DEP_ATTACH_STATE_PATH"
    fi
    return 0
  fi

  for relative_path in "${WT_DEP_ATTACH_MATERIALIZED_PATHS[@]}"; do
    source_path="$worktree_path/$relative_path"
    if [[ ! -e "$source_path" && ! -L "$source_path" ]]; then
      continue
    fi
    wt_stage_path_for_delete_trash "$repo_root" "$worktree_path" "$source_path"
  done

  if [[ -n "$WT_DEP_ATTACH_STATE_PATH" && -e "$WT_DEP_ATTACH_STATE_PATH" ]]; then
    wt_delete_path "$WT_DEP_ATTACH_STATE_PATH"
    printf '[wt-deps] removed attach state: %s\n' "$WT_DEP_ATTACH_STATE_PATH"
  fi

  return 0
}

wt_cleanup_dependency_materialization() {
  local repo_root="$1"
  local worktree_path="$2"
  local mode="${3:-apply}"

  if wt_cleanup_task_worktree_attached_node_modules "$repo_root" "$worktree_path" "$mode"; then
    wt_cleanup_legacy_externalized_dependency_materialization "$repo_root" "$worktree_path" "$mode"
    return 0
  fi
  wt_cleanup_task_worktree_node_modules "$repo_root" "$worktree_path" "$mode"
  wt_cleanup_legacy_externalized_dependency_materialization "$repo_root" "$worktree_path" "$mode"
}

wt_dependency_image_images_root() {
  local repo_root="$1"
  printf '%s/.omta/dependency-images/images\n' "$(wt_materialization_task_root "$repo_root")"
}

wt_dependency_image_locks_root() {
  local repo_root="$1"
  printf '%s/.omta/dependency-images/locks\n' "$(wt_materialization_task_root "$repo_root")"
}

wt_list_active_dependency_image_ids() {
  local repo_root="$1"
  local task_root=""
  local state_path=""
  local worktree_path=""
  local emitted_ids=""

  task_root="$(wt_materialization_task_root "$repo_root")"
  [[ -d "$task_root" ]] || return 0

  while IFS= read -r -d '' state_path; do
    worktree_path="$(dirname "$(dirname "$state_path")")"
    wt_read_dependency_image_cleanup_plan "$worktree_path"
    if [[ "$WT_DEP_ATTACH_MODE" == "shared-ro" && -n "$WT_DEP_ATTACH_DEP_IMAGE_ID" ]]; then
      if [[ ",$emitted_ids," != *",$WT_DEP_ATTACH_DEP_IMAGE_ID,"* ]]; then
        printf '%s\n' "$WT_DEP_ATTACH_DEP_IMAGE_ID"
        emitted_ids="${emitted_ids},${WT_DEP_ATTACH_DEP_IMAGE_ID}"
      fi
    fi
  done < <(
    find "$task_root" \
      -path "$task_root/.omta" -prune -o \
      -path "$task_root/_dead-wt-archive" -prune -o \
      -path '*/.tmp/dependency-image-attach-state.json' -print0
  )
}

wt_gc_shared_dependency_images() {
  local repo_root="$1"
  local mode="${2:-apply}"
  local images_root=""
  local locks_root=""
  local image_root=""
  local dep_image_id=""
  declare -A active_ids=()

  images_root="$(wt_dependency_image_images_root "$repo_root")"
  locks_root="$(wt_dependency_image_locks_root "$repo_root")"

  [[ -d "$images_root" ]] || return 0
  while IFS= read -r dep_image_id; do
    [[ -n "$dep_image_id" ]] && active_ids["$dep_image_id"]=1
  done < <(wt_list_active_dependency_image_ids "$repo_root")

  for image_root in "$images_root"/*; do
    [[ -d "$image_root" ]] || continue
    dep_image_id="$(basename "$image_root")"

    if [[ -n "${active_ids[$dep_image_id]:-}" ]]; then
      printf '[wt-deps] shared image still referenced; skipping GC: %s\n' "$dep_image_id"
      continue
    fi
    if [[ -e "$locks_root/$dep_image_id" ]]; then
      printf '[wt-deps] shared image build lock present; skipping GC: %s\n' "$dep_image_id"
      continue
    fi
    if [[ ! -f "$image_root/image.json" || ! -e "$image_root/node_modules" ]]; then
      printf '[wt-deps] shared image is incomplete; skipping GC: %s\n' "$dep_image_id"
      continue
    fi

    if [[ "$mode" == "dry-run" ]]; then
      printf '[wt-deps] dry-run shared image GC: rm -rf %s\n' "$image_root"
      continue
    fi

    wt_make_path_writable_for_detach "$image_root"
    wt_delete_path "$image_root"
    printf '[wt-deps] garbage-collected shared image: %s\n' "$image_root"
  done
}

wt_dependency_materialization_usage() {
  cat <<'USAGE'
Usage:
  dependency-materialization.sh cleanup --repo-root <path> --worktree <path> [--dry-run]
  dependency-materialization.sh gc-shared-images --repo-root <path> [--dry-run]
USAGE
}

wt_dependency_materialization_cli() {
  local command="${1:-}"
  local repo_root=""
  local worktree_path=""
  local dry_run=0

  shift || true
  while (($#)); do
    case "$1" in
      --repo-root)
        repo_root="${2:-}"
        shift 2
        ;;
      --worktree)
        worktree_path="${2:-}"
        shift 2
        ;;
      --dry-run)
        dry_run=1
        shift
        ;;
      -h|--help)
        wt_dependency_materialization_usage
        return 0
        ;;
      *)
        echo "[wt-deps] unknown argument: $1" >&2
        wt_dependency_materialization_usage >&2
        return 2
        ;;
    esac
  done

  [[ -n "$command" && -n "$repo_root" ]] || {
    wt_dependency_materialization_usage >&2
    return 2
  }

  case "$command" in
    cleanup)
      [[ -n "$worktree_path" ]] || {
        wt_dependency_materialization_usage >&2
        return 2
      }
      if (( dry_run == 1 )); then
        wt_cleanup_dependency_materialization "$repo_root" "$worktree_path" dry-run
      else
        wt_cleanup_dependency_materialization "$repo_root" "$worktree_path" apply
      fi
      ;;
    gc-shared-images)
      if (( dry_run == 1 )); then
        wt_gc_shared_dependency_images "$repo_root" dry-run
      else
        wt_gc_shared_dependency_images "$repo_root" apply
      fi
      ;;
    *)
      echo "[wt-deps] unknown command: $command" >&2
      wt_dependency_materialization_usage >&2
      return 2
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  wt_dependency_materialization_cli "$@"
fi
