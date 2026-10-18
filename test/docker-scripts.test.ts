// docker/run.sh and docker/entrypoint.sh: read BURROW_* first, SUITE_*
// second, and WRITE BOTH (task 01a14b9f stage 1).
//
// Both scripts run for real under bash, with `docker`, `claude` and `gh`
// replaced by stubs on PATH that record what they were called with. Nothing
// here starts a container.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DOCKER_DIR = resolve(import.meta.dir, "..", "docker");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "burrow-docker-scripts-"));
  tempDirs.push(d);
  return d;
}

function stub(binDir: string, name: string, body: string): void {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

/** A clean env: system PATH behind the stub dir, no BURROW_/SUITE_ names. */
function baseEnv(binDir: string, home: string): Record<string, string> {
  return { PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`, HOME: home };
}

function deprecations(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((l) => l.includes("is deprecated; set BURROW_"))
    .map((l) => l.replace(/^\[\w+\] /, "").split(" ")[0]!)
    .sort();
}

describe("docker/entrypoint.sh", () => {
  function runEntrypoint(vars: Record<string, string>) {
    const root = tempDir();
    const bin = join(root, "bin");
    const home = join(root, "home");
    const ws = join(root, "workspace");
    mkdirSync(bin);
    mkdirSync(home);
    stub(bin, "claude", `printf '%s\\n' "$@" > "${root}/claude.args"`);
    stub(bin, "gh", "exit 1");
    const proc = Bun.spawnSync(["bash", join(DOCKER_DIR, "entrypoint.sh")], {
      env: { ...baseEnv(bin, home), WORKSPACE_DIR: ws, ...vars },
    });
    return {
      exitCode: proc.exitCode,
      stderr: proc.stderr.toString(),
      mcp: () => JSON.parse(readFileSync(join(ws, ".mcp.json"), "utf8")),
      claudeArgs: () => readFileSync(join(root, "claude.args"), "utf8").trim().split("\n"),
    };
  }

  test("SUITE_* only (a container from an older run.sh): writes BOTH names under the unchanged suite-channel key", () => {
    const run = runEntrypoint({ SUITE_URL: "ws://old.invalid/ws", SUITE_RUNTIME_ID: "rt-old", SUITE_TOKEN: "tok-old" });

    expect(run.exitCode).toBe(0);
    const mcp = run.mcp();
    expect(Object.keys(mcp.mcpServers)).toEqual(["suite-channel"]);
    expect(mcp.mcpServers["suite-channel"].env).toEqual({
      BURROW_URL: "ws://old.invalid/ws",
      BURROW_RUNTIME_ID: "rt-old",
      BURROW_TOKEN: "tok-old",
      BURROW_ALLOW_PERMISSION_RELAY: "0",
      SUITE_URL: "ws://old.invalid/ws",
      SUITE_RUNTIME_ID: "rt-old",
      SUITE_TOKEN: "tok-old",
      SUITE_ALLOW_PERMISSION_RELAY: "0",
    });
    expect(run.claudeArgs()).toContain("server:suite-channel");
    expect(deprecations(run.stderr)).toEqual(["SUITE_RUNTIME_ID", "SUITE_TOKEN", "SUITE_URL"]);
  });

  test("both set to different values: BURROW_ values are written under both names, no warning", () => {
    const run = runEntrypoint({
      SUITE_URL: "ws://old.invalid/ws",
      SUITE_RUNTIME_ID: "rt-old",
      SUITE_TOKEN: "tok-old",
      SUITE_ALLOW_PERMISSION_RELAY: "0",
      BURROW_URL: "ws://new.invalid/ws",
      BURROW_RUNTIME_ID: "rt-new",
      BURROW_TOKEN: "tok-new",
      BURROW_ALLOW_PERMISSION_RELAY: "1",
    });

    expect(run.exitCode).toBe(0);
    const env = run.mcp().mcpServers["suite-channel"].env;
    expect(env.BURROW_URL).toBe("ws://new.invalid/ws");
    expect(env.SUITE_URL).toBe("ws://new.invalid/ws");
    expect(env.BURROW_RUNTIME_ID).toBe("rt-new");
    expect(env.SUITE_RUNTIME_ID).toBe("rt-new");
    expect(env.BURROW_ALLOW_PERMISSION_RELAY).toBe("1");
    expect(env.SUITE_ALLOW_PERMISSION_RELAY).toBe("1");
    expect(deprecations(run.stderr)).toEqual([]);
  });

  test("neither: exits non-zero naming BURROW_URL and SUITE_URL", () => {
    const run = runEntrypoint({});
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("BURROW_URL");
    expect(run.stderr).toContain("SUITE_URL");
  });
});

describe("docker/run.sh", () => {
  function runRunSh(envFileBody: string, vars: Record<string, string> = {}) {
    const root = tempDir();
    const bin = join(root, "bin");
    const home = join(root, "home");
    const ws = join(root, "workspace");
    mkdirSync(bin);
    mkdirSync(home);
    mkdirSync(ws);
    const envFile = join(root, "worker.env");
    writeFileSync(envFile, envFileBody);
    // `docker image inspect` succeeds (no build); `docker run` records its
    // argv and the values of every name it was told to pass with -e.
    stub(
      bin,
      "docker",
      `case "$1" in
  image) exit 0 ;;
  rm) exit 0 ;;
  run)
    printf '%s\\n' "$@" > "${root}/docker.args"
    for n in BURROW_URL SUITE_URL BURROW_RUNTIME_ID SUITE_RUNTIME_ID BURROW_TOKEN SUITE_TOKEN BURROW_ALLOW_PERMISSION_RELAY SUITE_ALLOW_PERMISSION_RELAY; do
      printf '%s=%s\\n' "$n" "\${!n:-}" >> "${root}/docker.env"
    done ;;
