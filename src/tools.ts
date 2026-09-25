/**
 * The outbound MCP tool surface: schemas, tool definitions and the call
 * dispatcher.
 *
 * Extracted from index.ts (which cannot be imported in a test because it
 * starts the MCP stdio server) so the tests exercise the production dispatch,
 * including which Suite pushes carry the optional reply annotations.
 */
import { z } from "zod";

import type { ReplyExtras, ReplyOk } from "./suite-client.ts";
import { replyResult } from "./reply-result.ts";
import { partialChunkResult } from "./chunk-result.ts";

/** The subset of `SuiteClient` the tools call. */
export interface ToolSuite {
  sendReply(spaceId: string, content: string, extras?: ReplyExtras): Promise<ReplyOk>;
  sendReplyWithMedia(
    spaceId: string,
    content: string,
    attachments: Array<{ filename: string; contentType: string; data: string }>,
    extras?: ReplyExtras,
  ): Promise<ReplyOk>;
  sendTyping(spaceId: string, typing: boolean): void;
  lastTypingRefusal(spaceId: string): string | undefined;
  sendReplyChunk(spaceId: string, chunkId: string, text: string, done: boolean): void;
  lastChunkRefusal(spaceId: string): string | undefined;
}

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// ── Optional reply annotations (task 01a0d8de) ─────────────────────────────

const IN_REPLY_TO_DESCRIPTION =
  "Optional. The message_id attribute of the channel tag you are answering. Suite links your reply to that message.";

const CONTEXT_DESCRIPTION =
  "Optional. One line, at most 200 characters, saying what this reply answers in words a person arriving hours later can follow; name the task, stage or item instead of writing '6'.";

const REPLY_EXTRAS_SHAPE = {
  in_reply_to_message_id: z.string().optional().describe(IN_REPLY_TO_DESCRIPTION),
  context: z.string().optional().describe(CONTEXT_DESCRIPTION),
};

const REPLY_EXTRAS_PROPERTIES = {
  in_reply_to_message_id: { type: "string", description: IN_REPLY_TO_DESCRIPTION },
  // No maxLength: a client that enforced it would refuse the whole reply over
  // an optional annotation. Core caps and reports it instead.
  context: { type: "string", description: CONTEXT_DESCRIPTION },
};

function extrasOf(args: { in_reply_to_message_id?: string; context?: string }): ReplyExtras {
  return { in_reply_to_message_id: args.in_reply_to_message_id, context: args.context };
}

/** One sentence for the MCP instructions string. */
export const REPLY_EXTRAS_INSTRUCTION =
  "On `suite_reply`, `suite_reply_with_media` and the final (`done:true`) `suite_reply_chunk`, also pass `in_reply_to_message_id` (the message_id attribute of the tag you are answering) and `context` (one line, at most 200 characters, naming the task, stage or item the reply answers so a person arriving hours later can follow it).";

// ── Schemas ────────────────────────────────────────────────────────────────

export const REPLY_SCHEMA = z.object({
  space_id: z.string().describe("UUID of the Suite space to reply in (from the inbound channel tag)"),
  content: z.string().describe("Reply body (markdown)"),
  ...REPLY_EXTRAS_SHAPE,
});

export const REPLY_WITH_MEDIA_SCHEMA = z.object({
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
  ...REPLY_EXTRAS_SHAPE,
});

export const TYPING_SCHEMA = z.object({
  space_id: z.string(),
  typing: z.boolean(),
});

export const REPLY_CHUNK_SCHEMA = z.object({
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
  ...REPLY_EXTRAS_SHAPE,
});

// ── Tool definitions (ListTools) ───────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "suite_reply",
    description:
      "Send a text reply into a Startup Suite space. Use this to answer a message that arrived via the channel. Pass the space_id attribute from the inbound <channel> tag.",
    inputSchema: {
      type: "object",
      properties: {
        space_id: { type: "string" },
        content: { type: "string" },
        ...REPLY_EXTRAS_PROPERTIES,
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
        ...REPLY_EXTRAS_PROPERTIES,
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
      "Send a partial reply chunk to a Suite space, appearing to the human as a progressively-revealed message. Use this for long or multi-step replies: call it several times in a row with the same chunk_id, passing the cumulative text each call. Set done:true on the last call. Prefer suite_reply for short replies where progressive reveal adds no value. in_reply_to_message_id and context are stored from the done:true call.",
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
        ...REPLY_EXTRAS_PROPERTIES,
      },
      required: ["space_id", "chunk_id", "text", "done"],
    },
  },
];

// ── Dispatcher (CallTool) ──────────────────────────────────────────────────

export async function callTool(suite: ToolSuite, name: string, args: unknown): Promise<ToolResult> {
  switch (name) {
    case "suite_reply": {
      const parsed = REPLY_SCHEMA.parse(args);
      const extras = extrasOf(parsed);
      return await replyResult((s, c) => suite.sendReply(s, c, extras), parsed.space_id, parsed.content);
    }
    case "suite_reply_with_media": {
      const parsed = REPLY_WITH_MEDIA_SCHEMA.parse(args);
      const extras = extrasOf(parsed);
      // Was unconditional success: the push was fire-and-forget, so a refusal
      // reported "sent with N attachment(s)". `replyResult` now surfaces the
      // server's own error text and recoverable flag, exactly as suite_reply.
      return await replyResult(
        (s, c) =>
          suite.sendReplyWithMedia(
            s,
            c,
            parsed.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.content_type,
              data: a.data,
            })),
            extras,
          ),
        parsed.space_id,
        parsed.content,
        `sent with ${parsed.attachments.length} attachment(s)`,
      );
    }
    case "suite_typing": {
      const { space_id, typing } = TYPING_SCHEMA.parse(args);
      suite.sendTyping(space_id, typing);
      // The push stays fire-and-forget (a cosmetic indicator must not delay
      // the reply it precedes), so this result CANNOT assert that THIS call
      // was delivered — "typing on" did, and was indistinguishable at the
      // caller from the delivered case. Two honest shapes instead: a known
      // prior refusal for this space is surfaced as an error, and otherwise
      // the text says only that the indicator was sent, unacknowledged.
      const refusal = suite.lastTypingRefusal(space_id);
      if (refusal) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `typing indicator not delivered to space ${space_id}: ${refusal}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `typing indicator ${typing ? "on" : "off"} sent (not acknowledged)`,
          },
        ],
      };
    }
    case "suite_reply_chunk": {
      const parsed = REPLY_CHUNK_SCHEMA.parse(args);
      const { space_id, chunk_id, text, done } = parsed;
      // The reply_chunk push itself carries no annotations: it is an
      // ephemeral broadcast with no persisted row to annotate.
      suite.sendReplyChunk(space_id, chunk_id, text, done);
      // Suite's reply_chunk is ephemeral (PubSub broadcast only). On the final
      // chunk we also fire a regular reply so the message persists to the DB
      // and shows up in space history.
      if (done) {
        // The final chunk persists via a regular reply, so it inherits the
        // same ack handling — a refused persist must not report success — and
        // it is the one push that carries the reply annotations.
        const extras = extrasOf(parsed);
        return await replyResult(
          (s, c) => suite.sendReply(s, c, extras),
          space_id,
          text,
          `chunk ${chunk_id} finalized and persisted`,
        );
      }
      // Non-final chunks stay fire-and-forget; surface a known refusal for
      // this space instead of asserting delivery.
      return partialChunkResult(chunk_id, space_id, suite.lastChunkRefusal(space_id));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
