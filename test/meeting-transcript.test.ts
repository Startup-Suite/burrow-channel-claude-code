// Inbound `meeting_transcript` frames (task 01a06702-aa24).
//
// Core broadcasts one frame per FINAL transcript segment on the runtime
// channel. This file pins two things:
//
//   1. the pure emitter in `src/meeting-transcript.ts` — every tag on the
//      notification, and the 1.5 s same-speaker coalescing rule, driven by an
//      injected scheduler so no test sleeps real time;
//   2. the wiring — `SuiteClient` registers `channel.on("meeting_transcript")`
//      and routes it to `onMeetingTranscript`, and a socket close reaches
//      `onDisconnect` so a pending burst can be flushed.
//
// Every coalescing test has a sibling that proves it is not passing vacuously:
// "200 ms apart → one message" is only meaningful because "2 s apart → two
// messages" fails a build that coalesces everything, and "speaker change →
// two messages, in order" fails one that coalesces across speakers.
//
// The tests deliberately use the module's DEFAULT window rather than passing
// their own, so that setting `COALESCE_WINDOW_MS` to 0 makes the 200 ms test
// go red (the mutation check the task asks for).

import { describe, expect, mock, test } from "bun:test";

import type { AttentionNotification, NotifyFn } from "../src/attention.ts";
import {
  COALESCE_WINDOW_MS,
  makeMeetingTranscriptEmitter,
  type MeetingTranscriptFrame,
  type Scheduler,
} from "../src/meeting-transcript.ts";

// ── Injected clock ─────────────────────────────────────────────────────────

class FakeClock implements Scheduler {
  now = 0;
  private seq = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.now + ms, fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };

  // Advance the clock, firing every due timer in due order.
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.now = due.at;
      due.fn();
    }
    this.now = target;
  }

  pendingCount(): number {
    return this.timers.length;
  }
}

function capture(): { notify: NotifyFn; calls: AttentionNotification[] } {
  const calls: AttentionNotification[] = [];
  const notify: NotifyFn = async (n) => {
    calls.push(n);
  };
  return { notify, calls };
}

function meta(n: AttentionNotification): Record<string, string> {
  return n.params.meta as Record<string, string>;
}

// The example frame from `core:docs/contracts/meeting-transcript-frame.md`.
const RYAN: MeetingTranscriptFrame = {
  room_name: "space-01a066cb-60c7-7001-a8e9-5af52dcf4811",
  meeting_id: "01a066d1-7813-7001-a3b2-8199c44c2af6",
  segment_id: "01a06700-1234-7001-b000-0eac1b8cf949",
  text: "Can one of you pick up the deploy?",
  participant_identity: "user:019d1357-cb08-7023-b165-fd19e9462316",
  speaker_name: "Ryan",
  speaker_kind: "human",
  spoken_at: "2026-09-03T10:31:07.412Z",
};

function frame(overrides: Partial<MeetingTranscriptFrame>): MeetingTranscriptFrame {
  return { ...RYAN, ...overrides };
}

function setup() {
  const clock = new FakeClock();
  const { notify, calls } = capture();
  const emitter = makeMeetingTranscriptEmitter({ notify, scheduler: clock });
  return { clock, calls, emitter };
}

// ── The emitter ────────────────────────────────────────────────────────────

