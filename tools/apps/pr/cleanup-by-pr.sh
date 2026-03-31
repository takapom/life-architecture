#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tools_root=$(cd "${script_dir}/../.." && pwd)
exec bash "${tools_root}/orchestrator/pr/cleanup-by-pr.sh" "$@"
