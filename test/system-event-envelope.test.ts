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
// `message.content` and `signal.prompt`, byte-equal, so NO FIXTURE-DRIVEN
// ASSERTION IN THIS FILE can distinguish a handler that reads one from a
// handler that reads the other. The fixture pins the OUTCOME and the server
// CONTRACT; the fallback ORDERING is pinned by the signal-only bare fixture,
// by the synthetic degradation cases at the bottom of this file, and by the
// sentinel test on `task/019fa56b-system-event-capability` (PR #16).
// Manufacturing a both-populated-but-different payload to force a red here
// would pin a shape core never sends. Measured, both directions, below.
//
// AND: the fixture's prompt is ABRIDGED (see `test/fixtures/index.ts` — the
// real body was 13,325 bytes and the capture elides its middle with a literal
// `[…]`). Nothing below asserts a body LENGTH or a substring of the body, only
// byte-identity against the fixture object and cross-key equality. An assertion
// on size would be an assertion about the elision.
//
// ── THE PERTURBATION MATRIX ────────────────────────────────────────────────
//
// A fixture test that passes against a broken handler is worse than none.
// Every row below was APPLIED to `src/attention.ts` in this worktree, run, and
// REVERTED, with `git status` confirming a clean tree after each. Failure text
// is transcribed from the run, not predicted. Format follows PR #16's body.
//
// MEASURED BASELINES. `origin/main` (eab9fb5): 41 pass, 0 fail, 127 expect(),
// 4 files. This branch after stages 1–4: 69 pass, 0 fail, 229 expect(),
// 5 files. `tsc --noEmit` clean at both.
//
// TWO DIFFERENT INSTRUMENTS, and each row says which. `bun test` strips types
// and never typechecks, so a perturbation that deletes or renames a declared
// field fails at COMPILE time and would still run green under `bun test`
// alone. Stage 3 widened `AttentionPayload["signal"]` precisely so the root
// copies of `plan_id`/`stage_id`/`project_id` were readable; perturbing that
// widening is a `tsc` finding, not an assert finding. Rows 1 and 2 below are
// caught by BOTH, and that is worth knowing rather than assuming.
//
// | # | perturbation | site | instrument | observed |
// |---|---|---|---|---|
// | 1 | `text` reads keys the payload genuinely lacks: `payload.message?.body ?? payload.signal?.rendered_prompt ?? ""` | `src/attention.ts:120` | `tsc` AND test | `tsc` TS2339 ×2 (`Property 'body' does not exist…`, `Property 'rendered_prompt' does not exist…`). `bun test` 55 pass / **14 fail**; byte-identity red at `:187` with a real diff — `Expected: "You are the Architect on the Suite plan-review path…"` / `Received: "System dispatch: architecture.review_plan (event_topic) — no rendered prompt."` |
// | 2 | whitelist key drift: `"plan_id"` → `"plan"` | `src/attention.ts:60` | `tsc` AND test | `tsc` TS7053 (`Property 'plan' does not exist…`). 62 pass / **7 fail**; `:231` `expect(meta.plan_id).toBeTruthy()` → `Received: undefined`. The preceding line, `expect(FULL_ENVELOPE.signal.plan_id).toBeTruthy()`, still PASSES — which is what proves the red is the handler's and not the fixture's. |
// | 3 | delete the `responsibility_key` forward | `src/attention.ts:146-148` | test | 56 pass / **13 fail**. `:252` `Expected: "architecture.review_plan"` / `Received: undefined`, and the bare envelope no longer survives the drop guard at all — `:558` `Expected: 1` / `Received: 0`. |
// | 4 | permission pin falls back to metadata: `payload.signal?.space_id ?? (payload.signal?.metadata?.space_id as string \| undefined)` | `src/attention.ts:111` | test | 66 pass / **3 fail**. `:364` and `:500` both `Received: [ "background-space" ]` against `Expected: []`. This is the live-approval-misrouting change, and it is also what proves the `pinnedSpaces` spy is LIVE rather than an array nothing ever writes to — see the note below. |
// | 5 | resolution loop reads metadata-first | `src/attention.ts:192-198` | test | 68 pass / **1 fail**. `:422` `Expected: "ROOT-plan"` / `Received: "META-plan"`. |
// | 6 | revert the placeholder — `const body = text` | `src/attention.ts:243` | test | 61 pass / **8 fail**. `:572` `Expected: "System dispatch: memory.dreaming (cron) — no rendered prompt."` / `Received: ""`; `:591` `not.toMatch(/^System dispatch:/)` inverse red with `Received: ""`. |
// | 7 | substitute the placeholder BEFORE the drop guard instead of after | `src/attention.ts:222` | test | 64 pass / **5 fail**. `:643` `Expected: 0` / `Received: 1` — the guard's `!text.trim()` arm becomes dead code and every presence sweep returns as a `System dispatch:` wake. Invisible to every other assertion in this file. |
//
// ROW 6 IS ROW 7's MIRROR. Row 6 collapses the promptless path onto the
// real-prompt path and `:591` goes red; the full envelope's `:171`
// (`not.toMatch(/^System dispatch:/)`) is what goes red under row 1 when the
// collapse runs the other way. The two assertions are each other's proof.
//
// THE HONEST NEGATIVE — NOT PAPERED OVER.
//
// | perturbation of `src/attention.ts:120` | this file alone | whole suite |
// |---|---|---|
// | `payload.signal?.prompt ?? ""` — message path dropped | **28 pass, 0 fail — GREEN** | 60 pass / 9 fail, all of them pre-existing chat-path tests in `emit-attention.test.ts`. Nothing in THIS file notices. |
// | `payload.message?.content ?? ""` — the literal pre-fix line, the ticket's actual bug | 27 pass / 1 fail | 66 pass / 3 fail |
//
// Read that carefully, because it corrects this file's own earlier claim. The
// captured envelope carries the prompt at `message.content` AND `signal.prompt`
// byte-equal, so EVERY FIXTURE-DRIVEN ASSERTION ABOVE STAYS GREEN UNDER BOTH
// SINGLE-SOURCE READS. That much is unchanged and is the boundary this file
// exists to state. What changed is that the file is no longer entirely blind to
// the pre-fix read: the single red is `a rendered prompt is never replaced`
// (`:727`), a SYNTHETIC signal-only payload added in stage 4, not the fixture —
// `Expected: "Do the actual work described here."` / `Received: "System
// dispatch: memory.dreaming (cron) — no rendered prompt."`. The complementary
// read, `signal.prompt` only, is caught by NOTHING here at all.
//
// So: the fixture protects the CONTRACT (both keys present, byte-equal, all
// four ids surviving, no invented space). The ORDERING is protected by
// synthetic single-source payloads and by PR #16's sentinel test. A
// both-populated-but-different envelope would force a green box at the cost of
// pinning a shape core does not send — PR #16 made the same call for its
// reversed-precedence row and it is the right one. An honest "this cannot catch
// X, here is what does" beats a green box; a signal that exists and does not
// reach what reads it is the exact defect class this task is the fourth
// instance of.
//
// ANTI-VACUITY NOTE ON THE HARNESS ITSELF. Every `pinnedSpaces` assertion in
// this file is NEGATIVE (`toEqual([])`), which is the shape that passes when
// the callback is never wired and no pin could ever have been recorded. Row 4
// discharges that: under it the same spy collects `["background-space"]`, so
// the empty arrays elsewhere are a measured absence rather than an inert one.
// `captureWithPermissionSpy()` deliberately does NOT wire the callback itself —
// each call site passes `setActivePermissionSpace` explicitly, so a test that
// forgets it fails loudly rather than reading as a green negative.
//
// `tsc` DOES NOT FLAG DEAD CODE HERE: under row 6, `describeBodylessDispatch`
// becomes unreferenced and `tsc --noEmit` still exits 0 (`noUnusedLocals` is
// not enabled in `tsconfig.json`). Do not rely on the typechecker to notice an
// orphaned helper.

