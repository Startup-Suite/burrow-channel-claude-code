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
WORKDIR /opt/burrow-channel-claude-code
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY tsconfig.json ./

# The image carries src/ WITHOUT .git, so the plugin cannot resolve its own
# commit at runtime. docker/run.sh passes the sha of the checkout this image
# was built from; src/build-identity.ts reports it as client_info.build.
# Unset (a bare `docker build`) means the plugin reports build_error instead.
# BURROW_CHANNEL_BUILD is read first; SUITE_CHANNEL_BUILD stays set for an
# older run.sh that passes only that build arg.
ARG BURROW_CHANNEL_BUILD=""
ARG SUITE_CHANNEL_BUILD=""
ENV BURROW_CHANNEL_BUILD=${BURROW_CHANNEL_BUILD}
ENV SUITE_CHANNEL_BUILD=${SUITE_CHANNEL_BUILD}

# ── Entrypoint ───────────────────────────────────────────────────────────────
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
