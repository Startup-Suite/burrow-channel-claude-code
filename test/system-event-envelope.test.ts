// The captured `architecture.review_plan` envelope, driven through the REAL
// inbound handler.
//
// ENTRY POINT. `makeEmitAttention` (`src/attention.ts:71`) is not a test
// double: `src/index.ts:11` imports it, `src/index.ts:249` binds it to the MCP
// notifier as `emitAttention`, and `src/index.ts:266-267` is what
// `SuiteClient`'s `channel.on("attention", ...)` handler
// (`src/suite-client.ts:275-284`) calls on every inbound websocket frame. The
// object this file inspects (`calls[0].params`) is byte-for-byte the object the
// agent receives.
//
// A NEW FILE, deliberately, rather than an append to `emit-attention.test.ts`:
// PR #16 is open and appends 81 lines to that file's EOF.
//
// WHAT THIS FILE CANNOT DO — stated up front so nobody mistakes green for
// coverage it does not have. The captured envelope populates BOTH
// `message.content` and `signal.prompt`, byte-equal, so perturbing
// `src/attention.ts:89` to read either single source leaves every assertion
// here green. This file pins the OUTCOME and the server CONTRACT; the fallback
// ORDERING is pinned by the signal-only bare fixture and by the divergence
// probes in the sibling stages. Manufacturing a both-populated-but-different
// payload to force a red here would pin a shape core never sends.
//
// AND: the fixture's prompt is ABRIDGED (see `test/fixtures/index.ts` — the
// real body was 13,325 bytes and the capture elides its middle with a literal
// `[…]`). Nothing below asserts a body LENGTH or a substring of the body, only
// byte-identity against the fixture object and cross-key equality. An assertion
// on size would be an assertion about the elision.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  makeEmitAttention,
  resetHistoryTracking,
  type AttentionNotification,
  type NotifyFn,
} from "../src/attention.ts";
import { FULL_ENVELOPE, fullEnvelope } from "./fixtures/index.ts";

function captureNotifications(): { notify: NotifyFn; calls: AttentionNotification[] } {
  const calls: AttentionNotification[] = [];
  const notify: NotifyFn = async (n) => {
    calls.push(n);
  };
  return { notify, calls };
}

// `historyEmittedForSpace` is module-level state shared across every test file
// in a single `bun test` run. Mirrors `test/emit-attention.test.ts:42-44`.
beforeEach(() => {
  resetHistoryTracking();
});

// Expected values are read OFF THE FIXTURE, never hard-coded, so an assertion
// cannot silently drift from the payload it claims to pin. Annotated `string`
// (not left as the JSON import's literal type) so the comparisons below stay
// runtime assertions instead of collapsing into compile-time literal identity.
const FIXTURE_BODY: string = FULL_ENVELOPE.message.content;
const FIXTURE_SIGNAL_PROMPT: string = FULL_ENVELOPE.signal.prompt;
const FIXTURE_METADATA_PROMPT: string = FULL_ENVELOPE.signal.metadata.prompt;

