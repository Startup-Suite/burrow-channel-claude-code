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
import type { AttentionPayload } from "../src/suite-client.ts";
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

// ── The two resolution rules ───────────────────────────────────────────────
//
// Everything above pins the OUTCOME on the captured envelope. It cannot pin
// the SOURCE, because the capture carries every correlation id at BOTH
// `signal.<id>` and `signal.metadata.<id>`, byte-equal — so a handler reading
// either one produces an identical tag. The tests below feed DISCRIMINATING
// payloads where the two candidate sources hold DIFFERENT values. That is the
// only construction that can tell you which copy was read.
//
// Synthetic on purpose, and only where the real envelope is structurally
// unable to answer the question. The fixture stays the authority on shape.

/** A minimal `system_event` signal with a body, so the drop-guard never fires. */
function systemEvent(signal: Partial<AttentionPayload["signal"]>): AttentionPayload {
  return {
    signal: {
      reason: "system_event",
      responsibility_key: "probe.resolution",
      prompt: "rendered body",
      ...signal,
    },
  };
}

function captureWithPermissionSpy(): {
  notify: NotifyFn;
  calls: AttentionNotification[];
  pinnedSpaces: string[];
} {
  const { notify, calls } = captureNotifications();
  const pinnedSpaces: string[] = [];
  return { notify, calls, pinnedSpaces };
}

// PART A — THE space_id ASYMMETRY.
//
// PIN ONLY. No production code changes for this describe block, and that is
// the point: the split between `src/attention.ts:80` (permission prompt, TOP
// LEVEL ONLY) and `:104`+the whitelist loop (reply target, metadata fallback
// allowed) is deliberate and load-bearing, is documented only in a comment,
// and was pinned by nothing that reads the real envelope. Replying into a
// space named in metadata is safe. Re-pinning where a PENDING APPROVAL gets
// answered is not — a background dispatch that moved it would send the prompt
// to a space no human is watching, and the human would simply never see it.
describe("system_event envelope — the space_id asymmetry", () => {
  // Asserted against the FIXTURE, not just handler output. A future edit that
  // "helpfully" adds a space_id to the capture would quietly gut every
  // assertion below it, and this is what catches that.
  test("the captured envelope names no space, at either level", () => {
    expect("space_id" in FULL_ENVELOPE.signal).toBe(false);
    expect("space_id" in FULL_ENVELOPE.signal.metadata).toBe(false);
  });

  // Key ABSENCE via `in`, not `=== undefined`. The suite already draws that
  // distinction at `test/emit-attention.test.ts:218-227` and it matters:
  // "no addressable space" and "space is blank" are different states, and only
  // the first lets a reader fall back to some other route.
  test("the handler does not invent a space, and pins no permission space", async () => {
    const { notify, calls, pinnedSpaces } = captureWithPermissionSpy();
    const emit = makeEmitAttention({
      notify,
      setActivePermissionSpace: (sid) => pinnedSpaces.push(sid),
    });

    await emit(fullEnvelope());

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect("space_id" in meta).toBe(false);
    expect(pinnedSpaces).toEqual([]);
  });

  // THE DISCRIMINATING CASE, and both halves belong in one test: stating them
  // together is what turns the asymmetry into a pinned RULE rather than two
  // facts that happen to coexist. Split them and a refactor can satisfy each
  // separately while destroying the relationship between them.
  test("a metadata-only space becomes the reply target but NOT the permission space", async () => {
    const { notify, calls, pinnedSpaces } = captureWithPermissionSpy();
    const emit = makeEmitAttention({
      notify,
      setActivePermissionSpace: (sid) => pinnedSpaces.push(sid),
    });

    await emit(systemEvent({ metadata: { space_id: "background-space" } }));

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.space_id).toBe("background-space");
    expect(pinnedSpaces).toEqual([]);
  });
});

