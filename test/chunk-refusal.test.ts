// Chunk-refusal tests (task 01a0ac1d, stage 1).
//
// `suite_reply_chunk` with done:false against a space the agent cannot write
// to returned "chunk … appended" isError=false: the refusal was logged to
// stderr and recorded nowhere, so the tool layer had nothing to report.
//
// The push stays fire-and-forget by design. What changed is that the client
// records the last reply_chunk refusal per space, in a map separate from the
// typing one. The ok/positive-control cases matter: without them a client
// that recorded EVERY chunk as refused would still satisfy the failure case.
import { describe, expect, mock, test } from "bun:test";

const SPACE = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
const OTHER_SPACE = "0199aaaa-bbbb-cccc-dddd-eeeeffff0002";

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

describe("a refused reply_chunk push is recorded per space", () => {
  test("a refusal records the server's text for that space", () => {
    const { client, channel } = joinedClient();
    client.sendReplyChunk(SPACE, "chunk-1", "partial", false);
    channel.lastPush!.trigger("error", {
      error: `Access denied: agent is not a participant in space ${SPACE}`,
    });

    expect(client.lastChunkRefusal(SPACE)).toContain("Access denied");
    client.disconnect();
  });

  test("an acked chunk records no refusal (positive control)", () => {
    const { client, channel } = joinedClient();
    client.sendReplyChunk(SPACE, "chunk-1", "partial", false);
    channel.lastPush!.trigger("ok", {});

    expect(client.lastChunkRefusal(SPACE)).toBeUndefined();
    client.disconnect();
  });

  test("a refusal on one space does not taint another", () => {
    const { client, channel } = joinedClient();
    client.sendReplyChunk(SPACE, "chunk-1", "partial", false);
    channel.lastPush!.trigger("error", { error: "Access denied" });

    expect(client.lastChunkRefusal(SPACE)).toBeDefined();
    expect(client.lastChunkRefusal(OTHER_SPACE)).toBeUndefined();
    client.disconnect();
  });

  test("an ack after a refusal on the same space clears it", () => {
    const { client, channel } = joinedClient();
    client.sendReplyChunk(SPACE, "chunk-1", "partial", false);
    channel.lastPush!.trigger("error", { error: "Access denied" });
    expect(client.lastChunkRefusal(SPACE)).toBeDefined();

    client.sendReplyChunk(SPACE, "chunk-1", "partial more", false);
    channel.lastPush!.trigger("ok", {});
    expect(client.lastChunkRefusal(SPACE)).toBeUndefined();
    client.disconnect();
  });

  test("the push is a reply_chunk event carrying done:false and returns nothing", () => {
    const { client, channel } = joinedClient();
    const returned = client.sendReplyChunk(SPACE, "chunk-1", "partial", false);

    expect(returned).toBeUndefined();
    expect(channel.lastEvent).toBe("reply_chunk");
    expect(channel.lastPayload).toEqual({
      space_id: SPACE,
      chunk_id: "chunk-1",
      text: "partial",
      done: false,
    });
    client.disconnect();
  });
});