describe("meeting_transcript — one frame, one message", () => {
  test("a single frame produces exactly one notification carrying every tag", () => {
    const { clock, calls, emitter } = setup();

    emitter.handle(RYAN);
    expect(calls.length).toBe(0); // nothing until the window closes
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    const n = calls[0]!;
    expect(n.method).toBe("notifications/claude/channel");
    expect(n.params.content).toBe("Can one of you pick up the deploy?");
    expect(meta(n)).toEqual({
      room_name: RYAN.room_name,
      meeting_id: RYAN.meeting_id!,
      segment_id: RYAN.segment_id,
      speaker_kind: "human",
      participant_identity: RYAN.participant_identity,
      author: "Ryan",
      reason: "meeting_transcript",
      spoken_at: RYAN.spoken_at,
    });
    // A single frame is not a burst: no `segment_ids`.
    expect(meta(n).segment_ids).toBeUndefined();
    // And the clock is idle afterwards — no timer left to double-deliver.
    clock.advance(10 * COALESCE_WINDOW_MS);
    expect(calls.length).toBe(1);
  });

  test("the default window is 1.5 s and the burst waits for all of it", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(RYAN);
    clock.advance(1_499);
    expect(calls.length).toBe(0);
    clock.advance(1);
    expect(calls.length).toBe(1);
  });

  test('speaker_kind="agent" is delivered with speaker_kind="agent" in its tags', () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(
      frame({
        participant_identity: "agent:historian",
        speaker_name: "Historian",
        speaker_kind: "agent",
        text: "Noted; I will log the decision.",
      }),
    );
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    expect(meta(calls[0]!).speaker_kind).toBe("agent");
    expect(meta(calls[0]!).author).toBe("Historian");
    expect(meta(calls[0]!).participant_identity).toBe("agent:historian");
  });

  test("speaker_name: null falls back to participant_identity for author", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(
      frame({
        participant_identity: "guest:019d1357-cb08-7023-b165-fd19e9462316",
        speaker_name: null,
      }),
    );
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    expect(meta(calls[0]!).author).toBe("guest:019d1357-cb08-7023-b165-fd19e9462316");
    // The fallback did not overwrite the identity attribute itself.
    expect(meta(calls[0]!).participant_identity).toBe("guest:019d1357-cb08-7023-b165-fd19e9462316");
  });

  test("meeting_id: null is an absent attribute, never the string \"null\"", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ meeting_id: null }));
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    expect("meeting_id" in meta(calls[0]!)).toBe(false);
    expect(meta(calls[0]!).room_name).toBe(RYAN.room_name);
  });

  test("a frame with unknown extra keys is delivered and the extras are ignored", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle({ ...RYAN, confidence: 0.98, language: "en" });
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    expect(meta(calls[0]!).confidence).toBeUndefined();
    expect(meta(calls[0]!).language).toBeUndefined();
    expect(calls[0]!.params.content).toBe(RYAN.text);
  });
});

describe("meeting_transcript — malformed frames", () => {
  test("a frame with no text is dropped without throwing and without a notification", () => {
    const { clock, calls, emitter } = setup();
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const { text: _dropped, ...noText } = RYAN;
      expect(() => emitter.handle(noText)).not.toThrow();
      expect(() => emitter.handle({ ...RYAN, text: 42 })).not.toThrow();
      expect(() => emitter.handle({ ...RYAN, room_name: undefined })).not.toThrow();
      expect(() => emitter.handle(null)).not.toThrow();
      expect(() => emitter.handle("not a frame")).not.toThrow();
    } finally {
      console.error = original;
    }
    clock.advance(10 * COALESCE_WINDOW_MS);

    expect(calls.length).toBe(0);
    expect(clock.pendingCount()).toBe(0);
    expect(errors.length).toBe(5);
    expect(errors[0]).toMatch(/dropped malformed meeting_transcript frame/);
  });

  test("a malformed frame does not disturb a pending burst from a good one", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "s1", text: "one" }));
    clock.advance(200);
    const original = console.error;
    console.error = () => {};
    try {
      emitter.handle({ ...RYAN, text: "" }); // blank counts as missing
    } finally {
      console.error = original;
    }
    clock.advance(200);
    emitter.handle(frame({ segment_id: "s2", text: "two" }));
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    expect(calls[0]!.params.content).toBe("one two");
    expect(meta(calls[0]!).segment_ids).toBe("s1,s2");
  });
});

