// Federation handshake contract test (stage 4 of task 019df0ee, extended by
// stage 4 of task 019fa56b).
//
// Verifies that the SuiteClient's runtime channel join passes
// `client_info: { product: "claude_channel", version: <truthy>,
// features: ["system_event_prompt"] }` so the Burrow dispatch renderer can
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

import { afterAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

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

type JoinClientInfo = {
  product?: string;
  version?: string;
  features?: unknown;
  build?: string;
  build_error?: string;
  started_at?: string;
};

function joinClientInfo(): JoinClientInfo {
  return joinClientInfos(1)[0]!;
}

/**
 * Join `n` times on ONE SuiteClient. The second and later `connect()` calls
 * are the reconnect path (`scheduleReconnect` calls `connect()` on the same
 * instance), i.e. a rejoin without a process restart.
 */
function joinClientInfos(n: number, gapMs = 0): JoinClientInfo[] {
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

  for (let i = 0; i < n; i++) {
    if (i > 0 && gapMs > 0) Bun.sleepSync(gapMs);
    client.connect();
  }

  expect(captured.length).toBe(n);
  client.disconnect();

  return captured.map(({ topic, params }) => {
    expect(topic).toBe("runtime:test-runtime");
    const p = params as { client_info?: JoinClientInfo };
    expect(p.client_info).toBeDefined();
    // Round-trip through JSON: that is what goes on the wire, and it is what
    // drops a key whose value is `undefined`.
    return JSON.parse(JSON.stringify(p.client_info)) as JoinClientInfo;
  });
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
    expect(ci.version).toBe("0.4.1");
  });

  // The exact literal, isolated from the join plumbing, so a drift in the
  // constant is attributable without reading a socket trace. This is the
  // string core matches on; core's own copy is
  // `AgentRuntime.system_event_prompt_feature/0`.
  test("CLIENT_INFO.features is exactly ['system_event_prompt']", () => {
    expect(CLIENT_INFO.features).toEqual(["system_event_prompt"]);
  });
});

// ── build / started_at (task 01a09e63 stage 1) ────────────────────────────
//
// `build` must answer "is this runtime on the build whose source I am
// reading?". A commit sha does; `version` does not (7288017 shipped a fix with
// no version bump). Both values are resolved ONCE when the module loads, so a
// reconnect re-sends what the resident process loaded - never what is on disk
// now, never anything derived from the connection.

const REPO_ROOT = resolve(import.meta.dir, "..");
const PROBE = join(import.meta.dir, "helpers", "join-probe.ts");

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.email=test@example.invalid", "-c", "user.name=test", ...args],
    { encoding: "utf8" },
  ).trim();
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "suite-channel-build-"));
  tempDirs.push(d);
  return d;
}

/** Copy the plugin's `src/` + `package.json` (no `.git`) into `dest`. */
function copyPlugin(dest: string): string {
  mkdirSync(dest, { recursive: true });
  cpSync(join(REPO_ROOT, "src"), join(dest, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dest, "package.json"));
  return join(dest, "src", "suite-client.ts");
}

type ProbeResult = { joins: JoinClientInfo[]; head_after: string | null };

function probe(clientPath: string, env: Record<string, string | undefined>, commitRepo?: string): ProbeResult {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) childEnv[k] = v;
  }
  const args = [PROBE, clientPath];
  if (commitRepo) args.push(commitRepo);
  const out = Bun.spawnSync([process.execPath, ...args], { env: childEnv, cwd: tmpdir() });
  if (out.exitCode !== 0) {
    throw new Error(`probe exited ${out.exitCode}: ${out.stderr.toString()}`);
  }
  const lines = out.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as ProbeResult;
}

