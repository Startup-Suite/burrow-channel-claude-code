// Per-space history injection contract test.
//
// Burrow chat-driven attentions carry a `history` array (see
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

  // BEHAVIOUR CHANGE, 019fa618 stage 4 — this test used to assert
  // `content === ""` and was green. The empty string was DELIBERATE at the
  // time and correct to assert: the point being made was "it still emits", and
  // pinning the exact body it emitted was the honest way to say it. It is
  // replaced because the empty tag turned out to BE the defect — an agent woken
  // by one has nothing to act on and cannot tell it from housekeeping noise —
  // not because asserting it was wrong. The placeholder is pinned in full by
  // `test/system-event-envelope.test.ts`; this file keeps the shape assertion.
  test("a prompt-less system_event still emits, with a placeholder body", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "system_event", responsibility_key: "memory.sweep", metadata: {} },
    });

    expect(calls.length).toBe(1);
    expect(calls[0]!.params.content).toMatch(/^System dispatch:/);
    expect(calls[0]!.params.content).toContain("memory.sweep");
    expect(calls[0]!.params.content).not.toBe("");
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

  // The guard must ask "can we correlate this?" using the SAME resolution the
  // meta block uses. `task_id` legitimately arrives inside `signal.metadata`
  // (see METADATA_SCALAR_KEYS), so a guard reading only the top level would
  // drop a dispatch whose id the very next block resolves successfully.
  test("empty content with a task_id ONLY in signal.metadata is forwarded", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: {
        reason: "system_event",
        metadata: { task_id: "task-in-metadata", stage_id: "stage-7" },
      },
    });

    expect(calls.length).toBe(1);
    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.task_id).toBe("task-in-metadata");
    expect(meta.stage_id).toBe("stage-7");
  });

  // A responsibility that fired and rendered NOTHING is a defect signal, not
  // housekeeping. That is the exact shape of the bug #15 fixed, and the empty
  // <channel> tag was the only evidence it left — it is how the defect was
  // found at all. Dropping these would re-blind us to a recurrence.
  test("empty content WITH a responsibility_key is forwarded (defect signal, not noise)", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({
      signal: { reason: "system_event", responsibility_key: "design.critique", metadata: {} },
    });

    expect(calls.length).toBe(1);
    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.responsibility_key).toBe("design.critique");
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

// ── Server-contract fixtures ───────────────────────────────────────────────
//
// The payloads below are built to match core's `build_system_event_signal/2`
// (`platform/chat/agent_responder.ex:477-495`) as it actually is, NOT
// reconstructed from a rendered <channel> tag. Deriving the input from the
// output would assume the very mapping under test.
//
// Two properties of that function drive everything here:
//
//   1. The signal carries ONLY `reason`, `agent_id`, `agent_slug` plus four
//      `maybe_put` fields (`responsibility_key`, `feature`, `trigger_kind`,
//      `prompt`) and the whole `metadata` map. It sets **no** `space_id`,
//      `task_id`, `plan_id` or `stage_id` at the top level — every
//      correlation id reaches us exclusively through `metadata`.
//   2. `maybe_put(map, _key, nil), do: map` — a responsibility whose provider
//      implements no `build_prompt/1` yields a signal with **no `prompt` key
//      at all**, not an empty one. There is no `message` key on this path
//      either, so the body is genuinely absent.
//
// The whole payload is `%{signal: ...}` — which is why `AttentionPayload.message`
// had to become optional.

describe("emitAttention — against core's build_system_event_signal/2", () => {
  test("the one dispatch observed live in production emits with its body and ids intact", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    // Shape of the 2026-07-27T19:57:21Z architecture.review_plan dispatch:
    // 16,070 bytes of rendered prompt, correlation ids in metadata only.
    const prompt = "You are the Architect on the Burrow plan-review path…";
    await emit({
      signal: {
        reason: "system_event",
        responsibility_key: "architecture.review_plan",
        feature: "architecture",
        prompt,
        metadata: {
          feature: "architecture",
          prompt,
          plan_id: "019fa527-2ec2-72b3-b39d-c03bbfd7b36e",
          task_id: "019fa504-90f9-7f57-ac67-888093ef8e20",
        },
      },
    });

    expect(calls.length).toBe(1);
    const { params } = calls[0]!;
    expect(params.content).toBe(prompt);

    const meta = params.meta as Record<string, string>;
    expect(meta.responsibility_key).toBe("architecture.review_plan");
    expect(meta.feature).toBe("architecture");
    expect(meta.plan_id).toBe("019fa527-2ec2-72b3-b39d-c03bbfd7b36e");
    expect(meta.task_id).toBe("019fa504-90f9-7f57-ac67-888093ef8e20");
    expect(meta.reason).toBe("system_event");

    // The prompt is the body; it must not also be copied into the attributes.
    expect(meta.prompt).toBeUndefined();
  });

  test("a responsibility with no rendered prompt still reaches us, correlated from metadata", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    // `maybe_put` omitted `prompt` outright: no body, ids in metadata only.
    // This is the exact shape a top-level-only guard would have dropped.
    await emit({
      signal: {
        reason: "system_event",
        responsibility_key: "design.critique",
        metadata: {
          task_id: "019fa504-90f9-7f57-ac67-888093ef8e20",
          stage_id: "019fa530-1111-7000-9000-000000000001",
        },
      },
    });

    expect(calls.length).toBe(1);
    const meta = calls[0]!.params.meta as Record<string, string>;
    // BEHAVIOUR CHANGE, 019fa618 stage 4 — was `toBe("")`, green and
    // deliberate: this test is about CORRELATION, and the empty body was the
    // true observation to record alongside it at the time. Replaced for the
    // same reason as the sibling above — the empty tag is the defect shape.
    // Every id assertion in this test is untouched.
    expect(calls[0]!.params.content).toMatch(/^System dispatch:/);
    expect(calls[0]!.params.content).toContain("design.critique");
    expect(meta.task_id).toBe("019fa504-90f9-7f57-ac67-888093ef8e20");
    expect(meta.stage_id).toBe("019fa530-1111-7000-9000-000000000001");
    expect(meta.responsibility_key).toBe("design.critique");
  });

  test("a signal with neither prompt nor any metadata id is the genuine noise case", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    // Same server path, nothing to correlate and nothing to say. This is the
    // only shape the filter is entitled to drop.
    await emit({
      signal: { reason: "system_event", metadata: {} },
    });

    expect(calls.length).toBe(0);
  });
});