describe("meeting_transcript — coalescing", () => {
  test("two frames from the same speaker 200 ms apart become ONE message", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "seg-a", text: "Can one of you", spoken_at: "2026-09-03T10:31:07.412Z" }));
    clock.advance(200);
    emitter.handle(frame({ segment_id: "seg-b", text: "pick up the deploy?", spoken_at: "2026-09-03T10:31:07.612Z" }));
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(1);
    const n = calls[0]!;
    expect(n.params.content).toBe("Can one of you pick up the deploy?");
    expect(meta(n).segment_id).toBe("seg-a");
    expect(meta(n).segment_ids).toBe("seg-a,seg-b");
    expect(meta(n).spoken_at).toBe("2026-09-03T10:31:07.412Z");
    expect(meta(n).author).toBe("Ryan");
    expect(meta(n).reason).toBe("meeting_transcript");
  });

  test("the same two frames 2 s apart produce TWO messages", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "seg-a", text: "Can one of you" }));
    clock.advance(2_000);
    expect(calls.length).toBe(1); // the first already flushed on its own
    emitter.handle(frame({ segment_id: "seg-b", text: "pick up the deploy?" }));
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(2);
    expect(calls[0]!.params.content).toBe("Can one of you");
    expect(meta(calls[0]!).segment_id).toBe("seg-a");
    expect(meta(calls[0]!).segment_ids).toBeUndefined();
    expect(calls[1]!.params.content).toBe("pick up the deploy?");
    expect(meta(calls[1]!).segment_id).toBe("seg-b");
    expect(meta(calls[1]!).segment_ids).toBeUndefined();
  });

  test("the window restarts on every frame: three frames 1 s apart are one message", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "s1", text: "one" }));
    clock.advance(1_000);
    emitter.handle(frame({ segment_id: "s2", text: "two" }));
    clock.advance(1_000);
    emitter.handle(frame({ segment_id: "s3", text: "three" }));
    clock.advance(1_000);
    expect(calls.length).toBe(0); // 1 s after the last frame is inside the window
    clock.advance(500);

    expect(calls.length).toBe(1);
    expect(calls[0]!.params.content).toBe("one two three");
    expect(meta(calls[0]!).segment_ids).toBe("s1,s2,s3");
  });

  test("a frame from speaker B 200 ms after speaker A produces TWO messages, A first", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "a1", text: "Who is on the deploy?" }));
    clock.advance(200);
    emitter.handle(
      frame({
        segment_id: "b1",
        text: "I can take it.",
        participant_identity: "user:b",
        speaker_name: "Bea",
      }),
    );
    // A was flushed the moment B arrived, before B was queued.
    expect(calls.length).toBe(1);
    expect(meta(calls[0]!).author).toBe("Ryan");
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(2);
    expect(calls[0]!.params.content).toBe("Who is on the deploy?");
    expect(meta(calls[0]!).segment_id).toBe("a1");
    expect(calls[1]!.params.content).toBe("I can take it.");
    expect(meta(calls[1]!).author).toBe("Bea");
    expect(meta(calls[1]!).participant_identity).toBe("user:b");
    expect(meta(calls[1]!).segment_id).toBe("b1");
  });

  test("the same speaker in a different room is a different burst", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "r1", text: "in room one", room_name: "space-one" }));
    clock.advance(200);
    emitter.handle(frame({ segment_id: "r2", text: "in room two", room_name: "space-two" }));
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.length).toBe(2);
    expect(meta(calls[0]!).room_name).toBe("space-one");
    expect(calls[0]!.params.content).toBe("in room one");
    expect(meta(calls[1]!).room_name).toBe("space-two");
    expect(calls[1]!.params.content).toBe("in room two");
  });

  test("A, B, A: the second A frame starts a fresh burst rather than rejoining the first", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "a1", text: "first" }));
    clock.advance(100);
    emitter.handle(frame({ segment_id: "b1", text: "reply", participant_identity: "user:b", speaker_name: "Bea" }));
    clock.advance(100);
    emitter.handle(frame({ segment_id: "a2", text: "second" }));
    clock.advance(COALESCE_WINDOW_MS);

    expect(calls.map((c) => c.params.content)).toEqual(["first", "reply", "second"]);
    expect(calls.map((c) => meta(c).segment_id)).toEqual(["a1", "b1", "a2"]);
  });

  test("flush() delivers a pending burst immediately and the stale timer does not re-deliver it", () => {
    const { clock, calls, emitter } = setup();
    emitter.handle(frame({ segment_id: "s1", text: "one" }));
    clock.advance(200);
    emitter.handle(frame({ segment_id: "s2", text: "two" }));
    expect(calls.length).toBe(0);

    emitter.flush();
    expect(calls.length).toBe(1);
    expect(calls[0]!.params.content).toBe("one two");
    expect(meta(calls[0]!).segment_ids).toBe("s1,s2");

    clock.advance(10 * COALESCE_WINDOW_MS);
    expect(calls.length).toBe(1);
    expect(clock.pendingCount()).toBe(0);

    // flush with nothing pending is a no-op, not a blank message
    emitter.flush();
    expect(calls.length).toBe(1);
  });

  test("a rejecting notifier is logged, not thrown, and does not wedge later bursts", async () => {
    const clock = new FakeClock();
    const calls: AttentionNotification[] = [];
    let rejectNext = true;
    const notify: NotifyFn = async (n) => {
      calls.push(n);
      if (rejectNext) {
        rejectNext = false;
        throw new Error("transport closed");
      }
    };
    const emitter = makeMeetingTranscriptEmitter({ notify, scheduler: clock });
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      emitter.handle(frame({ segment_id: "s1", text: "one" }));
      expect(() => clock.advance(COALESCE_WINDOW_MS)).not.toThrow();
      // The rejection lands on a later microtask; let it.
      await Promise.resolve();
      emitter.handle(frame({ segment_id: "s2", text: "two" }));
      clock.advance(COALESCE_WINDOW_MS);
      await Promise.resolve();
    } finally {
      console.error = original;
    }
    expect(calls.length).toBe(2);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/meeting_transcript notify failed: transport closed/);
  });
});

