// BURROW_* first, SUITE_* fallback (task 01a14b9f stage 1).
//
// The property under test: a host whose config was written before the Burrow
// rename (only SUITE_* names in .mcp.json or docker/.env) upgrades to this
// build without touching that config, and keeps connecting. And when both
// spellings are set, BURROW_* is what the socket actually dials.
//
// The end-to-end cases run the REAL entry point (src/index.ts) in a
// subprocess through test/helpers/index-probe.ts, with `phoenix` faked, and
// read back the URL the socket was constructed with and the topic it joined.
// Every one of them also asserts stdout is EMPTY: stdout is the MCP stdio
// transport, and a deprecation line written there would corrupt the session.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ENV_FALLBACKS, readEnv, resetEnvWarnings } from "../src/env.ts";
import { resolveBuild } from "../src/build-identity.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const INDEX = join(REPO_ROOT, "src", "index.ts");
const PROBE = join(import.meta.dir, "helpers", "index-probe.ts");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

type ProbeRecord = {
  sockets: Array<{ url: string; params: { runtime_id?: string; token?: string } }>;
  joins: Array<{ topic: string; client_info: Record<string, unknown> }>;
};

type ProbeRun = {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  record: ProbeRecord | null;
};

/** Run src/index.ts with ONLY the given BURROW_/SUITE_ names in its env. */
function runIndex(vars: Record<string, string>): ProbeRun {
  const dir = mkdtempSync(join(tmpdir(), "burrow-env-probe-"));
  tempDirs.push(dir);
  const out = join(dir, "record.json");

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // The test runner's own env must not leak a name into the case.
    if (k.startsWith("BURROW_") || k.startsWith("SUITE_")) continue;
    env[k] = v;
  }
  Object.assign(env, vars, { PROBE_OUT: out });

  const proc = Bun.spawnSync([process.execPath, PROBE, INDEX], { env, cwd: tmpdir(), stdin: "ignore" });
  return {
    exitCode: proc.exitCode,
    stdout: Buffer.from(proc.stdout),
    stderr: proc.stderr.toString(),
    record: existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as ProbeRecord) : null,
  };
}

function deprecationLines(stderr: string): string[] {
  return stderr.split("\n").filter((l) => l.includes("is deprecated; set BURROW_"));
}

