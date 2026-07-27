// Dedupe-key contract.
//
// `SuiteClient` collapses attentions whose identity repeats inside a ~1s
// bucket, because Suite retries delivery. The old identity was
// `space_id:message_id`, and a responsibility dispatch has NEITHER — no
// `space_id` in `build_system_event_signal/2`, and `message_id` is chat-only.
// So every system_event degraded to the same empty string and any two landing
// in the same second collapsed into one.
//
// That was unreachable while system_events arrived blank and were ignored.
// The `signal.prompt` fallback makes them real, which makes this reachable —
// so the two changes have to ship together, or we trade blank wake-ups for
// silently dropped dispatches.

import { describe, expect, test } from "bun:test";

import { attentionIdentity, type AttentionPayload } from "../src/suite-client.ts";

function systemEvent(
  overrides: { key?: string; prompt?: string; metadata?: Record<string, unknown> } = {},
): AttentionPayload {
  const {
    key = "design.task_direction",
    prompt = "Produce a design direction.",
    metadata = {},
  } = overrides;
  return {
    signal: {
      reason: "system_event",
      responsibility_key: key,
      prompt,
      metadata: { responsibility_key: key, prompt, ...metadata },
    },
  };
}

// The identity the OLD code built, kept here as the control. Without it,
// "these two differ" proves nothing — it would also have passed before.
function legacyIdentity(payload: AttentionPayload): string {
  const msgId = payload.signal?.message_id ?? payload.message?.content?.slice(0, 50) ?? "";
  return `${payload.signal?.space_id ?? ""}:${msgId}`;
}

describe("attentionIdentity — responsibility dispatches", () => {
  test("two different dispatches are distinguishable (the old key was not)", () => {
    const design = systemEvent({ key: "design.task_direction", metadata: { task_id: "task-1" } });
    const architecture = systemEvent({
      key: "architecture.review_plan",
      prompt: "Review this plan.",
      metadata: { task_id: "task-2" },
    });

    expect(attentionIdentity(design)).not.toBe(attentionIdentity(architecture));

    // The control: under the old scheme both are "::" — identical. Two
    // dispatches in one second, one delivered, one silently dropped.
    expect(legacyIdentity(design)).toBe(legacyIdentity(architecture));
    expect(legacyIdentity(design)).toBe(":");
  });

  test("the same responsibility fired for two different tasks stays distinct", () => {
    const a = systemEvent({ metadata: { task_id: "task-1" } });
    const b = systemEvent({ metadata: { task_id: "task-2" } });

    expect(attentionIdentity(a)).not.toBe(attentionIdentity(b));
  });

  test("plan_id and stage_id also discriminate", () => {
    const a = systemEvent({ metadata: { task_id: "t", plan_id: "p1", stage_id: "s1" } });
    const b = systemEvent({ metadata: { task_id: "t", plan_id: "p1", stage_id: "s2" } });

    expect(attentionIdentity(a)).not.toBe(attentionIdentity(b));
  });

  // The whole reason dedupe exists: Suite redelivering the same event.
  test("a byte-identical redelivery still collapses", () => {
    const first = systemEvent({ metadata: { task_id: "task-1" } });
    const retry = systemEvent({ metadata: { task_id: "task-1" } });

    expect(attentionIdentity(first)).toBe(attentionIdentity(retry));
  });
});

describe("attentionIdentity — chat attentions are unchanged in behavior", () => {
  test("same space + same message_id still collapses", () => {
    const build = (): AttentionPayload => ({
      signal: { reason: "message", space_id: "spaceA", message_id: "msg-1" },
      message: { content: "hello", author: "Alice" },
    });

    expect(attentionIdentity(build())).toBe(attentionIdentity(build()));
  });

  test("different messages in the same space stay distinct", () => {
    const a: AttentionPayload = {
      signal: { reason: "message", space_id: "spaceA", message_id: "msg-1" },
      message: { content: "hello", author: "Alice" },
    };
    const b: AttentionPayload = {
      signal: { reason: "message", space_id: "spaceA", message_id: "msg-2" },
      message: { content: "hello", author: "Alice" },
    };

    expect(attentionIdentity(a)).not.toBe(attentionIdentity(b));
  });

  // Dedupe may only ever become LESS aggressive. A key that gained components
  // cannot merge two events that were previously distinct, so the failure
  // direction is a duplicate wake-up (visible) rather than a dropped one
  // (silent).
  test("anything the old key told apart, the new key still tells apart", () => {
    const cases: AttentionPayload[] = [
      { signal: { reason: "message", space_id: "A", message_id: "1" } },
      { signal: { reason: "message", space_id: "A", message_id: "2" } },
      { signal: { reason: "message", space_id: "B", message_id: "1" } },
      {
        signal: { reason: "message", space_id: "C" },
        message: { content: "distinct body", author: "Alice" },
      },
    ];

    for (const a of cases) {
      for (const b of cases) {
        if (a === b) continue;
        if (legacyIdentity(a) !== legacyIdentity(b)) {
          expect(attentionIdentity(a)).not.toBe(attentionIdentity(b));
        }
      }
    }
  });
});