import { beforeEach, describe, expect, test } from "bun:test";

import {
  makeEmitAttention,
  resetHistoryTracking,
  type AttentionNotification,
  type NotifyFn,
} from "../src/attention.ts";
import type { AttentionPayload } from "../src/suite-client.ts";
import { BARE_ENVELOPE, FULL_ENVELOPE, bareEnvelope, fullEnvelope } from "./fixtures/index.ts";

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

// ── PART C — THE PROMPTLESS ENVELOPE GETS A LEGIBLE BODY ────────────────────
//
// THE ONE BEHAVIOUR CHANGE IN THIS TASK. Everything above pins existing
// behaviour; this block changes it, and the two `toBe("")` assertions at
// `test/emit-attention.test.ts:369` and `:601` moved with it.
//
// THE TICKET IS WRONG ABOUT THE SYMPTOM, measured rather than assumed. It says
// a handler dereferencing `payload.message.<anything>` THROWS on the bare
// envelope. At `eab9fb5` it does not: `src/attention.ts:89` is
// `payload.message?.content ?? payload.signal?.prompt ?? ""`, optional-chained
// on BOTH hops. That description fits the pre-fix handler still running in the
// live checkout at `4691bdb`, not the code this branches from. Running the
// bare fixture through `makeEmitAttention` at `eab9fb5` produced one
// notification, no throw, and `content: ""`.
//
// The real defect is quieter and worse: the bare envelope SURVIVES the drop
// guard (`meta.responsibility_key` is set, and that is correct — a
// responsibility that fired and rendered nothing is a defect signal, not
// noise) and is delivered as an EMPTY <channel> tag. That is the shape of the
// 167 empty wakes over six days this whole task exists to prevent: the agent
// wakes to nothing, and the guard that would have dropped it doesn't, PRECISELY
// because the payload is well-formed.
//
// ROLLOUT IS NOT SELF-VERIFYING. The live bun processes serving this session
// will not pick this up until a human runs `git pull` in
// `/home/queen/sources/claude-code-suite-channel` and restarts the Claude Code
// session — a session cannot restart its own MCP stdio server. Everything below
// verifies in the worktree only.

