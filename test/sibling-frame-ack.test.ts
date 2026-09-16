// Sibling-frame ack tests (task 01a09415, stage 4).
//
// Stage 3 fixed `sendReply`. The SAME silent-swallow shape lived on three
// sibling frames: `sendReplyWithMedia`, `sendReplyChunk` and `sendTyping`
// were all bare `this.channel?.push(...)` with no `.receive()` handler.
//
// The two groups are treated DIFFERENTLY on purpose, and these tests pin
// that difference so it reads as a decision rather than an oversight:
//
//   sendReplyWithMedia — persists a message. Awaits the ack and surfaces
//     the refusal, exactly like sendReply.
//   sendReplyChunk / sendTyping — ephemeral PubSub broadcasts with no
//     persisted row. A failed typing indicator is not worth failing or
//     delaying the reply it precedes, so they stay fire-and-forget: the
//     refusal is LOGGED (no longer silent) and nothing is awaited.

import { describe, expect, mock, test } from "bun:test";

const SPACE = "0199aaaa-bbbb-cccc-dddd-eeeeffff0002";

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
  lastTimeout: number | undefined;
  constructor(
    public topic: string,
    public params: unknown,
  ) {}
  on(): void {}
  push(event: string, payload: unknown, timeout?: number): FakePush {
    this.lastEvent = event;
    this.lastPayload = payload;
    this.lastTimeout = timeout;
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
  client.channelJoined = true;
  return { client, channel: client.socket.lastChannel as FakeChannel };
}

describe("sendReplyWithMedia awaits the server ack", () => {
  const attachments = [{ filename: "a.txt", contentType: "text/plain", data: "aGk=" }];

  test("a push answered with 'error' rejects, carrying the server's text and recoverable flag", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReplyWithMedia(SPACE, "hi", attachments);
    expect(channel.lastEvent).toBe("reply_with_media");
    channel.lastPush!.trigger("error", {
      error: `Access denied: agent is not a participant in space ${SPACE}`,
      recoverable: false,
    });

    await expect(promise).rejects.toThrow(SPACE);
    client.disconnect();
  });

  // Positive control: without it, a method that rejected EVERY send would
  // satisfy every failure assertion in this describe block.
  test("a push answered with 'ok' resolves with the server's message_id", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReplyWithMedia(SPACE, "hi", attachments);
    channel.lastPush!.trigger("ok", { message_id: "msg-media-1" });

    await expect(promise).resolves.toMatchObject({ message_id: "msg-media-1" });
    client.disconnect();
  });

  test("the payload keeps the wire's snake_case content_type", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReplyWithMedia(SPACE, "hi", attachments);
    expect(channel.lastPayload.attachments[0]).toMatchObject({
      filename: "a.txt",
      content_type: "text/plain",
    });
    channel.lastPush!.trigger("ok", {});
    await promise;
    client.disconnect();
  });

  test("a push is given an explicit timeout so a silent server cannot hang the caller", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReplyWithMedia(SPACE, "hi", attachments);
    expect(typeof channel.lastTimeout).toBe("number");
    channel.lastPush!.trigger("timeout");

    await expect(promise).rejects.toThrow(SPACE);
    client.disconnect();
  });

  test("a null channel rejects rather than resolving", async () => {
    const { client } = joinedClient();
    client.channel = null;
    await expect(client.sendReplyWithMedia(SPACE, "hi", attachments)).rejects.toThrow(
      /not connected to Suite/,
    );
  });
});

describe("the ephemeral frames stay fire-and-forget but are no longer silent", () => {
  test("sendTyping attaches an error handler and returns without awaiting", () => {
    const { client, channel } = joinedClient();
    const returned = client.sendTyping(SPACE, true);

    expect(returned).toBeUndefined();
    expect(channel.lastEvent).toBe("typing");
    // The whole point: an 'error' status has somewhere to land now.
    expect(Object.keys(channel.lastPush!.handlers)).toContain("error");
    // And triggering it neither throws nor produces an unhandled rejection.
    expect(() => channel.lastPush!.trigger("error", { error: "refused" })).not.toThrow();
    client.disconnect();
  });

  test("sendReplyChunk attaches an error handler and returns without awaiting", () => {
    const { client, channel } = joinedClient();
    const returned = client.sendReplyChunk(SPACE, "chunk-1", "partial", false);

    expect(returned).toBeUndefined();
    expect(channel.lastEvent).toBe("reply_chunk");
    expect(channel.lastPayload).toMatchObject({ chunk_id: "chunk-1", done: false });
    expect(Object.keys(channel.lastPush!.handlers)).toContain("error");
    expect(() => channel.lastPush!.trigger("error", { error: "refused" })).not.toThrow();
    client.disconnect();
  });

  // Control for the two above: the handler set is not trivially "everything",
  // so `toContain("error")` is a real assertion. These frames deliberately do
  // NOT install 'ok' or 'timeout' handlers — that is what fire-and-forget means.
  test("the ephemeral frames install ONLY an error handler, not ok/timeout", () => {
    const { client, channel } = joinedClient();
    client.sendTyping(SPACE, true);
    expect(Object.keys(channel.lastPush!.handlers).sort()).toEqual(["error"]);
    client.disconnect();
  });
});
