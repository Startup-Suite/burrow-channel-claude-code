// Per-space history injection contract test.
//
// Suite chat-driven attentions carry a `history` array (see
// `core/apps/platform/lib/platform/chat/agent_responder.ex:247`). The channel
// plugin used to drop it on the floor; this test pins the new behavior:
// inject history into the FIRST attention per space (this process lifetime),
// then leave subsequent attentions from that space alone.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  MAX_HISTORY_TURNS,
  makeEmitAttention,
  resetHistoryTracking,
  type AttentionNotification,
  type NotifyFn,
} from "../src/attention.ts";
import type { AttentionPayload } from "../src/suite-client.ts";

function buildPayload(overrides: Partial<AttentionPayload> & {
  spaceId?: string;
  text?: string;
  history?: AttentionPayload["history"];
}): AttentionPayload {
  const { spaceId = "space-1", text = "hello", history, ...rest } = overrides;
  return {
    signal: { reason: "message", space_id: spaceId },
    message: { content: text, author: "Alice" },
    ...(history !== undefined ? { history } : {}),
    ...rest,
  };
}

function captureNotifications(): { notify: NotifyFn; calls: AttentionNotification[] } {
  const calls: AttentionNotification[] = [];
  const notify: NotifyFn = async (n) => {
    calls.push(n);
  };
  return { notify, calls };
}

beforeEach(() => {
  resetHistoryTracking();
});

describe("emitAttention — per-space history injection", () => {
  test("first inbound per space prepends a Recent context block", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(
      buildPayload({
        spaceId: "spaceA",
        text: "hi",
        history: [{ author: "Alice", content: "earlier turn" }],
      }),
    );

    expect(calls.length).toBe(1);
    const { method, params } = calls[0]!;
    expect(method).toBe("notifications/claude/channel");
    const content = params.content as string;
    expect(content.startsWith("Recent context")).toBe(true);
    expect(content).toContain("earlier turn");
    expect(content).toContain("Alice: earlier turn");
    expect(content).toContain("Current message:\nhi");
  });

  test("second inbound from same space excludes the history block", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    const history = [{ author: "Alice", content: "earlier turn" }];
    await emit(buildPayload({ spaceId: "spaceA", text: "first", history }));
    await emit(buildPayload({ spaceId: "spaceA", text: "second", history }));

    expect(calls.length).toBe(2);
    const secondContent = calls[1]!.params.content as string;
    expect(secondContent).toBe("second");
    expect(secondContent).not.toContain("Recent context");
    expect(secondContent).not.toContain("earlier turn");
  });

  test("first inbound for a NEW space still gets history after another space already emitted", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(
      buildPayload({
        spaceId: "spaceA",
        text: "a-msg",
        history: [{ author: "Alice", content: "a-history" }],
      }),
    );
    await emit(
      buildPayload({
        spaceId: "spaceB",
        text: "b-msg",
        history: [{ author: "Bob", content: "b-history" }],
      }),
    );

    expect(calls.length).toBe(2);
    const aContent = calls[0]!.params.content as string;
    const bContent = calls[1]!.params.content as string;
    expect(aContent).toContain("Recent context");
    expect(aContent).toContain("a-history");
    expect(bContent).toContain("Recent context");
    expect(bContent).toContain("b-history");
  });

  test("resetHistoryTracking() re-arms a space for re-injection", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    const history = [{ author: "Alice", content: "earlier turn" }];
    await emit(buildPayload({ spaceId: "spaceA", text: "first", history }));
    resetHistoryTracking();
    await emit(buildPayload({ spaceId: "spaceA", text: "second", history }));

    expect(calls.length).toBe(2);
    const first = calls[0]!.params.content as string;
    const second = calls[1]!.params.content as string;
    expect(first).toContain("Recent context");
    expect(second).toContain("Recent context");
    expect(second).toContain("Current message:\nsecond");
  });

  test("empty or missing history does NOT add a block (and does not pin the space)", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    // Empty array.
    await emit(buildPayload({ spaceId: "spaceA", text: "msg1", history: [] }));
    // Undefined history.
    await emit(buildPayload({ spaceId: "spaceA", text: "msg2" }));
    // Now real history arrives — should still be treated as first emission.
    await emit(
      buildPayload({
        spaceId: "spaceA",
        text: "msg3",
        history: [{ author: "Alice", content: "later turn" }],
      }),
    );

    expect(calls.length).toBe(3);
    expect(calls[0]!.params.content).toBe("msg1");
    expect(calls[1]!.params.content).toBe("msg2");
    const third = calls[2]!.params.content as string;
    expect(third).toContain("Recent context");
    expect(third).toContain("later turn");
  });

  test("MAX_HISTORY_TURNS caps the block at the most recent turns", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    const history = Array.from({ length: 50 }, (_, i) => ({
      author: `User${i}`,
      content: `turn-${i}`,
    }));

    await emit(buildPayload({ spaceId: "spaceA", text: "now", history }));

    const content = calls[0]!.params.content as string;
    // Header should declare MAX_HISTORY_TURNS turns.
    expect(content).toContain(`last ${MAX_HISTORY_TURNS} turns`);
    // The most recent turn (49) must appear; turns before the window (e.g. 29
    // and earlier) must not.
    expect(content).toContain("turn-49");
    expect(content).toContain("turn-30"); // 50 - 20 = 30, so 30..49 inclusive
    expect(content).not.toContain("turn-29");
    expect(content).not.toContain("turn-0");

    // And: count lines between the header and the separator to assert exactly
    // 20 turn lines made it in.
    const headerLine = "Recent context (last 20 turns in this space):";
    const start = content.indexOf(headerLine);
    const end = content.indexOf("\n\n---");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = content.slice(start + headerLine.length + 1, end);
    const lines = block.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(MAX_HISTORY_TURNS);
  });
});

