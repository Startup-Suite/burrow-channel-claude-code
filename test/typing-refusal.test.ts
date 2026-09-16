// Typing-refusal tests (task 01a09415, stage 4).
//
// `suite_typing` against a space the agent does not participate in returned
// `isError=false` with the text "typing on": the refusal was logged to stderr
// and nothing about it reached the MCP caller, so the result was
// indistinguishable from the delivered case.
//
// The push stays fire-and-forget by design. What changed is the CLAIM: the
// client records the last refusal per space, and the tool layer reports it.
//
// The ok/positive-control cases matter: without them a bridge that refused
// EVERY typing push, or one that never reported success at all, would still
// satisfy the failure assertions.

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

/** The tool-layer shape, mirroring src/index.ts case "suite_typing". */
function typingResult(
  client: any,
  spaceId: string,
  typing: boolean,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  client.sendTyping(spaceId, typing);
  const refusal = client.lastTypingRefusal(spaceId);
  if (refusal) {
    return {
      isError: true,
      content: [
        { type: "text", text: `typing indicator not delivered to space ${spaceId}: ${refusal}` },
      ],
    };
  }
  return {
    content: [
      { type: "text", text: `typing indicator ${typing ? "on" : "off"} sent (not acknowledged)` },
    ],
  };
}

describe("a refused typing push is not reported as success", () => {
  test("the client records the server's refusal text for that space", () => {
    const { client, channel } = joinedClient();
    client.sendTyping(SPACE, true);
    expect(channel.lastEvent).toBe("typing");
    channel.lastPush!.trigger("error", {
      error: `Access denied: agent is not a participant in space ${SPACE}`,
    });

    expect(client.lastTypingRefusal(SPACE)).toContain("Access denied");
    client.disconnect();
  });

  test("the tool result for a refused space is isError with the server's text, never 'typing on'", () => {
    const { client, channel } = joinedClient();
    client.sendTyping(SPACE, true);
    channel.lastPush!.trigger("error", {
      error: `Access denied: agent is not a participant in space ${SPACE}`,
    });

    const result = typingResult(client, SPACE, true);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Access denied");
    expect(result.content[0]!.text).toContain(SPACE);
    expect(result.content[0]!.text).not.toBe("typing on");
    client.disconnect();
  });

  test("a refusal is scoped to its space and does not taint another (positive control)", () => {
    const { client, channel } = joinedClient();
    client.sendTyping(SPACE, true);
    channel.lastPush!.trigger("error", { error: "Access denied" });

    const ok = typingResult(client, OTHER_SPACE, true);
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]!.text).toContain("not acknowledged");
    client.disconnect();
  });

  test("an acked push clears a prior refusal so a recovered space stops erroring (positive control)", () => {
    const { client, channel } = joinedClient();
    client.sendTyping(SPACE, true);
    channel.lastPush!.trigger("error", { error: "Access denied" });
    expect(client.lastTypingRefusal(SPACE)).toBeDefined();

    client.sendTyping(SPACE, true);
    channel.lastPush!.trigger("ok", {});
    expect(client.lastTypingRefusal(SPACE)).toBeUndefined();

    const result = typingResult(client, SPACE, false);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("not acknowledged");
    client.disconnect();
  });

  test("with no refusal known the result does not claim delivery (positive control)", () => {
    const { client } = joinedClient();
    const result = typingResult(client, SPACE, true);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("typing indicator on sent (not acknowledged)");
    client.disconnect();
  });
});
