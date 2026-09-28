#!/usr/bin/env bash
# Usage: docker/run.sh [--rebuild] [-- <extra claude args>]
#
# Starts a containerized Claude Code worker federated with a Suite instance.
# Reads config from docker/.env (copy .env.example as a starting point) or the
# ambient environment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="${SUITE_WORKER_IMAGE:-claude-code-suite-worker:latest}"
ENV_FILE="${SUITE_WORKER_ENV_FILE:-$SCRIPT_DIR/.env}"

# ── Parse flags ─────────────────────────────────────────────────────────────
REBUILD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild) REBUILD=1; shift ;;
    --) shift; break ;;
    *) break ;;
  esac
done

# ── Load env ────────────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

: "${SUITE_URL:?SUITE_URL must be set (in $ENV_FILE or environment)}"
: "${SUITE_RUNTIME_ID:?SUITE_RUNTIME_ID must be set}"
: "${SUITE_TOKEN:?SUITE_TOKEN must be set}"

WORKSPACE="${WORKER_WORKSPACE:-$PWD}"
if [[ ! -d "$WORKSPACE" ]]; then
  echo "[run] workspace not found: $WORKSPACE" >&2
  exit 1
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"
CONTAINER_NAME="${SUITE_WORKER_CONTAINER:-suite-worker-${SUITE_RUNTIME_ID}}"

# ── Build image ─────────────────────────────────────────────────────────────
if [[ "$REBUILD" -eq 1 ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  # Stamp the commit being built so the plugin can report it as
  # client_info.build (the image has no .git). Same rule as
  # src/build-identity.ts: -dirty when tracked files differ from HEAD.
  BUILD_SHA=""
  if BUILD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"; then
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no)" ]]; then
      BUILD_SHA="${BUILD_SHA}-dirty"
    fi
  else
    BUILD_SHA=""
    echo "[run] warning: $REPO_ROOT is not a git checkout; the worker will report build_error instead of a build" >&2
  fi
  echo "[run] building $IMAGE (build=${BUILD_SHA:-unresolved})"
  docker build -t "$IMAGE" -f "$SCRIPT_DIR/Dockerfile" \
    --build-arg "SUITE_CHANNEL_BUILD=${BUILD_SHA}" "$REPO_ROOT"
fi

# ── Clean up stale container ────────────────────────────────────────────────
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# ── Mounts ──────────────────────────────────────────────────────────────────
MOUNTS=(
  --mount "type=bind,source=${WORKSPACE},target=/workspace"
)

# Claude Code auth state (claude.ai login). Read-write so token refreshes work.
if [[ -d "$HOME/.claude" ]]; then
  MOUNTS+=(--mount "type=bind,source=${HOME}/.claude,target=/root/.claude")
else
  echo "[run] warning: $HOME/.claude not found — run \`claude login\` on the host once before starting a worker" >&2
fi

# gh CLI auth (optional; GH_TOKEN env var is an alternative)
if [[ -d "$HOME/.config/gh" ]]; then
  MOUNTS+=(--mount "type=bind,source=${HOME}/.config/gh,target=/root/.config/gh,readonly")
fi

# Git user/config (optional but nice)
if [[ -f "$HOME/.gitconfig" ]]; then
  MOUNTS+=(--mount "type=bind,source=${HOME}/.gitconfig,target=/root/.gitconfig,readonly")
fi

# Known hosts for SSH remotes (optional — GH_TOKEN is simpler than SSH keys)
if [[ -f "$HOME/.ssh/known_hosts" ]]; then
  MOUNTS+=(--mount "type=bind,source=${HOME}/.ssh/known_hosts,target=/root/.ssh/known_hosts,readonly")
fi

# Optional extra mounts — SUITE_WORKER_EXTRA_MOUNTS="src=/a,target=/b src=/c,target=/d"
if [[ -n "${SUITE_WORKER_EXTRA_MOUNTS:-}" ]]; then
  # shellcheck disable=SC2206
  EXTRAS=(${SUITE_WORKER_EXTRA_MOUNTS})
  for m in "${EXTRAS[@]}"; do
    MOUNTS+=(--mount "type=bind,$m")
  done
fi

# ── Network ─────────────────────────────────────────────────────────────────
# Add host.docker.internal on Linux too so Suite at 127.0.0.1 on the host
# works the same as on Mac/Windows.
NETWORK_ARGS=(--add-host "host.docker.internal:host-gateway")

# ── Launch ──────────────────────────────────────────────────────────────────
echo "[run] starting $CONTAINER_NAME (runtime=$SUITE_RUNTIME_ID workspace=$WORKSPACE)"

docker run --rm -it \
  --name "$CONTAINER_NAME" \
  -e SUITE_URL \
  -e SUITE_RUNTIME_ID \
  -e SUITE_TOKEN \
  -e SUITE_ALLOW_PERMISSION_RELAY \
  -e GH_TOKEN \
  "${MOUNTS[@]}" \
  "${NETWORK_ARGS[@]}" \
  "$IMAGE" \
  "$@"
