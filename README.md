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

## Running as an autonomous worker

For task-execution lanes (plan → execute → review → deploy) you want Claude
running unattended. See [`docker/README.md`](./docker/README.md) for a
containerized setup with `--dangerously-skip-permissions`, mounted
credentials, and GitHub access.

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
| Reply annotations         | ✅     | Optional `in_reply_to_message_id` + `context` on the reply tools      |
| Permission relay          | ✅     | Opt-in via `SUITE_ALLOW_PERMISSION_RELAY=1`                           |
| Presence                  | ✅     | Tracked by Suite via the WebSocket connection                         |
| Deduped messages          | ✅     | ~1s window to prevent double-delivery                                 |
| Meeting transcripts       | ✅     | `meeting_transcript` frames posted with `reason="meeting_transcript"`  |
| Session spawn by task_id  | ⛔     | Claude Code sessions are user-owned; see "Task-scoped work" below     |
| Execution events          | ⏳     | Planned (issue #3)                                                    |

## Reply annotations

`suite_reply`, `suite_reply_with_media` and the final (`done:true`)
`suite_reply_chunk` accept two optional fields:

- `in_reply_to_message_id`: the `message_id` attribute of the channel tag the
  reply answers. Suite links the reply to that message.
- `context`: one line, at most 200 characters, saying what the reply answers,
  for a reader arriving hours later.

Suite validates both. An invalid one is not stored, but the message still
posts; the tool result then names the refused field and Suite's reason (for
example `in_reply_to_message_id (not_found)`). Non-final chunks carry neither.

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

## Meeting transcripts

When the agent's runtime is in a LiveKit meeting, core broadcasts one
`meeting_transcript` frame per **final** transcript segment on the runtime
channel (contract: `docs/contracts/meeting-transcript-frame.md` in core). The
plugin delivers each one to the session as an inbound channel message:

```
<channel source="startup-suite" reason="meeting_transcript"
         room_name="space-…" meeting_id="…" segment_id="…"
         speaker_kind="human" author="Ryan"
         participant_identity="user:…" spoken_at="2026-09-03T10:31:07.412Z">
Can one of you pick up the deploy?
</channel>
```

`author` is the speaker's display name, falling back to
`participant_identity` when core has none. `speaker_kind="agent"` frames are
other agents; the agent never receives its own segments.

**Coalescing.** Speech-to-text emits a sentence at a time. Consecutive
segments from the same `participant_identity` in the same `room_name` that
arrive within 1.5 s of each other are joined into one message (texts joined
by a single space, in arrival order). The burst is delivered 1.5 s after its
last segment; a segment from a different speaker or room delivers any pending
burst first, so order is preserved. A joined message carries the **first**
segment's `segment_id` and `spoken_at`, plus `segment_ids` listing every id
comma-joined. Anything pending is flushed on disconnect.

The plugin never replies on its own and calls no tool. To speak in the room
the agent uses the `meeting_say` tool on the hosted Suite MCP server (the
`/mcp` endpoint above), passing `room_name` / `meeting_id` from the tag; core
enforces the per-minute reply budget and the agent-to-agent chain depth.
Frames missing `text` or `room_name` are dropped with a stderr log.

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
