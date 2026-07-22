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
});

// Responsibility dispatches — `reason: "system_event"`. Built by
// `agent_responder.ex:477` (`build_system_event_signal/2`): no `message` key
// at all, the rendered prompt lifted to `signal.prompt`, correlation ids left
// inside `signal.metadata`. Reading only `message.content` delivered every one
// of these as an empty <channel> tag, which read as housekeeping noise.
describe("emitAttention — system_event responsibility dispatches", () => {
  // The real wire shape, transcribed from build_system_event_signal/2.
  function buildSystemEvent(
    overrides: { prompt?: string; metadata?: Record<string, unknown> } = {},
  ): AttentionPayload {
    const { prompt = "Produce a design direction for this task.", metadata = {} } = overrides;
    return {
      signal: {
        reason: "system_event",
        agent_id: "agent-saru",
        agent_slug: "saru",
        responsibility_key: "design.task_direction",
        feature: "design",
        trigger_kind: "event_topic",
        prompt,
        metadata: {
          responsibility_key: "design.task_direction",
          feature: "design",
          trigger_kind: "event_topic",
          agent_id: "agent-saru",
          agent_slug: "saru",
          task_id: "task-77",
          project_id: "proj-9",
          prompt,
          ...metadata,
        },
      },
    };
  }

  test("the rendered prompt becomes the content (no message key at all)", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(buildSystemEvent({ prompt: "Give direction for the Recovery hub." }));

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("notifications/claude/channel");
    expect(calls[0]!.params.content).toBe("Give direction for the Recovery hub.");
  });

  test("meta names which responsibility fired and carries the correlation ids", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(buildSystemEvent({ metadata: { plan_id: "plan-3", stage_id: "stage-1" } }));

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.reason).toBe("system_event");
    expect(meta.responsibility_key).toBe("design.task_direction");
    expect(meta.feature).toBe("design");
    expect(meta.trigger_kind).toBe("event_topic");
    // Lifted out of signal.metadata — these are NOT at the top level.
    expect(meta.task_id).toBe("task-77");
    expect(meta.plan_id).toBe("plan-3");
    expect(meta.stage_id).toBe("stage-1");
    expect(meta.project_id).toBe("proj-9");
  });

  // The whitelist is the point. `signal.metadata.prompt` is the entire
  // rendered body — already the tag's content — and the chat path stashes a
  // frozen history snapshot in there too. Spreading the map would duplicate
  // the whole dispatch into the tag attributes.
  test("metadata is whitelisted, not spread", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(
      buildSystemEvent({
        prompt: "a very long rendered prompt",
        metadata: { history: [{ author: "Alice", content: "secret" }], agent_slug: "saru" },
      }),
    );

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect("prompt" in meta).toBe(false);
    expect("history" in meta).toBe(false);
    expect("agent_slug" in meta).toBe(false);
    expect(JSON.stringify(meta)).not.toContain("secret");
  });

  test("a top-level signal id wins over the same key in metadata", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: {
        reason: "task_dispatch",
        space_id: "spaceA",
        task_id: "top-level-task",
        metadata: { task_id: "metadata-task" },
      },
      message: { content: "do the thing", author: "Bob" },
    });

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.task_id).toBe("top-level-task");
  });

  test("space_id is taken from metadata when the signal omits it", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(buildSystemEvent({ metadata: { space_id: "space-from-metadata" } }));

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.space_id).toBe("space-from-metadata");
  });

  // Replying is safe; re-pinning a pending permission prompt is not. A
  // background dispatch must not move where an approval gets answered.
  test("a metadata-only space does NOT re-pin the permission space", async () => {
    const { notify } = captureNotifications();
    const seen: string[] = [];
    const emit = makeEmitAttention({
      notify,
      setActivePermissionSpace: (sid) => seen.push(sid),
    });

    await emit(buildPayload({ spaceId: "chat-space" }));
    await emit(buildSystemEvent({ metadata: { space_id: "background-space" } }));

    expect(seen).toEqual(["chat-space"]);
  });

  test("a prompt-less system_event still emits, with empty content", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "system_event", responsibility_key: "memory.sweep", metadata: {} },
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.params.content).toBe("");
    expect((calls[0]!.params.meta as Record<string, string>).responsibility_key).toBe(
      "memory.sweep",
    );
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

describe("emitAttention — content-less housekeeping filter", () => {
  test("empty content with no task or message reference is dropped", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "system_event" },
      message: { content: "", author: "" },
    });

    expect(calls.length).toBe(0);
  });

  test("whitespace-only content with no references is dropped", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "system_event", space_id: "spaceA" },
      message: { content: "  \n ", author: "" },
    });

    expect(calls.length).toBe(0);
  });

  test("empty content WITH a task_id is still forwarded (status transitions)", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "watch", task_id: "taskZ", task_status: "deploying" },
      message: { content: "", author: "TaskRouter" },
    });

    expect(calls.length).toBe(1);
    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.task_id).toBe("taskZ");
  });

  test("empty content WITH a message_id is still forwarded", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "message", space_id: "spaceA", message_id: "m-1" },
      message: { content: "", author: "Alice" },
    });

    expect(calls.length).toBe(1);
  });

  test("a dropped noise event does not consume the space's one-time history injection", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    // Housekeeping noise from spaceA arrives first, carrying history.
    await emit({
      signal: { reason: "system_event", space_id: "spaceA" },
      message: { content: "", author: "" },
      history: [{ author: "Alice", content: "earlier turn" }],
    });
    // The first real message must still get the history block.
    await emit(
      buildPayload({
        spaceId: "spaceA",
        text: "real message",
        history: [{ author: "Alice", content: "earlier turn" }],
      }),
    );

    expect(calls.length).toBe(1);
    const content = calls[0]!.params.content as string;
    expect(content).toContain("Recent context");
    expect(content).toContain("Current message:\nreal message");
  });
});
