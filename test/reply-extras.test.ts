// Reply-annotation forwarding tests (task 01a0d8de, stage 4).
//
// `suite_reply`, `suite_reply_with_media` and the FINAL `suite_reply_chunk`
// forward two optional fields to core: `in_reply_to_message_id` and
// `context`. The non-final chunk and the `reply_chunk` push never carry them.
//
// Two layers are pinned: the tool dispatcher (which Suite call receives the
// extras) and the SuiteClient (what lands in the wire payload). The
// no-extras cases are the positive controls for omission: a client that
// always wrote `context: undefined` into the payload would fail them.

import { describe, expect, mock, test } from "bun:test";

const SPACE = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
const MSG = "0199aaaa-bbbb-cccc-dddd-eeeeffff0abc";
const CONTEXT = "Answers the stage 4 test_pass question for task 01a0d8de";

// ── Fake phoenix, for the wire-payload layer ───────────────────────────────

class FakePush {
  handlers: Record<string, (payload?: unknown) => void> = {};
  receive(status: string, cb: (payload?: unknown) => void): this {
    this.handlers[status] = cb;
    return this;
  }
  trigger(status: string, payload?: unknown): void {
    this.handlers[status]?.(payload);
  }
}

class FakeChannel {
  lastPush: FakePush | null = null;
  lastEvent: string | null = null;
  lastPayload: any = null;
  constructor(
    public topic: string,
    public params: unknown,
  ) {}
  on(): void {}
  push(event: string, payload: unknown): FakePush {
    this.lastEvent = event;
    this.lastPayload = payload;
    this.lastPush = new FakePush();
    return this.lastPush;
  }
  join(): FakePush {
    return new FakePush();
  }
  leave(): void {}
}

class FakeSocket {
  lastChannel: FakeChannel | null = null;
  connected = false;
  constructor(
    public url: string,
    public opts: unknown,
  ) {}
  channel(topic: string, params: unknown): FakeChannel {
    this.lastChannel = new FakeChannel(topic, params);
    return this.lastChannel;
  }
  onOpen(): void {}
  onClose(): void {}
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

mock.module("phoenix", () => ({ Socket: FakeSocket, Channel: FakeChannel }));

const { SuiteClient } = await import("../src/suite-client.ts");
const { callTool, TOOL_DEFINITIONS } = await import("../src/tools.ts");

function joinedClient(): { client: any; channel: FakeChannel } {
  const client: any = new SuiteClient(
    {
      url: "ws://localhost/socket",
      runtimeId: "test-runtime",
      token: "test-token",
      reconnectIntervalMs: 1_000_000,
      maxReconnectIntervalMs: 1_000_000,
    },
    { onAttention: () => {}, onDisconnect: () => {} },
  );
  client.connect();
  const channel = client.socket.lastChannel as FakeChannel;
  client.channelJoined = true;
  return { client, channel };
}

// ── Recording fake suite, for the dispatcher layer ─────────────────────────

function recordingSuite(ack: Record<string, unknown> = { message_id: "msg-1" }) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const suite = {
    sendReply: (...args: unknown[]) => {
      calls.push({ fn: "sendReply", args });
      return Promise.resolve(ack);
    },
    sendReplyWithMedia: (...args: unknown[]) => {
      calls.push({ fn: "sendReplyWithMedia", args });
      return Promise.resolve(ack);
    },
    sendTyping: (...args: unknown[]) => {
      calls.push({ fn: "sendTyping", args });
    },
    lastTypingRefusal: () => undefined,
    sendReplyChunk: (...args: unknown[]) => {
      calls.push({ fn: "sendReplyChunk", args });
    },
    lastChunkRefusal: () => undefined,
  };
  return { suite, calls };
}

const EXTRAS = { in_reply_to_message_id: MSG, context: CONTEXT };

