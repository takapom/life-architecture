#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: platform/dev/worktree/down.sh [TASK_ID] [options]

Tear down a worktree-isolated app environment.

Options:
  --task-id <id>             Task/worktree id (default: first arg or cwd basename)
  --namespace <name>         Worktree namespace override
  --force-non-wt-namespace   Allow namespace override outside wt-* (dangerous)
  --release <name>           Worktree Helm release override
  --secret <name>            Worktree env secret name (default: omta-wt-env)
  --shared-namespace <name>  Shared infra namespace (default: omta-shared)
  --shared-release <name>    Shared infra Helm release (default: omta-shared)
  --mode <destroy|suspend>   Lifecycle mode (default: destroy)
  -h, --help                 Show help
USAGE
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

source "$ROOT_DIR/platform/dev/worktree/lib/wt-common.sh"
source "$ROOT_DIR/versions.env"

KUBECONFIG="$(wt_require_kubeconfig_path "$ROOT_DIR")"
export KUBECONFIG

wt_require_binary kubectl
wt_require_binary helm

lifecycle_mode="destroy"
force_non_wt_namespace=0
task_id=""

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
    --namespace)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --namespace" >&2
        exit 2
      }
      WT_NAMESPACE="$2"
      shift 2
      ;;
    --force-non-wt-namespace)
      force_non_wt_namespace=1
      shift
      ;;
    --release)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --release" >&2
        exit 2
      }
      WT_RELEASE="$2"
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
    --shared-release)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --shared-release" >&2
        exit 2
      }
      SHARED_RELEASE="$2"
      shift 2
      ;;
    --mode)
      [[ $# -ge 2 ]] || {
        echo "Missing value for --mode" >&2
        exit 2
      }
      lifecycle_mode="$2"
      shift 2
      ;;
    --purge-data)
      echo "[wt-down] --purge-data is retired; use --mode destroy (the default)." >&2
      exit 2
      ;;
    --keep-namespace)
      echo "[wt-down] --keep-namespace is retired; use --mode suspend." >&2
      exit 2
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
        echo "Unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

[[ -n "$task_id" ]] || {
  echo "TASK_ID is required." >&2
  usage >&2
  exit 2
}

case "$lifecycle_mode" in
  destroy|suspend) ;;
  *)
    echo "[wt-down] --mode must be one of: destroy, suspend" >&2
    exit 2
    ;;
esac

wt_derive_context "$task_id"

echo "[wt-down] task=$WT_TASK_ID namespace=$WT_NAMESPACE release=$WT_RELEASE mode=$lifecycle_mode"

if [[ ! "$WT_NAMESPACE" =~ ^wt-[a-z0-9-]+$ ]] && (( force_non_wt_namespace == 0 )); then
  echo "Refusing to delete non-worktree namespace: $WT_NAMESPACE" >&2
  echo "If this is intentional, re-run with --force-non-wt-namespace" >&2
  exit 2
fi
if [[ "$WT_NAMESPACE" =~ ^(default|kube-system|kube-public|kube-node-lease|omta-shared)$ ]]; then
  echo "Refusing to delete protected namespace: $WT_NAMESPACE" >&2
  exit 2
fi

if helm status "$WT_RELEASE" -n "$WT_NAMESPACE" >/dev/null 2>&1; then
  helm uninstall "$WT_RELEASE" -n "$WT_NAMESPACE"
  echo "[wt-down] uninstalled release $WT_RELEASE"
else
  echo "[wt-down] release $WT_RELEASE not found in namespace $WT_NAMESPACE"
fi

if [[ "$lifecycle_mode" == "destroy" ]]; then
  wt_purge_shared_data_resources "$WT_TASK_ID" "$MINIO_MC_IMAGE"
  kubectl delete namespace "$WT_NAMESPACE" --ignore-not-found >/dev/null || true
  echo "[wt-down] deleted namespace $WT_NAMESPACE"
else
  echo "[wt-down] suspended runtime; namespace and shared data preserved"
fi

echo "[wt-down] done"
