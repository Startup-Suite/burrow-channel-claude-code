/**
 * Send a reply and translate the server's ack into an MCP tool result.
 *
 * The error text is the SERVER's `error` string (which carries the space_id
 * after core's 2026-09-16 change) plus the server's own `recoverable` flag —
 * deliberately passed through rather than reworded here, so the bridge cannot
 * drift from what the read path reports.
 */
export async function replyResult(
  send: (spaceId: string, content: string) => Promise<{ message_id?: string } | undefined>,
  spaceId: string,
  content: string,
  okPrefix?: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const ok = await send(spaceId, content);
    const receipt = ok?.message_id ? `message_id ${ok.message_id}` : "sent (no message_id returned)";
    return { content: [{ type: "text", text: okPrefix ? `${okPrefix} — ${receipt}` : receipt }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const recoverable = (err as { recoverable?: boolean })?.recoverable ?? false;
    return {
      isError: true,
      content: [{ type: "text", text: `${message} (recoverable: ${recoverable})` }],
    };
  }
}
