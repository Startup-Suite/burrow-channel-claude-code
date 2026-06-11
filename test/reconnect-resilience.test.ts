// Reconnect-resilience tests (channel hardening, 2026-06-11).
//
// Background: on 2026-06-10 the live channel went deaf for ~2 days — the
// websocket to Suite died but the plugin process stayed up, outbound MCP
// tools kept working, and inbound attention events silently stopped. The
// gaps: a rejected/timed-out channel join was logged once and never retried,
// and socket errors without a matching close event never re-entered the
// reconnect loop.
//
// These tests drive SuiteClient through each failure path with a fake
// phoenix module and assert that every one of them produces a fresh
// connection attempt (a new FakeSocket) instead of going quiet.

import { describe, expect, mock, test } from "bun:test";

const sockets: FakeSocket[] = [];

class FakePush {
  handlers: Record<string, (reason?: unknown) => void> = {};
  receive(status: string, cb: (reason?: unknown) => void): this {
    this.handlers[status] = cb;
    return this;
  }
  trigger(status: string, reason?: unknown): void {
    this.handlers[status]?.(reason);
  }
}

class FakeChannel {
  joinPush = new FakePush();
  constructor(
    public topic: string,
    public params: unknown,
  ) {}
  on(): void {}
  push(): FakePush {
    return new FakePush();
  }
  join(): FakePush {
    return this.joinPush;
  }
  leave(): void {}
}

class FakeSocket {
  static connectThrows = false;
  onOpenCbs: Array<() => void> = [];
  onCloseCbs: Array<(event?: unknown) => void> = [];
  onErrorCbs: Array<(err?: unknown) => void> = [];
  onMessageCbs: Array<() => void> = [];
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
  onOpen(cb: () => void): void {
    this.onOpenCbs.push(cb);
  }
  onClose(cb: (event?: unknown) => void): void {
    this.onCloseCbs.push(cb);
  }
  onError(cb: (err?: unknown) => void): void {
    this.onErrorCbs.push(cb);
  }
  onMessage(cb: () => void): void {
    this.onMessageCbs.push(cb);
  }
  isConnected(): boolean {
    return this.connected;
  }
  connect(): void {
    if (FakeSocket.connectThrows) {
      FakeSocket.connectThrows = false;
      throw new Error("synthetic dial failure");
    }
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

const { SuiteClient } = await import("../src/suite-client.ts");

function makeClient() {
  return new SuiteClient(
    {
      url: "ws://localhost/socket",
      runtimeId: "test-runtime",
      token: "test-token",
      reconnectIntervalMs: 1,
      maxReconnectIntervalMs: 4,
    },
    {
      onAttention: () => {},
      onDisconnect: () => {},
    },
  );
}

async function settle(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SuiteClient reconnect resilience", () => {
  test("a rejected channel join schedules a reconnect instead of going quiet", async () => {
    sockets.length = 0;
    const client = makeClient();
    client.connect();
    expect(sockets.length).toBe(1);

    sockets[0]!.lastChannel!.joinPush.trigger("error", { reason: "stale token" });
    await settle();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.disconnect();
  });

  test("a timed-out channel join schedules a reconnect", async () => {
    sockets.length = 0;
    const client = makeClient();
    client.connect();

    sockets[0]!.lastChannel!.joinPush.trigger("timeout");
    await settle();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.disconnect();
  });

  test("a socket error without a close event schedules a reconnect", async () => {
    sockets.length = 0;
    const client = makeClient();
    client.connect();

    for (const cb of sockets[0]!.onErrorCbs) cb(new Error("boom"));
    await settle();

    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.disconnect();
  });

  test("error followed by close arms only one reconnect timer (dedupe)", async () => {
    sockets.length = 0;
    const client = makeClient();
    client.connect();

    for (const cb of sockets[0]!.onErrorCbs) cb(new Error("boom"));
    for (const cb of sockets[0]!.onCloseCbs) cb({ code: 1006 });
    // Both fired before the (1ms) timer ran — only one reconnect may land
    // in this window.
    await settle(10);

    expect(sockets.length).toBe(2);
    client.disconnect();
  });

  test("a synchronous dial failure keeps the retry loop alive", async () => {
    sockets.length = 0;
    FakeSocket.connectThrows = true;

    const client = makeClient();
    client.connect(); // first dial throws inside connect()
    await settle();

    // The throw was caught and a fresh attempt was made.
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.at(-1)!.connected).toBe(true);
    client.disconnect();
  });

  test("disconnect() stops the loop for good", async () => {
    sockets.length = 0;
    const client = makeClient();
    client.connect();
    client.disconnect();

    for (const cb of sockets[0]!.onCloseCbs) cb({ code: 1000 });
    await settle();

    expect(sockets.length).toBe(1);
  });
});
