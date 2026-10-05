// SUITE_TOKEN as a token ref, through the plugin's REAL startup path (task
// 01a0d6b9 stage 1). Each case runs test/helpers/startup-probe.ts in a
// subprocess, so the resolver, the startup config and a real SuiteClient run
// as they do under index.ts, with only `phoenix` and `security` faked.
//
//  - keychain: a fake `security` (injected path, never PATH) records its argv;
//    the argv carries the item and service NAMES and never the value; the
//    resolved token is what the socket is opened with (compared by sha256).
//  - a fake `security` FIRST ON PATH is never run (positive control: the same
//    fake does record when called by name).
//  - file: refs and a literal still work.
//  - LEAK GREP: the token appears nowhere in the probe's stdout or stderr.
//    Positive control: a planted marker IS found by the same grep.
//
// Values are random canaries per test, never printed; failures print counts.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelStatePath, writeChannelState } from "../src/channel-state.ts";

const PROBE = join(import.meta.dir, "helpers", "startup-probe.ts");
const root = mkdtempSync(join(tmpdir(), `channel-startup-01a0d6b9-${process.pid}-`));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const canary = () => `tok_01a0d6b9_${randomBytes(24).toString("hex")}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A fake `security`: records argv (one per line), answers with the value from a file. */
function fakeSecurity(dir: string, value: string | null, exit = 0): { bin: string; argvLog: string } {
  mkdirSync(dir, { recursive: true });
  const valueFile = join(dir, "value");
  const argvLog = join(dir, "argv.log");
  if (value !== null) writeFileSync(valueFile, `${value}\n`);
  const bin = join(dir, "security");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `for a in "$@"; do printf '%s\\n' "$a" >> '${argvLog}'; done`,
      exit === 0 && value !== null ? `cat '${valueFile}'` : "",
      `exit ${exit}`,
    ].join("\n") + "\n",
  );
  chmodSync(bin, 0o755);
  return { bin, argvLog };
}

function probe(env: Record<string, string>, securityBin?: string) {
  const r = Bun.spawnSync(["bun", PROBE, ...(securityBin ? [securityBin] : [])], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = r.stdout.toString();
  const stderr = r.stderr.toString();
  const line = stdout.trim().split("\n").pop() ?? "{}";
  return { code: r.exitCode, stdout, stderr, doc: JSON.parse(line) as Record<string, unknown> };
}

/** Occurrences of `needle` across both streams. A count, so a failure prints no value. */
const leakCount = (r: { stdout: string; stderr: string }, needle: string) =>
  `${r.stdout}\n${r.stderr}`.split(needle).length - 1;

const BASE = { SUITE_URL: "ws://suite.example.invalid/runtime/ws", SUITE_RUNTIME_ID: "rt-01a0d6b9" };

describe("SUITE_TOKEN=keychain:<item>", () => {
  test("argv carries names only, and the resolved token is what the socket opens with", () => {
    const value = canary();
    const { bin, argvLog } = fakeSecurity(join(root, "kc-ok"), value);
    const r = probe(
      { ...BASE, SUITE_TOKEN: "keychain:RUNTIME_TOKEN.rt-01a0d6b9", SUITE_TOKEN_KEYCHAIN_SERVICE: "suite-01a0d6b9-test" },
      bin,
    );
    expect(r.code).toBe(0);
    expect(r.doc).toEqual({ ok: true, kind: "keychain", token_sha256: sha(value), runtime_id: "rt-01a0d6b9" });
    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(argv).toEqual(["find-generic-password", "-s", "suite-01a0d6b9-test", "-a", "RUNTIME_TOKEN.rt-01a0d6b9", "-w"]);
    expect(argv.join(" ").includes(value)).toBe(false);
    // LEAK GREP: zero occurrences in stdout and stderr.
    expect(leakCount(r, value)).toBe(0);
  });

  test("positive control: the same grep finds a planted marker", () => {
    const value = canary();
    const { bin } = fakeSecurity(join(root, "kc-plant"), value);
    const r = probe(
      { ...BASE, SUITE_TOKEN: "keychain:RUNTIME_TOKEN.rt", SUITE_TOKEN_KEYCHAIN_SERVICE: "suite-01a0d6b9-test", PROBE_PLANT: value },
      bin,
    );
    expect(r.code).toBe(0);
    expect(leakCount(r, value)).toBe(1);
  });

  test("a locked keychain or missing item exits 1 naming the item, never a value", () => {
    const { bin } = fakeSecurity(join(root, "kc-missing"), null, 44);
    const r = probe({ ...BASE, SUITE_TOKEN: "keychain:RUNTIME_TOKEN.absent", SUITE_TOKEN_KEYCHAIN_SERVICE: "suite-01a0d6b9-test" }, bin);
    expect(r.code).toBe(1);
    expect(r.doc).toEqual({ ok: false, code: "keychain_unavailable" });
    expect(r.stderr).toContain("RUNTIME_TOKEN.absent");
    expect(r.stderr).toContain("suite-01a0d6b9-test");
  });

  test("a fake `security` first on PATH is never run (absolute /usr/bin/security only)", () => {
    const value = canary();
    const onPath = fakeSecurity(join(root, "path-fake"), value);
    // Positive control: called BY NAME, the PATH fake does run and record.
    const control = Bun.spawnSync(["sh", "-c", "security probe-01a0d6b9"], {
      env: { PATH: `${join(root, "path-fake")}:/usr/bin:/bin` },
      stdout: "pipe",
    });
    expect(control.exitCode).toBe(0);
    expect(readFileSync(onPath.argvLog, "utf8").trim()).toBe("probe-01a0d6b9");
    rmSync(onPath.argvLog);
    // The resolver, with no injected bin: whatever /usr/bin/security does
    // (absent on Linux; on macOS no such item), the PATH fake records nothing.
    const r = probe({
      ...BASE,
      PATH: `${join(root, "path-fake")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      SUITE_TOKEN: "keychain:RUNTIME_TOKEN.nonexistent-01a0d6b9",
      SUITE_TOKEN_KEYCHAIN_SERVICE: "suite-01a0d6b9-test-absent",
    });
    expect(r.code).toBe(1);
    expect(existsSync(onPath.argvLog)).toBe(false);
    expect(leakCount(r, value)).toBe(0);
  });
});

