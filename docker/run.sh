#!/usr/bin/env bash
# Usage: docker/run.sh [--rebuild] [-- <extra claude args>]
#
# Starts a containerized Claude Code worker federated with a Burrow instance.
# Reads config from docker/.env (copy .env.example as a starting point) or the
# ambient environment.
#
# Every name is read BURROW_* first and SUITE_* second, so a docker/.env
# written before the Burrow rename (SUITE_* only) keeps working; each fallback
# prints one deprecation line on stderr. The container receives BOTH names, so
# an image built from an older checkout still finds what it reads.
set -euo pipefail

# burrow_env NAME: print BURROW_NAME if non-empty, else SUITE_NAME (warning
# once on stderr), else nothing.
burrow_env() {
  local next="BURROW_$1" old="SUITE_$1"
  if [[ -n "${!next:-}" ]]; then
    printf '%s' "${!next}"
  elif [[ -n "${!old:-}" ]]; then
    echo "[run] $old is deprecated; set $next" >&2
    printf '%s' "${!old}"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="$(burrow_env WORKER_IMAGE)"
IMAGE="${IMAGE:-claude-code-suite-worker:latest}"
ENV_FILE="$(burrow_env WORKER_ENV_FILE)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/.env}"

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

for name in URL RUNTIME_ID TOKEN; do
  value="$(burrow_env "$name")"
  if [[ -z "$value" ]]; then
    echo "[run] BURROW_$name must be set (in $ENV_FILE or environment; the deprecated SUITE_$name is also accepted)" >&2
    exit 1
  fi
  # Export both spellings: the container gets the value whichever one the
  # image's plugin build reads.
  export "BURROW_$name=$value" "SUITE_$name=$value"
done
RELAY="$(burrow_env ALLOW_PERMISSION_RELAY)"
if [[ -n "$RELAY" ]]; then
  export "BURROW_ALLOW_PERMISSION_RELAY=$RELAY" "SUITE_ALLOW_PERMISSION_RELAY=$RELAY"
fi

WORKSPACE="${WORKER_WORKSPACE:-$PWD}"
if [[ ! -d "$WORKSPACE" ]]; then
  echo "[run] workspace not found: $WORKSPACE" >&2
  exit 1
fi
WORKSPACE="$(cd "$WORKSPACE" && pwd)"
CONTAINER_NAME="$(burrow_env WORKER_CONTAINER)"
CONTAINER_NAME="${CONTAINER_NAME:-suite-worker-${BURROW_RUNTIME_ID}}"

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
    --build-arg "BURROW_CHANNEL_BUILD=${BUILD_SHA}" \
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

# Optional extra mounts — BURROW_WORKER_EXTRA_MOUNTS="src=/a,target=/b src=/c,target=/d"
EXTRA_MOUNTS="$(burrow_env WORKER_EXTRA_MOUNTS)"
if [[ -n "$EXTRA_MOUNTS" ]]; then
  # shellcheck disable=SC2206
  EXTRAS=(${EXTRA_MOUNTS})
  for m in "${EXTRAS[@]}"; do
    MOUNTS+=(--mount "type=bind,$m")
  done
fi

# ── Network ─────────────────────────────────────────────────────────────────
# Add host.docker.internal on Linux too so Burrow at 127.0.0.1 on the host
# works the same as on Mac/Windows.
NETWORK_ARGS=(--add-host "host.docker.internal:host-gateway")

# ── Launch ──────────────────────────────────────────────────────────────────
echo "[run] starting $CONTAINER_NAME (runtime=$BURROW_RUNTIME_ID workspace=$WORKSPACE)"

docker run --rm -it \
  --name "$CONTAINER_NAME" \
  -e BURROW_URL \
  -e SUITE_URL \
  -e BURROW_RUNTIME_ID \
  -e SUITE_RUNTIME_ID \
  -e BURROW_TOKEN \
  -e SUITE_TOKEN \
  -e BURROW_ALLOW_PERMISSION_RELAY \
  -e SUITE_ALLOW_PERMISSION_RELAY \
  -e GH_TOKEN \
  "${MOUNTS[@]}" \
  "${NETWORK_ARGS[@]}" \
  "$IMAGE" \
  "$@"