describe("emitAttention — meta and permission relay still work", () => {
  test("meta carries signal + author fields", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: {
        reason: "task_dispatch",
        space_id: "spaceA",
        message_id: "msg-42",
        task_id: "taskZ",
        task_status: "in_progress",
      },
      message: { content: "do the thing", author: "Bob", author_id: "u-bob" },
    });

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.space_id).toBe("spaceA");
    expect(meta.message_id).toBe("msg-42");
    expect(meta.task_id).toBe("taskZ");
    expect(meta.task_status).toBe("in_progress");
    expect(meta.reason).toBe("task_dispatch");
    expect(meta.author).toBe("Bob");
    expect(meta.author_id).toBe("u-bob");
  });

  // The guard matters as much as the forward: an attention with no message_id
  // (task-router dispatches don't carry one) must leave the key ABSENT rather
  // than emit an empty string, so Claude can tell "no addressable message"
  // apart from "message id is blank".
  test("meta omits message_id when the signal does not carry one", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(buildPayload({ spaceId: "spaceA" }));

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.space_id).toBe("spaceA");
    expect("message_id" in meta).toBe(false);
  });

  test("permission verdict shape bypasses history-prepend logic", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify, allowPermissionRelay: true });

    await emit(
      buildPayload({
        spaceId: "spaceA",
        text: "yes abcde",
        history: [{ author: "Alice", content: "earlier turn" }],
      }),
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("notifications/claude/channel/permission");
    expect(calls[0]!.params).toEqual({ request_id: "abcde", behavior: "allow" });
  });

  test("setActivePermissionSpace is called with the space_id", async () => {
    const { notify } = captureNotifications();
    const seen: string[] = [];
    const emit = makeEmitAttention({
      notify,
      setActivePermissionSpace: (sid) => seen.push(sid),
    });

    await emit(buildPayload({ spaceId: "spaceA" }));
    await emit(buildPayload({ spaceId: "spaceB" }));

    expect(seen).toEqual(["spaceA", "spaceB"]);
  });
});
