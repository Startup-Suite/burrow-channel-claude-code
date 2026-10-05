/**
 * What the plugin needs from its environment to start, with SUITE_TOKEN
 * resolved IN MEMORY when it is a token ref (src/token-ref.ts).
 *
 * Kept out of index.ts so tests can run it with a fake `security` and an
 * injected environment, without starting the MCP server.
 */
import { resolveToken, TokenRefError, type TokenKind, type TokenRefDeps } from "./token-ref.ts";

export interface StartupConfig {
  url: string;
  runtimeId: string;
  /** The resolved token. In memory only: never logged, never written. */
  token: string;
  tokenKind: TokenKind;
  allowPermissionRelay: boolean;
}

/** A startup refusal. Its message names env vars, refs and items only. */
export class StartupError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "StartupError";
    this.code = code;
  }
}

export async function resolveStartupConfig(
  env: Record<string, string | undefined>,
  deps: TokenRefDeps = {},
): Promise<StartupConfig> {
  const url = env.SUITE_URL;
  const runtimeId = env.SUITE_RUNTIME_ID;
  const raw = env.SUITE_TOKEN;
  if (!url || !runtimeId || !raw) {
    throw new StartupError("missing_env", "missing env: SUITE_URL, SUITE_RUNTIME_ID, SUITE_TOKEN are all required");
  }
  try {
    const { kind, value } = await resolveToken(raw, env.SUITE_TOKEN_KEYCHAIN_SERVICE, deps);
    return { url, runtimeId, token: value, tokenKind: kind, allowPermissionRelay: env.SUITE_ALLOW_PERMISSION_RELAY === "1" };
  } catch (e) {
    if (e instanceof TokenRefError) throw new StartupError(e.code, `SUITE_TOKEN: ${e.message}`);
    // Anything else: the class name only, in case a message carries more.
    throw new StartupError("token_ref_failed", `SUITE_TOKEN could not be resolved (${e instanceof Error ? e.name : "error"})`);
  }
}
