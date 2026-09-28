// What code is this process running, and since when?
//
// Both values are resolved ONCE, when this module is first loaded, and never
// again. bun runs `src/*.ts` directly with no build step, so for this plugin
// "the code bun loaded" and "the commit checked out at load time" are the same
// thing. Re-reading the checkout at join/rejoin time would report what is
// CHECKED OUT NOW, not what is RUNNING: a `git pull` without a restart would
// then advertise the new sha for old resident code, which is exactly the lie
// core's `normalize_build/1` contract (runtime_channel.ex) warns against.
//
// ── BUILD ───────────────────────────────────────────────────────────────────
//
// Resolution order:
//   1. env `SUITE_CHANNEL_BUILD`, if non-empty. Set only by docker/Dockerfile,
//      whose image copies `src/` without `.git`, from `docker/run.sh`'s
//      `git rev-parse HEAD` of the checkout it built from.
//   2. `git rev-parse HEAD` of the PLUGIN ROOT (the directory holding this
//      repo's package.json, found from this file's location - never
//      `process.cwd()`, because the plugin is launched as
//      `bun /path/to/src/index.ts` from an unrelated cwd). The plugin root must
//      BE the git toplevel: a copy vendored inside some other repo would
//      otherwise report that repo's sha, which names none of this code.
//      `-dirty` is appended when tracked files differ from HEAD, because then
//      the sha does not name the running code either.
//   3. Otherwise `BUILD` is null and `BUILD_ERROR` says why. Never a guess,
//      and never `package.json`'s version: commit 7288017 shipped a fix with
//      no version bump, so the version discriminates nothing.
//
// ── PROCESS_STARTED_AT ──────────────────────────────────────────────────────
//
// When this PROCESS started (`performance.timeOrigin`), not when a socket
// connected. A reconnect must re-send the same value, so a reader can tell a
// reconnect (connected_at moves, started_at does not) from a restart (both
// move).

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const GIT_TIMEOUT_MS = 3_000;
const ERROR_DETAIL_MAX = 120;

type Resolution = { build: string; error: null } | { build: null; error: string };

function findPluginRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function errorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const stderr = typeof e?.stderr === "string" ? e.stderr : Buffer.isBuffer(e?.stderr) ? e.stderr.toString() : "";
  const raw = (stderr.trim() || (typeof e?.message === "string" ? e.message : String(err))).replace(/\s+/g, " ");
  return raw.length > ERROR_DETAIL_MAX ? raw.slice(0, ERROR_DETAIL_MAX) : raw;
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveBuild(env: NodeJS.ProcessEnv, moduleDir: string): Resolution {
  const fromEnv = env.SUITE_CHANNEL_BUILD?.trim();
  if (fromEnv) return { build: fromEnv, error: null };

  const root = findPluginRoot(moduleDir);
  if (!root) return { build: null, error: "no package.json above the plugin source and SUITE_CHANNEL_BUILD unset" };

  let toplevel: string;
  try {
    toplevel = git(root, ["rev-parse", "--show-toplevel"]);
  } catch (err) {
    return { build: null, error: `not a git checkout and SUITE_CHANNEL_BUILD unset (${errorDetail(err)})`.slice(0, 200) };
  }

  if (realpathSync(toplevel) !== realpathSync(root)) {
    return {
      build: null,
      error: "plugin root is not the git toplevel (vendored inside another repo) and SUITE_CHANNEL_BUILD unset",
    };
  }

  try {
    const sha = git(root, ["rev-parse", "HEAD"]);
    if (!/^[0-9a-f]{40}$/.test(sha)) return { build: null, error: "git rev-parse HEAD returned no sha" };
    const dirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
    return { build: dirty ? `${sha}-dirty` : sha, error: null };
  } catch (err) {
    return { build: null, error: `git rev-parse failed: ${errorDetail(err)}` };
  }
}

function resolveProcessStartedAt(): string {
  const origin = performance.timeOrigin;
  if (Number.isFinite(origin) && origin > 0) return new Date(origin).toISOString();
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

const resolved = resolveBuild(process.env, import.meta.dir);

/** Commit this process loaded (`<40-hex>[-dirty]`, or the docker-stamped value); null if unresolvable. */
export const BUILD: string | null = resolved.build;

/** Why `BUILD` is null; null whenever `BUILD` is set. */
export const BUILD_ERROR: string | null = resolved.error;

/** ISO-8601 start time of this process. Never a connection time. */
export const PROCESS_STARTED_AT: string = resolveProcessStartedAt();
