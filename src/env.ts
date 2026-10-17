// Environment names: BURROW_* first, SUITE_* as a deprecated fallback.
//
// The product is now called Burrow. Hosts configured before the rename carry
// only SUITE_* names (in .mcp.json, in docker/.env), and an upgrade must not
// require touching them. So every reader resolves `BURROW_<name>` first and
// falls back to `SUITE_<name>`, and the writers in docker/ emit BOTH names so a
// downgrade to a SUITE-only build keeps working too.
//
// A fallback is reported ONCE per name, on STDERR. Never stdout: stdout is the
// MCP stdio transport, and a single non-JSON-RPC byte there corrupts the
// session (test/env-fallback.test.ts asserts stdout stays empty).
//
// `ENV_FALLBACKS` is the only place the pairs are written down, and
// `readEnv` refuses a name that is not in it, so the list is the contract and
// not a comment about one. test/env-fallback.test.ts pins it to a raw literal.

export const ENV_FALLBACKS = [
  ["BURROW_URL", "SUITE_URL"],
  ["BURROW_RUNTIME_ID", "SUITE_RUNTIME_ID"],
  ["BURROW_TOKEN", "SUITE_TOKEN"],
  ["BURROW_ALLOW_PERMISSION_RELAY", "SUITE_ALLOW_PERMISSION_RELAY"],
  ["BURROW_CHANNEL_BUILD", "SUITE_CHANNEL_BUILD"],
] as const;

export const LOG_PREFIX = "[burrow-channel-claude-code]";

const warned = new Set<string>();

function defaultWarn(line: string): void {
  console.error(line);
}

/** A value counts as set only when it is a non-empty string. */
function present(v: string | undefined): v is string {
  return v !== undefined && v !== "";
}

/**
 * Resolve `BURROW_<name>`, else `SUITE_<name>`, else undefined. `name` is the
 * unprefixed suffix (`"URL"`, `"RUNTIME_ID"`, ...). An empty string counts as
 * unset, so a writer that emits `BURROW_X=""` does not mask a real `SUITE_X`.
 */
export function readEnv(
  name: string,
  env: Record<string, string | undefined> = process.env,
  warn: (line: string) => void = defaultWarn,
): string | undefined {
  const pair = ENV_FALLBACKS.find(([next]) => next === `BURROW_${name}`);
  if (!pair) throw new Error(`readEnv: ${name} is not in ENV_FALLBACKS`);
  const [next, old] = pair;

  const fresh = env[next];
  if (present(fresh)) return fresh;

  const legacy = env[old];
  if (present(legacy)) {
    if (!warned.has(old)) {
      warned.add(old);
      warn(`${LOG_PREFIX} ${old} is deprecated; set ${next}`);
    }
    return legacy;
  }
  return undefined;
}

/** Test hook: forget which deprecation lines were already printed. */
export function resetEnvWarnings(): void {
  warned.clear();
}
