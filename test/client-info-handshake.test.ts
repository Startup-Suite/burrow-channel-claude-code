// Federation handshake contract test (stage 4 of task 019df0ee, extended by
// stage 4 of task 019fa56b).
//
// Verifies that the SuiteClient's runtime channel join passes
// `client_info: { product: "claude_channel", version: <truthy>,
// features: ["system_event_prompt"] }` so the Suite dispatch renderer can
// distinguish Claude-channel runtimes (single-agent per connection) from
// OpenClaw runtimes (multi-agent per connection), AND so the server can tell
// a build that reads `signal.prompt` from one that does not.
//
// WHY THE FEATURE LIST AND NOT THE VERSION: `package.json`'s version is not a
// function of the code that changed. The fix commit `7288017` did not bump it,
// so every runtime in the field reported `0.2.0` whether it was fixed or
// broken. A declared capability is emitted by the same build that contains the
// behavior — `CLIENT_INFO` lives in `src/suite-client.ts`, the same module
// that types `AttentionPayload.signal.prompt` — so the claim cannot outlive
// the code. Core reads it via `AgentRuntime.client_supports?/2`, which matches
// EXACTLY: `system_event_prompt_v2`, `SYSTEM_EVENT_PROMPT` and a space-padded
// variant are all rejected. Hence the byte-for-byte assertion below.
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

const { SuiteClient, CLIENT_INFO } = await import("../src/suite-client.ts");

type JoinClientInfo = { product?: string; version?: string; features?: unknown };

function joinClientInfo(): JoinClientInfo {
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

  client.disconnect();

  const p = params as { client_info?: JoinClientInfo };
  expect(p.client_info).toBeDefined();
  return p.client_info!;
}

describe("SuiteClient federation handshake", () => {
  test("declares client_info.product = 'claude_channel' on runtime channel join", () => {
    const ci = joinClientInfo();

    expect(ci.product).toBe("claude_channel");
    expect(typeof ci.version).toBe("string");
    expect((ci.version ?? "").length).toBeGreaterThan(0);
  });

  // The new key must be ADDITIVE. A test that only checked `features` would
  // pass just as happily on a handshake that dropped `product` or `version`
  // altogether — and `product` is what `ProviderGuidance` switches dispatch
  // guidance on, so losing it is a live regression, not a cosmetic one.
  test("declares features = ['system_event_prompt'] WITHOUT displacing product or version", () => {
    const ci = joinClientInfo();

    expect(Array.isArray(ci.features)).toBe(true);
    expect(ci.features as string[]).toContain("system_event_prompt");

    // Byte-for-byte. `AgentRuntime.client_supports?/2` is an exact `in` check
    // (stage 3 proved a fuzzy variant would accept `SYSTEM_EVENT_PROMPT`,
    // `" system_event_prompt "` and `system_event_prompt_v2`), so a typo or a
    // stray space here silently ships an unrecognised claim.
    expect((ci.features as string[]).filter((f) => f === "system_event_prompt").length).toBe(1);

    // Still the full pre-existing handshake, unchanged.
    expect(ci.product).toBe("claude_channel");
    expect(ci.version).toBe("0.3.0");
  });

  // The exact literal, isolated from the join plumbing, so a drift in the
  // constant is attributable without reading a socket trace. This is the
  // string core matches on; core's own copy is
  // `AgentRuntime.system_event_prompt_feature/0`.
  test("CLIENT_INFO.features is exactly ['system_event_prompt']", () => {
    expect(CLIENT_INFO.features).toEqual(["system_event_prompt"]);
  });
});