esac`,
    );
    const proc = Bun.spawnSync(["bash", join(DOCKER_DIR, "run.sh")], {
      env: { ...baseEnv(bin, home), WORKER_WORKSPACE: ws, ...vars, SUITE_WORKER_ENV_FILE: envFile },
      cwd: ws,
    });
    const read = (f: string) => readFileSync(join(root, f), "utf8").trim().split("\n");
    return {
      exitCode: proc.exitCode,
      stderr: proc.stderr.toString(),
      args: () => read("docker.args"),
      env: () => Object.fromEntries(read("docker.env").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
    };
  }

  test("an untouched SUITE_-only .env: launches, passes BOTH names, keeps the old container name", () => {
    const run = runRunSh("SUITE_URL=ws://old.invalid/ws\nSUITE_RUNTIME_ID=rt-old\nSUITE_TOKEN=tok-old\nSUITE_ALLOW_PERMISSION_RELAY=0\n");

    expect(run.exitCode).toBe(0);
    const args = run.args();
    for (const n of ["BURROW_URL", "SUITE_URL", "BURROW_RUNTIME_ID", "SUITE_RUNTIME_ID", "BURROW_TOKEN", "SUITE_TOKEN"]) {
      expect(args).toContain(n);
    }
    expect(args[args.indexOf("--name") + 1]).toBe("suite-worker-rt-old");
    expect(args).toContain("claude-code-suite-worker:latest");
    expect(run.env()).toEqual({
      BURROW_URL: "ws://old.invalid/ws",
      SUITE_URL: "ws://old.invalid/ws",
      BURROW_RUNTIME_ID: "rt-old",
      SUITE_RUNTIME_ID: "rt-old",
      BURROW_TOKEN: "tok-old",
      SUITE_TOKEN: "tok-old",
      BURROW_ALLOW_PERMISSION_RELAY: "0",
      SUITE_ALLOW_PERMISSION_RELAY: "0",
    });
    // SUITE_WORKER_ENV_FILE itself is one of the fallbacks used.
    expect(deprecations(run.stderr)).toEqual([
      "SUITE_ALLOW_PERMISSION_RELAY",
      "SUITE_RUNTIME_ID",
      "SUITE_TOKEN",
      "SUITE_URL",
      "SUITE_WORKER_ENV_FILE",
    ]);
  });

  test("both spellings in .env with different values: BURROW_ wins for both names passed", () => {
    const run = runRunSh(
      "SUITE_URL=ws://old.invalid/ws\nSUITE_RUNTIME_ID=rt-old\nSUITE_TOKEN=tok-old\n" +
        "BURROW_URL=ws://new.invalid/ws\nBURROW_RUNTIME_ID=rt-new\nBURROW_TOKEN=tok-new\n",
    );

    expect(run.exitCode).toBe(0);
    const env = run.env();
    expect(env.BURROW_URL).toBe("ws://new.invalid/ws");
    expect(env.SUITE_URL).toBe("ws://new.invalid/ws");
    expect(env.BURROW_RUNTIME_ID).toBe("rt-new");
    expect(env.SUITE_RUNTIME_ID).toBe("rt-new");
    expect(env.SUITE_TOKEN).toBe("tok-new");
    const args = run.args();
    expect(args[args.indexOf("--name") + 1]).toBe("suite-worker-rt-new");
  });

  test("BURROW_WORKER_CONTAINER beats SUITE_WORKER_CONTAINER", () => {
    const run = runRunSh("BURROW_URL=ws://x.invalid/ws\nBURROW_RUNTIME_ID=rt\nBURROW_TOKEN=t\n", {
      BURROW_WORKER_CONTAINER: "c-new",
      SUITE_WORKER_CONTAINER: "c-old",
    });
    expect(run.exitCode).toBe(0);
    const args = run.args();
    expect(args[args.indexOf("--name") + 1]).toBe("c-new");
  });

  test("missing everything: exits non-zero naming BURROW_URL and SUITE_URL", () => {
    const run = runRunSh("");
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("BURROW_URL");
    expect(run.stderr).toContain("SUITE_URL");
  });
});
