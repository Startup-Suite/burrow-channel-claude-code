# claude-code-suite-channel

A Claude Code [channels](https://code.claude.com/docs/en/channels) plugin for
[Startup Suite](https://github.com/Startup-Suite/core) federation.

When installed, Suite attention events (new messages, task dispatches, etc.)
arrive in your running Claude Code session as `<channel source="startup-suite"
…>` tags. Claude replies back through the channel via the `suite_reply`,
`suite_reply_with_media`, and `suite_typing` tools.

This plugin **does not expose Suite's tool surface** — tools live on the
`/mcp` endpoint in core (see ADR 0034 in `Startup-Suite/core`). Register
that separately with:

```bash
claude mcp add startup-suite --transport http https://<your-suite>/mcp \
  --header "Authorization: Bearer <runtime_token>"
```

The same `runtime_id` / `token` you use for MCP is the one this channel
plugin uses. No new credentials.

## Status

Research preview. Requires Claude Code v2.1.80+ and claude.ai login (API-key
auth is not supported for channels).

## Install (development)

Channel plugins need to be on the Anthropic allowlist to run under `--channels`.
Until this plugin is submitted and approved, use the development flag:

1. Clone and install deps:

   ```bash
   git clone https://github.com/Startup-Suite/claude-code-suite-channel.git
   cd claude-code-suite-channel
   bun install
   ```

2. Add a server entry to your project's `.mcp.json`:

   ```json
   {
     "mcpServers": {
       "suite-channel": {
         "command": "bun",
         "args": ["/absolute/path/to/claude-code-suite-channel/src/index.ts"],
         "env": {
           "SUITE_URL": "ws://127.0.0.1:4000/runtime/ws",
           "SUITE_RUNTIME_ID": "your-runtime-id",
           "SUITE_TOKEN": "your-runtime-token",
           "SUITE_ALLOW_PERMISSION_RELAY": "0"
         }
       }
     }
   }
   ```

3. Launch Claude Code with the development channel flag:

   ```bash
   claude --dangerously-load-development-channels server:suite-channel
   ```

   You should see the server join your runtime's channel in its stderr, and
   any attention event posted in the Suite space Claude's runtime participates
   in will arrive as a `<channel>` tag in your terminal.

## Capabilities

| Feature                   | Status | Notes                                                                 |
| ------------------------- | ------ | --------------------------------------------------------------------- |
| Attention → session       | ✅     | Posted as `<channel source="startup-suite" …>` with task/space meta   |
| Reply (text)              | ✅     | `suite_reply` tool                                                    |
| Reply with media          | ✅     | `suite_reply_with_media` tool, base64 attachments                     |
| Typing indicator          | ✅     | `suite_typing` tool                                                   |
| Reply chunks              | ✅     | `suite_reply_chunk` tool — cumulative-text progressive reveal          |
| Permission relay          | ✅     | Opt-in via `SUITE_ALLOW_PERMISSION_RELAY=1`                           |
| Presence                  | ✅     | Tracked by Suite via the WebSocket connection                         |
| Deduped messages          | ✅     | ~1s window to prevent double-delivery                                 |
| Session spawn by task_id  | ⛔     | Claude Code sessions are user-owned; see "Task-scoped work" below     |
| Execution events          | ⏳     | Planned (issue #3)                                                    |

## Reply chunking

Claude Code channel plugins can't observe Claude's raw token stream — only
tool calls. For long replies that benefit from progressive reveal in Suite,
Claude should call `suite_reply_chunk` several times with a stable `chunk_id`,
passing the **cumulative** text each time and `done:true` on the final call.

Short answers should keep using `suite_reply`. Chunking is for the kind of
multi-paragraph response where a single atomic drop feels jarring.

**Persistence:** Suite's `reply_chunk` is ephemeral (PubSub broadcast for the
LiveView UI; not persisted). The plugin's tool handler auto-fires a `reply`
on the final `done:true` chunk so the message lands in space history. Claude
only needs the one tool.

## Task-scoped work

The OpenClaw `startup-suite-channel` plugin spawns a new agent session keyed
to a task when Suite dispatches one. That pattern doesn't map to Claude Code
— sessions are started by the user, not the plugin.

Instead, this plugin tags attention events with `task_id` and `task_status`
meta. Claude's instructions encourage delegating task-scoped work to a
**sub-agent** (via the Task tool), keeping the main session unpinned while
the task runs with its own context.

## Permission relay

When `SUITE_ALLOW_PERMISSION_RELAY=1`, tool-approval prompts from Claude
Code are forwarded into the active Suite space as:

> Claude wants to run `Bash`: list files in cwd
>
> Reply "yes abcde" or "no abcde" to approve or deny.

Anyone with write access to the space can answer. Enable only when you trust
every participant with that authority. The local terminal dialog stays open
so you can still answer there — first verdict to arrive wins.

## Security model

- The plugin authenticates to Suite with the federation `runtime_id` + `token`
  you generate in Suite's Agent Resources UI. The same record gates both this
  channel and the `/mcp` endpoint.
- There is no additional sender allowlist: the Suite WebSocket connection is
  the trust boundary. Suite's own access control decides which spaces/messages
  reach your runtime.
- For permission relay, the trust boundary is every Suite participant in the
  active space. Opt in deliberately.

## License

MIT
