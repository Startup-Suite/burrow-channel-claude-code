import type { AttentionPayload } from "./suite-client.ts";

// ── History injection ──────────────────────────────────────────────────────
//
// Suite's chat-driven attention events carry a `history` array of prior turns
// in the space (see `agent_responder.ex:247`). Task-router dispatches leave it
// empty — they pass context via the `context` field instead.
//
// We want Claude's session to see that history *once*, on the first attention
// it receives from a given space within this process lifetime. Subsequent
// attentions don't re-emit it (the Claude session already has it in its own
// turn log). On WebSocket reconnect we clear the tracking set so the next
// attention from a space we'd already seen re-injects history — handy if the
// plugin missed events during the disconnect.

const historyEmittedForSpace = new Set<string>();

/**
 * Clear all per-space history tracking. Call this on WebSocket (re)connect so
 * a fresh socket session re-injects history per space.
 */
export function resetHistoryTracking(): void {
  historyEmittedForSpace.clear();
}

// Exposed for tests only. Don't call from production code.
export function _historyEmittedForSpace(): ReadonlySet<string> {
  return historyEmittedForSpace;
}

// Cap on the number of history turns we prepend, so a chatty space doesn't
// dump a 50-turn block on first contact.
export const MAX_HISTORY_TURNS = 20;

export interface AttentionNotification {
  method: "notifications/claude/channel" | "notifications/claude/channel/permission";
  params: Record<string, unknown>;
}

export type NotifyFn = (notification: AttentionNotification) => void | Promise<void>;

export interface EmitAttentionOptions {
  notify: NotifyFn;
  allowPermissionRelay?: boolean;
  // Setter called when an attention pins (or updates) the active permission
  // space. Kept as a callback so `index.ts` can own the mutable state.
  setActivePermissionSpace?: (spaceId: string) => void;
}

// Suite chat replies that match this shape are forwarded as permission
// verdicts instead of regular attentions.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/**
 * Build an `emitAttention` function bound to the given notifier. Factored out
 * of `index.ts` so the per-space history injection logic is testable without
 * booting the MCP server / Phoenix socket.
 */
export function makeEmitAttention(opts: EmitAttentionOptions): (payload: AttentionPayload) => Promise<void> {
  const { notify, allowPermissionRelay = false, setActivePermissionSpace } = opts;

  return async function emitAttention(payload: AttentionPayload): Promise<void> {
    const spaceId = payload.signal?.space_id;
    if (spaceId && setActivePermissionSpace) setActivePermissionSpace(spaceId);

    const text = payload.message?.content ?? "";
    const maybeVerdict = allowPermissionRelay ? PERMISSION_REPLY_RE.exec(text) : null;

    if (maybeVerdict) {
      await notify({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: maybeVerdict[2]!.toLowerCase(),
          behavior: maybeVerdict[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
        },
      });
      return;
    }

    const meta: Record<string, string> = {};
    if (payload.signal?.space_id) meta.space_id = payload.signal.space_id;
    if (payload.signal?.message_id) meta.message_id = payload.signal.message_id;
    if (payload.signal?.task_id) meta.task_id = payload.signal.task_id;
    if (payload.signal?.task_status) meta.task_status = payload.signal.task_status;
    if (payload.signal?.reason) meta.reason = payload.signal.reason;
    if (payload.message?.author) meta.author = payload.message.author;
    if (payload.message?.author_id) meta.author_id = payload.message.author_id;

    let content = text;
    if (
      spaceId &&
      !historyEmittedForSpace.has(spaceId) &&
      payload.history &&
      payload.history.length > 0
    ) {
      const recent = payload.history.slice(-MAX_HISTORY_TURNS);
      const block = recent.map((h) => `${h.author}: ${h.content}`).join("\n");
      content =
        `Recent context (last ${recent.length} turns in this space):\n${block}\n\n---\n\nCurrent message:\n${text}`;
      historyEmittedForSpace.add(spaceId);
    }

    await notify({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  };
}
