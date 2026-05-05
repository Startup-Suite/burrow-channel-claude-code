# Docker worker

A containerized Claude Code worker that federates with a Startup Suite
instance as an **autonomous execution lane**, separate from any interactive
Claude Code session you run for chat.

The container runs `claude` with `--dangerously-skip-permissions`, on the
assumption that the plan-approval gate in Suite is the trust boundary, not
per-action prompts. The sandbox IS the container — limit the blast radius
by what you mount in.

## Prerequisites

- Docker 24+ (Docker Desktop, OrbStack, Colima, etc.)
- A Claude Code account signed in on the host: run `claude login` once. The
  container mounts `~/.claude/` so it inherits that session.
- A runtime record in Suite (Agent Resources → Federation → Runtimes) linked
  to a worker agent. You'll need the `runtime_id` + raw token it issues.
- (Optional) `gh` CLI authenticated on the host (`gh auth login`), **or** a
  GitHub PAT set as `GH_TOKEN`.

## Setup

```bash
cd docker
cp .env.example .env
$EDITOR .env        # fill SUITE_URL, SUITE_RUNTIME_ID, SUITE_TOKEN at minimum
```

## Run

From the project you want the worker to operate on:

```bash
/path/to/claude-code-suite-channel/docker/run.sh
```

First run builds the image (once). Subsequent runs reuse it. Force a rebuild
with `./run.sh --rebuild`.

The default mounts:

| Host                 | Container                | Mode | Purpose                         |
| -------------------- | ------------------------ | ---- | ------------------------------- |
| `$PWD`               | `/workspace`             | rw   | The project the worker works in |
| `~/.claude`          | `/root/.claude`          | rw   | Claude Code auth + session      |
| `~/.config/gh`       | `/root/.config/gh`       | ro   | gh CLI auth (if present)        |
| `~/.gitconfig`       | `/root/.gitconfig`       | ro   | Git user.name / user.email      |
| `~/.ssh/known_hosts` | `/root/.ssh/known_hosts` | ro   | Prevents SSH host-key prompts   |

Override the workspace with `WORKER_WORKSPACE=/path/to/repo` in `.env`.
Add extra mounts with `SUITE_WORKER_EXTRA_MOUNTS` (space-separated mount
specs) — useful for shared credential stores or artifact directories.

## GitHub access inside the container

Two paths:

1. **Mount `gh` auth (default).** Run `gh auth login` once on the host. The
   entrypoint runs `gh auth setup-git` so git pushes use gh's OAuth token
   without needing SSH keys forwarded.

2. **`GH_TOKEN` env var.** Set it in `.env`. The entrypoint runs
   `gh auth login --with-token` on startup. Useful for CI-like setups
   where you don't have a host-side gh session.

SSH-based git (not recommended) requires forwarding `~/.ssh` manually with
`SUITE_WORKER_EXTRA_MOUNTS="source=$HOME/.ssh,target=/root/.ssh,readonly"`.

## Debugging

Start a shell inside the container without launching Claude:

```bash
./run.sh shell
```

Tail the channel plugin's WebSocket activity by running
`bun /opt/claude-code-suite-channel/src/index.ts` inside that shell with your
env vars — the plugin logs `[suite-client] joined runtime:<id>` when
federation connects.

## Permissions model

The worker runs with `--dangerously-skip-permissions`. This is the correct
posture for an autonomous execution lane:

- Trust is established at plan-approval time in Suite, not per action.
- Blast radius is the container's mounts — it can only touch what you
  mounted in.
- Nothing outside the container is writable unless you added a bind mount.

If you want an approval loop for a specific class of actions, disable
`--dangerously-skip-permissions` in `docker/entrypoint.sh` and enable
`SUITE_ALLOW_PERMISSION_RELAY=1` in `.env` — prompts will forward into the
Suite space where the task was dispatched, and a reviewer agent or human
can approve with `yes <id>` / `no <id>`.

## Running multiple workers

One container per runtime_id. Spin up additional workers with different
`.env` files:

```bash
SUITE_WORKER_ENV_FILE=./planner.env ./run.sh
SUITE_WORKER_ENV_FILE=./deployer.env ./run.sh
```

Each gets a unique container name (`suite-worker-<runtime_id>`) and its own
federation identity, so Suite's task router dispatches to the right one.

## Shutting down

Ctrl-C detaches and stops the container (the entrypoint uses `tini` so
signals propagate cleanly to Claude and the plugin). `docker stop
suite-worker-<runtime_id>` from another terminal works too.

## What's not in scope

- Full network isolation — the container uses Docker's default bridge, so
  it can reach anything your host can. For stricter isolation, start the
  container on a user-defined network with explicit `--add-host` rules.
- Multi-arch publishing — the Dockerfile builds for whatever arch `docker
  build` targets. Fine for local dev.
- Auto-update of the plugin inside a running container. `./run.sh --rebuild`
  from a fresh checkout.
