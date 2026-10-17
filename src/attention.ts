import type { AttentionPayload } from "./suite-client.ts";

// ── History injection ──────────────────────────────────────────────────────
//
// Suite's chat-driven attention events carry a `history` array of prior turns
// in the space (see `core:apps/platform/lib/platform/chat/agent_responder.ex §
// build_history/3`, whose result is attached to the chat-path signal).
// Task-router dispatches leave it empty — they pass context via the `context`
// field instead.
//
// We want Claude's session to see that history *once*, on the first attention
// it receives from a given space within this process lifetime. Subsequent
// attentions don't re-emit it (the Claude session already has it in its own
// turn log). On WebSocket reconnect we clear the tracking set so the next
// attention from a space we'd already seen re-injects history — handy if the
// plugin missed events during the disconnect.

const historyEmittedForSpace = new Set<string>();

/**
 * Clear all per-space history tracking. Call this on WebSocket (re)connect so
 * a fresh socket session re-injects history per space.
 */
export function resetHistoryTracking(): void {
  historyEmittedForSpace.clear();
}

// Exposed for tests only. Don't call from production code.
export function _historyEmittedForSpace(): ReadonlySet<string> {
  return historyEmittedForSpace;
}

// Cap on the number of history turns we prepend, so a chatty space doesn't
// dump a 50-turn block on first contact.
export const MAX_HISTORY_TURNS = 20;

export interface AttentionNotification {
  method: "notifications/claude/channel" | "notifications/claude/channel/permission";
  params: Record<string, unknown>;
}

export type NotifyFn = (notification: AttentionNotification) => void | Promise<void>;

export interface EmitAttentionOptions {
  notify: NotifyFn;
  allowPermissionRelay?: boolean;
  // Setter called when an attention pins (or updates) the active permission
  // space. Kept as a callback so `index.ts` can own the mutable state.
  setActivePermissionSpace?: (spaceId: string) => void;
}

// Suite chat replies that match this shape are forwarded as permission
// verdicts instead of regular attentions.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

// Scalar correlation ids lifted out of `signal.metadata` into the channel
// tag. Mirrors `@native_trigger_scalar_keys` in core's
// `responsibilities/router.ex`, plus `space_id` so a dispatch that only
// names its space inside metadata is still repliable.
export const METADATA_SCALAR_KEYS = [
  "task_id",
  "plan_id",
  "stage_id",
  "project_id",
  "space_id",
] as const;

/**
 * A one-line body for a dispatch that survived the drop guard carrying no
 * rendered prompt.
 *
 * A responsibility whose feature has no `build_prompt/1` fires with no
 * `message`, no `signal.prompt` and no `metadata.prompt` — core's
 * `maybe_put(map, _key, nil), do: map` omits those keys rather than blanking
 * them. Before this existed such a dispatch reached the agent as an EMPTY
 * `<channel>` tag: indistinguishable from housekeeping noise, with nothing to
 * act on and nothing to report. That is the shape of the 167 empty wakes over
 * six days that #15 and this function exist to eliminate.
 *
 * The text NAMES WHAT FIRED, so the receiving agent can decide whether the
 * absence of a prompt is itself the story (it usually is — a responsibility
 * that fired and rendered nothing is a defect signal). It is also deliberately
 * marked: `test/system-event-envelope.test.ts` asserts the placeholder DOES
 * match `/^System dispatch:/` and that a real rendered prompt does NOT, so the
 * two paths can never be collapsed without one of the two going red.
 *
 * Degrades one rung at a time and NEVER interpolates a missing value: emitting
 * the literal string "undefined" to an agent is worse than the empty tag,
 * because it reads as a bug in the dispatch rather than an absence in it.
 * `meta` only ever holds keys that were present and truthy (see the assignments
 * in `emitAttention`), so `||` here is a presence test, not a blank-coercion.
 */
function describeBodylessDispatch(meta: Record<string, string>): string {
  const what = meta.responsibility_key || meta.reason || "unidentified responsibility";
  const how = meta.trigger_kind ? ` (${meta.trigger_kind})` : "";
  return `System dispatch: ${what}${how} — no rendered prompt.`;
}

