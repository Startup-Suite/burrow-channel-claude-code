/**
 * The channel's join state, in a small file `suite status --json` reads.
 *
 *   <XDG_STATE_HOME or ~/.local/state>/suite/channel/<runtime id>.json
 *   {"state": "joined" | "disconnected", "pid": <this process>, "at": <ISO>}
 *
 * WHY A FILE. Asking `claude mcp list` whether the channel is connected starts
 * a SECOND copy of this plugin to health-check it, which joins Suite as the
 * same runtime, once per poll. This file costs nothing and carries no secret:
 * a state word, a pid and a time. The reader treats a dead pid as not
 * connected, so a crashed plugin cannot leave "joined" behind.
 *
 * Best effort: a state file that cannot be written never affects the channel.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type ChannelState = "joined" | "disconnected";

export function channelStatePath(env: Record<string, string | undefined>, runtimeId: string): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg !== undefined && xdg !== "" && xdg.startsWith("/") ? xdg : resolve(env.HOME ?? "", ".local", "state");
  return join(base, "suite", "channel", `${runtimeId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

export function writeChannelState(
  env: Record<string, string | undefined>,
  runtimeId: string,
  state: ChannelState,
  pid: number = process.pid,
): void {
  if ((env.HOME ?? "") === "" && (env.XDG_STATE_HOME ?? "") === "") return;
  try {
    const path = channelStatePath(env, runtimeId);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ state, pid, at: new Date().toISOString() })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* best effort */
  }
}
