import type { AttentionNotification, NotifyFn } from "./attention.ts";

// ── Meeting transcript frames ──────────────────────────────────────────────
//
// Core broadcasts one `meeting_transcript` event per FINAL transcript segment
// on the agent's runtime channel (contract:
// `core:docs/contracts/meeting-transcript-frame.md`). Every key is always
// present; keys may be added later but never renamed or removed, so this
// module reads the keys it knows and ignores the rest.
//
// Guarantees core makes, and that this module leans on:
//   - only final segments arrive (no interim/partial text);
//   - the agent never receives its own segments;
//   - frames arrive in append order; `spoken_at` is the tiebreaker;
//   - no ack is expected.
//
// This module does NOT reply, call any tool, or touch the attention/intent
// path. It delivers the segment to the session as an inbound channel message
// — the same notification the space-message path in `attention.ts` uses — and
// the agent decides whether to speak (via `meeting_say` on the hosted Burrow
// MCP server). Core enforces the reply budget.

export interface MeetingTranscriptFrame {
  room_name: string;
  meeting_id: string | null;
  segment_id: string;
  text: string;
  participant_identity: string;
  speaker_name: string | null;
  speaker_kind: "human" | "agent";
  spoken_at: string;
}

// Speech-to-text emits a sentence at a time. A person answering a question
// produces three or four final segments a few hundred milliseconds apart, and
// waking the session once per sentence hands the agent a half-thought to
// answer. Consecutive segments from ONE speaker in ONE room that arrive within
// this window of each other are joined into a single message; the burst
// flushes this long after its last frame.
export const COALESCE_WINDOW_MS = 1_500;

// Injectable timer so tests can drive the window without sleeping real time.
// Bun's test runner has no fake timers by default.
export interface Scheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_SCHEDULER: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface MeetingTranscriptEmitterOptions {
  notify: NotifyFn;
  scheduler?: Scheduler;
  coalesceWindowMs?: number;
}

export interface MeetingTranscriptEmitter {
  // Queue one frame from the socket. Never throws: a malformed frame is
  // logged and dropped.
  handle: (frame: unknown) => void;
  // Deliver whatever is pending right now, without waiting for the window.
  // Called on disconnect so a burst caught mid-window is not silently lost.
  flush: () => void;
}

interface PendingBurst {
  roomName: string;
  participantIdentity: string;
  frames: MeetingTranscriptFrame[];
  timer: unknown;
}

function log(msg: string): void {
  console.error(`[burrow-channel-claude-code] ${msg}`);
}

/**
 * Validate a frame off the wire. Only `text` and `room_name` are load-bearing
 * — without them there is nothing to deliver and nowhere to reply — so those
 * two are the drop condition. Everything else is read defensively: a missing
 * or oddly-typed optional key degrades to an omitted tag attribute, never to
 * a thrown error and never to the literal string "undefined" in the tag.
 *
 * EXPORTED because `suite-client.ts` gates the outbound
 * `meeting_transcript_ack` on exactly this check. The ack is the ONLY inbound
 * evidence core has that this runtime can hear a meeting
 * (`RuntimePresence.prove/2` will not take core's own outbound broadcast as
 * proof), so a second hand-rolled check there could drift and start acking
 * frames this module drops — turning an honest "never proven" cell into a
 * false positive. One validator, one definition of "delivered".
 */
export function normaliseFrame(raw: unknown): MeetingTranscriptFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const frame = raw as Record<string, unknown>;
  const text = frame.text;
  const roomName = frame.room_name;
  // Whitespace-only text counts as missing: a blank <channel> tag is the
  // exact defect `attention.ts` spent a task eliminating.
  if (typeof text !== "string" || !text.trim()) return null;
  if (typeof roomName !== "string" || !roomName) return null;

  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  const speakerKind = frame.speaker_kind === "agent" ? "agent" : "human";

  return {
    room_name: roomName,
    meeting_id: typeof frame.meeting_id === "string" ? frame.meeting_id : null,
    segment_id: str(frame.segment_id),
    text,
    participant_identity: str(frame.participant_identity),
    speaker_name: typeof frame.speaker_name === "string" ? frame.speaker_name : null,
    speaker_kind: speakerKind,
    spoken_at: str(frame.spoken_at),
  };
}

