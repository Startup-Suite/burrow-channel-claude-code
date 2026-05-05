FROM node:22-bookworm-slim

# ── System deps ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      git \
      ca-certificates \
      gnupg \
      jq \
      unzip \
      tini \
    && rm -rf /var/lib/apt/lists/*

# ── gh CLI (apt) ─────────────────────────────────────────────────────────────
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
         | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
         | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ── Bun (for running the TS plugin directly) ─────────────────────────────────
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# ── Claude Code CLI ──────────────────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

# ── Channel plugin ───────────────────────────────────────────────────────────
# Build context is the repo root; Dockerfile lives under docker/.
WORKDIR /opt/claude-code-suite-channel
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./

# ── Entrypoint ───────────────────────────────────────────────────────────────
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