// ENVELOPE-RECORD 3/3 — system_event attention envelope
// DECIDED: this bridge resolves the scalar correlation ids ROOT-FIRST with a
//   `signal.metadata` fallback. The sibling `openclaw-suite-channel` bridge
//   resolves them from the root EXCLUSIVELY, with no fallback at all. That
//   divergence is deliberate, not drift, and the two are NOT to be harmonised.
//   `space_id` rides the metadata list as a REPLY target ONLY — the permission
//   pin at the top of `emitAttention` reads the top level and nothing else.
// WHY: openclaw's inbound path reads the root everywhere, and its metadata
//   also carries the rendered prompt, so a metadata fallback would buy that
//   bridge nothing it does not already have. Here the fallback is load-bearing
//   in the other direction: a responsibility whose feature renders no prompt
//   ships its ids in metadata alone, and dropping the fallback would lose them.
//   The `space_id` half is the same ruling in both repos for the same reason —
//   resolving the PERMISSION space from metadata would silently move a live
//   approval prompt to a space no human is watching, and the prompt would
//   still look delivered. Replying into a metadata-named space is safe;
//   re-pinning an approval is not.
// WHAT WOULD RETIRE THIS: the divergence is justified by exactly one premise —
//   the two bridges' inbound paths differ, so each ruling is correct for its
//   own repo rather than one of them being behind. Two observable changes
//   would end that premise, and either is enough:
//     (a) `openclaw-suite-channel` grows a metadata fallback of its own. The
//         paths then no longer differ, "correct for their own repo" stops
//         being true, and harmonising the two becomes the cheaper option.
//     (b) Core stops emitting the duplicate copies in `signal.metadata`. The
//         fallback is then dead code on BOTH sides and there is nothing left
//         to diverge about.
//   The specific observable for (b), so this is checkable rather than
//   rhetorical: core writes every scalar correlation id TWICE today.
//   `core:apps/platform/lib/platform/responsibilities/router.ex §
//   put_trigger_scalars/2` writes each id INTO `metadata`, and
//   `core:apps/platform/lib/platform/chat/agent_responder.ex §
//   build_system_event_signal/2` then lifts the same ids to the signal ROOT
//   while leaving `metadata` intact (`|> lift_correlation_ids(metadata) |>
//   Map.put(:metadata, metadata)`). Every id core sends today therefore exists
//   at both places, byte-equal — pinned by "the captured envelope mirrors all
//   four ids, root and metadata byte-equal" in
//   `test/system-event-envelope.test.ts`. The day either side stops
//   dual-writing, that test goes red and this record is due for revisiting.
// RETIREMENT STATUS 2026-07-31: NOT MET.
//   READ THE ASYMMETRY DELIBERATELY: records 1/3 and 2/3 are both stamped MET
//   and this one is not. That is information, not an inconsistency to smooth
//   over — the three records share a SUBJECT, not a CONDITION. Records 1 and 2
//   turn on whether a client still silently drops this envelope and swallows
//   the throw; task `019fa618-ca92` closed that, so their condition is met.
//   THIS record turns on whether the two bridges' inbound paths still differ,
//   and both of its premises hold today:
//     (a) `019fa618-ca92` shipped openclaw v0.6.9 (`429dfd5`), which widened
//         its payload TYPE to match the envelope core actually sends. It did
//         NOT add a metadata fallback; that bridge still resolves root-only.
//     (b) Core still dual-writes, at both sites named above.
//   So the divergence remains justified, and this is the one record of the
//   three whose condition is genuinely still open. A met condition on the
//   other two makes their question askable; it says nothing about this one.
// SIBLING RECORDS:
//   1/3 core:apps/platform/test/platform/chat/agent_responder_system_event_payload_test.exs § describe "site 3 — broadcast_system_event/3" (019fa56b-c5ef)
//   2/3 core:apps/platform/lib/platform/chat/agent_responder.ex § build_system_event_payload/1 (019fa510)

/**
 * Build an `emitAttention` function bound to the given notifier. Factored out
 * of `index.ts` so the per-space history injection logic is testable without
 * booting the MCP server / Phoenix socket.
 */
