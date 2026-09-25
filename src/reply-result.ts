import type { DroppedField } from "./suite-client.ts";

/**
 * Send a reply and translate the server's ack into an MCP tool result.
 *
 * The error text is the SERVER's `error` string (which carries the space_id
 * after core's 2026-09-16 change) plus the server's own `recoverable` flag —
 * deliberately passed through rather than reworded here, so the bridge cannot
 * drift from what the read path reports.
 *
 * An ok ack may carry `dropped` (task 01a0d8de): optional annotations
 * (`in_reply_to_message_id`, `context`) that core refused while still posting
 * the message. They are surfaced in the result text so the agent learns the
 * annotation did not land; the result stays a success because the reply did.
 */
export async function replyResult(
  send: (
    spaceId: string,
    content: string,
  ) => Promise<{ message_id?: string; dropped?: DroppedField[] } | undefined>,
  spaceId: string,
  content: string,
  okPrefix?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const ok = await send(spaceId, content);
    const receipt = ok?.message_id ? `message_id ${ok.message_id}` : "sent (no message_id returned)";
    const base = okPrefix ? `${okPrefix} — ${receipt}` : receipt;
    return { content: [{ type: "text", text: base + droppedSuffix(ok?.dropped) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const recoverable = (err as { recoverable?: boolean })?.recoverable ?? false;
    return {
      isError: true,
      content: [{ type: "text", text: `${message} (recoverable: ${recoverable})` }],
    };
  }
}

function droppedSuffix(dropped: DroppedField[] | undefined): string {
  if (!Array.isArray(dropped) || dropped.length === 0) return "";
  const parts = dropped.map((d) => `${d?.field ?? "unknown"} (${d?.reason ?? "unknown"})`);
  return `; Suite posted the message but did not store: ${parts.join(", ")}`;
}
