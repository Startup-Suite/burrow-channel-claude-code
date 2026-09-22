// Non-final chunk result tests (task 01a0ac1d, stage 2).
//
// `suite_reply_chunk` with done:false returned "chunk … appended" with no
// isError, unconditionally — even for a space Suite had already refused. The
// result is now built by `partialChunkResult` (src/chunk-result.ts), which
// index.ts calls with `suite.lastChunkRefusal(space_id)`. These tests import
// that production function; they do NOT re-implement the branch locally.
import { describe, expect, mock, test } from "bun:test";

const GHOST = "0199aaaa-bbbb-cccc-dddd-eeeeffff0001";
const GOOD = "0199aaaa-bbbb-cccc-dddd-eeeeffff0002";
const CHUNK = "chunk-abc";
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
const { partialChunkResult } = await import("../src/chunk-result.ts");

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

describe("partialChunkResult", () => {
  test("a known refusal makes a non-final chunk isError naming the space", () => {
    const result = partialChunkResult(
      CHUNK,
      GHOST,
      `Access denied: agent is not a participant in space ${GHOST}`,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain(GHOST);
    expect(text).toContain("Access denied");
    expect(text).toContain(CHUNK);
    expect(text).not.toContain("appended");
  });

  test("GOOD space non-final chunk is not an error (positive control)", () => {
    const result = partialChunkResult(CHUNK, GOOD, undefined);
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toBe(`chunk ${CHUNK} queued`);
  });

  test("the non-final text is not longer than the old appended text", () => {
    const text = partialChunkResult(CHUNK, GOOD, undefined).content[0]!.text;
    expect(text.length).toBeLessThanOrEqual(`chunk ${CHUNK} appended`.length);
  });
});

describe("partialChunkResult fed by SuiteClient.lastChunkRefusal", () => {
  test("a refused GHOST chunk surfaces as isError while an acked GOOD chunk on the same client does not", () => {
    const { client, channel } = joinedClient();

    client.sendReplyChunk(GHOST, CHUNK, "partial", false);
    channel.lastPush!.trigger("error", {
      error: `Access denied: agent is not a participant in space ${GHOST}`,
    });
    const ghost = partialChunkResult(CHUNK, GHOST, client.lastChunkRefusal(GHOST));
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]!.text).toContain(GHOST);
    expect(ghost.content[0]!.text).toContain("Access denied");

    client.sendReplyChunk(GOOD, CHUNK, "partial", false);
    channel.lastPush!.trigger("ok", {});
    const good = partialChunkResult(CHUNK, GOOD, client.lastChunkRefusal(GOOD));
    expect(good.isError).toBeFalsy();
    expect(good.content[0]!.text).toBe(`chunk ${CHUNK} queued`);

    client.disconnect();
  });
});