// ── The envelope, both directions, in one run ──────────────────────────────
//
// This is the block the `system_event_prompt` capability actually names. The
// two attention envelopes core emits are asymmetric, and stage 1 of task
// 019fa56b pinned that asymmetry server-side so a refactor cannot quietly
// normalise it away:
//
//   * `task_router.ex:1388` and `agent_responder.ex:243` carry the body at
//     `message.content`.
//   * `agent_responder.ex:424` (`broadcast_system_event/3`) carries ONLY
//     `signal` — `Map.keys(payload) == [:signal]` — with the rendered prompt
//     at `signal.prompt`.
//
// A bridge reading `payload.message?.content ?? ""` renders the first two
// perfectly and drops the third entirely. That is why "dalton received a task
// dispatch with a full body" proves nothing about that runtime's system_event
// handling — and why the fix has to be discriminated by a declared capability
// rather than inferred from traffic.
//
// Both directions are asserted against SENTINEL TEXT (not `content !== ""`)
// in a SINGLE test through a SINGLE emit function, so neither half can pass
// on a dispatch that never fired, and a regression in either direction is
// caught. Verified by perturbing `attention.ts:89`:
//
//   * `message?.content ?? ""`   (the literal pre-fix line, still live at
//     `4691bdb` `src/index.ts:256`)  -> direction 1 fails, "" vs SENTINEL-WAKE
//   * `signal?.prompt ?? ""`     (message path dropped)
//                                    -> direction 2 fails, "" vs SENTINEL-TASK
//
// A third perturbation — REVERSING the precedence to
// `signal?.prompt ?? message?.content ?? ""` — stays green, and that is
// correct rather than a hole: no core emit path puts a body in BOTH places,
// so the two orderings are behaviourally identical against every payload core
// actually sends. A test manufacturing a both-populated payload to fail it
// would be pinning a shape the server does not produce.
describe("emitAttention — the system_event envelope, both directions", () => {
  const WAKE = "SENTINEL-WAKE-7f3c1a90";
  const TASK = "SENTINEL-TASK-2b8e40d5";

  test("a signal-only payload renders signal.prompt, and a message payload still renders message.content", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    // Direction 1 — the exact `broadcast_system_event/3` shape: `signal` and
    // nothing else. No `message` key at all, not even an empty one.
    const systemEvent: AttentionPayload = {
      signal: {
        reason: "system_event",
        prompt: WAKE,
        responsibility_key: "design.task_direction",
      },
    };
    expect(Object.keys(systemEvent)).toEqual(["signal"]);
    await emit(systemEvent);

    // Direction 2 — the `task_router.ex:1385-1389` shape, same emit function.
    await emit({
      signal: { reason: "task_assigned", task_id: "task-019fa56b", task_status: "in_progress" },
      message: { content: TASK, author: "TaskRouter" },
    });

    expect(calls.length).toBe(2);
    expect(calls[0]!.params.content).toBe(WAKE);
    expect(calls[1]!.params.content).toBe(TASK);

    // The system_event tag has to say what asked, or it arrives as an
    // unattributable instruction.
    const wakeMeta = calls[0]!.params.meta as Record<string, string>;
    expect(wakeMeta.reason).toBe("system_event");
    expect(wakeMeta.responsibility_key).toBe("design.task_direction");
  });

  // DELIBERATELY NOT PINNED HERE: `attention.ts:89` uses `??`, not `||`, so a
  // payload carrying BOTH an empty `message.content` and a real
  // `signal.prompt` would render empty. That shape is not reachable from core
  // today — stage 1 of 019fa56b pinned `Map.keys(payload) == [:signal]` on the
  // system_event path, so the two never co-occur — and swapping the operator
  // is a behavior change outside this stage's scope. Noted so the next reader
  // does not have to rediscover it.
});