// Read off the fixture, annotated `string` so the comparisons stay RUNTIME
// assertions. Left at the JSON import's literal type, `expect(a).toBe(b)` over
// two identical string literals is checked by `tsc` and a fixture edit would
// surface as a typecheck failure instead of a red test.
const BARE_KEY: string = BARE_ENVELOPE.signal.responsibility_key;
const BARE_TRIGGER: string = BARE_ENVELOPE.signal.trigger_kind;

describe("system_event envelope — the promptless dispatch carries a legible body", () => {
  // The premise. If a future edit "helpfully" adds a prompt to the capture,
  // every assertion below would pass for the wrong reason.
  test("the captured bare envelope really has no body, at any of the three keys", () => {
    expect("message" in BARE_ENVELOPE).toBe(false);
    expect("prompt" in BARE_ENVELOPE.signal).toBe(false);
    expect("prompt" in BARE_ENVELOPE.signal.metadata).toBe(false);
  });

  // Call count is asserted EXPLICITLY, not implied. A throw inside the handler
  // that a test framework swallowed would otherwise read as zero notifications
  // and look indistinguishable from a deliberate drop.
  test("the handler does not throw, and emits exactly one notification", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(bareEnvelope());

    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("notifications/claude/channel");
  });

  // THE ACTUAL PLACEHOLDER TEXT, asserted in full. `not.toBe("")` or a
  // length check would pass on any garbage; the placeholder's entire job is to
  // be LEGIBLE to the agent that receives it, so legibility is what is pinned.
  test("the body names what fired, in full", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(bareEnvelope());

    const content = calls[0]!.params.content as string;
    expect(content).toBe("System dispatch: memory.dreaming (cron) — no rendered prompt.");
    // Restated against the fixture, so the literal above cannot drift from the
    // payload it claims to describe.
    expect(content).toContain(BARE_KEY);
    expect(content).toContain(BARE_TRIGGER);
    expect(content).not.toContain("undefined");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  // Paired with "body is a non-empty string" above, which requires the FULL
  // envelope's content does NOT match this. The two assertions are each other's
  // proof: collapse the promptless path onto the real-prompt path and exactly
  // one of them goes red.
  test("the body is marked as a placeholder, not passed off as a rendered prompt", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(bareEnvelope());

    expect(calls[0]!.params.content as string).toMatch(/^System dispatch:/);
    expect(calls[0]!.params.content as string).toMatch(/no rendered prompt\.$/);
  });

  test("the responsibility metadata survives alongside the placeholder", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit(bareEnvelope());

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect(meta.responsibility_key).toBe("memory.dreaming");
    expect(meta.feature).toBe("memory");
    expect(meta.trigger_kind).toBe("cron");
    expect(meta.reason).toBe("system_event");
  });

  // Key ABSENCE via `in`, matching `test/emit-attention.test.ts:218-227`. The
  // bare envelope has no space and no correlation ids at all; asserting they
  // are ABSENT — not blank — stops a future `meta` change from inventing
  // placeholders for IDS the way this stage invented one for the BODY.
  test("no space is invented, and no correlation ids are invented either", async () => {
    const { notify, calls, pinnedSpaces } = captureWithPermissionSpy();
    const emit = makeEmitAttention({
      notify,
      setActivePermissionSpace: (sid) => pinnedSpaces.push(sid),
    });

    await emit(bareEnvelope());

    const meta = calls[0]!.params.meta as Record<string, string>;
    expect("space_id" in meta).toBe(false);
    expect("task_id" in meta).toBe(false);
    expect("plan_id" in meta).toBe(false);
    expect(pinnedSpaces).toEqual([]);
  });

  // THE REGRESSION GUARD, and the reason the substitution sits AFTER the drop
  // guard rather than next to the `text` assignment. Computed before the guard,
  // the placeholder would make `text.trim()` non-empty for EVERY payload, the
  // guard's `!text.trim()` arm would become dead code, and every presence sweep
  // and reconnect echo would come back as a "System dispatch:" wake. This is
  // the single most plausible way to get the change wrong.
  //
  // Mirrors `test/emit-attention.test.ts:607-618`, restated here against the
  // placeholder specifically.
  test("a genuinely content-free attention still drops — the guard is not dead code", async () => {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });

    await emit({ signal: { reason: "system_event", metadata: {} } });

    expect(calls.length).toBe(0);
  });
});

