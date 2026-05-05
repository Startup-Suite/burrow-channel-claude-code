// Federation handshake contract test (stage 4 of task 019df0ee).
//
// Verifies that the SuiteClient's runtime channel join passes
// `client_info: { product: "claude_channel", version: <truthy> }` so the Suite
// dispatch renderer can distinguish Claude-channel runtimes (single-agent
// per connection) from OpenClaw runtimes (multi-agent per connection).
//
// We don't open a real WebSocket — `phoenix` is replaced via `mock.module`
// with a tiny shim that captures every (topic, params) pair on channel().

import { describe, expect, mock, test } from "bun:test";

const captured: Array<{ topic: string; params: unknown }> = [];

class FakePush {
  receive(): this {
    return this;
  }
}

class FakeChannel {
  constructor(public topic: string, public params: unknown) {
    captured.push({ topic, params });
  }
  on(): void {}
  push(): FakePush {
    return new FakePush();
  }
  join(): FakePush {
    return new FakePush();
  }
  leave(): void {}
}

class FakeSocket {
  constructor() {}
  channel(topic: string, params: unknown): FakeChannel {
    return new FakeChannel(topic, params);
  }
  onOpen(): void {}
  onClose(): void {}
  onError(): void {}
  connect(): void {}
  disconnect(): void {}
}

mock.module("phoenix", () => ({
  Socket: FakeSocket,
  Channel: FakeChannel,
}));

const { SuiteClient } = await import("../src/suite-client.ts");

describe("SuiteClient federation handshake", () => {
  test("declares client_info.product = 'claude_channel' on runtime channel join", () => {
    captured.length = 0;

    const client = new SuiteClient(
      {
        url: "ws://localhost/socket",
        runtimeId: "test-runtime",
        token: "test-token",
        reconnectIntervalMs: 100,
        maxReconnectIntervalMs: 1000,
      },
      {
        onAttention: () => {},
        onDisconnect: () => {},
      },
    );

    client.connect();

    expect(captured.length).toBe(1);
    const { topic, params } = captured[0]!;
    expect(topic).toBe("runtime:test-runtime");

    const p = params as { client_info?: { product?: string; version?: string } };
    expect(p.client_info).toBeDefined();
    expect(p.client_info!.product).toBe("claude_channel");
    expect(typeof p.client_info!.version).toBe("string");
    expect((p.client_info!.version ?? "").length).toBeGreaterThan(0);

    client.disconnect();
  });
});