// ── The wiring through SuiteClient ─────────────────────────────────────────
//
// Same fake-phoenix technique as `reconnect-resilience.test.ts`: swap the
// module, then import `SuiteClient` and read the handlers it registered.

class FakePush {
  handlers: Record<string, (reason?: unknown) => void> = {};
  receive(status: string, cb: (reason?: unknown) => void): this {
    this.handlers[status] = cb;
    return this;
  }
}

class FakeChannel {
  on_handlers: Record<string, (payload: unknown) => void> = {};
  // Every outbound push, in order. `push()` used to discard its arguments,
  // which made any "did we ack?" assertion vacuous: a push happens on this
  // channel either way (`pong`, `reply`, …), so only the event NAME and
  // PAYLOAD can distinguish an ack for a delivered segment from an ack fired
  // at some other moment.
  pushed: Array<{ event: string; payload: unknown }> = [];
  constructor(
    public topic: string,
    public params: unknown,
  ) {}
  on(event: string, cb: (payload: unknown) => void): void {
    this.on_handlers[event] = cb;
  }
  push(event: string, payload?: unknown): FakePush {
    this.pushed.push({ event, payload });
    return new FakePush();
  }
  // The join push is retained rather than discarded so a test can invoke the
  // callbacks `SuiteClient` registered on it — the "ack-at-connect" mutant
  // pushes from inside `.receive("ok", …)`, and a fresh FakePush per call
  // would hide it.
  lastJoin: FakePush | null = null;
  join(): FakePush {
    this.lastJoin = new FakePush();
    return this.lastJoin;
  }
  leave(): void {}
}

const sockets: FakeSocket[] = [];

class FakeSocket {
  onCloseCbs: Array<(event?: unknown) => void> = [];
  connected = false;
  lastChannel: FakeChannel | null = null;
  constructor(
    public url: string,
    public opts: unknown,
  ) {
    sockets.push(this);
  }
  channel(topic: string, params: unknown): FakeChannel {
    this.lastChannel = new FakeChannel(topic, params);
    return this.lastChannel;
  }
  onOpen(): void {}
  onClose(cb: (event?: unknown) => void): void {
    this.onCloseCbs.push(cb);
  }
  onError(): void {}
  onMessage(): void {}
  isConnected(): boolean {
    return this.connected;
  }
  connect(): void {
    this.connected = true;
  }
  disconnect(): void {
    this.connected = false;
  }
}

mock.module("phoenix", () => ({
  Socket: FakeSocket,
  Channel: FakeChannel,
}));

const { SuiteClient, CLIENT_INFO } = await import("../src/suite-client.ts");

