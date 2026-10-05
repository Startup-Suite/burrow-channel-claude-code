#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SuiteClient } from "./suite-client.ts";
import { makeEmitAttention } from "./attention.ts";
import { callTool, REPLY_EXTRAS_INSTRUCTION, TOOL_DEFINITIONS } from "./tools.ts";
import { makeMeetingTranscriptEmitter } from "./meeting-transcript.ts";
import { resolveStartupConfig, StartupError, type StartupConfig } from "./startup-config.ts";
import { writeChannelState } from "./channel-state.ts";

// ── Configuration ──────────────────────────────────────────────────────────
//
// SUITE_TOKEN may be a token REF (`keychain:<item>` with
// SUITE_TOKEN_KEYCHAIN_SERVICE, or `file:<absolute path>`), resolved here, in
// memory, before anything connects. A literal still works. A refusal names the
// ref and never a value (src/token-ref.ts, suite-cli spec/token-ref.md).

let startup: StartupConfig;
try {
  startup = await resolveStartupConfig(process.env);
} catch (e) {
  console.error(`[claude-code-suite-channel] ${e instanceof StartupError ? e.message : "startup failed"}`);
  process.exit(1);
}
const SUITE_URL = startup.url;
const SUITE_RUNTIME_ID = startup.runtimeId;
const SUITE_TOKEN = startup.token;
const ALLOW_PERMISSION_RELAY = startup.allowPermissionRelay;

// ── MCP server ─────────────────────────────────────────────────────────────

const experimental: Record<string, Record<string, unknown>> = {
  "claude/channel": {},
};
if (ALLOW_PERMISSION_RELAY) {
  experimental["claude/channel/permission"] = {};
}

const instructions = [
  'Messages arrive from Startup Suite as <channel source="startup-suite" space_id="..." message_id="..." task_id="..." reason="..." author="..." author_id="...">.',
  "Reply with the `suite_reply` tool, passing the `space_id` attribute from the inbound tag.",
  "To attach files, use `suite_reply_with_media` (attachments are base64-encoded).",
  "For long or multi-step replies, use `suite_reply_chunk` instead: generate one `chunk_id` at the start, then call the tool repeatedly with the cumulative `text` and `done:false`, finishing with `done:true`. This gives Suite readers progressive reveal instead of a single big block.",
  REPLY_EXTRAS_INSTRUCTION,
  "Always call `suite_typing` with `typing: true` immediately before composing any reply — short or long — so the human can see you are working. Suite clears the indicator automatically when your reply arrives, so you do not normally need to send `typing: false`; only send it if you decide not to reply after all.",
  "Task-scoped work: the inbound tag carries task_id when Suite is dispatching a task. Consider delegating to a sub-agent (Task tool) scoped to that task so the main session stays oriented.",
  'Meeting transcript segments arrive as <channel source="startup-suite" reason="meeting_transcript" room_name="..." meeting_id="..." segment_id="..." speaker_kind="..." author="..." participant_identity="..." spoken_at="...">; the body is what was said (consecutive sentences from one speaker are joined into one message, with every segment id in segment_ids).',
  "To speak in the room, call the `meeting_say` tool on the hosted Suite MCP server (it is not part of this plugin), passing the room_name and meeting_id from the tag. If it fails with code reply_budget_exhausted, stop speaking for the rest of the minute and post whatever you still had to say as a chat message with `suite_reply` instead of retrying. If it fails with code agent_chain_too_deep, wait for a frame with speaker_kind=\"human\" in that room before speaking again.",
  'Frames with speaker_kind="agent" are other agents talking; it is fine not to answer them.',
  ALLOW_PERMISSION_RELAY
    ? 'Remote permission approval is enabled: a Suite collaborator can reply "yes <id>" or "no <id>" to approve/deny tool use. Only trust this when you trust every participant in the space.'
    : "",
]
  .filter(Boolean)
  .join(" ");

const mcp = new Server(
  { name: "startup-suite", version: "0.1.0" },
  {
    capabilities: { experimental, tools: {} },
    instructions,
  },
);

// ── Outbound tools ─────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) =>
  callTool(suite, req.params.name, req.params.arguments),
);

// ── Permission relay ───────────────────────────────────────────────────────

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// Tracks the space we'd route permission prompts back to. The first attention
// event pins it; subsequent attention updates it. v1 is single-space-at-a-time.
let activePermissionSpace: string | null = null;

if (ALLOW_PERMISSION_RELAY) {
  mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
    if (!activePermissionSpace) return;
    const prompt =
      `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
      `Reply "yes ${params.request_id}" or "no ${params.request_id}" to approve or deny.`;
    suite.sendReply(activePermissionSpace, prompt);
  });
}

// ── Attention bridge ───────────────────────────────────────────────────────

const emitAttention = makeEmitAttention({
  notify: (n) => mcp.notification(n),
  allowPermissionRelay: ALLOW_PERMISSION_RELAY,
  setActivePermissionSpace: (spaceId) => {
    activePermissionSpace = spaceId;
  },
});

// ── Meeting transcript bridge ──────────────────────────────────────────────

const meetingTranscripts = makeMeetingTranscriptEmitter({
  notify: (n) => mcp.notification(n),
});

// ── Startup ────────────────────────────────────────────────────────────────

const suite = new SuiteClient(
  {
    url: SUITE_URL,
    runtimeId: SUITE_RUNTIME_ID,
    token: SUITE_TOKEN,
  },
  {
    onAttention: (payload) => {
      void emitAttention(payload).catch((err) => {
        console.error("[claude-code-suite-channel] attention handler error:", err);
      });
    },
    onJoined: () => {
      writeChannelState(process.env, SUITE_RUNTIME_ID, "joined");
    },
    onDisconnect: () => {
      writeChannelState(process.env, SUITE_RUNTIME_ID, "disconnected");
      console.error("[claude-code-suite-channel] disconnected from Suite");
      // A burst caught mid-window must not wait for a reconnect that may
      // never come — and must not be lost if it does.
      meetingTranscripts.flush();
    },
    onMeetingTranscript: (frame) => {
      meetingTranscripts.handle(frame);
    },
    onSpacesManifest: (spaces) => {
      console.error(`[claude-code-suite-channel] spaces_manifest: ${spaces.length} spaces`);
    },
  },
);

await mcp.connect(new StdioServerTransport());
suite.connect();

// Clean shutdown
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    meetingTranscripts.flush();
    writeChannelState(process.env, SUITE_RUNTIME_ID, "disconnected");
    suite.disconnect();
    process.exit(0);
  });
}
