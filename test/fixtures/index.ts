/**
 * Captured `system_event` envelopes, as the Burrow server actually emits them.
 *
 * PROVENANCE. Both JSON files are verbatim captures from live production
 * dispatches, filed on Burrow task `019fa618-c860-7f4d-9e00-4519a6aca5bd` by
 * task `019fa510` stage 6. They are wire payloads, not hand-written
 * approximations — that is the entire point of the fixture, and it is why the
 * JSON files carry no comments, no reformatting and no key reordering.
 *
 *   - `system_event.architecture_review_plan.json` — an `architecture.review_plan`
 *     fire for agent `moore`. Carries `message`, `context`, `history` and a
 *     rendered `signal.prompt`.
 *   - `system_event.bare_no_prompt.json` — a `memory.dreaming` cron fire for
 *     `higgins`. Carries NO `message`, NO `history`, NO `context` and NO
 *     `signal.prompt` key at all: when a responsibility's feature has no
 *     `build_prompt/1`, core's `maybe_put(map, _key, nil), do: map` OMITS those
 *     keys rather than sending them blank. Their absence is the test; do not
 *     add empty stand-ins.
 *
 * ELISION — READ THIS BEFORE TRUSTING A BYTE COUNT. The real
 * `architecture.review_plan` prompt was 13,325 bytes. The capture as filed
 * elides its middle with a literal `[…]` marker, and the full body was never
 * captured, so this fixture's prompt is ABRIDGED and is not 13,325 bytes. That
 * marker is part of the artifact and is preserved on purpose. It costs nothing
 * here: what this fixture pins is the envelope's SHAPE and the byte-equality of
 * its duplicated keys, neither of which depends on the body's length. Any test
 * asserting a body length or a full-prompt substring is asserting against the
 * elision, not against production.
 *
 * TWO STRUCTURAL FACTS the full envelope encodes, both load-bearing:
 *
 *   1. `message.content`, `signal.prompt` and `signal.metadata.prompt` are all
 *      BYTE-EQUAL. That equality is what makes the `??` fallback at
 *      `src/attention.ts:89` safe rather than a coin flip.
 *   2. The four correlation ids (`task_id`, `plan_id`, `stage_id`,
 *      `project_id`) each appear at BOTH `signal.<id>` and
 *      `signal.metadata.<id>`, byte-equal.
 *
 * Also note what is ABSENT and must stay absent: there is no `space_id`, at
 * either `signal` or `signal.metadata`. A native `system_event` envelope does
 * not name a space, and `src/attention.ts:80` pins a pending permission prompt
 * from the top-level field ONLY.
 *
 * WHAT THIS PROTECTS, measured on production 2026-07-27T20:55Z → 2026-07-28T00:14Z,
 * after the `signal.prompt` fallback landed: 23 non-empty `system_event` wakes
 * in moore's transcripts and ZERO empty ones, against 167 empty wakes over the
 * preceding six days. Verdict rows on plans went 4 → 9 in the same window.
 */

import type { AttentionPayload } from "../../src/suite-client.ts";
import fullFixture from "./system_event.architecture_review_plan.json" with { type: "json" };
import bareFixture from "./system_event.bare_no_prompt.json" with { type: "json" };

// The raw imports, re-exported with their precise inferred JSON types. Tests
// read EXPECTED values off these (e.g. `FULL_ENVELOPE.message.content`) so an
// assertion can never drift from the fixture the way a hard-coded string
// literal silently would. Treat them as frozen: to feed the handler, use the
// cloning accessors below.
export { fullFixture as FULL_ENVELOPE, bareFixture as BARE_ENVELOPE };

/**
 * The full `architecture.review_plan` envelope, as a fresh deep copy.
 *
 * A structured clone per call, deliberately: `bun test` shares module state
 * across every test file in a run, so handing out the imported object would let
 * one test mutate the fixture out from under another.
 */
export function fullEnvelope(): AttentionPayload {
  return structuredClone(fullFixture) as AttentionPayload;
}

/**
 * The promptless `memory.dreaming` envelope, as a fresh deep copy. Same
 * isolation reasoning as `fullEnvelope()`.
 */
export function bareEnvelope(): AttentionPayload {
  return structuredClone(bareFixture) as AttentionPayload;
}
