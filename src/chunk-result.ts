/**
 * Build the MCP tool result for a NON-FINAL `suite_reply_chunk` (done:false).
 *
 * The chunk push is fire-and-forget, so this result cannot assert that THIS
 * chunk was delivered. Two honest shapes instead: a known prior refusal for
 * the space (from `SuiteClient.lastChunkRefusal`) is surfaced as an error
 * naming the space, and otherwise the text says only that the chunk was
 * queued. The first non-final chunk to a space Suite will refuse still reads
 * "queued" — that is the honest limit of a non-blocking push.
 *
 * Extracted from index.ts (which cannot be imported in a test because it
 * starts the MCP stdio server) so the tests exercise the production branch.
 */
export function partialChunkResult(
  chunkId: string,
  spaceId: string,
  refusal: string | undefined,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (refusal) {
    return {
      isError: true,
      content: [{ type: "text", text: `chunk ${chunkId} not delivered to space ${spaceId}: ${refusal}` }],
    };
  }
  return { content: [{ type: "text", text: `chunk ${chunkId} queued` }] };
}