describe("system_event envelope — the captured architecture.review_plan wire payload", () => {
  test("reaches the agent as exactly one channel notification", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("notifications/claude/channel");
  });

  // The ticket names three negatives. Each is asserted EXPLICITLY rather than
  // folded into the length check, because they are three different defects:
  // `""` is the 167-empty-wake bug, `undefined` is a key rename, and a
  // `System dispatch:` body means the promptless placeholder path swallowed a
  // dispatch that had a real rendered prompt.
  test("body is a non-empty string — not \"\", not undefined, not the placeholder", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    const content = calls[0]!.params.content;
    expect(typeof content).toBe("string");
    expect(content).not.toBeUndefined();
    expect(content).not.toBe("");
    expect((content as string).trim().length).toBeGreaterThan(0);
    // Paired with the bare-envelope assertion in the sibling stage, which
    // requires the promptless dispatch DOES match this. Collapse the two paths
    // onto one body and exactly one of the two tests goes red.
    expect(content as string).not.toMatch(/^System dispatch:/);
  });

  // BYTE IDENTITY against the loaded fixture — not `toContain` on a snippet
  // (which passes on a truncated body) and not a string literal (which drifts
  // from the fixture silently). Reading the expected value off the fixture is
  // what makes the fixture load-bearing rather than decorative.
  test("body is byte-identical to the captured message.content", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    // Guards the identity assertion against the degenerate case where the
    // fixture itself was blanked: "" === "" would otherwise read as green.
    expect(FIXTURE_BODY.length).toBeGreaterThan(0);
    expect(calls[0]!.params.content).toBe(FIXTURE_BODY);
  });

  // The envelope carries `history: []`, so the injection block at
  // `src/attention.ts:167-178` must not fire. Two independent conditions
  // currently prevent it (no top-level `space_id`, and an empty history array);
  // this pins the observable result of both.
  test("no Recent context block is prepended", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    expect(calls[0]!.params.content as string).not.toMatch(/^Recent context/);
  });

  // An assertion about the SERVER CONTRACT, which is why it is made against the
  // fixture and not against handler output. The `??` chain at
  // `src/attention.ts:89` is only safe while these three are byte-equal; if
  // core ever renders them from different sources the fallback becomes a coin
  // flip, and this is the only place that would notice.
  test("core sends the prompt at all three keys, byte-equal", () => {
    expect(FIXTURE_BODY.length).toBeGreaterThan(0);
    expect(FIXTURE_SIGNAL_PROMPT).toBe(FIXTURE_BODY);
    expect(FIXTURE_METADATA_PROMPT).toBe(FIXTURE_SIGNAL_PROMPT);
  });

  // Each id is asserted EQUAL to the fixture's value AND independently truthy.
  // The equality alone is the vacuity trap this task exists to close:
  // `expect(undefined).toBe(undefined)` passes, so a handler that resolved
  // nothing and a fixture that carried nothing would agree perfectly.
  test("all four correlation ids survive to the agent", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    const meta = calls[0]!.params.meta as Record<string, string>;

    expect(FULL_ENVELOPE.signal.task_id).toBeTruthy();
    expect(meta.task_id).toBeTruthy();
    expect(meta.task_id).toBe(FULL_ENVELOPE.signal.task_id);

    expect(FULL_ENVELOPE.signal.plan_id).toBeTruthy();
    expect(meta.plan_id).toBeTruthy();
    expect(meta.plan_id).toBe(FULL_ENVELOPE.signal.plan_id);

    expect(FULL_ENVELOPE.signal.stage_id).toBeTruthy();
    expect(meta.stage_id).toBeTruthy();
    expect(meta.stage_id).toBe(FULL_ENVELOPE.signal.stage_id);

    expect(FULL_ENVELOPE.signal.project_id).toBeTruthy();
    expect(meta.project_id).toBeTruthy();
    expect(meta.project_id).toBe(FULL_ENVELOPE.signal.project_id);
  });

  // Which responsibility fired, and under what. Without these the dispatch says
  // "do this" with no indication of what asked or why.
  test("responsibility_key, feature, trigger_kind and reason survive to the agent", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.responsibility_key).toBe("architecture.review_plan");
    expect(meta.responsibility_key).toBe(FULL_ENVELOPE.signal.responsibility_key);
    expect(meta.feature).toBe("architecture");
    expect(meta.trigger_kind).toBe("event_topic");
    expect(meta.reason).toBe("system_event");
    expect(meta.author).toBe(FULL_ENVELOPE.message.author);
  });

  // The whitelist at `src/attention.ts:131-136` exists so the rendered body is
  // not duplicated out of the tag's content into its attributes. `signal.metadata`
  // also carries `prompt`, `agent_slug` and `agent_id`; only the correlation ids
  // are meant to cross.
  test("the rendered prompt is not duplicated into the tag attributes", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(fullEnvelope());

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.prompt).toBeUndefined();
    expect("prompt" in meta).toBe(false);
    expect(JSON.stringify(meta)).not.toContain(FIXTURE_BODY);
    expect(JSON.stringify(meta)).not.toContain("You are the Architect");
  });
});
