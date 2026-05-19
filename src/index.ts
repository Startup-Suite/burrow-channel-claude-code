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

// ── Configuration ──────────────────────────────────────────────────────────

const SUITE_URL = process.env.SUITE_URL;
const SUITE_RUNTIME_ID = process.env.SUITE_RUNTIME_ID;
const SUITE_TOKEN = process.env.SUITE_TOKEN;
const ALLOW_PERMISSION_RELAY = process.env.SUITE_ALLOW_PERMISSION_RELAY === "1";

if (!SUITE_URL || !SUITE_RUNTIME_ID || !SUITE_TOKEN) {
  console.error(
    "[claude-code-suite-channel] missing env: SUITE_URL, SUITE_RUNTIME_ID, SUITE_TOKEN are all required",
  );
  process.exit(1);
}

// ── MCP server ─────────────────────────────────────────────────────────────

const experimental: Record<string, Record<string, unknown>> = {
  "claude/channel": {},
};
if (ALLOW_PERMISSION_RELAY) {
  experimental["claude/channel/permission"] = {};
}

const instructions = [
  'Messages arrive from Startup Suite as <channel source="startup-suite" space_id="..." task_id="..." reason="..." author="..." author_id="...">.',
  "Reply with the `suite_reply` tool, passing the `space_id` attribute from the inbound tag.",
  "To attach files, use `suite_reply_with_media` (attachments are base64-encoded).",
  "For long or multi-step replies, use `suite_reply_chunk` instead: generate one `chunk_id` at the start, then call the tool repeatedly with the cumulative `text` and `done:false`, finishing with `done:true`. This gives Suite readers progressive reveal instead of a single big block.",
  "Call `suite_typing` with `typing: true` when you start composing a long reply, and `typing: false` when done.",
  "Task-scoped work: the inbound tag carries task_id when Suite is dispatching a task. Consider delegating to a sub-agent (Task tool) scoped to that task so the main session stays oriented.",
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

const REPLY_SCHEMA = z.object({
  space_id: z.string().describe("UUID of the Suite space to reply in (from the inbound channel tag)"),
  content: z.string().describe("Reply body (markdown)"),
});

const REPLY_WITH_MEDIA_SCHEMA = z.object({
  space_id: z.string(),
  content: z.string(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        content_type: z.string(),
        data: z.string().describe("Base64-encoded file contents"),
      }),
    )
    .min(1),
});

const TYPING_SCHEMA = z.object({
  space_id: z.string(),
  typing: z.boolean(),
});

const REPLY_CHUNK_SCHEMA = z.object({
  space_id: z.string(),
  chunk_id: z
    .string()
    .describe(
      "Stable identifier shared across all chunks of one reply — Suite appends chunks with the same id to a single message. Generate it once at the start of a chunked reply and reuse it for each chunk.",
    ),
  text: z.string().describe("Cumulative reply text so far (not delta). Suite replaces the in-flight message with this text on every chunk."),
  done: z
    .boolean()
    .describe("Set to true on the final chunk of the reply so Suite finalizes the message. Set to false while more chunks are coming."),
});

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "suite_reply",
      description:
        "Send a text reply into a Startup Suite space. Use this to answer a message that arrived via the channel. Pass the space_id attribute from the inbound <channel> tag.",
      inputSchema: {
        type: "object",
        properties: {
          space_id: { type: "string" },
          content: { type: "string" },
        },
        required: ["space_id", "content"],
      },
    },
    {
      name: "suite_reply_with_media",
      description:
        "Send a text reply with base64-encoded file attachments (e.g. a screenshot or diagram). Use when a visual artifact belongs in the thread.",
      inputSchema: {
        type: "object",
        properties: {
          space_id: { type: "string" },
          content: { type: "string" },
          attachments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                filename: { type: "string" },
                content_type: { type: "string" },
                data: { type: "string" },
              },
              required: ["filename", "content_type", "data"],
            },
            minItems: 1,
          },
        },
        required: ["space_id", "content", "attachments"],
      },
    },
    {
      name: "suite_typing",
      description:
        "Toggle a typing indicator in the Suite space so humans can see that a reply is being composed.",
      inputSchema: {
        type: "object",
        properties: {
          space_id: { type: "string" },
          typing: { type: "boolean" },
        },
        required: ["space_id", "typing"],
      },
    },
    {
      name: "suite_reply_chunk",
      description:
        "Send a partial reply chunk to a Suite space, appearing to the human as a progressively-revealed message. Use this for long or multi-step replies: call it several times in a row with the same chunk_id, passing the cumulative text each call. Set done:true on the last call. Prefer suite_reply for short replies where progressive reveal adds no value.",
      inputSchema: {
        type: "object",
        properties: {
          space_id: { type: "string" },
          chunk_id: {
            type: "string",
            description: "Stable id across all chunks of one reply. Reuse it on every chunk.",
          },
          text: {
            type: "string",
            description: "Cumulative reply text so far (not delta).",
          },
          done: {
            type: "boolean",
            description: "true on the final chunk, false otherwise.",
          },
        },
        required: ["space_id", "chunk_id", "text", "done"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  switch (req.params.name) {
    case "suite_reply": {
      const { space_id, content } = REPLY_SCHEMA.parse(req.params.arguments);
      suite.sendReply(space_id, content);
      return { content: [{ type: "text", text: "sent" }] };
    }
    case "suite_reply_with_media": {
      const { space_id, content, attachments } = REPLY_WITH_MEDIA_SCHEMA.parse(
        req.params.arguments,
      );
      suite.sendReplyWithMedia(
        space_id,
        content,
        attachments.map((a) => ({
          filename: a.filename,
          contentType: a.content_type,
          data: a.data,
        })),
      );
      return { content: [{ type: "text", text: `sent with ${attachments.length} attachment(s)` }] };
    }
    case "suite_typing": {
      const { space_id, typing } = TYPING_SCHEMA.parse(req.params.arguments);
      suite.sendTyping(space_id, typing);
      return { content: [{ type: "text", text: typing ? "typing on" : "typing off" }] };
    }
    case "suite_reply_chunk": {
      const { space_id, chunk_id, text, done } = REPLY_CHUNK_SCHEMA.parse(req.params.arguments);
      suite.sendReplyChunk(space_id, chunk_id, text, done);
      // Suite's reply_chunk is ephemeral (PubSub broadcast only). On the final
      // chunk we also fire a regular reply so the message persists to the DB
      // and shows up in space history.
      if (done) suite.sendReply(space_id, text);
      return {
        content: [{ type: "text", text: done ? `chunk ${chunk_id} finalized and persisted` : `chunk ${chunk_id} appended` }],
      };
    }
    default:
      throw new Error(`unknown tool: ${req.params.name}`);
  }
});

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
    onDisconnect: () => {
      console.error("[claude-code-suite-channel] disconnected from Suite");
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
    suite.disconnect();
    process.exit(0);
  });
}
