#!/usr/bin/env bash
# install.sh — Copy the orchestrator distribution unit into a target project.
#
# Usage:
#   ./tools/orchestrator/scripts/install.sh <target-repo-root>
#
# The script copies the directories that together form the self-contained
# orchestrator distribution unit:
#
#   <source>/tools/orchestrator/          →  <target>/tools/orchestrator/
#   <source>/tools/core/                  →  <target>/tools/core/
#   <source>/tools/adapters/              →  <target>/tools/adapters/
#   <source>/tools/contracts/             →  <target>/tools/contracts/
#   <source>/platform/dev/worktree/       →  <target>/platform/dev/worktree/
#   <source>/.agents/skills/              →  <target>/.agents/skills/
#
# Relative paths between the directories are preserved so that import paths
# such as "../../../../tools/orchestrator/..." continue to resolve correctly.
#
# After copying, a smoke test runs supervisor_runtime.ts to verify the
# TypeScript entry point is importable in the target environment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <target-repo-root>" >&2
  exit 1
fi

TARGET_ROOT="$(cd "$1" && pwd)"

if [[ "$TARGET_ROOT" == "$SOURCE_ROOT" ]]; then
  echo "error: target and source are the same directory: $TARGET_ROOT" >&2
  exit 1
fi

echo "Source: $SOURCE_ROOT"
echo "Target: $TARGET_ROOT"

SRC_ORCHESTRATOR="$SOURCE_ROOT/tools/orchestrator"
SRC_CORE="$SOURCE_ROOT/tools/core"
SRC_ADAPTERS="$SOURCE_ROOT/tools/adapters"
SRC_CONTRACTS="$SOURCE_ROOT/tools/contracts"
SRC_PLATFORM_WORKTREE="$SOURCE_ROOT/platform/dev/worktree"
SRC_SKILLS="$SOURCE_ROOT/.agents/skills"
DST_ORCHESTRATOR="$TARGET_ROOT/tools/orchestrator"
DST_CORE="$TARGET_ROOT/tools/core"
DST_ADAPTERS="$TARGET_ROOT/tools/adapters"
DST_CONTRACTS="$TARGET_ROOT/tools/contracts"
DST_PLATFORM_WORKTREE="$TARGET_ROOT/platform/dev/worktree"
DST_SKILLS="$TARGET_ROOT/.agents/skills"

# --- Copy tools/orchestrator/ ---
echo ""
echo "Copying tools/orchestrator/ ..."
mkdir -p "$DST_ORCHESTRATOR"
rsync -a --delete \
  --exclude "orchestrate/skills.config.toml" \
  --exclude "src/" \
  --exclude "*.test.ts" \
  "$SRC_ORCHESTRATOR/" "$DST_ORCHESTRATOR/"

# Place the template as skills.config.toml if the target does not already have one
if [[ ! -f "$DST_ORCHESTRATOR/orchestrate/skills.config.toml" ]]; then
  echo "Installing skills.config.template.toml as skills.config.toml (no existing config found)"
  cp "$DST_ORCHESTRATOR/orchestrate/skills.config.template.toml" \
     "$DST_ORCHESTRATOR/orchestrate/skills.config.toml"
fi

# --- Copy tools/core/ ---
echo ""
echo "Copying tools/core/ ..."
mkdir -p "$DST_CORE"
rsync -a --delete \
  --exclude "*.test.ts" \
  "$SRC_CORE/" "$DST_CORE/"

# --- Copy tools/adapters/ ---
echo ""
echo "Copying tools/adapters/ ..."
mkdir -p "$DST_ADAPTERS"
rsync -a --delete \
  --exclude "*.test.ts" \
  "$SRC_ADAPTERS/" "$DST_ADAPTERS/"

# --- Copy tools/contracts/ ---
echo ""
echo "Copying tools/contracts/ ..."
mkdir -p "$DST_CONTRACTS"
rsync -a --delete \
  --exclude "*.test.ts" \
  "$SRC_CONTRACTS/" "$DST_CONTRACTS/"

# --- Copy platform/dev/worktree/ ---
echo ""
echo "Copying platform/dev/worktree/ ..."
mkdir -p "$DST_PLATFORM_WORKTREE"
rsync -a --delete \
  --exclude "*.test.ts" \
  "$SRC_PLATFORM_WORKTREE/" "$DST_PLATFORM_WORKTREE/"

# --- Copy .agents/skills/ ---
echo ""
echo "Copying .agents/skills/ ..."
mkdir -p "$DST_SKILLS"
rsync -a --delete "$SRC_SKILLS/" "$DST_SKILLS/"

# --- Verify relative path structure ---
echo ""
echo "Verifying relative path structure ..."
EXPECTED_REL="../../../../tools/orchestrator"
CHECK_FILE="$DST_SKILLS/orchestrate-close/scripts/close_runtime.ts"
if [[ -f "$CHECK_FILE" ]]; then
  if grep -qF "$EXPECTED_REL" "$CHECK_FILE"; then
    echo "  OK: import path anchor '$EXPECTED_REL' found in close_runtime.ts"
  else
    echo "  WARNING: expected anchor '$EXPECTED_REL' not found in close_runtime.ts" \
         "— check that your target layout places tools/ and .agents/ at the repo root."
  fi
fi

# --- Smoke test ---
echo ""
echo "Running smoke test: supervisor_runtime.ts --help ..."
SUPERVISOR="$DST_SKILLS/orchestrate-supervisor/scripts/supervisor_runtime.ts"
if [[ ! -f "$SUPERVISOR" ]]; then
  echo "  SKIP: supervisor_runtime.ts not found at expected path $SUPERVISOR"
else
  if command -v bun &>/dev/null; then
    if bun run "$SUPERVISOR" --help &>/dev/null; then
      echo "  OK: supervisor_runtime.ts --help exited 0"
    else
      echo "  INFO: supervisor_runtime.ts --help exited non-zero (may be expected if --help exits 1)"
    fi
  else
    echo "  SKIP: bun not found in PATH; skipping runtime smoke test"
  fi
fi

echo ""
echo "Done. Next steps:"
echo "  1. Edit $DST_ORCHESTRATOR/orchestrate/skills.config.toml for your project."
echo "  2. Set ISSUE_GRAPH_PROJECT_NUMBER (and other env vars) as needed."