describe("SuiteClient client_info.build / started_at", () => {
  // The test process may itself have BURROW_CHANNEL_BUILD / SUITE_CHANNEL_BUILD
  // set (the docker image sets them); these in-process cases assert the git path.
  const envBuild = process.env.BURROW_CHANNEL_BUILD || process.env.SUITE_CHANNEL_BUILD;

  test("(a) build is `git rev-parse HEAD` of the plugin checkout, -dirty only when the tree is dirty", () => {
    if (envBuild) return; // resolution (a) wins; covered by test (e)
    const head = git(REPO_ROOT, "rev-parse", "HEAD");
    const dirty = git(REPO_ROOT, "status", "--porcelain", "--untracked-files=no").length > 0;
    const ci = joinClientInfo();

    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(ci.build).toBe(dirty ? `${head}-dirty` : head);
    if (!dirty) expect(ci.build!.endsWith("-dirty")).toBe(false);
    expect(ci.build_error).toBeUndefined();
    // Fits core's 64-byte cap (runtime_channel.ex normalize_build/1).
    expect(Buffer.byteLength(ci.build!)).toBeLessThanOrEqual(64);
  });

  test("(b) build is never the package.json version", () => {
    const ci = joinClientInfo();
    expect(typeof ci.build).toBe("string");
    expect(ci.build).not.toBe(CLIENT_INFO.version);
    expect(ci.build).not.toBe((pkg as { version: string }).version);
    expect(ci.version).toBe((pkg as { version: string }).version);
  });

  test("(c) started_at is the process start: parses, is in the past, identical across a rejoin", () => {
    const before = Date.now();
    const [first, second] = joinClientInfos(2, 25);

    expect(typeof first!.started_at).toBe("string");
    const t = Date.parse(first!.started_at!);
    expect(Number.isNaN(t)).toBe(false);
    expect(t).toBeLessThanOrEqual(Date.now());
    // Earlier than the first connect in this test: not a connect-time value.
    expect(t).toBeLessThan(before);
    // A connect-time value would differ by >= the 25 ms gap.
    expect(second!.started_at).toBe(first!.started_at);
    expect(second!.build).toBe(first!.build);
  });

  test("(d) loaded from a copy with no .git and both build envs unset: no build, a build_error saying why", () => {
    const clientPath = copyPlugin(join(tempDir(), "plugin"));
    const { joins } = probe(clientPath, { BURROW_CHANNEL_BUILD: undefined, SUITE_CHANNEL_BUILD: undefined });

    expect(joins.length).toBe(2);
    for (const ci of joins) {
      expect("build" in ci).toBe(false);
      expect(typeof ci.build_error).toBe("string");
      expect(ci.build_error!.length).toBeGreaterThan(0);
      expect(ci.product).toBe("claude_channel");
      expect(typeof ci.started_at).toBe("string");
    }
  });

  test("(e) the deprecated SUITE_CHANNEL_BUILD alone still wins over git", () => {
    const { joins } = probe(join(REPO_ROOT, "src", "suite-client.ts"), {
      BURROW_CHANNEL_BUILD: undefined,
      SUITE_CHANNEL_BUILD: "abc123",
    });

    expect(joins[0]!.build).toBe("abc123");
    expect("build_error" in joins[0]!).toBe(false);
  });

  test("(f) a commit landing after load does NOT change the build sent on rejoin", () => {
    const repo = join(tempDir(), "plugin");
    const clientPath = copyPlugin(repo);
    git(repo, "init", "-q");
    git(repo, "add", "src", "package.json");
    git(repo, "commit", "-q", "-m", "initial");
    const loadedHead = git(repo, "rev-parse", "HEAD");

    const { joins, head_after } = probe(
      clientPath,
      { BURROW_CHANNEL_BUILD: undefined, SUITE_CHANNEL_BUILD: undefined },
      repo,
    );

    expect(head_after).not.toBe(loadedHead);
    expect(joins[0]!.build).toBe(loadedHead);
    expect(joins[1]!.build).toBe(loadedHead);
    expect(joins[1]!.started_at).toBe(joins[0]!.started_at);
  });

  // Installed as a subdirectory of SOME OTHER repo (a vendored copy, a
  // node_modules install inside a project): `git rev-parse HEAD` would answer
  // with the enclosing project's sha, which names none of this plugin's code.
  test("(g) a copy nested inside a foreign git repo reports build_error, not the foreign sha", () => {
    const outer = tempDir();
    git(outer, "init", "-q");
    git(outer, "commit", "--allow-empty", "-q", "-m", "foreign");
    const clientPath = copyPlugin(join(outer, "vendor", "plugin"));

    const { joins } = probe(clientPath, { BURROW_CHANNEL_BUILD: undefined, SUITE_CHANNEL_BUILD: undefined });

    expect("build" in joins[0]!).toBe(false);
    expect(joins[0]!.build_error!.length).toBeGreaterThan(0);
  });
});