// PART B — WHICH COPY OF THE FOUR IDS THE HANDLER READS.
//
// MEASURED on `origin/main` (eab9fb5) before the change, with exactly the
// payload the first test below feeds:
//
//     task_id    = "ROOT-task"   <- seeded from the root at `attention.ts:106`
//     plan_id    = "META-plan"   <- resolved from metadata by the loop
//     stage_id   = "META-stage"
//     project_id = "META-proj"
//
// One field in four. The comment at `src/attention.ts:130` claims "Top level
// wins" for all of them; the loop could not honour it for the other three
// because `AttentionPayload["signal"]` (`src/suite-client.ts:26-50`) did not
// DECLARE `plan_id` / `stage_id` / `project_id` at the root — so the root
// copies core actually sends were unreadable, not merely unread. The fix is
// two lines of interface plus a root-first lookup.
//
// Behaviour-preserving against every payload core emits today: the captured
// envelope carries all four at both places, byte-equal (pinned below, since
// that equality is this change's entire safety argument).
describe("system_event envelope — correlation ids resolve root-first", () => {
  // The premise of the whole change. If core ever stops mirroring these, the
  // divergence stops being hypothetical and this goes red first.
  test("the captured envelope mirrors all four ids, root and metadata byte-equal", () => {
    for (const key of ["task_id", "plan_id", "stage_id", "project_id"] as const) {
      const root = FULL_ENVELOPE.signal[key];
      const fromMetadata = FULL_ENVELOPE.signal.metadata[key];
      expect(root).toBeTruthy();
      expect(fromMetadata).toBe(root);
    }
  });

  // THE DIVERGENCE PROBE. Red before the change on three of four keys.
  test("root wins for all four ids when root and metadata disagree", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(
      systemEvent({
        task_id: "ROOT-task",
        plan_id: "ROOT-plan",
        stage_id: "ROOT-stage",
        project_id: "ROOT-proj",
        metadata: {
          task_id: "META-task",
          plan_id: "META-plan",
          stage_id: "META-stage",
          project_id: "META-proj",
        },
      }),
    );

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.task_id).toBe("ROOT-task");
    expect(meta.plan_id).toBe("ROOT-plan");
    expect(meta.stage_id).toBe("ROOT-stage");
    expect(meta.project_id).toBe("ROOT-proj");
  });

  // THE REGRESSION GUARD on the change above, and the reason root-first is
  // "first" rather than "only": responsibilities whose feature renders no
  // prompt ship their ids in metadata alone (see
  // `test/emit-attention.test.ts:436-451` and `:582-605`, which must also stay
  // green). If this goes red the change is wrong — do not relax the test.
  test("metadata-only ids still resolve when the root omits them", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(
      systemEvent({
        metadata: {
          task_id: "META-task",
          plan_id: "META-plan",
          stage_id: "META-stage",
          project_id: "META-proj",
        },
      }),
    );

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.task_id).toBe("META-task");
    expect(meta.plan_id).toBe("META-plan");
    expect(meta.stage_id).toBe("META-stage");
    expect(meta.project_id).toBe("META-proj");
  });

  // Discriminates against the obvious one-line spelling of "root-first",
  // `signal[key] ?? metadata[key]`: a blank root is not `undefined`, so that
  // version yields `""`, fails the truthiness guard, and DROPS the key
  // entirely — losing an id that was sitting right there in metadata.
  test("a blank root id does not beat a real metadata value", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(
      systemEvent({
        plan_id: "",
        stage_id: "",
        metadata: { plan_id: "META-plan", stage_id: "META-stage" },
      }),
    );

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.plan_id).toBe("META-plan");
    expect(meta.stage_id).toBe("META-stage");
  });

  // `space_id` is NOT swept into the root-first rule's blast radius. Its
  // permission pin stays top-level-only even when the root also carries the
  // four ids — i.e. on exactly the payload shape that tempts a "make them all
  // consistent" refactor. Part A pins the asymmetry; this pins that Part B
  // did not quietly break it.
  test("the root-first rule leaves the permission pin alone", async () => {
    const { notify, calls, pinnedSpaces } = captureWithPermissionSpy();
    const emit = makeEmitAttention({
      notify,
      setActivePermissionSpace: (sid) => pinnedSpaces.push(sid),
    });

    await emit(
      systemEvent({
        task_id: "ROOT-task",
        plan_id: "ROOT-plan",
        metadata: { space_id: "background-space", stage_id: "META-stage" },
      }),
    );

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.task_id).toBe("ROOT-task");
    expect(meta.plan_id).toBe("ROOT-plan");
    expect(meta.stage_id).toBe("META-stage");
    expect(meta.space_id).toBe("background-space");
    expect(pinnedSpaces).toEqual([]);
  });
});