describe("src/index.ts env resolution, end to end", () => {
  test("(a) SUITE_* only (an untouched pre-Burrow config): joins, one deprecation line per used name, stdout empty", () => {
    const run = runIndex({
      SUITE_URL: "ws://old.invalid/runtime/ws",
      SUITE_RUNTIME_ID: "rt-old",
      SUITE_TOKEN: "tok-old",
      SUITE_ALLOW_PERMISSION_RELAY: "0",
      SUITE_CHANNEL_BUILD: "build-old",
    });

    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.record!.sockets).toEqual([
      { url: "ws://old.invalid/runtime/ws", params: { runtime_id: "rt-old", token: "tok-old" } },
    ]);
    expect(run.record!.joins.map((j) => j.topic)).toEqual(["runtime:rt-old"]);
    expect(run.record!.joins[0]!.client_info.build).toBe("build-old");

    const lines = deprecationLines(run.stderr);
    // Exactly one per name, each with its BURROW_ replacement, all on stderr.
    expect(lines.sort()).toEqual(
      [
        "[burrow-channel-claude-code] SUITE_ALLOW_PERMISSION_RELAY is deprecated; set BURROW_ALLOW_PERMISSION_RELAY",
        "[burrow-channel-claude-code] SUITE_CHANNEL_BUILD is deprecated; set BURROW_CHANNEL_BUILD",
        "[burrow-channel-claude-code] SUITE_RUNTIME_ID is deprecated; set BURROW_RUNTIME_ID",
        "[burrow-channel-claude-code] SUITE_TOKEN is deprecated; set BURROW_TOKEN",
        "[burrow-channel-claude-code] SUITE_URL is deprecated; set BURROW_URL",
      ],
    );
  });

  test("(a') the minimal old config (URL, RUNTIME_ID, TOKEN only) warns for exactly those three", () => {
    const run = runIndex({
      SUITE_URL: "ws://old.invalid/runtime/ws",
      SUITE_RUNTIME_ID: "rt-old",
      SUITE_TOKEN: "tok-old",
    });

    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.record!.joins.map((j) => j.topic)).toEqual(["runtime:rt-old"]);
    expect(deprecationLines(run.stderr).map((l) => l.split(" ")[1]).sort()).toEqual([
      "SUITE_RUNTIME_ID",
      "SUITE_TOKEN",
      "SUITE_URL",
    ]);
  });

  test("(b) BURROW_* only: joins, no deprecation warning, stdout empty", () => {
    const run = runIndex({
      BURROW_URL: "ws://new.invalid/runtime/ws",
      BURROW_RUNTIME_ID: "rt-new",
      BURROW_TOKEN: "tok-new",
      BURROW_ALLOW_PERMISSION_RELAY: "0",
      BURROW_CHANNEL_BUILD: "build-new",
    });

    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.record!.sockets).toEqual([
      { url: "ws://new.invalid/runtime/ws", params: { runtime_id: "rt-new", token: "tok-new" } },
    ]);
    expect(run.record!.joins.map((j) => j.topic)).toEqual(["runtime:rt-new"]);
    expect(run.record!.joins[0]!.client_info.build).toBe("build-new");
    expect(deprecationLines(run.stderr)).toEqual([]);
  });

  test("(c) both set to different values: the socket dials BURROW_URL and joins BURROW_RUNTIME_ID", () => {
    const run = runIndex({
      SUITE_URL: "ws://old.invalid/runtime/ws",
      SUITE_RUNTIME_ID: "rt-old",
      SUITE_TOKEN: "tok-old",
      SUITE_CHANNEL_BUILD: "build-old",
      BURROW_URL: "ws://new.invalid/runtime/ws",
      BURROW_RUNTIME_ID: "rt-new",
      BURROW_TOKEN: "tok-new",
      BURROW_CHANNEL_BUILD: "build-new",
    });

    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.record!.sockets).toEqual([
      { url: "ws://new.invalid/runtime/ws", params: { runtime_id: "rt-new", token: "tok-new" } },
    ]);
    expect(run.record!.joins.map((j) => j.topic)).toEqual(["runtime:rt-new"]);
    expect(run.record!.joins[0]!.client_info.build).toBe("build-new");
    // No warning for a name whose BURROW_ spelling is set.
    expect(deprecationLines(run.stderr)).toEqual([]);
  });

  test("(c') an EMPTY BURROW_ value does not mask a real SUITE_ value", () => {
    const run = runIndex({
      BURROW_URL: "",
      BURROW_RUNTIME_ID: "",
      BURROW_TOKEN: "",
      SUITE_URL: "ws://old.invalid/runtime/ws",
      SUITE_RUNTIME_ID: "rt-old",
      SUITE_TOKEN: "tok-old",
    });

    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(0);
    expect(run.record!.joins.map((j) => j.topic)).toEqual(["runtime:rt-old"]);
  });

  test("(d) neither: exit 1, the message names BURROW_* and SUITE_*, stdout empty", () => {
    const run = runIndex({});

    expect(run.stdout.length).toBe(0);
    expect(run.exitCode).toBe(1);
    expect(run.record).toBeNull();
    for (const n of ["BURROW_URL", "BURROW_RUNTIME_ID", "BURROW_TOKEN", "SUITE_URL", "SUITE_RUNTIME_ID", "SUITE_TOKEN"]) {
      expect(run.stderr).toContain(n);
    }
  });

  test("client_info key set is the baseline 0.3.1 set; product unchanged", () => {
    const run = runIndex({
      BURROW_URL: "ws://new.invalid/runtime/ws",
      BURROW_RUNTIME_ID: "rt-new",
      BURROW_TOKEN: "tok-new",
      BURROW_CHANNEL_BUILD: "build-new",
    });
    const ci = run.record!.joins[0]!.client_info;

    // Raw literal, read off 0.3.1 (90e873fd) src/suite-client.ts CLIENT_INFO.
    expect(Object.keys(ci).sort()).toEqual(["build", "features", "product", "started_at", "version"]);
    expect(ci.product).toBe("claude_channel");
    expect(ci.features).toEqual(["system_event_prompt"]);
  });
});