/**
 * Build the notification for one burst (one or more frames from a single
 * speaker in a single room). Texts are joined in arrival order by one space.
 * For a coalesced burst `segment_id` is the FIRST segment's id, `spoken_at`
 * the first frame's, and `segment_ids` lists every id comma-joined so the
 * agent can still name each segment it heard.
 *
 * `meta` only ever holds keys that were present and non-empty, in the same
 * style as `emitAttention`: an absent value is an absent attribute, not
 * `""` or `"null"`.
 */
export function buildMeetingTranscriptNotification(
  frames: readonly MeetingTranscriptFrame[],
): AttentionNotification {
  const first = frames[0]!;
  const meta: Record<string, string> = {};

  meta.room_name = first.room_name;
  if (first.meeting_id) meta.meeting_id = first.meeting_id;
  if (first.segment_id) meta.segment_id = first.segment_id;
  if (frames.length > 1) {
    const ids = frames.map((f) => f.segment_id).filter(Boolean);
    if (ids.length > 0) meta.segment_ids = ids.join(",");
  }
  meta.speaker_kind = first.speaker_kind;
  if (first.participant_identity) meta.participant_identity = first.participant_identity;
  // `speaker_name` is null for identities core could not resolve to a display
  // name; the identity string is still a stable handle for the agent.
  const author = first.speaker_name || first.participant_identity;
  if (author) meta.author = author;
  meta.reason = "meeting_transcript";
  if (first.spoken_at) meta.spoken_at = first.spoken_at;

  const content = frames.map((f) => f.text.trim()).join(" ");

  return {
    method: "notifications/claude/channel",
    params: { content, meta },
  };
}

/**
 * Build a transcript emitter bound to the given notifier. Factored out of
 * `index.ts`, like `makeEmitAttention`, so the coalescing logic is testable
 * without booting the MCP server / Phoenix socket.
 *
 * Coalescing rule:
 *   - consecutive frames from the SAME `participant_identity` in the SAME
 *     `room_name`, each arriving within `coalesceWindowMs` of the previous
 *     one, become ONE message;
 *   - a frame from a different speaker or room flushes the pending burst
 *     FIRST, before it is queued, so delivery order matches arrival order;
 *   - the burst flushes `coalesceWindowMs` after its LAST frame;
 *   - `flush()` delivers a pending burst immediately (used on disconnect).
 */
export function makeMeetingTranscriptEmitter(
  opts: MeetingTranscriptEmitterOptions,
): MeetingTranscriptEmitter {
  const { notify, scheduler = REAL_SCHEDULER, coalesceWindowMs = COALESCE_WINDOW_MS } = opts;

  let pending: PendingBurst | null = null;

  function deliver(frames: MeetingTranscriptFrame[]): void {
    const notification = buildMeetingTranscriptNotification(frames);
    const fail = (err: unknown): void => {
      log(`meeting_transcript notify failed: ${err instanceof Error ? err.message : err}`);
    };
    // Invoked synchronously so two bursts flushed back to back reach the
    // session in the order they were flushed; the promise is only observed
    // for its rejection.
    try {
      const result = notify(notification);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(fail);
      }
    } catch (err) {
      fail(err);
    }
  }

  function flush(): void {
    if (!pending) return;
    const burst = pending;
    pending = null;
    scheduler.clearTimeout(burst.timer);
    deliver(burst.frames);
  }

  function arm(burst: PendingBurst): void {
    scheduler.clearTimeout(burst.timer);
    burst.timer = scheduler.setTimeout(() => {
      // Only the burst that armed this timer may be flushed by it. A burst
      // flushed by a speaker change and replaced within the same tick would
      // otherwise be delivered by the old burst's timer.
      if (pending === burst) flush();
    }, coalesceWindowMs);
  }

  function handle(raw: unknown): void {
    const frame = normaliseFrame(raw);
    if (!frame) {
      const room = raw && typeof raw === "object" ? (raw as Record<string, unknown>).room_name : undefined;
      log(
        `dropped malformed meeting_transcript frame (room_name=${typeof room === "string" ? room : "missing"}, text=${
          raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).text === "string" ? "present" : "missing"
        })`,
      );
      return;
    }

    if (
      pending &&
      (pending.roomName !== frame.room_name || pending.participantIdentity !== frame.participant_identity)
    ) {
      flush();
    }

    if (pending) {
      pending.frames.push(frame);
      arm(pending);
      return;
    }

    pending = {
      roomName: frame.room_name,
      participantIdentity: frame.participant_identity,
      frames: [frame],
      timer: null,
    };
    arm(pending);
  }

  return { handle, flush };
}
