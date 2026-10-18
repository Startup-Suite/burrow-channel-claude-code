#!/usr/bin/env bash
set -euo pipefail

# Every name is read BURROW_* first and SUITE_* second (a container started
# by an older run.sh passes SUITE_* only). .mcp.json below gets BOTH names, so
# the plugin finds its config whichever spelling its build reads.
burrow_env() {
  local next="BURROW_$1" old="SUITE_$1"
  if [[ -n "${!next:-}" ]]; then
    printf '%s' "${!next}"
  elif [[ -n "${!old:-}" ]]; then
    echo "[worker] $old is deprecated; set $next" >&2
    printf '%s' "${!old}"
  fi
}

CHANNEL_URL="$(burrow_env URL)"
CHANNEL_RUNTIME_ID="$(burrow_env RUNTIME_ID)"
CHANNEL_TOKEN="$(burrow_env TOKEN)"
CHANNEL_RELAY="$(burrow_env ALLOW_PERMISSION_RELAY)"
CHANNEL_RELAY="${CHANNEL_RELAY:-0}"
: "${CHANNEL_URL:?BURROW_URL is required (the deprecated SUITE_URL is also accepted)}"
: "${CHANNEL_RUNTIME_ID:?BURROW_RUNTIME_ID is required (the deprecated SUITE_RUNTIME_ID is also accepted)}"
: "${CHANNEL_TOKEN:?BURROW_TOKEN is required (the deprecated SUITE_TOKEN is also accepted)}"

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# Write .mcp.json so Claude Code knows how to spawn our plugin as a local
# development channel server. The `suite-channel` key is deliberately kept: it
# sets the <channel source=...> attribute, the mcp__suite-channel__* tool
# prefix that permission allowlists name, and the server:suite-channel flag
# below.
cat > "$WORKSPACE_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "suite-channel": {
      "command": "bun",
      "args": ["/opt/burrow-channel-claude-code/src/index.ts"],
      "env": {
        "BURROW_URL": "$CHANNEL_URL",
        "BURROW_RUNTIME_ID": "$CHANNEL_RUNTIME_ID",
        "BURROW_TOKEN": "$CHANNEL_TOKEN",
        "BURROW_ALLOW_PERMISSION_RELAY": "$CHANNEL_RELAY",
        "SUITE_URL": "$CHANNEL_URL",
        "SUITE_RUNTIME_ID": "$CHANNEL_RUNTIME_ID",
        "SUITE_TOKEN": "$CHANNEL_TOKEN",
        "SUITE_ALLOW_PERMISSION_RELAY": "$CHANNEL_RELAY"
      }
    }
  }
}
EOF

# ── gh auth ──────────────────────────────────────────────────────────────────
# Prefer a pre-authed $HOME/.config/gh mount if present; otherwise use GH_TOKEN.
if [[ -n "${GH_TOKEN:-}" && ! -d "$HOME/.config/gh" ]]; then
  echo "$GH_TOKEN" | gh auth login --with-token >/dev/null 2>&1 || {
    echo "[worker] gh auth login failed; continuing without gh auth" >&2
  }
fi

# Expose gh's token to git so pushes work without SSH key forwarding.
if gh auth status >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || true
fi

# ── Debug bail-out ───────────────────────────────────────────────────────────
if [[ "${1:-}" == "shell" ]]; then
  exec bash
fi

# ── Launch Claude Code ───────────────────────────────────────────────────────
# --dangerously-skip-permissions because the sandbox IS the container: once
# a plan is approved in Burrow, execution runs without per-action prompts.
# --dangerously-load-development-channels is required until the channel
# plugin is published on Anthropic's marketplace.
exec claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:suite-channel \
  "$@"