describe("(e) build resolution order", () => {
  // A directory with no package.json above it, so the git path cannot answer.
  const noRepo = "/";

  test("BURROW_CHANNEL_BUILD beats SUITE_CHANNEL_BUILD", () => {
    expect(resolveBuild({ BURROW_CHANNEL_BUILD: "new", SUITE_CHANNEL_BUILD: "old" }, noRepo).build).toBe("new");
  });

  test("SUITE_CHANNEL_BUILD beats git", () => {
    expect(resolveBuild({ SUITE_CHANNEL_BUILD: "old" }, join(REPO_ROOT, "src")).build).toBe("old");
  });

  test("BURROW_CHANNEL_BUILD beats git", () => {
    expect(resolveBuild({ BURROW_CHANNEL_BUILD: "new" }, join(REPO_ROOT, "src")).build).toBe("new");
  });

  test("neither: git answers (a 40-hex sha, optionally -dirty)", () => {
    expect(resolveBuild({}, join(REPO_ROOT, "src")).build).toMatch(/^[0-9a-f]{40}(-dirty)?$/);
  });
});

describe("readEnv", () => {
  beforeEach(() => resetEnvWarnings());

  test("warns once per name, however often it is read", () => {
    const lines: string[] = [];
    const warn = (l: string) => lines.push(l);
    const env = { SUITE_URL: "u", SUITE_TOKEN: "t" };

    expect(readEnv("URL", env, warn)).toBe("u");
    expect(readEnv("URL", env, warn)).toBe("u");
    expect(readEnv("TOKEN", env, warn)).toBe("t");
    expect(readEnv("TOKEN", env, warn)).toBe("t");

    expect(lines).toEqual([
      "[burrow-channel-claude-code] SUITE_URL is deprecated; set BURROW_URL",
      "[burrow-channel-claude-code] SUITE_TOKEN is deprecated; set BURROW_TOKEN",
    ]);
  });

  test("BURROW_ wins and does not warn; unset everywhere is undefined", () => {
    const lines: string[] = [];
    const warn = (l: string) => lines.push(l);
    expect(readEnv("URL", { BURROW_URL: "b", SUITE_URL: "s" }, warn)).toBe("b");
    expect(readEnv("URL", {}, warn)).toBeUndefined();
    expect(lines).toEqual([]);
  });

  test("refuses a name that is not in ENV_FALLBACKS", () => {
    expect(() => readEnv("NOT_A_NAME", {})).toThrow(/not in ENV_FALLBACKS/);
  });

  test("every pair is a pure prefix swap", () => {
    for (const [next, old] of ENV_FALLBACKS) {
      expect(next.startsWith("BURROW_")).toBe(true);
      expect(old as string).toBe(`SUITE_${next.slice("BURROW_".length)}`);
    }
  });
});

// GUARD. A RAW literal, deliberately not derived from anything: deleting,
// adding or misspelling a pair in src/env.ts must fail here. Mutation probe
// (task 01a14b9f stage 1): deleting one pair from ENV_FALLBACKS makes this
// test fail.
test("ENV_FALLBACKS is exactly the agreed list", () => {
  expect(ENV_FALLBACKS as unknown).toEqual([
    ["BURROW_URL", "SUITE_URL"],
    ["BURROW_RUNTIME_ID", "SUITE_RUNTIME_ID"],
    ["BURROW_TOKEN", "SUITE_TOKEN"],
    ["BURROW_ALLOW_PERMISSION_RELAY", "SUITE_ALLOW_PERMISSION_RELAY"],
    ["BURROW_CHANNEL_BUILD", "SUITE_CHANNEL_BUILD"],
  ]);
});