describe("meeting_transcript — SuiteClient wiring", () => {
  test("a frame on channel.on(\"meeting_transcript\") reaches the session as one notification", () => {
    sockets.length = 0;
    const { clock, calls, emitter } = setup();
    const client = new SuiteClient(
      { url: "ws://localhost/socket", runtimeId: "test-runtime", token: "t", reconnectIntervalMs: 1_000_000 },
      {
        onAttention: () => {},
        onDisconnect: () => emitter.flush(),
        onMeetingTranscript: (f) => emitter.handle(f),
      },
    );
    try {
      client.connect();
      const channel = sockets[0]!.lastChannel!;
      expect(channel.topic).toBe("runtime:test-runtime");
      const onTranscript = channel.on_handlers["meeting_transcript"];
      expect(typeof onTranscript).toBe("function");

      onTranscript!(RYAN);
      expect(calls.length).toBe(0);
      clock.advance(COALESCE_WINDOW_MS);

      expect(calls.length).toBe(1);
      expect(calls[0]!.method).toBe("notifications/claude/channel");
      expect(calls[0]!.params.content).toBe(RYAN.text);
      expect(meta(calls[0]!).reason).toBe("meeting_transcript");
      expect(meta(calls[0]!).room_name).toBe(RYAN.room_name);
      expect(meta(calls[0]!).segment_id).toBe(RYAN.segment_id);
    } finally {
      client.disconnect();
    }
  });

  test("a pending burst is flushed on disconnect, before the window closes", () => {
    sockets.length = 0;
    const { clock, calls, emitter } = setup();
    const client = new SuiteClient(
      { url: "ws://localhost/socket", runtimeId: "test-runtime", token: "t", reconnectIntervalMs: 1_000_000 },
      {
        onAttention: () => {},
        onDisconnect: () => emitter.flush(),
        onMeetingTranscript: (f) => emitter.handle(f),
      },
    );
    try {
      client.connect();
      const socket = sockets[0]!;
      const onTranscript = socket.lastChannel!.on_handlers["meeting_transcript"]!;

      onTranscript(frame({ segment_id: "s1", text: "before the" }));
      clock.advance(200);
      onTranscript(frame({ segment_id: "s2", text: "socket dies" }));
      expect(calls.length).toBe(0);

      // The socket closes while the burst is still inside its window.
      for (const cb of socket.onCloseCbs) cb({ code: 1006, reason: "" });

      expect(calls.length).toBe(1);
      expect(calls[0]!.params.content).toBe("before the socket dies");
      expect(meta(calls[0]!).segment_ids).toBe("s1,s2");

      // And the timer that was armed does not re-deliver it afterwards.
      clock.advance(10 * COALESCE_WINDOW_MS);
      expect(calls.length).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  test("a malformed frame on the socket is dropped without throwing out of the channel handler", () => {
    sockets.length = 0;
    const { clock, calls, emitter } = setup();
    const client = new SuiteClient(
      { url: "ws://localhost/socket", runtimeId: "test-runtime", token: "t", reconnectIntervalMs: 1_000_000 },
      {
        onAttention: () => {},
        onDisconnect: () => emitter.flush(),
        onMeetingTranscript: (f) => emitter.handle(f),
      },
    );
    const original = console.error;
    console.error = () => {};
    try {
      client.connect();
      const onTranscript = sockets[0]!.lastChannel!.on_handlers["meeting_transcript"]!;
      expect(() => onTranscript({ room_name: RYAN.room_name })).not.toThrow();
      clock.advance(COALESCE_WINDOW_MS);
      expect(calls.length).toBe(0);
    } finally {
      console.error = original;
      client.disconnect();
    }
  });
});

// ── The outbound ack ───────────────────────────────────────────────────────
//
// `meeting_transcript_ack` exists so core's `RuntimePresence.prove/2` has an
// INBOUND frame proving this runtime heard a segment; core will not take its
// own outbound broadcast as proof. That makes the ack's precision the whole
// point: it must fire once per DELIVERED segment and never otherwise, because
// an ack with no segment behind it converts an honest "never proven" cell into
// a false positive — strictly worse than no ack at all.
//
// The named mutation these tests exist to kill is "ack-at-connect": move the
// `channel.push("meeting_transcript_ack", …)` out of the frame handler and
// into `.join().receive("ok", …)` (or anywhere in `connect()`), so the plugin
// acks once per session instead of once per segment. `zero frames delivered →
// zero acks` goes red against that mutant, and it can only do so because
// `FakeChannel.push` now records the event name — a push happens either way.

function acks(channel: FakeChannel): Array<Record<string, unknown>> {
  return channel.pushed
    .filter((p) => p.event === "meeting_transcript_ack")
    .map((p) => p.payload as Record<string, unknown>);
}

function connectClient(emitter: { handle: (f: unknown) => void; flush: () => void }) {
  sockets.length = 0;
  const client = new SuiteClient(
    { url: "ws://localhost/socket", runtimeId: "test-runtime", token: "t", reconnectIntervalMs: 1_000_000 },
    {
      onAttention: () => {},
      onDisconnect: () => emitter.flush(),
      onMeetingTranscript: (f) => emitter.handle(f),
    },
  );
  client.connect();
  const socket = sockets[0]!;
  const channel = socket.lastChannel!;
  return { client, socket, channel };
}

describe("meeting_transcript_ack — the inbound proof frame", () => {
  test("MUTATION 'ack-at-connect': zero delivered frames means zero acks", () => {
    const { emitter } = setup();
    const { client, channel } = connectClient(emitter);
    try {
      // Connected and joined. No `meeting_transcript` frame has been
      // delivered, so nothing has been heard and nothing may be claimed.
      const ok = channel.lastJoin?.handlers["ok"];
      expect(typeof ok).toBe("function");
      ok!();

      expect(acks(channel).length).toBe(0);
    } finally {
      client.disconnect();
    }
  });

  test("one delivered frame acks once, synchronously, with segment_id, room_name and the client_info build", () => {
    const { clock, calls, emitter } = setup();
    const { client, channel } = connectClient(emitter);
    try {
      const onTranscript = channel.on_handlers["meeting_transcript"]!;
      onTranscript(RYAN);

      // Synchronous: the ack is a receipt for the raw frame, not for the
      // coalesced notification, so it is already out while the burst is still
      // inside its 1.5 s window and the session has seen nothing.
      expect(calls.length).toBe(0);
      expect(acks(channel)).toEqual([
        {
          segment_id: RYAN.segment_id,
          room_name: RYAN.room_name,
          build: CLIENT_INFO.version,
        },
      ]);

      // Closing the window delivers the segment and does NOT ack a second time.
      clock.advance(COALESCE_WINDOW_MS);
      expect(calls.length).toBe(1);
      expect(acks(channel).length).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  test("the build is the same string client_info carries at join", () => {
    const { emitter } = setup();
    const { client, channel } = connectClient(emitter);
    try {
      channel.on_handlers["meeting_transcript"]!(RYAN);
      const joinInfo = (channel.params as { client_info: { version: string } }).client_info;
      expect(acks(channel)[0]!.build).toBe(joinInfo.version);
    } finally {
      client.disconnect();
    }
  });

  test("one ack per segment: three frames in one coalesced burst ack three times", () => {
    const { clock, calls, emitter } = setup();
    const { client, channel } = connectClient(emitter);
    try {
      const onTranscript = channel.on_handlers["meeting_transcript"]!;
      onTranscript(frame({ segment_id: "s1", text: "one" }));
      clock.advance(200);
      onTranscript(frame({ segment_id: "s2", text: "two" }));
      clock.advance(200);
      onTranscript(frame({ segment_id: "s3", text: "three" }));

      // The three segments coalesce into ONE notification, but each was heard
      // separately and each is acked separately — the ack is decoupled from
      // the coalescing pipeline.
      expect(acks(channel).map((a) => a.segment_id)).toEqual(["s1", "s2", "s3"]);
      clock.advance(COALESCE_WINDOW_MS);
      expect(calls.length).toBe(1);
      expect(acks(channel).length).toBe(3);
    } finally {
      client.disconnect();
    }
  });

  test("a frame the validator rejects produces NO ack", () => {
    const { clock, calls, emitter } = setup();
    const { client, channel } = connectClient(emitter);
    const original = console.error;
    console.error = () => {};
    try {
      const onTranscript = channel.on_handlers["meeting_transcript"]!;
      // The exact rejections `normaliseFrame` makes — the ack must be gated on
      // the SAME check the delivery path uses, or it widens what counts as
      // "delivered".
      const bad = (raw: unknown) => onTranscript(raw as Record<string, unknown>);
      bad({ room_name: RYAN.room_name }); // no text
      bad({ ...RYAN, text: "   " }); // whitespace-only text
      bad({ ...RYAN, room_name: "" }); // no room to reply into
      bad({ ...RYAN, text: 42 }); // wrong type
      bad(null);
      bad("not an object");

      expect(acks(channel).length).toBe(0);
      clock.advance(COALESCE_WINDOW_MS);
      expect(calls.length).toBe(0);
    } finally {
      console.error = original;
      client.disconnect();
    }
  });
});