describe("the tool dispatcher forwards reply annotations", () => {
  test("suite_reply passes both fields to sendReply", async () => {
    const { suite, calls } = recordingSuite();
    await callTool(suite, "suite_reply", { space_id: SPACE, content: "hi", ...EXTRAS });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("sendReply");
    expect(calls[0]!.args).toEqual([SPACE, "hi", EXTRAS]);
  });

  test("suite_reply_with_media passes both fields to sendReplyWithMedia", async () => {
    const { suite, calls } = recordingSuite();
    await callTool(suite, "suite_reply_with_media", {
      space_id: SPACE,
      content: "see attached",
      attachments: [{ filename: "a.png", content_type: "image/png", data: "AAAA" }],
      ...EXTRAS,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fn).toBe("sendReplyWithMedia");
    expect(calls[0]!.args[3]).toEqual(EXTRAS);
  });

  test("the final chunk forwards both fields into its persisting sendReply, and the chunk push carries none", async () => {
    const { suite, calls } = recordingSuite();
    await callTool(suite, "suite_reply_chunk", {
      space_id: SPACE,
      chunk_id: "c1",
      text: "all of it",
      done: true,
      ...EXTRAS,
    });
    expect(calls.map((c) => c.fn)).toEqual(["sendReplyChunk", "sendReply"]);
    expect(calls[0]!.args).toEqual([SPACE, "c1", "all of it", true]);
    expect(calls[1]!.args).toEqual([SPACE, "all of it", EXTRAS]);
  });

  test("a non-final chunk sends no persisting reply, so the annotations go nowhere", async () => {
    const { suite, calls } = recordingSuite();
    await callTool(suite, "suite_reply_chunk", {
      space_id: SPACE,
      chunk_id: "c1",
      text: "partial",
      done: false,
      ...EXTRAS,
    });
    expect(calls.map((c) => c.fn)).toEqual(["sendReplyChunk"]);
    expect(calls[0]!.args).toEqual([SPACE, "c1", "partial", false]);
  });

  test("omitted fields reach the client as undefined, not as empty strings", async () => {
    const { suite, calls } = recordingSuite();
    await callTool(suite, "suite_reply", { space_id: SPACE, content: "hi" });
    expect(calls[0]!.args[2]).toEqual({ in_reply_to_message_id: undefined, context: undefined });
  });

  test("a dropped annotation is surfaced in the result, which stays a success", async () => {
    const { suite } = recordingSuite({
      message_id: "msg-9",
      dropped: [{ field: "in_reply_to_message_id", reason: "not_found" }],
    });
    const result = await callTool(suite, "suite_reply", {
      space_id: SPACE,
      content: "hi",
      ...EXTRAS,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("msg-9");
    expect(result.content[0]!.text).toContain("in_reply_to_message_id (not_found)");
  });

  test("an ack without dropped reads as a plain receipt (positive control)", async () => {
    const { suite } = recordingSuite({ message_id: "msg-9" });
    const result = await callTool(suite, "suite_reply", { space_id: SPACE, content: "hi" });
    expect(result.content[0]!.text).toBe("message_id msg-9");
  });

  test("the three reply tools advertise both optional fields and require neither", () => {
    for (const name of ["suite_reply", "suite_reply_with_media", "suite_reply_chunk"]) {
      const def = TOOL_DEFINITIONS.find((d) => d.name === name)!;
      const props = def.inputSchema.properties as Record<string, unknown>;
      expect(props).toHaveProperty("in_reply_to_message_id");
      expect(props).toHaveProperty("context");
      expect(def.inputSchema.required).not.toContain("in_reply_to_message_id");
      expect(def.inputSchema.required).not.toContain("context");
    }
    const typing = TOOL_DEFINITIONS.find((d) => d.name === "suite_typing")!;
    expect(typing.inputSchema.properties).not.toHaveProperty("context");
  });
});

describe("SuiteClient writes the annotations into the wire payload", () => {
  test("sendReply includes both fields in the reply push", () => {
    const { client, channel } = joinedClient();
    void client.sendReply(SPACE, "hi", EXTRAS);
    expect(channel.lastEvent).toBe("reply");
    expect(channel.lastPayload).toEqual({ space_id: SPACE, content: "hi", ...EXTRAS });
    client.disconnect();
  });

  test("sendReply without extras pushes only space_id and content", () => {
    const { client, channel } = joinedClient();
    void client.sendReply(SPACE, "hi", { in_reply_to_message_id: undefined, context: undefined });
    expect(Object.keys(channel.lastPayload).sort()).toEqual(["content", "space_id"]);
    client.disconnect();
  });

  test("sendReplyWithMedia includes both fields in the reply_with_media push", () => {
    const { client, channel } = joinedClient();
    void client.sendReplyWithMedia(
      SPACE,
      "see attached",
      [{ filename: "a.png", contentType: "image/png", data: "AAAA" }],
      EXTRAS,
    );
    expect(channel.lastEvent).toBe("reply_with_media");
    expect(channel.lastPayload.in_reply_to_message_id).toBe(MSG);
    expect(channel.lastPayload.context).toBe(CONTEXT);
    expect(channel.lastPayload.attachments[0].content_type).toBe("image/png");
    client.disconnect();
  });

  test("sendReplyWithMedia without extras carries neither key", () => {
    const { client, channel } = joinedClient();
    void client.sendReplyWithMedia(SPACE, "x", [
      { filename: "a.png", contentType: "image/png", data: "AAAA" },
    ]);
    expect(channel.lastPayload).not.toHaveProperty("in_reply_to_message_id");
    expect(channel.lastPayload).not.toHaveProperty("context");
    client.disconnect();
  });
});
