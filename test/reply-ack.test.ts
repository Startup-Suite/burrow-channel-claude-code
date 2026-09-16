// Reply-ack tests (task 01a09415, stage 3).
//
// Before this change `sendReply` was `this.channel?.push("reply", …)` with no
// `.receive()` handler, and the tool layer returned the literal string "sent"
// synchronously. An authorization refusal, a timeout, and a null channel were
// all indistinguishable from success. These tests pin the three outcomes.
//
// The 'ok' case is the positive control: without it, a bridge that failed
// EVERY send would still satisfy the two failure assertions.

import { describe, expect, mock, test } from "bun:test";
import { replyResult } from "../src/reply-result.ts";

const SPACE = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";

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
  lastPayload: unknown = null;
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

function makeClient() {
  return new SuiteClient(
    {
      url: "ws://localhost/socket",
      runtimeId: "test-runtime",
      token: "test-token",
      reconnectIntervalMs: 1_000_000,
      maxReconnectIntervalMs: 1_000_000,
    },
    { onAttention: () => {}, onDisconnect: () => {} },
  );
}

/** Connect and force the client into the joined state the tests need. */
function joinedClient(): { client: any; channel: FakeChannel } {
  const client: any = makeClient();
  client.connect();
  const channel = client.socket.lastChannel as FakeChannel;
  client.channelJoined = true;
  return { client, channel };
}

describe("sendReply awaits the server ack", () => {
  test("a push answered with 'error' rejects, and the rejection carries the server's text and recoverable flag", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReply(SPACE, "hello");
    channel.lastPush!.trigger("error", {
      error: `Access denied: agent is not a participant in space ${SPACE}`,
      recoverable: false,
    });

    await expect(promise).rejects.toThrow(SPACE);
    client.disconnect();
  });

  test("a push answered with 'ok' resolves with the server's message_id (positive control)", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReply(SPACE, "hello");
    expect(channel.lastEvent).toBe("reply");
    channel.lastPush!.trigger("ok", { message_id: "msg-123" });

    await expect(promise).resolves.toMatchObject({ message_id: "msg-123" });
    client.disconnect();
  });

  test("a push is given an explicit timeout so a silent server cannot hang the caller forever", async () => {
    const { client, channel } = joinedClient();
    const promise = client.sendReply(SPACE, "hello");
    expect(typeof channel.lastTimeout).toBe("number");
    channel.lastPush!.trigger("timeout");

    await expect(promise).rejects.toThrow(SPACE);
    client.disconnect();
  });

  test("a null channel rejects rather than resolving", async () => {
    const client: any = makeClient();
    expect(client.channel).toBeNull();
    await expect(client.sendReply(SPACE, "hello")).rejects.toThrow(/not connected to Suite/);
  });

  test("an existing-but-unjoined channel also rejects", async () => {
    const client: any = makeClient();
    client.connect();
    expect(client.channel).not.toBeNull();
    await expect(client.sendReply(SPACE, "hello")).rejects.toThrow(/not connected to Suite/);
    client.disconnect();
  });
});

describe("replyResult maps the ack onto an MCP tool result", () => {
  test("a rejection produces isError with the server's own error text, the space_id, and recoverable: false", async () => {
    const err = new Error(
      `Access denied: agent is not a participant in space ${SPACE}`,
    ) as Error & { recoverable?: boolean };
    err.recoverable = false;

    const result = await replyResult(
      () => Promise.reject(err),
      SPACE,
      "hello",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(SPACE);
    expect(result.content[0]!.text).toContain("recoverable: false");
    expect(result.content[0]!.text).not.toBe("sent");
  });

  test("a resolution returns the message_id receipt, not the bare string 'sent'", async () => {
    const result = await replyResult(
      () => Promise.resolve({ message_id: "msg-456" }),
      SPACE,
      "hello",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("msg-456");
  });

  test("the reply_chunk finalizer keeps its own prefix while still surfacing the receipt", async () => {
    const result = await replyResult(
      () => Promise.resolve({ message_id: "msg-789" }),
      SPACE,
      "hello",
      "chunk abc finalized and persisted",
    );

    expect(result.content[0]!.text).toContain("chunk abc finalized and persisted");
    expect(result.content[0]!.text).toContain("msg-789");
  });
});
