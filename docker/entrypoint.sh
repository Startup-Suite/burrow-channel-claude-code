#!/usr/bin/env bash
set -euo pipefail

: "${SUITE_URL:?SUITE_URL is required}"
: "${SUITE_RUNTIME_ID:?SUITE_RUNTIME_ID is required}"
: "${SUITE_TOKEN:?SUITE_TOKEN is required}"

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
mkdir -p "$WORKSPACE_DIR"
cd "$WORKSPACE_DIR"

# Write .mcp.json so Claude Code knows how to spawn our plugin as a local
# development channel server.
cat > "$WORKSPACE_DIR/.mcp.json" <<EOF
{
  "mcpServers": {
    "suite-channel": {
      "command": "bun",
      "args": ["/opt/claude-code-suite-channel/src/index.ts"],
      "env": {
        "SUITE_URL": "$SUITE_URL",
        "SUITE_RUNTIME_ID": "$SUITE_RUNTIME_ID",
        "SUITE_TOKEN": "$SUITE_TOKEN",
        "SUITE_ALLOW_PERMISSION_RELAY": "${SUITE_ALLOW_PERMISSION_RELAY:-0}"
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
# a plan is approved in Suite, execution runs without per-action prompts.
# --dangerously-load-development-channels is required until the channel
# plugin is published on Anthropic's marketplace.
exec claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels server:suite-channel \
  "$@"