// DEGRADATION. The captured fixture carries both `responsibility_key` and
// `trigger_kind`; core omits keys it cannot render (`maybe_put(map, _key, nil),
// do: map`), so neither is guaranteed. Each rung is asserted for the text it
// actually produces, and every one of them for the absence of the literal
// "undefined" — emitting that string to an agent is worse than the empty tag,
// because it looks like a bug in the dispatch rather than an absence in it.
describe("system_event envelope — the placeholder degrades without inventing text", () => {
  async function bodyFor(signal: AttentionPayload["signal"]): Promise<string> {
    const { notify, calls } = captureNotifications();
    const emit = makeEmitAttention({ notify });
    await emit({ signal });
    expect(calls.length).toBe(1);
    return calls[0]!.params.content as string;
  }

  test("without trigger_kind, it still names the responsibility", async () => {
    const body = await bodyFor({
      reason: "system_event",
      responsibility_key: "memory.sweep",
      metadata: {},
    });

    expect(body).toBe("System dispatch: memory.sweep — no rendered prompt.");
    expect(body).not.toContain("undefined");
  });

  // No responsibility at all, but a correlation id — so the guard keeps it and
  // there is still something true to say about why it fired.
  test("without a responsibility, it falls back to the reason", async () => {
    const body = await bodyFor({
      reason: "system_event",
      metadata: { task_id: "019fa504-90f9-7f57-ac67-888093ef8e20" },
    });

    expect(body).toBe("System dispatch: system_event — no rendered prompt.");
    expect(body).not.toContain("undefined");
  });

  // The bottom rung: nothing to name at all. Kept only because a message_id
  // makes it correlatable.
  //
  // Reached via a BLANK reason, not a missing one, and that is a fact `tsc`
  // established rather than a stylistic choice: `AttentionPayload["signal"]`
  // declares `reason` as REQUIRED, so omitting it is a compile error and this
  // rung is unreachable from a well-typed payload. A blank one is the real
  // runtime shape — `meta.reason` is only assigned when truthy
  // (`src/attention.ts`), so a blank reason never reaches the placeholder.
  test("with nothing to name, it says so rather than emitting undefined", async () => {
    const body = await bodyFor({
      reason: "",
      message_id: "019fa504-0000-7000-9000-000000000001",
    });

    expect(body).toBe("System dispatch: unidentified responsibility — no rendered prompt.");
    expect(body).not.toContain("undefined");
  });

  // A whitespace-only body is an empty body. `text` would be truthy, so a
  // substitution keyed on `text` rather than `text.trim()` would ship a tag
  // containing a single newline — visually identical to the defect.
  test("a whitespace-only prompt is treated as no prompt", async () => {
    const body = await bodyFor({
      reason: "system_event",
      responsibility_key: "memory.dreaming",
      trigger_kind: "cron",
      prompt: "   \n  ",
    });

    expect(body).toBe("System dispatch: memory.dreaming (cron) — no rendered prompt.");
  });

  // The other side of the same line: a real body is never touched.
  test("a rendered prompt is never replaced", async () => {
    const body = await bodyFor({
      reason: "system_event",
      responsibility_key: "memory.dreaming",
      trigger_kind: "cron",
      prompt: "Do the actual work described here.",
    });

    expect(body).toBe("Do the actual work described here.");
    expect(body).not.toMatch(/^System dispatch:/);
  });
});