export function makeEmitAttention(opts: EmitAttentionOptions): (payload: AttentionPayload) => Promise<void> {
  const { notify, allowPermissionRelay = false, setActivePermissionSpace } = opts;

  return async function emitAttention(payload: AttentionPayload): Promise<void> {
    // Read from the top level ONLY, not from `signal.metadata`. A background
    // responsibility dispatch naming a space in its metadata must not re-pin
    // where a pending permission prompt gets answered — that would silently
    // move an approval to a space the human isn't watching. `meta.space_id`
    // below is resolved more permissively, because replying is safe.
    const spaceId = payload.signal?.space_id;
    if (spaceId && setActivePermissionSpace) setActivePermissionSpace(spaceId);

    // Chat attentions carry `message.content`. Responsibility dispatches
    // (`reason: "system_event"` — design steps, architecture reviews, memory
    // sweeps, every `event_topic` responsibility) carry no `message` key at
    // all; their rendered prompt is at `signal.prompt`. Reading only the
    // first is why those arrived as empty <channel> tags and looked like
    // housekeeping noise.
    const text = payload.message?.content ?? payload.signal?.prompt ?? "";
    const maybeVerdict = allowPermissionRelay ? PERMISSION_REPLY_RE.exec(text) : null;

    if (maybeVerdict) {
      await notify({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: maybeVerdict[2]!.toLowerCase(),
          behavior: maybeVerdict[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
        },
      });
      return;
    }

    const meta: Record<string, string> = {};
    if (payload.signal?.space_id) meta.space_id = payload.signal.space_id;
    if (payload.signal?.message_id) meta.message_id = payload.signal.message_id;
    if (payload.signal?.task_id) meta.task_id = payload.signal.task_id;
    if (payload.signal?.task_status) meta.task_status = payload.signal.task_status;
    if (payload.signal?.reason) meta.reason = payload.signal.reason;
    if (payload.message?.author) meta.author = payload.message.author;
    if (payload.message?.author_id) meta.author_id = payload.message.author_id;

    // Which responsibility fired, lifted to the top of the signal by
    // `core:apps/platform/lib/platform/chat/agent_responder.ex §
    // build_system_event_signal/2`. Without these a dispatch says "do this"
    // with no indication of what asked or why.
    //
    // WAS a line pin into `agent_responder.ex` at lines 485-487, and it had
    // rotted: those lines now sit inside an unrelated comment block, and the
    // lift is in the function named above. A line number records no
    // expectation, so nothing could notice; a function name either is in the
    // file or is not. (Written out longhand rather than as `file:line`, because
    // the audit bans that shape ANYWHERE in a record — including in an account
    // of a pin that has already been removed. The history is the point; the
    // followable-looking string is not.)
    if (payload.signal?.responsibility_key) {
      meta.responsibility_key = payload.signal.responsibility_key;
    }
    if (payload.signal?.feature) meta.feature = payload.signal.feature;
    if (payload.signal?.trigger_kind) meta.trigger_kind = payload.signal.trigger_kind;

    // Correlation ids, resolved ROOT-FIRST with `signal.metadata` as fallback,
    // one key at a time.
    //
    // A WHITELIST, deliberately — never spread the map. It also holds
    // `prompt` (the entire rendered body, already the tag's content) and on
    // the chat path a frozen history snapshot, so copying it wholesale would
    // duplicate the whole dispatch into the tag attributes. Same reasoning as
    // `@native_trigger_scalar_keys` on the server side —
    // `core:apps/platform/lib/platform/responsibilities/router.ex §
    // native_trigger_scalar_keys/0` (the whitelist itself; the write is
    // `put_trigger_scalars/2` just below it). Was pinned into `router.ex` at
    // line 1447, which no longer lands on either.
    //
    // Top level wins: chat attentions set `signal.task_id` directly, and a
    // value the server put at the top is the more specific statement. That
    // claim used to hold for `task_id` ALONE — seeded above from the root —
    // while `plan_id`, `stage_id` and `project_id` resolved from metadata,
    // because `AttentionPayload["signal"]` did not declare them at the root
    // and this loop therefore could not see the copies core was already
    // sending. Behaviour-preserving for every payload core emits today (both
    // copies are byte-equal), and it degrades gracefully if metadata is ever
    // slimmed. Pinned by the divergence probe in
    // `test/system-event-envelope.test.ts`, which is the only construction
    // that can distinguish the two sources.
    //
    // `space_id` RIDES THIS LIST AS A REPLY TARGET ONLY. Do not "make it
    // consistent" with the other four: its root value is already seeded above
    // and the permission pin at the top of this function reads the top level
    // and nothing else, on purpose. Resolving the PERMISSION space from
    // metadata would silently move a live approval prompt to a space no human
    // is watching — an invisible failure, since the prompt would still look
    // delivered. Pinned by "the space_id asymmetry" in the same test file.
    //
    // The sibling `openclaw-suite-channel` bridge resolves these from the root
    // EXCLUSIVELY, with no metadata fallback. That divergence is deliberate,
    // not drift: its inbound path reads root everywhere and its metadata also
    // carries the rendered prompt. Both rulings are correct for their own
    // repo; do not harmonise them. THE FALSIFIER FOR THAT RULING — the two
    // observable changes that would make harmonising correct, and why the
    // record's status differs from its two siblings' — is stated in record 3/3
    // above `makeEmitAttention`. This paragraph stays here because its detail
    // is load-bearing at exactly this line; the record is where the decision
    // is argued and cross-referenced.
    const signalMetadata = payload.signal?.metadata ?? {};
    for (const key of METADATA_SCALAR_KEYS) {
      if (meta[key]) continue;
      // `typeof` guard on both sources, not just `??`: a root key present but
      // BLANK must fall through to metadata rather than win and then be
      // discarded, which would drop an id that was available all along.
      const rootValue = payload.signal?.[key];
      if (typeof rootValue === "string" && rootValue) {
        meta[key] = rootValue;
        continue;
      }
      const value = signalMetadata[key];
      if (typeof value === "string" && value) meta[key] = value;
    }

    // Drop attentions that carry no body AND nothing to correlate — presence
    // sweeps and reconnect echoes. Forwarding those surfaces an empty
    // <channel> tag that interrupts the session with nothing to act on.
    //
    // Deliberately placed HERE, after `meta` is resolved, not next to the
    // `text` assignment:
    //
    //   - `task_id` legitimately arrives inside `signal.metadata`, so a guard
    //     reading `payload.signal.task_id` alone would drop a dispatch whose
    //     id the whitelist loop above just resolved. The question "can we
    //     correlate this?" must be asked against the same resolution the tag
    //     will actually carry.
    //   - `responsibility_key` counts as actionable even with a blank body. A
    //     responsibility that fired and rendered nothing is a DEFECT SIGNAL,
    //     not housekeeping — it is precisely the shape of the bug fixed in
    //     #15, where the empty tag was the only evidence the defect left and
    //     the sole reason it was ever found. Filtering those re-blinds us.
    //
    // Still lands after space pinning (permission relay unchanged) and before
    // history injection (noise can't consume a space's one-time history
    // block). Both are pinned by tests.
    if (!text.trim() && !meta.task_id && !meta.message_id && !meta.responsibility_key) {
      console.error(
        `[burrow-channel-claude-code] dropped content-less attention (reason=${meta.reason || "unknown"})`,
      );
      return;
    }

    // The attention survived the guard but rendered no body. Substitute a
    // placeholder that names what fired, so the agent gets a legible statement
    // instead of an empty <channel> tag. Whitespace-only counts as empty:
    // keying this on `text` rather than `text.trim()` would ship a tag holding
    // a single newline, which is the defect wearing a different hat.
    //
    // PLACEMENT IS LOAD-BEARING — this runs AFTER the drop guard above, never
    // before it, and it must stay there. Computed earlier, `text.trim()` would
    // be non-empty for EVERY payload, the guard's `!text.trim()` arm would
    // become dead code, and every presence sweep and reconnect echo the guard
    // is entitled to drop would come back as a "System dispatch:" wake. The
    // guard decides WHAT REACHES the agent; this decides only how the survivors
    // READ. Pinned by "a genuinely content-free attention still drops" in
    // `test/system-event-envelope.test.ts`.
    const body = text.trim() ? text : describeBodylessDispatch(meta);

    let content = body;
    if (
      spaceId &&
      !historyEmittedForSpace.has(spaceId) &&
      payload.history &&
      payload.history.length > 0
    ) {
      const recent = payload.history.slice(-MAX_HISTORY_TURNS);
      const block = recent.map((h) => `${h.author}: ${h.content}`).join("\n");
      content =
        `Recent context (last ${recent.length} turns in this space):\n${block}\n\n---\n\nCurrent message:\n${body}`;
      historyEmittedForSpace.add(spaceId);
    }

    await notify({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  };
}
