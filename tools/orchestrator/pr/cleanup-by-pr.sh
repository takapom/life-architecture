#!/usr/bin/env bash
set -euo pipefail

exec bun run pr:merge:safe -- --cleanup-only "$@"