describe("SUITE_TOKEN=file:<path> and a literal", () => {
  test("a 0600 file resolves; the socket opens with its content", () => {
    const value = canary();
    const p = join(root, "runtime.token");
    writeFileSync(p, `${value}\n`);
    chmodSync(p, 0o600);
    const r = probe({ ...BASE, SUITE_TOKEN: `file:${p}` });
    expect(r.code).toBe(0);
    expect(r.doc.token_sha256).toBe(sha(value));
    expect(leakCount(r, value)).toBe(0);
  });

  test("a 0644 file is refused naming path and mode, never the content", () => {
    const value = canary();
    const p = join(root, "loose.token");
    writeFileSync(p, value);
    chmodSync(p, 0o644);
    const r = probe({ ...BASE, SUITE_TOKEN: `file:${p}` });
    expect(r.code).toBe(1);
    expect(r.doc).toEqual({ ok: false, code: "token_file_mode" });
    expect(r.stderr).toContain(p);
    expect(r.stderr).toContain("0644");
    expect(leakCount(r, value)).toBe(0);
  });

  test("a literal SUITE_TOKEN still works, unchanged (legacy)", () => {
    const value = canary();
    const r = probe({ ...BASE, SUITE_TOKEN: value });
    expect(r.code).toBe(0);
    expect(r.doc).toEqual({ ok: true, kind: "literal", token_sha256: sha(value), runtime_id: "rt-01a0d6b9" });
  });
});

describe("the join-state file suite status reads", () => {
  test("joined, then disconnected, with this pid and no secret", () => {
    const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };
    writeChannelState(env, "rt-01a0d6b9", "joined", 4242);
    const path = channelStatePath(env, "rt-01a0d6b9");
    expect(path).toBe(join(root, "state", "suite", "channel", "rt-01a0d6b9.json"));
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ state: "joined", pid: 4242 });
    writeChannelState(env, "rt-01a0d6b9", "disconnected", 4242);
    expect(JSON.parse(readFileSync(path, "utf8")).state).toBe("disconnected");
    expect(Object.keys(JSON.parse(readFileSync(path, "utf8"))).sort()).toEqual(["at", "pid", "state"]);
  });
});
